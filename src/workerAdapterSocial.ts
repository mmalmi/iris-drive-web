import { generateRequestId, type WorkerSocialGraphEvent as SocialGraphEvent } from '@hashtree/core';
import { WorkerAdapterNostr } from './workerAdapterNostr';
import type { ExtendedWorkerRequest } from './workerAdapterCore';

export class WorkerAdapterSocial extends WorkerAdapterNostr {
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
   * Check if follower follows followed
   */
  async isFollowing(follower: string, followed: string): Promise<boolean> {
    const id = generateRequestId();
    const response = await this.request<{ result: boolean; error?: string }>({
      type: 'isFollowing',
      id,
      follower,
      followed,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return response.result;
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
   * Get list of pubkeys following a user
   */
  async getFollowers(pubkey: string): Promise<string[]> {
    const id = generateRequestId();
    const response = await this.request<{ pubkeys: string[]; error?: string }>({
      type: 'getFollowers',
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
   * Fetch a user's follow list when visiting their profile.
   * Only fetches if we don't already have their follow list.
   */
  fetchUserFollows(pubkey: string): void {
    const id = generateRequestId();
    // Fire and forget - don't await response
    this.request<{ error?: string }>({
      type: 'fetchUserFollows',
      id,
      pubkey,
    } as ExtendedWorkerRequest).catch(() => {});
  }

  /**
   * Fetch followers of a user (who follows them) - for profile views
   */
  fetchUserFollowers(pubkey: string): void {
    const id = generateRequestId();
    // Fire and forget - don't await response
    this.request<{ error?: string }>({
      type: 'fetchUserFollowers',
      id,
      pubkey,
    } as ExtendedWorkerRequest).catch(() => {});
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
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  close(): void {
    this.stopHeartbeat();

    if (this.worker) {
      this.postMessage({ type: 'close', id: generateRequestId() });
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.pendingRequests.clear();
    this.subscriptions.clear();
    this.streamCallbacks.clear();
    this.messageQueue = [];
    this.socialGraphVersionCallback = null;
    this.treeRootUpdateCallbacks.clear();
    this.p2pProvider = null;
  }
}
