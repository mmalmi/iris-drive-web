import { describe, expect, it, vi } from 'vitest';
import { ConfirmedUploads, uploadOnceFetch, type ConfirmedUploadStorage } from '../src/workers/uploadOnce';

const SERVER = 'https://files.example';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function upload(send: typeof fetch, hash: string, server = SERVER): Promise<Response> {
  return send(`${server}/upload`, { method: 'PUT', headers: { 'X-SHA-256': hash }, body: 'block' });
}

function stored(hash: string, status = 201): Response {
  return new Response(JSON.stringify({ sha256: hash }), { status });
}

describe('sending each block to a file server once', () => {
  it('sends a block the first time and answers a repeat without the server', async () => {
    const real = vi.fn(async () => stored(HASH_A));
    const send = uploadOnceFetch(real as unknown as typeof fetch, new ConfirmedUploads());

    expect((await upload(send, HASH_A)).status).toBe(201);
    const repeat = await upload(send, HASH_A);

    expect(real).toHaveBeenCalledTimes(1);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ sha256: HASH_A });
  });

  it('keeps blocks and servers apart', async () => {
    const real = vi.fn(async (_url: string, init: RequestInit) => stored(new Headers(init.headers).get('x-sha-256')!));
    const send = uploadOnceFetch(real as unknown as typeof fetch, new ConfirmedUploads());

    await upload(send, HASH_A);
    await upload(send, HASH_B);
    await upload(send, HASH_A, 'https://other.example');

    expect(real).toHaveBeenCalledTimes(3);
  });

  it('sends a block again after an upload that failed or stored something else', async () => {
    const answers = [new Response('busy', { status: 503 }), stored(HASH_B), stored(HASH_A)];
    const real = vi.fn(async () => answers.shift()!);
    const send = uploadOnceFetch(real as unknown as typeof fetch, new ConfirmedUploads());

    await upload(send, HASH_A);
    await upload(send, HASH_A);
    await upload(send, HASH_A);
    await upload(send, HASH_A);

    expect(real).toHaveBeenCalledTimes(3);
  });

  it('sends a block once when two uploads of it start together', async () => {
    let finish: (response: Response) => void = () => {};
    const real = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const send = uploadOnceFetch(real as unknown as typeof fetch, new ConfirmedUploads());

    const first = upload(send, HASH_A);
    const second = upload(send, HASH_A);
    await Promise.resolve();
    finish(stored(HASH_A));

    expect((await first).status).toBe(201);
    expect((await second).status).toBe(200);
    expect(real).toHaveBeenCalledTimes(1);
  });

  it('trusts a confirmation for a day and forgets a block that was deleted', async () => {
    let now = 1_000_000;
    const real = vi.fn(async () => stored(HASH_A));
    const send = uploadOnceFetch(real as unknown as typeof fetch, new ConfirmedUploads(null, () => now));

    await upload(send, HASH_A);
    now += 23 * 60 * 60 * 1000;
    await upload(send, HASH_A);
    expect(real).toHaveBeenCalledTimes(1);

    now += 2 * 60 * 60 * 1000;
    await upload(send, HASH_A);
    expect(real).toHaveBeenCalledTimes(2);

    await send(`${SERVER}/${HASH_A}.bin`, { method: 'DELETE' });
    await upload(send, HASH_A);
    expect(real).toHaveBeenCalledTimes(4);
  });

  it('remembers confirmations across a reload and leaves other requests alone', async () => {
    const saved = new Map<string, number>([[`${SERVER}|${HASH_A}`, Date.now() - 1000], [`${SERVER}|${HASH_B}`, 5]]);
    const storage: ConfirmedUploadStorage = {
      load: async () => [...saved],
      save: async (entries) => { for (const [key, time] of entries) saved.set(key, time); },
      remove: async (keys) => { for (const key of keys) saved.delete(key); },
    };
    const real = vi.fn(async () => stored(HASH_B));
    const uploads = new ConfirmedUploads(storage);
    const send = uploadOnceFetch(real as unknown as typeof fetch, uploads);
    await vi.waitFor(() => expect(saved.has(`${SERVER}|${HASH_B}`)).toBe(false));

    await upload(send, HASH_A);
    expect(real).not.toHaveBeenCalled();

    await upload(send, HASH_B);
    await send(`${SERVER}/${HASH_A}.bin`);
    await send(`${SERVER}/upload`, { method: 'PUT', body: 'no hash header' });
    expect(real).toHaveBeenCalledTimes(3);
  });
});
