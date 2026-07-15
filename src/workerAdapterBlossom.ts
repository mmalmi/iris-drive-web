import { generateRequestId } from '@hashtree/core';
import type {
  WorkerBlossomBandwidthStats as BlossomBandwidthStats,
  WorkerBlossomUploadProgress as BlossomUploadProgress,
} from '@hashtree/core';
import { WorkerAdapterCore, type ExtendedWorkerRequest } from './workerAdapterCore';

export class WorkerAdapterBlossom extends WorkerAdapterCore {
  // Public API - Blossom Upload Sessions
  // ============================================================================

  /**
   * Set callback for blossom upload progress updates
   */
  onBlossomProgress(callback: (progress: BlossomUploadProgress) => void): void {
    this.blossomProgressCallback = callback;
  }

  onBlossomBandwidth(callback: (stats: BlossomBandwidthStats) => void): void {
    this.blossomBandwidthCallback = callback;
  }

  /**
   * Set callback for background Blossom push progress (automatic pushes)
   */
  onBlossomPushProgress(callback: (treeName: string, current: number, total: number) => void): void {
    this.blossomPushProgressCallback = callback;
  }

  /**
   * Set callback for background Blossom push completion
   */
  onBlossomPushComplete(callback: (treeName: string, pushed: number, skipped: number, failed: number) => void): void {
    this.blossomPushCompleteCallback = callback;
  }

  /**
   * Subscribe to tree root updates from worker (Nostr subscription notifications).
   * Returns an unsubscribe function.
   */
  onTreeRootUpdate(
    callback: (npub: string, treeName: string, hash: Uint8Array, updatedAt: number, options: { key?: Uint8Array; visibility: string; labels?: string[]; encryptedKey?: string; keyId?: string; selfEncryptedKey?: string; selfEncryptedLinkKey?: string }) => void
  ): () => void {
    this.treeRootUpdateCallbacks.add(callback);
    return () => this.treeRootUpdateCallbacks.delete(callback);
  }

  /**
   * Start a blossom upload session for progress tracking
   * @param sessionId - Unique session identifier
   * @param totalChunks - Total number of chunks to upload
   */
  async startBlossomSession(sessionId: string, totalChunks: number): Promise<void> {
    const id = generateRequestId();
    await this.request<{ error?: string }>({
      type: 'startBlossomSession',
      id,
      sessionId,
      totalChunks,
    } as ExtendedWorkerRequest);
  }

  /**
   * End the current blossom upload session
   */
  async endBlossomSession(): Promise<void> {
    const id = generateRequestId();
    await this.request<{ error?: string }>({
      type: 'endBlossomSession',
      id,
    } as ExtendedWorkerRequest);
  }

  /**
   * Push a tree to blossom servers
   * @param cidHash - Hash of the root CID
   * @param cidKey - Optional encryption key
   * @param treeName - Optional tree name for progress tracking
   * @returns Push result with pushed/skipped/failed counts and error messages
   */
  async pushToBlossom(cidHash: Uint8Array, cidKey?: Uint8Array, treeName?: string): Promise<{ pushed: number; skipped: number; failed: number; errors?: string[] }> {
    const id = generateRequestId();
    const response = await this.request<{ pushed: number; skipped: number; failed: number; error?: string; errors?: string[] }>({
      type: 'pushToBlossom',
      id,
      cidHash,
      cidKey,
      treeName,
    } as ExtendedWorkerRequest, undefined, this.BLOSSOM_PUSH_REQUEST_TIMEOUT_MS);
    if (response.error) throw new Error(response.error);
    return { pushed: response.pushed, skipped: response.skipped, failed: response.failed, errors: response.errors };
  }

  /**
   * Republish all cached tree events to relays
   * @param prefix - Optional URL-encoded prefix to filter trees by d-tag
   * @returns Result with count and any trees with encryption errors
   */
  async republishTrees(prefix?: string): Promise<{ count: number; encryptionErrors?: string[] }> {
    const id = generateRequestId();
    const response = await this.request<{ count: number; error?: string; encryptionErrors?: string[] }>({
      type: 'republishTrees',
      id,
      prefix,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return { count: response.count, encryptionErrors: response.encryptionErrors };
  }

  /**
   * Republish a single tree's event to relays (preserves original event)
   * Works for any user's tree, not just own.
   * @param pubkey - Pubkey of the tree owner
   * @param treeName - Name of the tree (d-tag)
   * @returns true if republished successfully
   */
  async republishTree(pubkey: string, treeName: string): Promise<boolean> {
    const id = generateRequestId();
    const response = await this.request<{ value: boolean; error?: string }>({
      type: 'republishTree',
      id,
      pubkey,
      treeName,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return response.value;
  }

  // ============================================================================
}
