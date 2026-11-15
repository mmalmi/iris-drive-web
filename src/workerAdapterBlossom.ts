import { generateRequestId } from '@hashtree/core';
import type {
  WorkerBlossomBandwidthStats as BlossomBandwidthStats,
  WorkerBlossomUploadProgress as BlossomUploadProgress,
} from '@hashtree/core';
import { WorkerAdapterCore, type ExtendedWorkerRequest } from './workerAdapterCore';
import type { DriveBackupRequest, DriveBackupResult } from './workers/driveBackup';
import type { DriveHolding } from './workers/driveHolding';

const DRIVE_BACKUP_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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

  /**
   * Back up the Drive to one place, or check a backup, in the worker. Progress
   * arrives through `onDriveBackupProgress`; the answer when it is done.
   */
  async runDriveBackup(request: DriveBackupRequest): Promise<DriveBackupResult> {
    return this.request<DriveBackupResult>({
      type: 'driveBackup',
      id: generateRequestId(),
      request,
    } as ExtendedWorkerRequest, undefined, DRIVE_BACKUP_TIMEOUT_MS);
  }

  /**
   * How much of the Drive at `root` this device holds, measured in the worker.
   * Folders it lacks are fetched; file content never is. What was counted
   * for a folder in the last `maxAgeMs` is used again.
   */
  async measureDriveHolding(root: { hash: Uint8Array; key?: Uint8Array }, maxAgeMs?: number): Promise<DriveHolding> {
    const response = await this.request<{ holding?: DriveHolding; error?: string }>({
      type: 'driveHolding',
      id: generateRequestId(),
      root,
      maxAgeMs,
    } as ExtendedWorkerRequest, undefined, DRIVE_BACKUP_TIMEOUT_MS);
    if (response.error || !response.holding) throw new Error(response.error ?? 'Drive storage did not answer');
    return response.holding;
  }

  /** Stop a backup or check of one place. */
  stopDriveBackup(target: string): void {
    this.postMessage({ type: 'driveBackupStop', target } as ExtendedWorkerRequest);
  }

  onDriveBackupProgress(callback: (target: string, done: number, total: number) => void): () => void {
    this.driveBackupProgressCallbacks.add(callback);
    return () => this.driveBackupProgressCallbacks.delete(callback);
  }

  // ============================================================================
}
