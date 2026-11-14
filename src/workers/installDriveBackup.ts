/**
 * Runs backups in the storage worker, beside the library's own handler.
 *
 * Parts are read through the library's own `get`, so a part this device
 * does not hold comes from wherever the Drive keeps it, as for any read. The
 * worker answers the page through `postMessage`; replies to the questions
 * asked here are taken out of that stream before they reach the page.
 *
 * Uploads are signed with the account's key as the worker has it, or, for an
 * account in a browser extension, by the page, as the library itself does.
 */
import { finalizeEvent } from 'nostr-tools';
import { HashTree, toHex, type CID, type TreeNode } from '@hashtree/core';
import { confirmedUploads } from './installUploadOnce';
import {
  backUp,
  checkBackup,
  folderPlace,
  serverPlace,
  type DriveBackupRequest,
  type DriveBackupResult,
  type DriveParts,
  type UnsignedAuth,
} from './driveBackup';

interface Message { type?: string; id?: string; [field: string]: unknown }
interface WorkerScope {
  postMessage(message: unknown, options?: unknown): void;
  onmessage: ((event: MessageEvent) => unknown) | null;
  addEventListener(type: 'message', listener: (event: MessageEvent<Message>) => void): void;
}

const scope = self as unknown as WorkerScope;
const post = scope.postMessage.bind(scope);
const replies = new Map<string, (reply: Message) => void>();
const signatures = new Map<string, (reply: Message) => void>();
const running = new Map<string, AbortController>();
let secretKey: Uint8Array | null = null;
let sequence = 0;
const PROGRESS_EVERY_MS = 150;
const MAX_REMEMBERED_NODES = 200_000;

function keyFromHex(hex: unknown): Uint8Array | null {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  return new Uint8Array(hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));
}

// Replies to the library's handler, asked from here, stay here.
scope.postMessage = (message: unknown, options?: unknown) => {
  const id = (message as Message | null)?.id;
  const reply = typeof id === 'string' ? replies.get(id) : undefined;
  if (reply) {
    replies.delete(id!);
    reply(message as Message);
    return;
  }
  post(message, options);
};

/** Asks the library's own handler, as the page would. */
function ask(message: Message): Promise<Message> {
  const id = `drive-backup-${++sequence}`;
  return new Promise((resolve, reject) => {
    const handler = scope.onmessage;
    if (!handler) {
      reject(new Error('Drive storage is not ready yet'));
      return;
    }
    replies.set(id, (reply) => (reply.error ? reject(new Error(String(reply.error))) : resolve(reply)));
    void Promise.resolve(handler.call(scope, new MessageEvent('message', { data: { ...message, id } }))).catch((error) => {
      replies.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function getPart(hash: Uint8Array): Promise<Uint8Array | null> {
  const reply = await ask({ type: 'get', hash });
  return (reply.data as Uint8Array | undefined) ?? null;
}

const missing = new Set<string>();
const tree = new HashTree({
  store: {
    async get(hash) {
      const bytes = await getPart(hash);
      if (!bytes) missing.add(toHex(hash));
      return bytes;
    },
    async put() { return false; },
    async has(hash) { return (await getPart(hash)) !== null; },
    async delete() { return false; },
  },
});

// A part's hash fixes what it holds, so what was learned about it stays true.
const nodes = new Map<string, TreeNode | null>();
const driveParts: DriveParts = {
  async node(cid: CID) {
    const hex = toHex(cid.hash);
    if (nodes.has(hex)) return nodes.get(hex)!;
    missing.delete(hex);
    const node = await tree.getTreeNode(cid);
    if (!node && missing.has(hex)) throw new Error('Some parts of your Drive could not be found');
    if (nodes.size >= MAX_REMEMBERED_NODES) nodes.clear();
    nodes.set(hex, node);
    return node;
  },
  bytes: getPart,
};

function sign(event: UnsignedAuth): Promise<unknown> {
  if (secretKey) return Promise.resolve(finalizeEvent(event, secretKey));
  const id = `drive-backup-sign-${++sequence}`;
  return new Promise((resolve, reject) => {
    signatures.set(id, (reply) => (reply.error ? reject(new Error(String(reply.error))) : resolve(reply.event)));
    post({ type: 'signEvent', id, event });
  });
}

async function run(id: string, request: DriveBackupRequest): Promise<void> {
  running.get(request.target)?.abort();
  const controller = new AbortController();
  running.set(request.target, controller);
  const root: CID = request.root.key ? { hash: request.root.hash, key: request.root.key } : { hash: request.root.hash };
  let result: DriveBackupResult;
  try {
    const place = request.place.kind === 'server'
      ? serverPlace(request.place.url, (input, init) => globalThis.fetch(input, init), sign, confirmedUploads, request.fresh)
      : folderPlace(request.place.handle);
    if (request.job === 'check') {
      result = { check: await checkBackup(root, driveParts, place, { signal: controller.signal }) };
    } else {
      let shownAt = 0;
      const backup = await backUp(root, driveParts, place, {
        signal: controller.signal,
        onProgress(done, total) {
          const now = Date.now();
          if (done !== 0 && done !== total && now - shownAt < PROGRESS_EVERY_MS) return;
          shownAt = now;
          post({ type: 'driveBackupProgress', target: request.target, done, total });
        },
      });
      result = { backup };
    }
  } catch (error) {
    result = { error: controller.signal.aborted ? 'stopped' : error instanceof Error ? error.message : String(error) };
  } finally {
    if (running.get(request.target) === controller) running.delete(request.target);
  }
  post({ type: 'result', id, ...result });
}

scope.addEventListener('message', (event) => {
  const message = event.data;
  switch (message?.type) {
    case 'init':
      secretKey = keyFromHex((message.config as { nsec?: unknown } | undefined)?.nsec);
      return;
    case 'setIdentity':
      secretKey = keyFromHex(message.nsec);
      return;
    case 'signed': {
      const reply = typeof message.id === 'string' ? signatures.get(message.id) : undefined;
      if (!reply) return;
      event.stopImmediatePropagation();
      signatures.delete(message.id!);
      reply(message);
      return;
    }
    case 'driveBackup':
      event.stopImmediatePropagation();
      void run(String(message.id), message.request as DriveBackupRequest);
      return;
    case 'driveBackupStop':
      event.stopImmediatePropagation();
      running.get(String(message.target))?.abort();
      return;
  }
});
