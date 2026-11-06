import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { matchFilters } from 'nostr-tools';
import ts from 'typescript';

// Exercise the runtime's already locked NEG implementation instead of adding
// another protocol implementation or test dependency.
const appDir = fileURLToPath(new URL('..', import.meta.url));
const pubsubDir = await realpath(path.join(appDir, 'node_modules/nostr-pubsub'));
const reconcileDir = path.resolve(pubsubDir, '..', 'nostr-pubsub-reconcile');
const metadata = JSON.parse(await readFile(path.join(reconcileDir, 'package.json'), 'utf8'));
const { Reconciliation } = await import(pathToFileURL(path.resolve(reconcileDir, metadata.exports['.'].import)).href);

const mime = new Map([
  ['.html', 'text/html'], ['.js', 'application/javascript'], ['.css', 'text/css'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.ico', 'image/x-icon'],
  ['.json', 'application/json'], ['.webmanifest', 'application/manifest+json'],
  ['.wasm', 'application/wasm'],
]);

export async function startGraphBrowserFixture(distDir) {
  const events = new Map();
  const frames = [];
  const channels = new Map();
  const errors = [];
  let deferHistory = false;
  let workerRelayScope;
  const server = createServer(async (request, response) => {
    if (request.headers.accept === 'application/nostr+json') {
      response.writeHead(200, { 'content-type': 'application/nostr+json' });
      response.end(JSON.stringify({ supported_nips: [77] }));
      return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/blank') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Drive graph browser fixture</title>');
      return;
    }
    try {
      const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
      const file = path.resolve(distDir, relative);
      if (!file.startsWith(path.resolve(distDir) + path.sep)) throw new Error('Outside build output');
      let body = await readFile(file);
      if (workerRelayScope && /^hashtree\.worker-.*\.js$/.test(path.basename(file))) {
        const module = ts.createSourceFile('worker.js', body.toString(), ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
        if (module.statements.some(statement => ts.isImportDeclaration(statement)
          || (ts.isExportDeclaration(statement) && statement.moduleSpecifier))) {
          errors.push('Worker loopback requires a self-contained bundle before WebSocket capture');
          response.writeHead(500); response.end('Worker fixture cannot safely prefix static imports'); return;
        }
        const shim = `if (typeof document === 'undefined' && !globalThis.__driveSocketFixture) {
          globalThis.__driveSocketFixture = true;
          const Original = globalThis.WebSocket, scope = ${JSON.stringify(workerRelayScope)};
          globalThis.WebSocket = class extends Original {
            constructor(url, protocols) {
              const requested = String(url), normalized = requested.trim().replace(/\\/+$/, '');
              const mapped = scope.relays.includes(normalized)
                ? scope.local + '?configured=' + encodeURIComponent(requested) : requested;
              super(mapped, protocols);
              globalThis.postMessage({ type: '__driveFixtureSocket', requested, mapped: mapped !== requested });
            }
          };
          globalThis.postMessage({ type: '__driveFixtureInstalled' });
        }\n`;
        body = Buffer.concat([Buffer.from(shim), body]);
      }
      response.writeHead(200, {
        'content-type': mime.get(path.extname(file)) ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'credentialless',
      });
      response.end(body);
    } catch {
      response.writeHead(404); response.end('not found');
    }
  });
  const relay = new WebSocketServer({ server });
  relay.on('connection', (socket, request) => {
    const state = { path: request.url, subscriptions: new Map(), sessions: new Map(), catchup: false };
    channels.set(socket, state);
    let tail = Promise.resolve();
    socket.on('message', data => {
      tail = tail.then(async () => {
        const frame = JSON.parse(data.toString());
        const [type, id] = frame;
        if (frames.length >= 4096) throw new Error('Fixture frame bound exceeded');
        if (frames.length === 0 || !state.seen) {
          state.catchup = type === 'NEG-OPEN' && frame[2]?.kinds?.includes(3) && frame[2]?.kinds?.includes(10000);
          state.seen = true;
        }
        frames.push({ type, id: typeof id === 'string' ? id : undefined, path: state.path, filter: type === 'NEG-OPEN' ? frame[2] : undefined,
          filters: type === 'REQ' ? frame.slice(2) : undefined, catchup: state.catchup });
        if (type === 'NEG-OPEN' || type === 'NEG-MSG') {
          if (state.path.includes('unsupported')) {
            socket.send(JSON.stringify(['NEG-ERR', id, 'unsupported']));
            return;
          }
          if (type === 'NEG-OPEN') {
            const filter = frame[2];
            if (!filter.authors?.length || filter.authors.length > 256) throw new Error('Graph NEG author scope is not bounded');
            if (state.sessions.size >= 16) throw new Error('Fixture session bound exceeded');
            const matching = [...events.values()].filter(event => matchFilters([filter], event));
            state.sessions.set(id, new Reconciliation(matching.map(event => ({
              timestamp: BigInt(event.created_at), id: Uint8Array.from(Buffer.from(event.id, 'hex')),
            })), { since: BigInt(filter.since ?? 0), until: BigInt(filter.until ?? '18446744073709551614') }, { maxFrameBytes: 16384 }));
          }
          const session = state.sessions.get(id);
          if (!session) throw new Error('Unknown NEG session');
          const reply = await session.respond(Uint8Array.from(Buffer.from(frame[type === 'NEG-OPEN' ? 3 : 2], 'hex')));
          if (socket.readyState === 1) socket.send(JSON.stringify(['NEG-MSG', id, Buffer.from(reply).toString('hex')]));
        } else if (type === 'NEG-CLOSE') {
          state.sessions.delete(id);
        } else if (type === 'REQ') {
          state.subscriptions.set(id, frame.slice(2));
          if (deferHistory && !state.catchup && frame.slice(2).some(filter => filter.kinds?.includes(3) && filter.kinds?.includes(10000))) {
            if (!state.pendingHistory) state.pendingHistory = new Set();
            state.pendingHistory.add(id);
            return;
          }
          for (const event of events.values()) if (matchFilters(frame.slice(2), event)) socket.send(JSON.stringify(['EVENT', id, event]));
          socket.send(JSON.stringify(['EOSE', id]));
        } else if (type === 'CLOSE') {
          state.subscriptions.delete(id);
        } else if (type === 'EVENT') {
          socket.send(JSON.stringify(['OK', frame[1].id, true, '']));
        }
      }).catch(error => { errors.push(error.message); socket.close(1011, 'fixture protocol error'); });
    });
    socket.on('close', () => {
      state.closed = true;
      frames.push({ type: 'SOCKET-CLOSE', path: state.path, catchup: state.catchup });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, frames, errors,
    relayUrl: `${origin.replace('http:', 'ws:')}/relay`,
    setWorkerRelayScope(relays) {
      workerRelayScope = relays === null ? undefined : {
        relays: relays.map(relay => relay.trim().replace(/\/+$/, '')),
        local: `${origin.replace('http:', 'ws:')}/relay`,
      };
    },
    setEvents(next) { events.clear(); for (const event of next) events.set(event.id, event); },
    deferLiveHistory() { deferHistory = true; },
    releaseLiveHistory() {
      deferHistory = false;
      for (const [socket, state] of channels) if (socket.readyState === 1) {
        for (const id of state.pendingHistory ?? []) {
          const filters = state.subscriptions.get(id);
          if (!filters) continue;
          for (const event of events.values()) if (matchFilters(filters, event)) socket.send(JSON.stringify(['EVENT', id, event]));
          socket.send(JSON.stringify(['EOSE', id]));
        }
        state.pendingHistory?.clear();
      }
    },
    liveListeners(author) {
      return [...channels].flatMap(([socket, state]) => socket.readyState === 1 && !state.catchup
        ? [...state.subscriptions].filter(([, filters]) => filters.some(filter => !filter.ids && filter.authors?.includes(author)
          && filter.kinds?.includes(3) && filter.kinds?.includes(10000))).map(([id]) => ({ socket, id })) : []);
    },
    broadcast(event) {
      events.set(event.id, event);
      for (const [socket, state] of channels) if (socket.readyState === 1 && !state.catchup) {
        for (const [id, filters] of state.subscriptions) if (matchFilters(filters, event)) socket.send(JSON.stringify(['EVENT', id, event]));
      }
    },
    async close() {
      for (const socket of relay.clients) socket.terminate();
      await new Promise(resolve => relay.close(resolve));
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    },
  };
}

// Playwright keeps the configured browser URL observable while only this owned
// relay is contacted. Real Nostr frames and NEG exchanges cross the bridge.
export function bridgeBrowserRelay(route, relayUrl) {
  const socket = new WebSocket(relayUrl);
  const pending = [];
  route.onMessage(message => {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
    else if (socket.readyState === WebSocket.CONNECTING && pending.length < 128) pending.push(message);
    else route.close({ code: 1011, reason: 'Fixture relay unavailable' });
  });
  socket.on('open', () => { for (const message of pending.splice(0)) socket.send(message); });
  socket.on('message', (message, binary) => route.send(binary ? message : message.toString()));
  socket.on('error', () => route.close({ code: 1011, reason: 'Fixture relay unavailable' }));
  socket.on('close', () => route.close({ code: 1000, reason: 'Fixture relay closed' }));
  route.onClose(() => socket.close());
}

export async function seedBrowserDatabase(page, name, store, keyPath, rows, version = 1) {
  await page.evaluate(async ({ name, store, keyPath, rows, version }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => request.result.createObjectStore(store, { keyPath });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        for (const row of rows) tx.objectStore(store).put(row);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, { name, store, keyPath, rows, version });
}

export async function retainedGraphBytes(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('hashtree-social-graph');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('socialGraph').objectStore('socialGraph').get('main');
        request.onsuccess = () => resolve([...request.result.data]); request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}

export async function workerRequest(page, payload) {
  return page.evaluate(payload => new Promise((resolve, reject) => {
    const worker = window.policyWorker, id = crypto.randomUUID();
    const timer = setTimeout(() => { worker.removeEventListener('message', listener); reject(new Error(`No response to ${payload.type}`)); }, 10000);
    const listener = event => {
      if (event.data.id !== id && !(payload.type === 'init' && event.data.type === 'ready')) return;
      clearTimeout(timer); worker.removeEventListener('message', listener);
      if (event.data.type === 'error') reject(new Error(event.data.error)); else resolve(event.data);
    };
    worker.addEventListener('message', listener); worker.postMessage({ ...payload, id });
  }), payload);
}
