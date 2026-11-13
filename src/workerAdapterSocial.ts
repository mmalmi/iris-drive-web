import { generateRequestId, type WorkerSocialGraphEvent as SocialGraphEvent } from '@hashtree/core';
import { WorkerAdapterNostr } from './workerAdapterNostr';
import type { ExtendedWorkerRequest } from './workerAdapterCore';

export class WorkerAdapterSocial extends WorkerAdapterNostr {
  private readonly identityChangeCallbacks = new Set<(
    identity: { pubkey: string; nsec?: string },
  ) => void>();

  // Public API - Media Streaming
  // ============================================================================

  /**
   * Register a MessagePort from the service worker for media streaming
   */
  registerMediaPort(port: MessagePort, debug?: boolean): void {
    if (!this.worker) {
      console.warn('[WorkerAdapter] Cannot register media port - worker not ready');
      return;
    }
    this.worker.postMessage({ type: 'registerMediaPort', port, debug } as ExtendedWorkerRequest, [port]);
  }

  // ============================================================================
  // Public API - SocialGraph
  // ============================================================================

  /**
   * Set callback for social graph version updates
   */
  onSocialGraphVersion(callback: (version: number) => void): void {
    this.socialGraphVersionCallback = callback;
  }

  /**
   * Initialize the social graph with optional root pubkey
   */
  async initSocialGraph(rootPubkey?: string): Promise<{ version: number; size: number }> {
    const id = generateRequestId();
    const response = await this.request<{ version: number; size: number; error?: string }>({
      type: 'initSocialGraph',
      id,
      rootPubkey,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return { version: response.version, size: response.size };
  }

  /**
   * Runs one follow-list catch-up pass in the worker, in the background.
   * Nothing waits for it; the graph updates as lists arrive.
   */
  refreshSocialGraph(): void {
    this.postMessage({ type: 'refreshSocialGraph' } as ExtendedWorkerRequest);
  }

  /**
   * Set the social graph root pubkey
   */
  async setSocialGraphRoot(pubkey: string): Promise<void> {
    const id = generateRequestId();
    const response = await this.request<{ error?: string }>({
      type: 'setSocialGraphRoot',
      id,
      pubkey,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
  }

  /**
   * Handle social graph events (kind:3 contact lists)
   */
  handleSocialGraphEvents(events: SocialGraphEvent[]): void {
    if (events.length === 0) return;
    this.postMessage({
      type: 'handleSocialGraphEvents',
      id: generateRequestId(),
      events,
    } as ExtendedWorkerRequest);
  }

  /**
   * Get follow distance for a pubkey
   */
  async getFollowDistance(pubkey: string): Promise<number> {
    const id = generateRequestId();
    const response = await this.request<{ distance: number; error?: string }>({
      type: 'getFollowDistance',
      id,
      pubkey,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return response.distance;
  }

  /**
   * Get list of pubkeys a user follows
   */
  async getFollows(pubkey: string): Promise<string[]> {
    const id = generateRequestId();
    const response = await this.request<{ pubkeys: string[]; error?: string }>({
      type: 'getFollows',
      id,
      pubkey,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return response.pubkeys;
  }

  /**
   * Get pubkeys followed by friends of a user
   */
  async getFollowedByFriends(pubkey: string): Promise<string[]> {
    const id = generateRequestId();
    const response = await this.request<{ pubkeys: string[]; error?: string }>({
      type: 'getFollowedByFriends',
      id,
      pubkey,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return response.pubkeys;
  }

  /**
   * Get size of the social graph
   */
  async getSocialGraphSize(): Promise<number> {
    const id = generateRequestId();
    const response = await this.request<{ size: number; error?: string }>({
      type: 'getSocialGraphSize',
      id,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return response.size;
  }

  /**
   * Get users by follow distance
   */
  async getUsersByDistance(distance: number): Promise<string[]> {
    const id = generateRequestId();
    const response = await this.request<{ pubkeys: string[]; error?: string }>({
      type: 'getUsersByDistance',
      id,
      distance,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return response.pubkeys;
  }

  // ============================================================================
  // Identity Management
  // ============================================================================

  onIdentityChange(
    callback: (identity: { pubkey: string; nsec?: string }) => void,
  ): () => void {
    this.identityChangeCallbacks.add(callback);
    return () => this.identityChangeCallbacks.delete(callback);
  }

  /**
   * Update worker's user identity (for account switching)
   */
  async setIdentity(pubkey: string, nsec?: string): Promise<void> {
    const update = () => this.request<{ error?: string }>({
      type: 'setIdentity',
      id: generateRequestId(),
      pubkey,
      nsec,
    } as ExtendedWorkerRequest);
    try {
      await update();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Worker crashed') throw error;
      await update();
    }
    this.config = { ...this.config, pubkey, nsec };
    for (const callback of this.identityChangeCallbacks) {
      callback({ pubkey, ...(nsec ? { nsec } : {}) });
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  close(): void {
    this.stopHeartbeat();
    this.sourceBridge?.();
    this.sourceBridge = null;
    this.nostrSource = null;

    if (this.worker) {
      this.postMessage({ type: 'close', id: generateRequestId() });
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(new Error('Worker closed'));
    }
    this.pendingRequests.clear();
    this.subscriptions.clear();
    this.streamCallbacks.clear();
    this.messageQueue = [];
    this.socialGraphVersionCallback = null;
    this.treeRootUpdateCallbacks.clear();
    this.identityChangeCallbacks.clear();
    this.p2pProvider = null;
  }
}
