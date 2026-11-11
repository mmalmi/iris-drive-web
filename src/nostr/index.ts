/**
 * Nostr integration for HashTree Explorer
 * Uses the shared pubsub worker and persistent Hashtree indexes
 */

// Re-export TreeVisibility from hashtree lib
export type { TreeVisibility } from '@hashtree/core';

// Store exports
export {
  nostrStore,
  useNostrStore,
  type NostrState,
  type HashTreeEvent,
  type RelayStatus,
  type RelayInfo,
} from './store';

export { nostr, signEvent, type NostrEvent } from './client';

// Relay management exports
export {
  updateConnectedRelayCount,
  initRelayTracking,
} from './relays';

// Authentication exports
export {
  restoreSession,
  loginWithExtension,
  loginWithNsec,
  generateNewKey,
  createDriveProfile,
  createDriveDeviceApprovalLink,
  approveDriveDeviceApprovalBootstrap,
  activateDriveDeviceApprovalIfApproved,
  setDriveProfileAppKeyAdmin,
  removeDriveProfileAppKeyWithAdmin,
  recoverDriveProfileWithAppKey,
  removeDriveProfileAppKeyWithRecovery,
  getCurrentNostrIdentitySession,
  loadDriveDeviceLabels,
  getStoredNostrIdentitySessionForAccount,
  waitForNostrExtension,
  initReadonlyBackend,
  logout,
  getSecretKey,
  getNsec,
  encrypt,
  decrypt,
  type DriveRecoveryAppKeyOptions,
  type DriveDeviceApprovalActivation,
  type DriveDeviceApprovalLink,
  type DriveRecoveryMethod,
  type DriveRecoveryRemoveAppKeyOptions,
  type DriveRecoveryRemoveAppKeyResult,
  type DriveRecoveryRequest,
} from './auth';

// Tree management exports
export {
  saveHashtree,
  deleteTree,
  autosaveIfOwn,
  saveOwnTreeRoot,
  isOwnTree,
  pubkeyToNpub,
  npubToPubkey,
  linkKeyUtils,
  type SaveHashtreeOptions,
} from './trees';

// Re-export stopWebRTC for backwards compatibility (actual impl is in ../store)
export { stopWebRTC } from '../store';
