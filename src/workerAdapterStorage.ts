import { generateRequestId, type CID, type WorkerDirEntry as DirEntry } from '@hashtree/core';
import { WorkerAdapterBlossom } from './workerAdapterBlossom';

export class WorkerAdapterStorage extends WorkerAdapterBlossom {
  // Public API - Store Operations
  // ============================================================================

  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    const id = generateRequestId();
    const response = await this.request<{ data?: Uint8Array; error?: string }>({
      type: 'get',
      id,
      hash,
    });
    if (response.error) throw new Error(response.error);
    return response.data || null;
  }

  async put(hash: Uint8Array, data: Uint8Array): Promise<boolean> {
    const id = generateRequestId();
    const response = await this.request<{ value: boolean; error?: string }>(
      { type: 'put', id, hash, data },
      [data.buffer]  // Transfer ownership
    );
    if (response.error) throw new Error(response.error);
    return response.value;
  }

  async has(hash: Uint8Array): Promise<boolean> {
    const id = generateRequestId();
    const response = await this.request<{ value: boolean; error?: string }>({
      type: 'has',
      id,
      hash,
    });
    if (response.error) throw new Error(response.error);
    return response.value;
  }

  async delete(hash: Uint8Array): Promise<boolean> {
    const id = generateRequestId();
    const response = await this.request<{ value: boolean; error?: string }>({
      type: 'delete',
      id,
      hash,
    });
    if (response.error) throw new Error(response.error);
    return response.value;
  }

  // ============================================================================
  // Public API - Tree Operations
  // ============================================================================

  async readFile(cid: CID): Promise<Uint8Array | null> {
    const id = generateRequestId();
    const response = await this.request<{ data?: Uint8Array; error?: string }>({
      type: 'readFile',
      id,
      cid,
    });
    if (response.error) throw new Error(response.error);
    return response.data || null;
  }

  async readFileRange(cid: CID, start: number, end?: number): Promise<Uint8Array | null> {
    const id = generateRequestId();
    const response = await this.request<{ data?: Uint8Array; error?: string }>({
      type: 'readFileRange',
      id,
      cid,
      start,
      end,
    });
    if (response.error) throw new Error(response.error);
    return response.data || null;
  }

  async *readFileStream(cid: CID): AsyncGenerator<Uint8Array> {
    const id = generateRequestId();
    const chunks: Uint8Array[] = [];
    let done = false;
    let resolveNext: (() => void) | null = null;

    this.streamCallbacks.set(id, (chunk, isDone) => {
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      done = isDone;
      resolveNext?.();
    });

    this.postMessage({ type: 'readFileStream', id, cid });

    while (!done) {
      if (chunks.length > 0) {
        yield chunks.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    }

    // Yield any remaining chunks
    while (chunks.length > 0) {
      yield chunks.shift()!;
    }
  }

  async writeFile(parentCid: CID | null, path: string, data: Uint8Array): Promise<CID> {
    const id = generateRequestId();
    const response = await this.request<{ cid?: CID; error?: string }>(
      { type: 'writeFile', id, parentCid, path, data },
      [data.buffer]
    );
    if (response.error) throw new Error(response.error);
    if (!response.cid) throw new Error('No CID returned');
    return response.cid;
  }

  async deleteFile(parentCid: CID, path: string): Promise<CID> {
    const id = generateRequestId();
    const response = await this.request<{ cid?: CID; error?: string }>({
      type: 'deleteFile',
      id,
      parentCid,
      path,
    });
    if (response.error) throw new Error(response.error);
    if (!response.cid) throw new Error('No CID returned');
    return response.cid;
  }

  async listDir(cid: CID): Promise<DirEntry[]> {
    const id = generateRequestId();
    const response = await this.request<{ entries?: DirEntry[]; error?: string }>({
      type: 'listDir',
      id,
      cid,
    });
    if (response.error) throw new Error(response.error);
    return response.entries || [];
  }

  async resolveRoot(npub: string, path?: string): Promise<CID | null> {
    const id = generateRequestId();
    const response = await this.request<{ cid?: CID; error?: string }>({
      type: 'resolveRoot',
      id,
      npub,
      path,
    });
    if (response.error) throw new Error(response.error);
    return response.cid || null;
  }

  // ============================================================================
}
