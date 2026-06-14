/**
 * Cross-language WebSocket integration test: ts <-> rust
 *
 * Tests that the TypeScript WebSocketPeer can communicate with the
 * Rust rust /ws endpoint using the shared protocol:
 * - JSON messages: req, res
 * - Binary messages: [4-byte LE request_id][data]
 */

import WebSocket from 'ws';
import { createHash } from 'crypto';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

// Polyfill WebSocket for Node.js environment
(globalThis as any).WebSocket = WebSocket;

export const RUST_SERVER_PORT = 18787;
export const RUST_SERVER_URL = `ws://127.0.0.1:${RUST_SERVER_PORT}/ws`;
export const HTTP_URL = `http://127.0.0.1:${RUST_SERVER_PORT}`;

/**
 * Simple WebSocket client that speaks the hashtree protocol
 * (mirrors wsPeer.ts but simplified for testing)
 */
export class TestWsClient {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<number, {
    hash: string;
    resolve: (data: Uint8Array | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private nextRequestId = 1;
  private name: string;

  constructor(name = 'TestWsClient') {
    this.name = name;
  }

  async connect(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        const timeout = setTimeout(() => {
          this.ws?.close();
          resolve(false);
        }, 5000);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          console.log(`[${this.name}] Connected`);
          resolve(true);
        };

        this.ws.onerror = (err) => {
          clearTimeout(timeout);
          console.log(`[${this.name}] Error:`, err);
          resolve(false);
        };

        this.ws.onmessage = (event) => {
          if (typeof event.data === 'string') {
            this.handleJsonMessage(event.data);
          } else if (event.data instanceof ArrayBuffer) {
            this.handleBinaryMessage(event.data);
          }
        };
      } catch {
        resolve(false);
      }
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    this.pendingRequests.clear();
  }

  async request(hashHex: string, timeoutMs = 5000): Promise<Uint8Array | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return null;
    }

    const requestId = this.nextRequestId++;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.log(`[${this.name}] Request timeout for`, hashHex.slice(0, 16));
        resolve(null);
      }, timeoutMs);

      this.pendingRequests.set(requestId, { hash: hashHex, resolve, timeout });

      const msg = { type: 'req', id: requestId, hash: hashHex };
      this.ws!.send(JSON.stringify(msg));
      console.log(`[${this.name}] Sent request:`, msg);
    });
  }

  protected handleJsonMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      console.log(`[${this.name}] Received JSON:`, msg);

      if (msg.type === 'res') {
        const pending = this.pendingRequests.get(msg.id);
        if (pending && !msg.found) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.id);
          pending.resolve(null);
        }
        // If found=true, wait for binary data
      }
    } catch (err) {
      console.log(`[${this.name}] Error parsing JSON:`, err);
    }
  }

  protected handleBinaryMessage(data: ArrayBuffer): void {
    // Parse: [4-byte LE request_id][payload]
    const view = new DataView(data);
    const requestId = view.getUint32(0, true); // little-endian
    const payload = new Uint8Array(data, 4);

    console.log(`[${this.name}] Received binary:`, requestId, 'bytes:', payload.length);

    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);

    // Verify hash
    const computedHash = createHash('sha256').update(payload).digest('hex');
    if (computedHash === pending.hash) {
      pending.resolve(payload);
    } else {
      console.log(`[${this.name}] Hash mismatch:`, computedHash, 'expected:', pending.hash);
      pending.resolve(null);
    }
  }

  protected getWs(): WebSocket | null {
    return this.ws;
  }

  protected getName(): string {
    return this.name;
  }
}

/**
 * WebSocket client that can also serve data (respond to requests)
 * Used to simulate a browser that has content and can serve it to others
 */
export class ServingWsClient extends TestWsClient {
  // Local storage: hash -> data
  private localData = new Map<string, Uint8Array>();

  constructor(name = 'ServingClient') {
    super(name);
  }

  /**
   * Add data to local storage
   */
  addData(data: Uint8Array): string {
    const hash = createHash('sha256').update(data).digest('hex');
    this.localData.set(hash, data);
    console.log(`[${this.getName()}] Added data with hash:`, hash.slice(0, 16));
    return hash;
  }

  protected handleJsonMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      console.log(`[${this.getName()}] Received JSON:`, msg);

      if (msg.type === 'req') {
        // Server is forwarding a request to us - check if we have the data
        this.handleRequest(msg.id, msg.hash);
      } else if (msg.type === 'res') {
        // Response to our own request
        const pending = (this as any).pendingRequests.get(msg.id);
        if (pending && !msg.found) {
          clearTimeout(pending.timeout);
          (this as any).pendingRequests.delete(msg.id);
          pending.resolve(null);
        }
      }
    } catch (err) {
      console.log(`[${this.getName()}] Error parsing JSON:`, err);
    }
  }

  private handleRequest(id: number, hash: string): void {
    const ws = this.getWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const data = this.localData.get(hash);
    if (data) {
      console.log(`[${this.getName()}] Serving data for hash:`, hash.slice(0, 16));

      // Send found response
      ws.send(JSON.stringify({ type: 'res', id, hash, found: true }));

      // Send binary data: [4-byte LE id][data]
      const packet = new Uint8Array(4 + data.length);
      const view = new DataView(packet.buffer);
      view.setUint32(0, id, true); // little-endian
      packet.set(data, 4);
      ws.send(packet.buffer);
    } else {
      // Don't have it - stay silent, let server timeout and try next peer
      console.log(`[${this.getName()}] Don't have hash:`, hash.slice(0, 16), '(silent)');
    }
  }
}

/**
 * WebSocket client that speaks the WebRTC-style msgpack protocol:
 * [type byte][msgpack body], where body is { h: bytes, d?: bytes }
 */
export class MsgpackWsClient {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, {
    resolve: (data: Uint8Array | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private name: string;

  constructor(name = 'MsgpackWsClient') {
    this.name = name;
  }

  async connect(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        const timeout = setTimeout(() => {
          this.ws?.close();
          resolve(false);
        }, 5000);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          console.log(`[${this.name}] Connected`);
          resolve(true);
        };

        this.ws.onerror = (err) => {
          clearTimeout(timeout);
          console.log(`[${this.name}] Error:`, err);
          resolve(false);
        };

        this.ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            this.handleBinaryMessage(event.data);
          }
        };
      } catch {
        resolve(false);
      }
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    this.pendingRequests.clear();
  }

  async request(hashHex: string, timeoutMs = 5000): Promise<Uint8Array | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return null;
    }

    const hashBytes = Buffer.from(hashHex, 'hex');
    const requestBody = msgpackEncode({ h: hashBytes });
    const packet = new Uint8Array(1 + requestBody.length);
    packet[0] = 0x00; // MSG_TYPE_REQUEST
    packet.set(requestBody, 1);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(hashHex);
        console.log(`[${this.name}] Request timeout for`, hashHex.slice(0, 16));
        resolve(null);
      }, timeoutMs);

      this.pendingRequests.set(hashHex, { resolve, timeout });
      this.ws!.send(packet);
      console.log(`[${this.name}] Sent msgpack request:`, hashHex.slice(0, 16));
    });
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    const bytes = new Uint8Array(data);
    if (bytes.length < 2) return;
    const msgType = bytes[0];
    if (msgType !== 0x01) return; // MSG_TYPE_RESPONSE

    try {
      const body = msgpackDecode(bytes.slice(1)) as { h: Uint8Array; d: Uint8Array };
      const hashHex = Buffer.from(body.h).toString('hex');
      const pending = this.pendingRequests.get(hashHex);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(hashHex);
      pending.resolve(body.d);
    } catch (err) {
      console.log(`[${this.name}] Error parsing msgpack:`, err);
    }
  }
}
