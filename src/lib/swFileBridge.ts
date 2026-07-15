/// <reference lib="webworker" />

import type { FileRequest } from './swFileRequest';
import { createSequentialStreamWriter, type SequentialStreamWriter } from './sequentialStreamWriter';
import { lookupWorkerPort, waitForWorkerPort } from './swWorkerPort';

interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  streamWriter?: SequentialStreamWriter;
  totalSize?: number;
  headers?: Record<string, string>;
  status?: number;
  onCancel?: () => void;
}

interface FileResponseHeaders {
  status: number;
  headers: Record<string, string>;
  body: 'STREAM' | string | null;
  totalSize?: number;
}

interface SwFileBridgeOptions {
  selfScope: ServiceWorkerGlobalScope;
  portTimeoutMs: number;
  streamInactivityTimeoutMs: number;
  portRegistrationWaitMs: number;
  portRegistrationRetryWaitMs: number;
  portRegistrationIntervalMs: number;
}

export interface SwFileBridge {
  registerMessageHandler(): void;
  serveFile(
    request: FileRequest,
    clientId?: string | null,
    clientKey?: string | null,
    referrer?: string | null,
  ): Promise<Response>;
}

export function createSwFileBridge(options: SwFileBridgeOptions): SwFileBridge {
  const {
    selfScope,
    portTimeoutMs,
    streamInactivityTimeoutMs,
    portRegistrationWaitMs,
    portRegistrationRetryWaitMs,
    portRegistrationIntervalMs,
  } = options;

  const workerPorts = new Map<string, MessagePort>();
  const workerPortsByClientKey = new Map<string, MessagePort>();
  const pendingRequests = new Map<string, PendingRequest>();
  const debugByClientId = new Map<string, boolean>();
  const debugByClientKey = new Map<string, boolean>();
  let defaultWorkerPort: MessagePort | null = null;
  let defaultDebug = false;

  function resolveDebug(clientId?: string | null, clientKey?: string | null): boolean {
    if (clientKey && debugByClientKey.get(clientKey)) return true;
    if (clientId && debugByClientId.get(clientId)) return true;
    return defaultDebug;
  }

  function swLog(enabled: boolean, message: string, data?: Record<string, unknown>): void {
    if (!enabled) return;
    if (data) {
      console.log(`[SW] ${message}`, data);
    } else {
      console.log(`[SW] ${message}`);
    }
  }

  function registerMessageHandler(): void {
    selfScope.addEventListener('message', (event: ExtendableMessageEvent) => {
      if (event.data?.type === 'PING_WORKER_PORT') {
        const source = event.source as Client | null;
        const requestId = event.data?.requestId;
        const clientId = source?.id ?? event.data?.clientId;
        const clientKey = event.data?.clientKey as string | undefined;
        const hasPort = (clientKey && workerPortsByClientKey.has(clientKey))
          || (clientId && workerPorts.has(clientId))
          || !!defaultWorkerPort;
        if (requestId && source?.postMessage) {
          source.postMessage({ type: 'WORKER_PORT_PONG', requestId, ok: hasPort });
        }
        return;
      }

      if (event.data?.type !== 'REGISTER_WORKER_PORT') return;

      const port = event.data?.port ?? event.ports?.[0];
      if (!port) {
        console.warn('[SW] Worker port registration missing MessagePort');
        return;
      }
      const source = event.source as Client | null;
      const clientId = source?.id ?? event.data?.clientId;
      const clientKey = event.data?.clientKey as string | undefined;
      if (clientId) {
        workerPorts.set(clientId, port);
      } else {
        defaultWorkerPort = port;
      }
      if (clientKey) {
        workerPortsByClientKey.set(clientKey, port);
      }
      port.start?.();
      const debugEnabled = !!event.data?.debug;
      if (clientId) {
        if (debugEnabled) debugByClientId.set(clientId, true);
        else debugByClientId.delete(clientId);
      }
      if (clientKey) {
        if (debugEnabled) debugByClientKey.set(clientKey, true);
        else debugByClientKey.delete(clientKey);
      }
      if (!clientId && !clientKey && debugEnabled) {
        defaultDebug = true;
      }
      port.onmessage = handleWorkerMessage;
      console.log('[SW] Worker port registered', clientId ? `for ${clientId}` : '(default)');
      swLog(debugEnabled, 'debug:enabled', { clientId: clientId ?? null, clientKey: clientKey ?? null });
      const requestId = event.data?.requestId;
      if (requestId && source?.postMessage) {
        source.postMessage({ type: 'WORKER_PORT_READY', requestId });
      }
    });
  }

  function handleWorkerMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.requestId) return;

    const pending = pendingRequests.get(msg.requestId);
    if (!pending) return;

    switch (msg.type) {
      case 'headers': {
        pending.totalSize = msg.totalSize;
        pending.status = msg.status || 200;
        pending.headers = msg.headers || {};

        const { readable, writable } = new TransformStream<Uint8Array>();
        const writer = writable.getWriter();

        pending.streamWriter = createSequentialStreamWriter({
          writer,
          inactivityTimeoutMs: streamInactivityTimeoutMs,
          timeoutMessage: 'Timed out waiting for file data',
          onTimeout: (error) => {
            pending.onCancel?.();
            console.warn('[SW] File stream timed out:', error.message);
          },
          onError: (error) => {
            pending.onCancel?.();
            console.warn('[SW] File stream failed:', error);
          },
          onClosed: () => {
            pendingRequests.delete(msg.requestId);
          },
        });

        const headers = new Headers(pending.headers);
        headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
        headers.set('Access-Control-Allow-Origin', '*');

        pending.resolve(new Response(readable, {
          status: pending.status,
          headers,
        }));
        break;
      }

      case 'chunk': {
        if (pending.streamWriter && msg.data) {
          const chunk = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
          pending.streamWriter.enqueue(chunk);
        }
        break;
      }

      case 'done': {
        pending.streamWriter?.close();
        if (!pending.streamWriter) {
          pendingRequests.delete(msg.requestId);
        }
        break;
      }

      case 'error': {
        if (pending.streamWriter) {
          pending.streamWriter.abort(new Error(msg.message || 'Worker error'));
          pendingRequests.delete(msg.requestId);
          break;
        }
        const headers = new Headers({
          'Content-Type': 'text/plain; charset=utf-8',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
          'Access-Control-Allow-Origin': '*',
        });
        pending.resolve(new Response(msg.message || 'Worker error', {
          status: typeof msg.status === 'number' ? msg.status : 500,
          headers,
        }));
        pendingRequests.delete(msg.requestId);
        break;
      }
    }
  }

  function serveFileViaWorker(request: FileRequest, port: MessagePort, debug = false): Promise<Response> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingRequests.get(request.requestId);
        if (!pending) return;
        pending.streamWriter?.dispose();
        pendingRequests.delete(request.requestId);
        swLog(debug, 'worker:timeout', { requestId: request.requestId });
        pending.onCancel?.();
        reject(new Error('Timeout waiting for worker response'));
      }, portTimeoutMs);

      pendingRequests.set(request.requestId, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        onCancel: () => {
          try {
            port.postMessage({ type: 'cancelMedia', requestId: request.requestId });
          } catch {
            // The worker may already be gone; stream cleanup still matters.
          }
        },
      });

      swLog(debug, 'worker:request', {
        requestId: request.requestId,
        npub: request.npub ?? null,
        nhash: request.nhash ?? null,
        treeName: request.treeName ?? null,
        path: request.path,
        start: request.start,
        end: request.end ?? null,
      });
      port.postMessage(request);
    });
  }

  async function getWorkerPortForClient(clientId?: string | null): Promise<MessagePort | null> {
    if (clientId && workerPorts.has(clientId)) {
      return workerPorts.get(clientId) || null;
    }
    if (clientId) {
      const client = await selfScope.clients.get(clientId).catch(() => null);
      if (!client) {
        workerPorts.delete(clientId);
      }
    }
    return defaultWorkerPort;
  }

  function lookupRegisteredWorkerPort(
    clientId?: string | null,
    clientKey?: string | null,
  ): MessagePort | null {
    return lookupWorkerPort(
      {
        byClientId: workerPorts,
        byClientKey: workerPortsByClientKey,
        defaultPort: defaultWorkerPort,
      },
      clientId,
      clientKey,
    );
  }

  function dropWorkerPortRegistration(
    port: MessagePort,
    clientId?: string | null,
    clientKey?: string | null,
  ): void {
    if (clientKey && workerPortsByClientKey.get(clientKey) === port) {
      workerPortsByClientKey.delete(clientKey);
    }
    if (clientId && workerPorts.get(clientId) === port) {
      workerPorts.delete(clientId);
    }
    if (defaultWorkerPort === port) {
      defaultWorkerPort = null;
    }
  }

  async function requestWorkerPortReconnect(
    clientId?: string | null,
    clientKey?: string | null,
    debug = false,
  ): Promise<void> {
    try {
      const message = { type: 'REQUEST_WORKER_PORT_RECONNECT', clientKey: clientKey ?? null };
      let posted = 0;
      if (clientId) {
        const client = await selfScope.clients.get(clientId).catch(() => null);
        if (client) {
          client.postMessage(message);
          posted += 1;
        }
      }
      if (posted === 0) {
        const clients = await selfScope.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clients) {
          client.postMessage(message);
          posted += 1;
        }
      }
      swLog(debug, 'request:reconnect-broadcast', {
        clientId: clientId ?? null,
        clientKey: clientKey ?? null,
        posted,
      });
    } catch (error) {
      console.warn('[SW] Failed to broadcast worker port reconnect:', error);
    }
  }

  function normalizeClientUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return url.split('#')[0] || url;
    }
  }

  async function resolveClientId(clientId?: string | null, referrer?: string | null): Promise<string | null> {
    if (clientId) return clientId;
    if (!referrer) return null;

    const target = normalizeClientUrl(referrer);
    const clients = await selfScope.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const match = clients.find(client => normalizeClientUrl(client.url) === target);
    return match?.id ?? null;
  }

  async function serveFile(
    request: FileRequest,
    clientId?: string | null,
    clientKey?: string | null,
    referrer?: string | null,
  ): Promise<Response> {
    const resolvedClientId = await resolveClientId(clientId, referrer);
    let port = lookupRegisteredWorkerPort(resolvedClientId, clientKey)
      ?? await getWorkerPortForClient(resolvedClientId);
    const debug = resolveDebug(resolvedClientId ?? clientId ?? null, clientKey);
    swLog(debug, 'request:start', {
      requestId: request.requestId,
      npub: request.npub ?? null,
      nhash: request.nhash ?? null,
      treeName: request.treeName ?? null,
      path: request.path,
      start: request.start,
      end: request.end ?? null,
      clientId: resolvedClientId ?? clientId ?? null,
      clientKey: clientKey ?? null,
    });

    if (!port) {
      swLog(debug, 'request:wait-for-port', {
        requestId: request.requestId,
        clientId: resolvedClientId ?? clientId ?? null,
        clientKey: clientKey ?? null,
      });
      await requestWorkerPortReconnect(resolvedClientId ?? clientId, clientKey, debug);
      port = await waitForWorkerPort(
        () => lookupRegisteredWorkerPort(resolvedClientId, clientKey),
        {
          timeoutMs: portRegistrationWaitMs,
          intervalMs: portRegistrationIntervalMs,
        },
      );
    }

    if (port) {
      try {
        return await serveFileViaWorker(request, port, debug);
      } catch (error) {
        dropWorkerPortRegistration(port, resolvedClientId, clientKey);
        console.warn('[SW] Worker path failed, falling back to clients:', error);
        swLog(debug, 'request:worker-failed', {
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        });

        await requestWorkerPortReconnect(resolvedClientId ?? clientId, clientKey, debug);
        const retriedPort = await waitForWorkerPort(
          () => lookupRegisteredWorkerPort(resolvedClientId, clientKey),
          {
            timeoutMs: portRegistrationRetryWaitMs,
            intervalMs: portRegistrationIntervalMs,
          },
        );
        if (retriedPort) {
          swLog(debug, 'request:worker-retry', {
            requestId: request.requestId,
            clientId: resolvedClientId ?? clientId ?? null,
            clientKey: clientKey ?? null,
          });
          return await serveFileViaWorker(request, retriedPort, debug);
        }
      }
    } else {
      swLog(debug, 'request:no-port', { requestId: request.requestId });
    }

    return serveFileViaClients(request, debug);
  }

  async function serveFileViaClients(request: FileRequest, debug = false): Promise<Response> {
    const clientList = await selfScope.clients.matchAll({ type: 'window', includeUncontrolled: true });

    if (clientList.length === 0) {
      swLog(debug, 'clients:none', { requestId: request.requestId });
      return new Response('No clients available', { status: 503 });
    }

    const [data, port] = await new Promise<[FileResponseHeaders, MessagePort]>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          swLog(debug, 'clients:timeout', { requestId: request.requestId });
          reject(new Error('Timeout waiting for client response'));
        }
      }, portTimeoutMs);

      for (const client of clientList) {
        const messageChannel = new MessageChannel();
        const { port1, port2 } = messageChannel;

        port1.onmessage = ({ data }) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve([data, port1]);
          }
        };

        client.postMessage(request, [port2]);
      }
    });

    const cleanup = () => {
      port.postMessage(false);
      port.onmessage = null;
    };

    if (data.body !== 'STREAM') {
      cleanup();
      const headers = new Headers(data.headers);
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(data.body, {
        status: data.status,
        headers,
      });
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let streamClosed = false;

    const stream = new ReadableStream({
      pull(controller) {
        return new Promise<void>((resolve) => {
          if (streamClosed) {
            resolve();
            return;
          }

          port.onmessage = ({ data: chunk }) => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
            if (chunk) {
              controller.enqueue(new Uint8Array(chunk));
            } else {
              streamClosed = true;
              cleanup();
              controller.close();
            }
            resolve();
          };

          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }

          timeoutHandle = setTimeout(() => {
            if (!streamClosed) {
              streamClosed = true;
              cleanup();
              controller.close();
            }
            resolve();
          }, portTimeoutMs);

          port.postMessage(true);
        });
      },
      cancel() {
        streamClosed = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        cleanup();
      },
    });

    const headers = new Headers(data.headers);
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(stream, {
      status: data.status,
      headers,
    });
  }

  return {
    registerMessageHandler,
    serveFile,
  };
}
