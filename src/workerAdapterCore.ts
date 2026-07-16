/**
 * Worker Adapter
 *
 * Main thread adapter for communicating with the hashtree worker.
 * Provides a Promise-based API wrapping postMessage communication.
 * Handles worker crash recovery with exponential backoff.
 */

import type {
  WorkerRequest,
  WorkerResponse,
  WorkerConfig as HashtreeWorkerConfig,
  WorkerSignedEvent as SignedEvent,
  WorkerUnsignedEvent as UnsignedEvent,
  WorkerBlossomBandwidthStats as BlossomBandwidthStats,
  WorkerBlossomUploadProgress as BlossomUploadProgress,
} from '@hashtree/core';
import { generateRequestId } from '@hashtree/core';
import { getErrorMessage } from './utils/errorMessage';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
};

export type SubscriptionCallback = (event: SignedEvent) => void;
export type EoseCallback = () => void;
export type WorkerAdapterConfig = HashtreeWorkerConfig;
export type ExtendedWorkerRequest = WorkerRequest | (Record<string, unknown> & {
  type: string;
  id?: string;
});
export interface WorkerP2PProvider {
  fetch(hashHex: string, peerId?: string, htl?: number): Promise<Uint8Array | null>;
  listPeerIds(): string[] | Promise<string[]>;
}

// Worker constructor type - can be a URL object, URL string, or a Worker constructor from Vite
export type WorkerConstructor = URL | string | (new () => Worker);

export class WorkerAdapterCore {
  protected worker: Worker | null = null;
  protected workerFactory: WorkerConstructor;
  protected config: WorkerAdapterConfig;
  protected ready = false;
  protected readyPromise: Promise<void> | null = null;
  protected readyResolve: (() => void) | null = null;
  protected restartAttempts = 0;
  protected maxRestartAttempts = 10;

  // Heartbeat monitoring - detects unresponsive workers (infinite loops, deadlocks)
  protected heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  protected lastPong: number = Date.now();
  protected readonly HEARTBEAT_INTERVAL_MS = 5000;  // Send ping every 5s
  protected readonly HEARTBEAT_TIMEOUT_MS = 15000;  // 3 missed beats = unresponsive
  protected readonly DEFAULT_REQUEST_TIMEOUT_MS = 120000;
  protected readonly BLOSSOM_PUSH_REQUEST_TIMEOUT_MS = 600000;

  // Pending requests waiting for responses
  protected pendingRequests = new Map<string, PendingRequest>();

  // Nostr subscription callbacks
  protected subscriptions = new Map<string, { callback?: SubscriptionCallback; eose?: EoseCallback }>();
  protected globalEventCallback: ((event: SignedEvent) => void) | null = null;

  // Stream callbacks (for readFileStream)
  protected streamCallbacks = new Map<string, (chunk: Uint8Array, done: boolean) => void>();

  // SocialGraph version callback
  protected socialGraphVersionCallback: ((version: number) => void) | null = null;

  // Blossom upload progress callback
  protected blossomProgressCallback: ((progress: BlossomUploadProgress) => void) | null = null;
  protected blossomBandwidthCallback: ((stats: BlossomBandwidthStats) => void) | null = null;

  // Background Blossom push progress callback (for automatic pushes)
  protected blossomPushProgressCallback: ((treeName: string, current: number, total: number) => void) | null = null;
  protected blossomPushCompleteCallback: ((treeName: string, pushed: number, skipped: number, failed: number) => void) | null = null;

  // Tree root update callbacks (worker → main thread notifications)
  protected treeRootUpdateCallbacks = new Set<(npub: string, treeName: string, hash: Uint8Array, updatedAt: number, options: { key?: Uint8Array; visibility: string; labels?: string[]; encryptedKey?: string; keyId?: string; selfEncryptedKey?: string; selfEncryptedLinkKey?: string }) => void>();

  // Message queue for messages sent before worker is ready
  protected messageQueue: ExtendedWorkerRequest[] = [];

  // FIPS-backed P2P provider owned by the main thread.
  protected p2pProvider: WorkerP2PProvider | null = null;

  /**
   * Create a WorkerAdapter
   * @param workerFactory - Either a URL string or a Worker constructor from Vite's `?worker` import
   * @param config - Worker configuration
   */
  constructor(workerFactory: WorkerConstructor, config: WorkerAdapterConfig) {
    this.workerFactory = workerFactory;
    this.config = config;
  }

  /**
   * Initialize the worker and wait for it to be ready
   */
  async init(): Promise<void> {
    if (this.ready) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    this.spawnWorker();

    return this.readyPromise;
  }

  protected spawnWorker() {
    if (this.workerFactory instanceof URL) {
      // URL object - recommended approach
      this.worker = new Worker(this.workerFactory, { type: 'module' });
    } else if (typeof this.workerFactory === 'string') {
      // URL string
      this.worker = new Worker(this.workerFactory, { type: 'module' });
    } else {
      // Vite worker constructor from ?worker import
      this.worker = new this.workerFactory();
    }
    this.setupMessageHandler();
    this.setupErrorHandler();

    // Send init message
    this.worker.postMessage({
      type: 'init',
      id: generateRequestId(),
      config: this.config,
      p2pProviderEnabled: this.p2pProvider !== null,
    } as ExtendedWorkerRequest);
  }

  protected setupMessageHandler() {
    if (!this.worker) return;

    this.worker.onmessage = async (e: MessageEvent<WorkerResponse>) => {
      // The worker package emits a few deployed message variants that lag behind
      // its exported protocol union, so the adapter validates by switch cases.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg: any = e.data;

      switch (msg.type) {
        case 'ready':
          this.ready = true;
          this.restartAttempts = 0;
          this.flushMessageQueue();
          this.startHeartbeat();
          this.readyResolve?.();
          console.log('[WorkerAdapter] Worker ready');
          break;

        case 'pong':
          this.lastPong = Date.now();
          break;

        case 'error':
          if (msg.id) {
            this.rejectPending(msg.id, new Error(msg.error));
          } else {
            console.error('[WorkerAdapter] Worker error:', msg.error);
          }
          break;

        case 'result':
        case 'bool':
        case 'cid':
        case 'void':
        case 'dirListing':
        case 'peerStats':
        case 'relayStats':
        case 'storageStats':
        case 'treeRootInfo':
          this.resolvePending(msg.id, msg);
          break;

        case 'streamChunk':
          this.handleStreamChunk(msg.id, msg.chunk, msg.done);
          break;

        case 'event':
          this.handleNostrEvent(msg.subId, msg.event);
          break;

        case 'eose':
          this.handleEose(msg.subId);
          break;

        // NIP-07 requests from worker - delegate to main thread extension
        case 'signEvent':
          await this.handleSignRequest(msg.id, msg.event);
          break;

        case 'nip44Encrypt':
          await this.handleEncryptRequest(msg.id, msg.pubkey, msg.plaintext);
          break;

        case 'nip44Decrypt':
          await this.handleDecryptRequest(msg.id, msg.pubkey, msg.ciphertext);
          break;

        // SocialGraph responses
        case 'socialGraphReady':
        case 'followDistance':
        case 'isFollowingResult':
        case 'pubkeyList':
        case 'socialGraphSize':
          this.resolvePending(msg.id, msg);
          break;

        case 'socialGraphVersion':
          this.handleSocialGraphVersion(msg.version);
          break;

        // Blossom upload progress
        case 'blossomBandwidth':
          this.handleBlossomBandwidth(msg.stats);
          break;

        case 'blossomUploadProgress':
          this.handleBlossomProgress(msg.progress);
          break;

        // Background Blossom push progress
        case 'blossomPushProgress':
          this.blossomPushProgressCallback?.(msg.treeName, msg.current, msg.total);
          break;

        case 'blossomPushComplete':
          this.blossomPushCompleteCallback?.(msg.treeName, msg.pushed, msg.skipped, msg.failed);
          break;

        // Tree root updates from worker (Nostr subscriptions)
        case 'treeRootUpdate':
          this.handleTreeRootUpdate(msg as unknown as {
            npub: string;
            treeName: string;
            hash: Uint8Array;
            key?: Uint8Array;
            visibility: string;
            updatedAt: number;
            encryptedKey?: string;
            keyId?: string;
            selfEncryptedKey?: string;
            selfEncryptedLinkKey?: string;
          });
          break;

        case 'blossomPushResult':
        case 'republishResult':
          this.resolvePending(msg.id, msg);
          break;

        case 'p2pFetch':
          void this.handleP2PFetch(msg.requestId, msg.hashHex, msg.htl, msg.peerId);
          break;
        case 'p2pPeerList':
          void this.handleP2PPeerList(msg.requestId);
          break;

        default:
          console.warn('[WorkerAdapter] Unknown message type:', (msg as { type: string }).type);
      }
    };
  }

  protected setupErrorHandler() {
    if (!this.worker) return;

    this.worker.onerror = (error) => {
      // Try to get more details from the error event
      const errorEvent = error as ErrorEvent;
      console.error('[WorkerAdapter] Worker crashed:', {
        message: errorEvent.message,
        filename: errorEvent.filename,
        lineno: errorEvent.lineno,
        colno: errorEvent.colno,
        error: errorEvent.error,
      });
      this.handleWorkerCrash();
    };
  }

  protected startHeartbeat() {
    this.stopHeartbeat();
    this.lastPong = Date.now();

    this.heartbeatInterval = setInterval(() => {
      if (!this.ready || !this.worker) {
        return;
      }

      // Check if worker is unresponsive
      if (Date.now() - this.lastPong > this.HEARTBEAT_TIMEOUT_MS) {
        console.error('[WorkerAdapter] Worker unresponsive (no pong received), restarting...');
        this.handleWorkerCrash();
        return;
      }

      // Send ping
      this.worker.postMessage({ type: 'ping', id: generateRequestId() });
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  protected stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  protected async handleWorkerCrash() {
    this.stopHeartbeat();
    this.ready = false;
    this.worker?.terminate();
    this.worker = null;

    // Reject all pending requests
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('Worker crashed'));
    }
    this.pendingRequests.clear();

    // Attempt restart with exponential backoff
    if (this.restartAttempts < this.maxRestartAttempts) {
      this.restartAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.restartAttempts - 1), 30000);
      console.log(`[WorkerAdapter] Restarting worker in ${delay}ms (attempt ${this.restartAttempts})`);

      await new Promise((resolve) => setTimeout(resolve, delay));

      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
      });

      this.spawnWorker();
    } else {
      console.error('[WorkerAdapter] Max restart attempts exceeded');
    }
  }

  protected flushMessageQueue() {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      this.worker?.postMessage(msg);
    }
  }

  setP2PProvider(provider: WorkerP2PProvider | null): void {
    this.p2pProvider = provider;
    this.postMessage({
      type: 'setP2PProviderState',
      id: generateRequestId(),
      enabled: provider !== null,
    } as ExtendedWorkerRequest);
  }

  private async handleP2PFetch(
    requestId: string,
    hashHex: string,
    htl?: number,
    peerId?: string,
  ): Promise<void> {
    try {
      if (!this.p2pProvider) throw new Error('No P2P blob route configured');
      const data = await this.p2pProvider.fetch(hashHex, peerId, htl);
      const message = {
        type: 'p2pFetchResult',
        id: generateRequestId(),
        requestId,
        data: data ?? undefined,
      } as ExtendedWorkerRequest;
      if (data) {
        this.worker?.postMessage(message, [data.buffer]);
      } else {
        this.worker?.postMessage(message);
      }
    } catch (error) {
      this.worker?.postMessage({
        type: 'p2pFetchResult',
        id: generateRequestId(),
        requestId,
        error: getErrorMessage(error),
      } as ExtendedWorkerRequest);
    }
  }

  private async handleP2PPeerList(requestId: string): Promise<void> {
    try {
      const peerIds = await Promise.resolve(this.p2pProvider?.listPeerIds() ?? []);
      this.worker?.postMessage({
        type: 'p2pPeerListResult',
        id: generateRequestId(),
        requestId,
        peerIds,
      } as ExtendedWorkerRequest);
    } catch (error) {
      this.worker?.postMessage({
        type: 'p2pPeerListResult',
        id: generateRequestId(),
        requestId,
        error: getErrorMessage(error),
      } as ExtendedWorkerRequest);
    }
  }

  protected postMessage(msg: ExtendedWorkerRequest, transfer?: Transferable[]) {
    if (this.ready && this.worker) {
      if (transfer) {
        this.worker.postMessage(msg, transfer);
      } else {
        this.worker.postMessage(msg);
      }
    } else {
      this.messageQueue.push(msg);
    }
  }

  protected resolvePending(id: string, value: unknown) {
    const pending = this.pendingRequests.get(id);
    if (pending) {
      this.pendingRequests.delete(id);
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.resolve(value);
    }
  }

  protected rejectPending(id: string, error: Error) {
    const pending = this.pendingRequests.get(id);
    if (pending) {
      this.pendingRequests.delete(id);
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
  }

  protected request<T>(
    msg: ExtendedWorkerRequest,
    transfer?: Transferable[],
    timeoutMs = this.DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = (msg as { id: string }).id;

      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId,
      });
      this.postMessage(msg, transfer);
    });
  }

  // ============================================================================
  // Stream Handling
  // ============================================================================

  protected handleStreamChunk(id: string, chunk: Uint8Array, done: boolean) {
    const callback = this.streamCallbacks.get(id);
    if (callback) {
      callback(chunk, done);
      if (done) {
        this.streamCallbacks.delete(id);
      }
    }
  }

  // ============================================================================
  // Nostr Event Handling
  // ============================================================================

  protected handleNostrEvent(subId: string, event: SignedEvent) {
    // Call global event callback (for subManager.dispatchEvent pattern)
    if (this.globalEventCallback) {
      this.globalEventCallback(event);
    }
    // Also call per-subscription callback if set
    const sub = this.subscriptions.get(subId);
    if (sub?.callback) {
      sub.callback(event);
    }
  }

  protected handleEose(subId: string) {
    const sub = this.subscriptions.get(subId);
    if (sub?.eose) {
      sub.eose();
    }
  }

  // ============================================================================
  // NIP-07 Handlers (delegate to window.nostr)
  // ============================================================================

  protected async handleSignRequest(id: string, event: UnsignedEvent) {
    try {
      const nostr = (window as unknown as { nostr?: { signEvent: (e: UnsignedEvent) => Promise<SignedEvent> } }).nostr;
      if (!nostr?.signEvent) {
        throw new Error('NIP-07 extension not available');
      }

      const signed = await nostr.signEvent(event);
      this.worker?.postMessage({ type: 'signed', id, event: signed } as ExtendedWorkerRequest);
    } catch (err) {
      const error = getErrorMessage(err);
      this.worker?.postMessage({ type: 'signed', id, error } as ExtendedWorkerRequest);
    }
  }

  protected async handleEncryptRequest(id: string, pubkey: string, plaintext: string) {
    try {
      const nostr = (window as unknown as { nostr?: { nip44?: { encrypt: (pk: string, pt: string) => Promise<string> } } }).nostr;
      if (!nostr?.nip44?.encrypt) {
        throw new Error('NIP-44 encryption not available');
      }

      const ciphertext = await nostr.nip44.encrypt(pubkey, plaintext);
      this.worker?.postMessage({ type: 'encrypted', id, ciphertext } as ExtendedWorkerRequest);
    } catch (err) {
      const error = getErrorMessage(err);
      this.worker?.postMessage({ type: 'encrypted', id, error } as ExtendedWorkerRequest);
    }
  }

  protected async handleDecryptRequest(id: string, pubkey: string, ciphertext: string) {
    try {
      const nostr = (window as unknown as { nostr?: { nip44?: { decrypt: (pk: string, ct: string) => Promise<string> } } }).nostr;
      if (!nostr?.nip44?.decrypt) {
        throw new Error('NIP-44 decryption not available');
      }

      const plaintext = await nostr.nip44.decrypt(pubkey, ciphertext);
      this.worker?.postMessage({ type: 'decrypted', id, plaintext } as ExtendedWorkerRequest);
    } catch (err) {
      const error = getErrorMessage(err);
      this.worker?.postMessage({ type: 'decrypted', id, error } as ExtendedWorkerRequest);
    }
  }

  // ============================================================================
  // SocialGraph Version Handler
  // ============================================================================

  protected handleSocialGraphVersion(version: number) {
    this.socialGraphVersionCallback?.(version);
  }

  // ============================================================================
  // Blossom Progress Handler
  // ============================================================================

  protected handleBlossomProgress(progress: BlossomUploadProgress) {
    this.blossomProgressCallback?.(progress);
  }

  protected handleBlossomBandwidth(stats: BlossomBandwidthStats) {
    this.blossomBandwidthCallback?.(stats);
  }

  // ============================================================================
  // Tree Root Update Handler
  // ============================================================================

  protected handleTreeRootUpdate(msg: {
    npub: string;
    treeName: string;
    hash: Uint8Array;
    key?: Uint8Array;
    visibility: string;
    labels?: string[];
    updatedAt: number;
    encryptedKey?: string;
    keyId?: string;
    selfEncryptedKey?: string;
    selfEncryptedLinkKey?: string;
  }) {
    for (const callback of this.treeRootUpdateCallbacks) {
      callback(msg.npub, msg.treeName, msg.hash, msg.updatedAt, {
        key: msg.key,
        visibility: msg.visibility,
        labels: msg.labels,
        encryptedKey: msg.encryptedKey,
        keyId: msg.keyId,
        selfEncryptedKey: msg.selfEncryptedKey,
        selfEncryptedLinkKey: msg.selfEncryptedLinkKey,
      });
    }
  }

}
