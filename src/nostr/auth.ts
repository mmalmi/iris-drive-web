/**
 * Nostr Authentication and Encryption
 */
import { generateSecretKey, getPublicKey, nip19, nip44, verifyEvent, type Event as NostrToolsEvent } from 'nostr-tools';
import {
  approveDeviceLinkRequest,
  approveNostrIdentityDeviceApprovalRequest,
  buildNostrIdentityDeviceApprovalReceiptEvent,
  createAttachedNostrIdentitySession,
  createNostrIdentitySignerFromNip07,
  createNostrIdentitySignerFromNip46,
  createNostrIdentitySignerFromNsec,
  createNostrIdentitySignerFromSeedPhrase,
  encodeDeviceLinkInvite,
  normalizeHexPubkey,
  nostrIdentityAppKeyApprovalCandidateFilters,
  nostrIdentityAppKeyApprovalCandidatesFromEvents,
  parseNostrIdentityDeviceApprovalReceiptEvent,
  parseNostrIdentityDeviceApprovalReceiptRosterOp,
  parseDeviceLinkRequestEvent as parseIdentityDeviceLinkRequestEvent,
  removeNostrAppKeyFromIdentity,
  signDeviceLinkRequestEvent,
  type NostrIdentityDeviceApprovalReceipt,
  type NostrIdentityEventSigner,
  type NostrIdentityAppKeyApprovalCandidate,
  type RemoveNostrAppKeyResult,
} from '@iris/identity';
import { APP_KEY_WRITER_CAPABILITIES } from 'nostr-social-graph';
import type { NDKFilter, NDKKind } from 'ndk';
import { ndk, NDKNip46Signer, NDKPrivateKeySigner, NDKNip07Signer, NDKEvent } from './ndk';
import { nostrStore } from './store';
import { initHashtreeBackend, getWorkerAdapter, updateFollowsSubscription, waitForWorkerAdapter } from '../lib/workerInit';
import {
  accountsStore,
  initAccountsStore,
  createAccountFromNsec,
  createExtensionAccount,
  saveActiveAccountToStorage,
} from '../accounts';
import { stopWebRTC } from '../store';
import { needsMigrations, runMigrations } from '../migrations';
import { initWallet, disposeWallet } from '../stores/wallet';
import {
  createPendingDeviceLinkSession,
  createDriveDeviceApprovalDraft,
  driveDeviceApprovalRequestSecretKey,
  pendingDriveDeviceApprovalFromDraft,
  createNostrIdentityDckRotateAfterAddOp,
  createNostrIdentityDckRotateAfterRemovalOp,
  createNostrIdentityDckRewrapOp,
  DEVICE_APPROVAL_REQUEST_TYPE,
  DRIVE_DEVICE_APPROVAL_RESOURCES,
  isCompactDriveDeviceApprovalRequest,
  KIND_NOSTR_IDENTITY_FACET_ACCEPTANCE,
  KIND_NOSTR_IDENTITY_ROSTER_OP,
  type DriveDeviceApprovalRequest,
  type FullDriveDeviceApprovalRequest,
  type PendingDriveDeviceApproval,
  type DeviceLinkRequest,
  parseDeviceLinkInvite,
  parseDriveDeviceApprovalRequest,
  parseNostrIdentityFacetAcceptanceEvent,
  parseNostrIdentityRosterOpEvent,
  projectNostrIdentityRoster,
  signNostrIdentityRosterOp,
  type NostrIdentitySession,
  type NostrIdentityCapabilities,
  type NostrIdentityId,
  type SignedNostrIdentityRosterOp,
  type StoredNostrIdentitySession,
} from '../drive/protocol';
import {
  DRIVE_DEVICE_LABEL_SCHEMA,
  currentBrowserDeviceLabel,
  decryptDriveDeviceLabelsWithDck,
  encryptDriveDeviceLabelsWithDck,
  encryptedDeviceLabelPayloadsFromEventJson,
  readStoredDeviceLabels,
  saveStoredDeviceLabel,
  saveStoredDeviceLabels,
} from '../drive/deviceLabels';
import { KIND_APP_DATA } from '../utils/constants';

// Storage keys
const STORAGE_KEY_NSEC = 'hashtree:nsec';
const STORAGE_KEY_LOGIN_TYPE = 'hashtree:loginType';
const STORAGE_KEY_IRIS_IDENTITY = 'iris:identity:session';
const STORAGE_KEY_IRIS_IDENTITY_SESSIONS = 'iris:identity:sessions';
const DRIVE_ROOT_NAME = 'main';

// Private key (only set for nsec login)
let secretKey: Uint8Array | null = null;
let bootstrapPubkey: string | null = null;
let bootstrapSecretKey: Uint8Array | null = null;
let bootstrapUsedForLogin = false;
const isTestMode = !!import.meta.env.VITE_TEST_MODE;

export interface RestoreSessionOptions {
  autoCreate?: boolean;
}

export type DriveRecoveryMethod = 'nsec' | 'seed_phrase' | 'nip07' | 'nip46';

export interface DriveRecoveryRequest {
  method: DriveRecoveryMethod;
  nsec?: string;
  seedWords?: string;
  seedPassphrase?: string;
  nip46Connection?: string;
  nip46Relay?: string;
}

export interface DriveRecoveryAppKeyOptions {
  profileId?: NostrIdentityId;
  recovery: DriveRecoveryRequest;
  label?: string;
  rosterFetchTimeoutMs?: number;
}

export interface DriveRecoveryRemoveAppKeyOptions {
  profileId: NostrIdentityId;
  recovery: DriveRecoveryRequest;
  appKeyPubkey: string;
  reason?: string;
  rosterFetchTimeoutMs?: number;
}

export interface DriveRecoveryRemoveAppKeyResult {
  removal: RemoveNostrAppKeyResult;
  dckRotationOp: SignedNostrIdentityRosterOp | null;
  session: NostrIdentitySession | null;
}

export interface DriveDeviceLinkInvite {
  profileId: NostrIdentityId;
  adminAppKeyPubkey: string;
  invitePubkey: string;
  inviteSecretKeyNsec: string;
  url: string;
}

export interface DriveDeviceLinkRequest {
  id: string;
  request: DeviceLinkRequest;
  pubkey: string;
  label?: string;
  requestedAt: number;
}

export interface DriveDeviceApprovalLink {
  url: string;
  appKeyNsec: string;
  appKeyNpub: string;
  appKeyPubkey: string;
  pendingApproval: PendingDriveDeviceApproval;
  label?: string;
}

export interface DriveDeviceApprovalActivation {
  nsec: string;
  npub: string;
  session: NostrIdentitySession;
  receipt: NostrIdentityDeviceApprovalReceipt;
}

export interface DriveDeviceLinkRequestScope {
  profileId: NostrIdentityId;
  adminAppKeyPubkey: string;
  invitePubkey: string;
  inviteSecretKey: Uint8Array;
}

type DefaultTree = {
  name: string;
  visibility: 'public' | 'link-visible' | 'private';
};

const CLASSIC_DEFAULT_TREES: readonly DefaultTree[] = [
  { name: 'public', visibility: 'public' },
  { name: 'link', visibility: 'link-visible' },
  { name: 'private', visibility: 'private' },
];

const DRIVE_DEFAULT_TREES: readonly DefaultTree[] = [
  { name: DRIVE_ROOT_NAME, visibility: 'private' },
];

let currentNostrIdentitySession: NostrIdentitySession | null = null;

const DRIVE_APP_KEY_ADMIN_CAPABILITIES: NostrIdentityCapabilities = {
  can_write_roots: true,
  can_admin_profile: true,
  can_recover_app_keys: true,
  can_receive_secret_wraps: true,
  can_decrypt_secret_epochs: true,
};

/**
 * Get the secret key for decryption (only available for nsec login)
 */
export function getSecretKey(): Uint8Array | null {
  return secretKey;
}

/**
 * Get the nsec string (only available for nsec login)
 */
export function getNsec(): string | null {
  if (!secretKey) return null;
  return nip19.nsecEncode(secretKey);
}

export function getCurrentNostrIdentitySession(): NostrIdentitySession | null {
  return currentNostrIdentitySession;
}

export async function loadDriveDeviceLabels(): Promise<Record<string, string>> {
  const session = currentNostrIdentitySession;
  if (!session || session.status !== 'active') return {};
  const rosterOps = await currentDriveRosterOps(session).catch(() => session.rosterOps);
  const labels = await collectDriveDeviceLabels(session, rosterOps);
  saveStoredDeviceLabels(session.profileId, labels);
  appendCurrentNostrIdentitySessionRosterOps(session.profileId, rosterOps);
  return labels;
}

/**
 * Initialize or update backend with user identity.
 */
async function initOrUpdateBackendIdentity(pubkey: string, nsecHex?: string): Promise<void> {
  const adapter = getWorkerAdapter();
  if (adapter) {
    await adapter.setIdentity(pubkey, nsecHex);
    updateFollowsSubscription(pubkey);
  } else {
    await initHashtreeBackend({ pubkey, nsec: nsecHex });
    const readyAdapter = getWorkerAdapter();
    if (readyAdapter) {
      await readyAdapter.setIdentity(pubkey, nsecHex);
      updateFollowsSubscription(pubkey);
    }
  }
}

/**
 * Initialize the backend early for read-only access.
 * This avoids waiting on login flows before connecting to relays.
 */
export async function initReadonlyBackend(): Promise<void> {
  if (getWorkerAdapter()) return;
  if (secretKey) {
    const pubkey = getPublicKey(secretKey);
    const nsecHex = Array.from(secretKey).map(b => b.toString(16).padStart(2, '0')).join('');
    await initHashtreeBackend({ pubkey, nsec: nsecHex });
    return;
  }
  ensureBootstrapIdentity();
  const nsecHex = bootstrapSecretKey
    ? Array.from(bootstrapSecretKey).map(b => b.toString(16).padStart(2, '0')).join('')
    : undefined;
  if (!bootstrapPubkey) return;
  await initHashtreeBackend({ pubkey: bootstrapPubkey, nsec: nsecHex });
}

export async function initReadonlyWorker(): Promise<void> {
  return initReadonlyBackend();
}

/**
 * Wait for window.nostr to be available
 */
export async function waitForNostrExtension(timeoutMs = 2000): Promise<boolean> {
  if (window.nostr) return true;

  return new Promise((resolve) => {
    const startTime = Date.now();
    const checkInterval = setInterval(() => {
      if (window.nostr) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval);
        resolve(false);
      }
    }, 100);
  });
}

/**
 * Try to restore session from localStorage
 */
export async function restoreSession(options: RestoreSessionOptions = {}): Promise<boolean> {
  const { autoCreate = true } = options;
  const t0 = performance.now();
  const logT = (msg: string) => console.log(`[restoreSession] ${msg}: ${Math.round(performance.now() - t0)}ms`);

  initAccountsStore();
  logT('initAccountsStore');
  const restoredIrisSession = restoreStoredNostrIdentitySession();
  if (restoredIrisSession?.status === 'pending_device_link') {
    secretKey = null;
    ndk.signer = undefined;
    nostrStore.setPubkey(null);
    nostrStore.setNpub(null);
    nostrStore.setIsLoggedIn(false);
    nostrStore.setSelectedTree(null);
    localStorage.removeItem(STORAGE_KEY_LOGIN_TYPE);
    localStorage.removeItem(STORAGE_KEY_NSEC);
    logT('pending device link');
    return false;
  }

  // Migrate legacy single account to multi-account storage if needed
  const legacyLoginType = localStorage.getItem(STORAGE_KEY_LOGIN_TYPE);
  const legacyNsec = localStorage.getItem(STORAGE_KEY_NSEC);
  let accountsState = accountsStore.getState();

  if (accountsState.accounts.length === 0 && (legacyLoginType || legacyNsec)) {
    if (legacyLoginType === 'nsec' && legacyNsec) {
      const account = createAccountFromNsec(legacyNsec);
      if (account) {
        accountsStore.addAccount(account);
        accountsStore.setActiveAccount(account.pubkey);
        saveActiveAccountToStorage(account.pubkey);
      }
    }
  }
  accountsState = accountsStore.getState();

  const activeAccount = accountsState.accounts.find(
    a => a.pubkey === accountsState.activeAccountPubkey
  );

  if (activeAccount) {
    logT('found activeAccount');
    if (activeAccount.type === 'extension') {
      const result = await loginWithExtension();
      if (result) {
        await ensureTestDefaultFolders();
      }
      return result;
    } else if ((activeAccount.type === 'nsec' || activeAccount.type === 'drive_profile') && activeAccount.nsec) {
      logT('calling loginWithNsec');
      const result = await loginWithNsec(activeAccount.nsec, false);
      logT('loginWithNsec done');
      if (result) {
        await ensureTestDefaultFolders();
      }
      return result;
    }
  }

  if (legacyLoginType === 'extension') {
    const result = await loginWithExtension();
    if (result) {
      await ensureTestDefaultFolders();
    }
    return result;
  } else if (legacyLoginType === 'nsec' && legacyNsec) {
    const result = await loginWithNsec(legacyNsec);
    if (result) {
      await ensureTestDefaultFolders();
    }
    return result;
  }

  if (!autoCreate) {
    logT('no stored session');
    return false;
  }

  logT('calling generateInitialKey');
  await generateInitialKey();
  await ensureTestDefaultFolders();
  logT('generateInitialKey done');
  return true;
}

/**
 * Login with NIP-07 browser extension
 */
export async function loginWithExtension(): Promise<boolean> {
  try {
    const extensionAvailable = await waitForNostrExtension();
    if (!extensionAvailable) {
      throw new Error('No nostr extension found');
    }

    const signer = new NDKNip07Signer();
    ndk.signer = signer;

    const user = await signer.user();
    const pk = user.pubkey;

    nostrStore.setPubkey(pk);
    nostrStore.setNpub(nip19.npubEncode(pk));
    nostrStore.setIsLoggedIn(true);
    secretKey = null;

    localStorage.setItem(STORAGE_KEY_LOGIN_TYPE, 'extension');
    localStorage.removeItem(STORAGE_KEY_NSEC);

    const accountsState = accountsStore.getState();
    if (!accountsState.accounts.some(a => a.pubkey === pk)) {
      const account = createExtensionAccount(pk);
      accountsStore.addAccount(account);
    }
    accountsStore.setActiveAccount(pk);
    saveActiveAccountToStorage(pk);

    await initOrUpdateBackendIdentity(pk);

    // Run migrations in background (delay to allow relays to connect)
    if (needsMigrations()) {
      const npub = nip19.npubEncode(pk);
      setTimeout(() => runMigrations(npub), 5000);
    }

    return true;
  } catch (e) {
    console.error('Extension login failed:', e);
    return false;
  }
}

/**
 * Login with nsec
 */
export async function loginWithNsec(nsec: string, save = true): Promise<boolean> {
  try {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') {
      throw new Error('Invalid nsec');
    }

    secretKey = decoded.data as Uint8Array;
    const pk = getPublicKey(secretKey);

    const signer = new NDKPrivateKeySigner(nsec);
    ndk.signer = signer;

    nostrStore.setPubkey(pk);
    nostrStore.setNpub(nip19.npubEncode(pk));
    nostrStore.setIsLoggedIn(true);

    if (save) {
      localStorage.setItem(STORAGE_KEY_LOGIN_TYPE, 'nsec');
      localStorage.setItem(STORAGE_KEY_NSEC, nsec);

      const accountsState = accountsStore.getState();
      if (!accountsState.accounts.some(a => a.pubkey === pk)) {
        const account = createAccountFromNsec(nsec);
        if (account) {
          accountsStore.addAccount(account);
        }
      }
      accountsStore.setActiveAccount(pk);
      saveActiveAccountToStorage(pk);
    }

    const nsecHex = Array.from(secretKey).map(b => b.toString(16).padStart(2, '0')).join('');
    await initOrUpdateBackendIdentity(pk, nsecHex);

    // Initialize wallet with secret key
    initWallet(secretKey).catch(e => {
      console.error('Wallet initialization failed:', e);
    });

    // Run migrations in background (delay to allow relays to connect)
    if (needsMigrations()) {
      const npub = nip19.npubEncode(pk);
      setTimeout(() => runMigrations(npub), 5000);
    }

    return true;
  } catch (e) {
    console.error('Nsec login failed:', e);
    return false;
  }
}

/**
 * Generate new keypair
 */
async function applySecretKey(
  nextKey: Uint8Array,
  defaultTrees: readonly DefaultTree[] = CLASSIC_DEFAULT_TREES,
  accountOptions: { nostrIdentityId?: NostrIdentityId; name?: string } = {},
): Promise<{ nsec: string; npub: string }> {
  secretKey = nextKey;
  const pk = getPublicKey(nextKey);
  const nsec = nip19.nsecEncode(nextKey);

  const signer = new NDKPrivateKeySigner(nsec);
  ndk.signer = signer;

  nostrStore.setPubkey(pk);
  const npubStr = nip19.npubEncode(pk);
  nostrStore.setNpub(npubStr);
  nostrStore.setIsLoggedIn(true);

  localStorage.setItem(STORAGE_KEY_LOGIN_TYPE, 'nsec');
  localStorage.setItem(STORAGE_KEY_NSEC, nsec);

  const account = createAccountFromNsec(nsec, {
    type: accountOptions.nostrIdentityId ? 'drive_profile' : 'nsec',
    nostrIdentityId: accountOptions.nostrIdentityId,
    name: accountOptions.name,
  });
  if (account) {
    accountsStore.addAccount(account);
    if (accountOptions.nostrIdentityId) {
      accountsStore.updateAccount(account.pubkey, {
        type: 'drive_profile',
        nostrIdentityId: accountOptions.nostrIdentityId,
        name: accountOptions.name,
        nsec,
      });
    }
    accountsStore.setActiveAccount(pk);
    saveActiveAccountToStorage(pk);
  }

  const nsecHex = Array.from(nextKey).map(b => b.toString(16).padStart(2, '0')).join('');
  await initOrUpdateBackendIdentity(pk, nsecHex);

  // Initialize wallet with secret key
  initWallet(nextKey).catch(e => {
    console.error('Wallet initialization failed:', e);
  });

  // Create default folders for new user
  await createDefaultTrees(defaultTrees);

  // Publish initial profile with npub.cash lightning address
  publishInitialProfile(npubStr).catch(e => {
    console.error('Failed to publish initial profile:', e);
  });

  return { nsec, npub: npubStr };
}

async function generateInitialKey(): Promise<{ nsec: string; npub: string }> {
  ensureBootstrapIdentity();
  if (bootstrapSecretKey && !bootstrapUsedForLogin) {
    const nextKey = bootstrapSecretKey;
    bootstrapUsedForLogin = true;
    return applySecretKey(nextKey);
  }
  return applySecretKey(generateSecretKey());
}

export async function generateNewKey(): Promise<{ nsec: string; npub: string }> {
  return applySecretKey(generateSecretKey());
}

export async function createDriveProfile(
  options: { name?: string } = {},
): Promise<{ nsec: string; npub: string; profileId: NostrIdentityId }> {
  const appKeySecretKey = generateSecretKey();
  const appKeyPubkey = getPublicKey(appKeySecretKey);
  const profileId = randomProfileId();
  const createdAt = currentUnixSeconds();
  const label = currentBrowserDeviceLabel();
  const dckPlaintext = randomDriveContentKey();
  const encryptedDeviceLabels = await encryptDriveDeviceLabelsWithDck({
    schema: DRIVE_DEVICE_LABEL_SCHEMA,
    profileId,
    secretEpoch: 1,
    labels: { [appKeyPubkey]: label },
    updatedAt: createdAt,
  }, dckPlaintext);
  const session = createDriveIdentitySession({
    profileId,
    appKeySecretKey,
    createdAt,
    label,
    encryptedDeviceLabels,
  });
  const dckRotationOp = await createNostrIdentityDckRotateAfterAddOp({
    profileId: session.profileId,
    signer: createNostrIdentitySignerFromNsec(session.appKeyNsec),
    rosterOps: [],
    parentRosterOp: session.rosterOps[0],
    createdAt: createdAt + 1,
    clientNonce: `${session.rosterOps[0].content.client_nonce}:create-dck`,
    dckPlaintext,
  });
  const activeSession: NostrIdentitySession = {
    ...session,
    rosterOps: [...session.rosterOps, dckRotationOp],
  };
  saveStoredDeviceLabel(activeSession.profileId, activeSession.appKeyPubkey, label);
  saveNostrIdentitySession(activeSession);
  const applied = await applySecretKey(appKeySecretKey, DRIVE_DEFAULT_TREES, {
    nostrIdentityId: activeSession.profileId,
    name: options.name?.trim() || undefined,
  });
  return {
    ...applied,
    profileId: activeSession.profileId,
  };
}

export async function linkDriveDevice(inviteInput: string): Promise<{ nsec: string; npub: string; session: NostrIdentitySession } | null> {
  const invite = parseDeviceLinkInvite(inviteInput);
  if (!invite) return null;
  const session = createPendingDeviceLinkSession({
    invite,
    label: currentBrowserDeviceLabel(),
  });
  const decoded = nip19.decode(session.appKeyNsec);
  if (decoded.type !== 'nsec') return null;
  const appKeySecretKey = decoded.data as Uint8Array;
  saveNostrIdentitySession(session);
  if (session.label) {
    saveStoredDeviceLabel(session.profileId, session.appKeyPubkey, session.label);
  }
  secretKey = null;
  ndk.signer = undefined;
  nostrStore.setPubkey(null);
  nostrStore.setNpub(null);
  nostrStore.setIsLoggedIn(false);
  nostrStore.setSelectedTree(null);
  accountsStore.setActiveAccount(null);
  saveActiveAccountToStorage(null);
  localStorage.removeItem(STORAGE_KEY_LOGIN_TYPE);
  localStorage.removeItem(STORAGE_KEY_NSEC);
  await publishDriveDeviceLinkRequest(session, appKeySecretKey);
  return { nsec: session.appKeyNsec, npub: session.appKeyNpub, session };
}

export function createDriveDeviceApprovalLink(options: { label?: string } = {}): DriveDeviceApprovalLink {
  const label = options.label?.trim() || currentBrowserDeviceLabel();
  const draft = createDriveDeviceApprovalDraft({ label });
  const appKeyPubkey = getPublicKey(draft.appKeySecretKey);
  const appKeyNsec = nip19.nsecEncode(draft.appKeySecretKey);
  return {
    url: draft.url,
    appKeyNsec,
    appKeyNpub: nip19.npubEncode(appKeyPubkey),
    appKeyPubkey,
    pendingApproval: pendingDriveDeviceApprovalFromDraft(draft),
    ...(label ? { label } : {}),
  };
}

export function parseDriveDeviceApprovalRequestInput(input: string): DriveDeviceApprovalRequest | null {
  return parseDriveDeviceApprovalRequest(input);
}

export async function approveDriveDeviceApprovalRequest(
  request: DriveDeviceApprovalRequest,
): Promise<NostrIdentitySession> {
  const session = requireActiveDriveIdentitySession();
  requireCurrentDriveAdmin(session);
  if (!secretKey) throw new Error('No active Drive AppKey secret');
  validateDriveDeviceApprovalRequest(request, session);

  const rosterOps = await currentDriveRosterOps(session);
  const approvedAt = currentUnixSeconds();
  const label = request.label?.trim();
  const deviceLabels = await collectDriveDeviceLabels(session, rosterOps);
  if (label) {
    deviceLabels[request.deviceAppKeyPubkey] = label;
  }
  const dckPlaintext = randomDriveContentKey();
  const secretEpoch = nextSecretEpochNumber(session.profileId, rosterOps);
  const encryptedDeviceLabels = await encryptDriveDeviceLabelsWithDck({
    schema: DRIVE_DEVICE_LABEL_SCHEMA,
    profileId: session.profileId,
    secretEpoch,
    labels: deviceLabels,
    updatedAt: approvedAt,
  }, dckPlaintext);
  const requestForApproval = isCompactDriveDeviceApprovalRequest(request)
    ? { deviceAppKeyPubkey: request.deviceAppKeyPubkey } as FullDriveDeviceApprovalRequest
    : { ...request, label: undefined };
  const content = approveNostrIdentityDeviceApprovalRequest({
    request: requestForApproval,
    profileId: session.profileId,
    rosterOps,
    approvedByPubkey: session.appKeyPubkey,
    approvedAt,
    clientNonce: randomClientNonce(),
    capabilities: APP_KEY_WRITER_CAPABILITIES,
  });
  const signed = signNostrIdentityRosterOp({
    signerSecretKey: secretKey,
    profileId: content.profile_id,
    parents: content.parents,
    createdAt: content.created_at,
    clientNonce: content.client_nonce,
    encryptedDeviceLabels,
    op: content.op,
  });
  const dckRotationOp = await createNostrIdentityDckRotateAfterAddOp({
    profileId: session.profileId,
    signer: createNostrIdentitySignerFromNsec(session.appKeyNsec),
    rosterOps,
    parentRosterOp: signed,
    createdAt: approvedAt + 1,
    clientNonce: `${content.client_nonce}:rotate-dck`,
    dckPlaintext,
  });
  const receiptEvent = isCompactDriveDeviceApprovalRequest(request)
    ? null
    : buildNostrIdentityDeviceApprovalReceiptEvent({
        signerSecretKey: secretKey,
        request,
        profileId: session.profileId,
        approvedAt,
        subjectPubkey: session.appKeyPubkey,
        rosterOpEvent: JSON.parse(signed.event_json) as NostrToolsEvent,
      });

  await publishCurrentDriveIdentityRosterOps({ ...session, rosterOps });
  await publishSignedIdentityEventJson(signed.event_json);
  await publishSignedIdentityEventJson(dckRotationOp.event_json);
  if (receiptEvent) {
    await publishRawNostrEvent(receiptEvent as NostrToolsEvent);
  }
  const updated = appendCurrentNostrIdentitySessionRosterOps(session.profileId, [
    ...rosterOps,
    signed,
    dckRotationOp,
  ]);
  if (!updated) throw new Error('Approved key removed the active Drive user');
  saveStoredDeviceLabels(updated.profileId, deviceLabels);
  return updated;
}

export async function activateDriveDeviceApprovalIfApproved(
  pendingApproval: PendingDriveDeviceApproval,
  appKeyNsec: string,
  options: { timeoutMs?: number } = {},
): Promise<DriveDeviceApprovalActivation | null> {
  const decoded = nip19.decode(appKeyNsec);
  if (decoded.type !== 'nsec') {
    throw new Error('Pending Drive AppKey is not an nsec');
  }
  const appKeySecretKey = decoded.data as Uint8Array;
  const appKeyPubkey = getPublicKey(appKeySecretKey);
  if (appKeyPubkey !== pendingApproval.request.deviceAppKeyPubkey) {
    throw new Error('Pending Drive AppKey does not match approval request');
  }
  const candidate = await fetchDriveDeviceApprovalCandidates(appKeyPubkey, options.timeoutMs ?? 5000)
    .then((candidates) => candidates[0] ?? null)
    .catch(() => null);
  if (candidate) {
    const activated = await activateDriveDeviceApprovalCandidate(
      candidate,
      appKeySecretKey,
      appKeyNsec,
      pendingApproval.request.label,
    );
    if (activated) return activated;
  }

  const requestSecretKey = driveDeviceApprovalRequestSecretKey(pendingApproval);
  const receipt = await fetchDriveDeviceApprovalReceipt(
    pendingApproval.request,
    requestSecretKey,
    options.timeoutMs,
  );
  if (!receipt) return null;
  const receiptRosterOp = parseNostrIdentityDeviceApprovalReceiptRosterOp(receipt);
  const remoteOps = await fetchNostrIdentityRosterOps(receipt.profileId, options.timeoutMs ?? 5000);
  const rosterOps = mergeRosterOps([receiptRosterOp], remoteOps);
  const projection = projectNostrIdentityRoster(receipt.profileId, rosterOps);
  const facet = projection.active_facets[appKeyPubkey];
  const latestEpoch = Object.values(projection.secret_epochs)
    .sort((left, right) => right.epoch - left.epoch)[0];
  if (!facet?.capabilities?.can_write_roots
    || !facet.capabilities.can_receive_secret_wraps
    || !facet.capabilities.can_decrypt_secret_epochs
    || !latestEpoch?.wrapped_secrets[appKeyPubkey]) {
    return null;
  }

  const session: NostrIdentitySession = {
    profileId: receipt.profileId,
    appKeyPubkey,
    appKeyNpub: nip19.npubEncode(appKeyPubkey),
    appKeyNsec,
    status: 'active',
    rosterOps,
    createdAt: pendingApproval.request.requestedAt,
    ...(pendingApproval.request.label ? { label: pendingApproval.request.label } : {}),
  };
  await applySecretKey(appKeySecretKey, DRIVE_DEFAULT_TREES, {
    nostrIdentityId: session.profileId,
  });
  const labels = await collectDriveDeviceLabels(session, rosterOps).catch(() => ({
    [session.appKeyPubkey]: session.label ?? currentBrowserDeviceLabel(),
  }));
  saveStoredDeviceLabels(session.profileId, labels);
  saveNostrIdentitySession(session);
  return {
    nsec: appKeyNsec,
    npub: session.appKeyNpub,
    session,
    receipt,
  };
}

async function activateDriveDeviceApprovalCandidate(
  candidate: NostrIdentityAppKeyApprovalCandidate,
  appKeySecretKey: Uint8Array,
  appKeyNsec: string,
  label?: string,
): Promise<DriveDeviceApprovalActivation | null> {
  const appKeyPubkey = getPublicKey(appKeySecretKey);
  const projection = projectNostrIdentityRoster(candidate.profileId, candidate.profileRosterOps);
  const facet = projection.active_facets[appKeyPubkey];
  const latestEpoch = Object.values(projection.secret_epochs)
    .sort((left, right) => right.epoch - left.epoch)[0];
  if (!facet?.capabilities?.can_write_roots
    || !facet.capabilities.can_receive_secret_wraps
    || !facet.capabilities.can_decrypt_secret_epochs
    || !latestEpoch?.wrapped_secrets[appKeyPubkey]) {
    return null;
  }

  const session: NostrIdentitySession = {
    profileId: candidate.profileId,
    appKeyPubkey,
    appKeyNpub: nip19.npubEncode(appKeyPubkey),
    appKeyNsec,
    status: 'active',
    rosterOps: candidate.profileRosterOps,
    createdAt: candidate.latestRosterOpCreatedAt ?? currentUnixSeconds(),
    ...(label?.trim() ? { label: label.trim() } : {}),
  };
  await applySecretKey(appKeySecretKey, DRIVE_DEFAULT_TREES, {
    nostrIdentityId: session.profileId,
  });
  const labels = await collectDriveDeviceLabels(session, candidate.profileRosterOps).catch(() => ({
    [session.appKeyPubkey]: session.label ?? currentBrowserDeviceLabel(),
  }));
  saveStoredDeviceLabels(session.profileId, labels);
  saveNostrIdentitySession(session);
  return {
    nsec: appKeyNsec,
    npub: session.appKeyNpub,
    session,
    receipt: {
      schema: 1,
      profileId: candidate.profileId,
      requestPubkey: '',
      deviceAppKeyPubkey: appKeyPubkey,
      approvedByPubkey: candidate.adminAppKeyPubkey,
      approvedAt: candidate.latestRosterOpCreatedAt ?? currentUnixSeconds(),
      requestSecret: '',
    },
  };
}

export async function createDriveDeviceLinkInvite(): Promise<DriveDeviceLinkInvite> {
  const session = requireActiveDriveIdentitySession();
  requireCurrentDriveAdmin(session);
  await publishCurrentDriveIdentityRosterOps(session);
  const inviteSecretKey = generateSecretKey();
  const invitePubkey = getPublicKey(inviteSecretKey);
  return {
    profileId: session.profileId,
    adminAppKeyPubkey: session.appKeyPubkey,
    invitePubkey,
    inviteSecretKeyNsec: nip19.nsecEncode(inviteSecretKey),
    url: encodeDeviceLinkInvite({
      profileId: session.profileId,
      adminAppKeyPubkey: session.appKeyPubkey,
      invitePubkey,
    }),
  };
}

export function subscribeDriveDeviceLinkRequestsForAdmin(
  scope: DriveDeviceLinkRequestScope,
  onRequests: (requests: DriveDeviceLinkRequest[]) => void,
): () => void {
  const requests = new Map<string, DriveDeviceLinkRequest>();
  let stopped = false;
  const emitRequests = () => {
    if (stopped) return;
    onRequests(Array.from(requests.values()).sort((left, right) => right.requestedAt - left.requestedAt));
  };
  const recordRequest = (request: DriveDeviceLinkRequest | null) => {
    if (!request || stopped) return;
    requests.set(request.id, request);
    emitRequests();
  };
  const filters = driveDeviceLinkRequestFilters(scope);
  const sub = ndk.subscribe(
    filters,
    { closeOnEose: false },
  );

  sub.on('event', (event) => {
    void (async () => {
      const parsed = await parseDriveDeviceLinkRequestEventForAdmin(event.rawEvent() as NostrToolsEvent, scope);
      recordRequest(parsed);
    })();
  });

  const backfill = () => {
    void backfillDriveDeviceLinkRequestsForAdmin(scope)
      .then((fetched) => {
        if (stopped) return;
        for (const request of fetched) {
          requests.set(request.id, request);
        }
        emitRequests();
      })
      .catch((error) => {
        console.warn('[auth] Could not backfill device link requests:', error);
      });
  };
  backfill();
  const backfillTimer = setInterval(backfill, 3000);

  return () => {
    stopped = true;
    clearInterval(backfillTimer);
    sub.stop();
  };
}

function driveDeviceLinkRequestFilters(scope: DriveDeviceLinkRequestScope): NDKFilter[] {
  return [
    {
      kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP as NDKKind],
      '#i': [scope.profileId],
      '#p': [scope.invitePubkey],
      limit: 200,
    },
    {
      kinds: [KIND_APP_DATA as NDKKind],
      '#d': [legacyDriveDeviceLinkRequestDTag(scope.profileId)],
      limit: 200,
    },
  ];
}

async function backfillDriveDeviceLinkRequestsForAdmin(
  scope: DriveDeviceLinkRequestScope,
  timeoutMs = 2500,
): Promise<DriveDeviceLinkRequest[]> {
  const events: NostrToolsEvent[] = [];

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      sub.stop();
      resolve();
    };
    const sub = ndk.subscribe(driveDeviceLinkRequestFilters(scope), { closeOnEose: true });
    const timer = setTimeout(finish, timeoutMs);

    sub.on('event', (event) => {
      events.push(event.rawEvent() as NostrToolsEvent);
    });
    sub.on('eose', finish);
  });

  const parsed = await Promise.all(
    events.map((event) => parseDriveDeviceLinkRequestEventForAdmin(event, scope)),
  );
  return parsed.filter((request): request is DriveDeviceLinkRequest => Boolean(request));
}

export function subscribeDriveDeviceLinkRequests(
  invite: Pick<DriveDeviceLinkInvite, 'profileId' | 'adminAppKeyPubkey' | 'invitePubkey' | 'inviteSecretKeyNsec'>,
  onRequests: (requests: DriveDeviceLinkRequest[]) => void,
): () => void {
  return subscribeDriveDeviceLinkRequestsForAdmin(driveDeviceLinkRequestScopeFromInvite(invite), onRequests);
}

function driveDeviceLinkRequestScopeFromInvite(
  invite: Pick<DriveDeviceLinkInvite, 'profileId' | 'adminAppKeyPubkey' | 'invitePubkey' | 'inviteSecretKeyNsec'>,
): DriveDeviceLinkRequestScope {
  const decoded = nip19.decode(invite.inviteSecretKeyNsec);
  if (decoded.type !== 'nsec') {
    throw new Error('Stored device-link invite secret is not an nsec');
  }
  const inviteSecretKey = decoded.data as Uint8Array;
  if (getPublicKey(inviteSecretKey) !== invite.invitePubkey) {
    throw new Error('Stored device-link invite secret does not match the invite pubkey');
  }
  return {
    profileId: invite.profileId,
    adminAppKeyPubkey: invite.adminAppKeyPubkey,
    invitePubkey: invite.invitePubkey,
    inviteSecretKey,
  };
}

export async function approveDriveDeviceLinkRequest(
  request: DeviceLinkRequest,
): Promise<NostrIdentitySession> {
  const session = requireActiveDriveIdentitySession();
  requireCurrentDriveAdmin(session);
  if (request.profileId !== session.profileId || request.adminAppKeyPubkey !== session.appKeyPubkey) {
    throw new Error('Device link request does not match the current Drive user');
  }
  if (!secretKey) throw new Error('No active Drive AppKey secret');

  const rosterOps = await currentDriveRosterOps(session);
  const approvedAt = currentUnixSeconds();
  const label = request.label?.trim();
  const deviceLabels = await collectDriveDeviceLabels(session, rosterOps);
  if (label) {
    deviceLabels[request.deviceAppKeyPubkey] = label;
  }
  const dckPlaintext = randomDriveContentKey();
  const secretEpoch = nextSecretEpochNumber(session.profileId, rosterOps);
  const encryptedDeviceLabels = await encryptDriveDeviceLabelsWithDck({
    schema: DRIVE_DEVICE_LABEL_SCHEMA,
    profileId: session.profileId,
    secretEpoch,
    labels: deviceLabels,
    updatedAt: approvedAt,
  }, dckPlaintext);
  const content = approveDeviceLinkRequest({
    request: { ...request, label: undefined },
    rosterOps,
    approvedByPubkey: session.appKeyPubkey,
    approvedAt,
    clientNonce: randomClientNonce(),
    capabilities: APP_KEY_WRITER_CAPABILITIES,
  });
  const signed = signNostrIdentityRosterOp({
    signerSecretKey: secretKey,
    profileId: content.profile_id,
    parents: content.parents,
    createdAt: content.created_at,
    clientNonce: content.client_nonce,
    encryptedDeviceLabels,
    op: content.op,
  });
  const dckRotationOp = await createNostrIdentityDckRotateAfterAddOp({
    profileId: session.profileId,
    signer: createNostrIdentitySignerFromNsec(session.appKeyNsec),
    rosterOps,
    parentRosterOp: signed,
    createdAt: approvedAt + 1,
    clientNonce: `${content.client_nonce}:rotate-dck`,
    dckPlaintext,
  });

  await publishCurrentDriveIdentityRosterOps({ ...session, rosterOps });
  await publishSignedIdentityEventJson(signed.event_json);
  await publishSignedIdentityEventJson(dckRotationOp.event_json);
  const updated = appendCurrentNostrIdentitySessionRosterOps(session.profileId, [
    ...rosterOps,
    signed,
    dckRotationOp,
  ]);
  if (!updated) throw new Error('Approved key removed the active Drive user');
  saveStoredDeviceLabels(updated.profileId, deviceLabels);
  return updated;
}

export async function setDriveProfileAppKeyAdmin(
  appKeyPubkey: string,
  admin: boolean,
): Promise<NostrIdentitySession> {
  const session = requireActiveDriveIdentitySession();
  requireCurrentDriveAdmin(session);
  if (!secretKey) throw new Error('No active Drive AppKey secret');
  const target = normalizeHexPubkey(appKeyPubkey);
  if (!target) throw new Error('Invalid Drive key');

  const rosterOps = await currentDriveRosterOps(session);
  const projection = projectNostrIdentityRoster(session.profileId, rosterOps);
  const facet = projection.active_facets[target];
  if (!facet) throw new Error('Drive key is not active');
  const capabilities: NostrIdentityCapabilities = { ...(facet.capabilities ?? {}) };
  if (admin) {
    capabilities.can_admin_profile = true;
  } else {
    delete capabilities.can_admin_profile;
  }

  const signed = signNostrIdentityRosterOp({
    signerSecretKey: secretKey,
    profileId: session.profileId,
    parents: projection.accepted_op_ids,
    createdAt: currentUnixSeconds(),
    clientNonce: randomClientNonce(),
    op: {
      op: 'set_capabilities',
      pubkey: target,
      capabilities,
    },
  });

  await publishCurrentDriveIdentityRosterOps({ ...session, rosterOps });
  await publishSignedIdentityEventJson(signed.event_json);
  const updated = appendCurrentNostrIdentitySessionRosterOps(session.profileId, [...rosterOps, signed]);
  if (!updated) throw new Error('Drive user session is no longer active');
  return updated;
}

export async function removeDriveProfileAppKeyWithAdmin(
  appKeyPubkey: string,
): Promise<NostrIdentitySession | null> {
  const session = requireActiveDriveIdentitySession();
  requireCurrentDriveAdmin(session);
  if (!secretKey) throw new Error('No active Drive AppKey secret');
  const target = normalizeHexPubkey(appKeyPubkey);
  if (!target) throw new Error('Invalid Drive key');
  if (target === session.appKeyPubkey) throw new Error('Use account removal to remove this device');

  const rosterOps = await currentDriveRosterOps(session);
  const projection = projectNostrIdentityRoster(session.profileId, rosterOps);
  if (!projection.active_facets[target]) throw new Error('Drive key is not active');
  const signed = signNostrIdentityRosterOp({
    signerSecretKey: secretKey,
    profileId: session.profileId,
    parents: projection.accepted_op_ids,
    createdAt: currentUnixSeconds(),
    clientNonce: randomClientNonce(),
    op: {
      op: 'tombstone_facet',
      pubkey: target,
      reason: 'removed from Drive settings',
    },
  });

  await publishCurrentDriveIdentityRosterOps({ ...session, rosterOps });
  await publishSignedIdentityEventJson(signed.event_json);
  return appendCurrentNostrIdentitySessionRosterOps(session.profileId, [...rosterOps, signed], target);
}

export async function activatePendingDriveDeviceLinkIfApproved(): Promise<NostrIdentitySession | null> {
  const session = currentNostrIdentitySession;
  if (!session || session.status !== 'pending_device_link') return session;
  const rosterOps = await fetchNostrIdentityRosterOps(session.profileId, 8000);
  if (rosterOps.length === 0) return session;
  const projection = projectNostrIdentityRoster(session.profileId, rosterOps);
  const facet = projection.active_facets[session.appKeyPubkey];
  const hasAdminFacet = Object.values(projection.active_facets)
    .some((candidate) => candidate.capabilities?.can_admin_profile);
  const latestEpoch = Object.values(projection.secret_epochs)
    .sort((left, right) => right.epoch - left.epoch)[0];
  if (!hasAdminFacet
    || !facet?.capabilities?.can_write_roots
    || !facet.capabilities.can_receive_secret_wraps
    || !facet.capabilities.can_decrypt_secret_epochs
    || !latestEpoch?.wrapped_secrets[session.appKeyPubkey]) {
    return session;
  }
  const activeSession: NostrIdentitySession = {
    ...session,
    status: 'active',
    rosterOps,
  };
  const decoded = nip19.decode(session.appKeyNsec);
  if (decoded.type !== 'nsec') {
    throw new Error('Pending Drive AppKey is not an nsec');
  }
  await applySecretKey(decoded.data as Uint8Array, DRIVE_DEFAULT_TREES, {
    nostrIdentityId: activeSession.profileId,
  });
  const labels = await collectDriveDeviceLabels(activeSession, rosterOps).catch(() => ({
    [activeSession.appKeyPubkey]: activeSession.label ?? currentBrowserDeviceLabel(),
  }));
  saveStoredDeviceLabels(activeSession.profileId, labels);
  saveNostrIdentitySession(activeSession);
  return activeSession;
}

export async function recoverDriveProfileWithAppKey(
  options: DriveRecoveryAppKeyOptions,
): Promise<{ nsec: string; npub: string; session: NostrIdentitySession }> {
  const signer = await createRecoverySigner(options.recovery);
  const explicitProfileId = options.profileId ? normalizeProfileId(options.profileId) : null;
  const { profileId, rosterOps } = explicitProfileId
    ? {
        profileId: explicitProfileId,
        rosterOps: await fetchNostrIdentityRosterOps(explicitProfileId, options.rosterFetchTimeoutMs),
      }
    : await discoverRecoverableNostrIdentityRoster(signer, options.rosterFetchTimeoutMs);
  if (rosterOps.length === 0) {
    throw new Error('No Drive user found for that recovery key');
  }

  const createdAt = currentUnixSeconds();
  const localLabel = options.label?.trim() || currentBrowserDeviceLabel();
  const appKeySecretKey = generateSecretKey();
  const appKeyPubkey = getPublicKey(appKeySecretKey);
  const encryptedDeviceLabels = await encryptedDeviceLabelsForRecoveryAttach({
    profileId,
    rosterOps,
    signer,
    appKeyPubkey,
    label: localLabel,
    updatedAt: createdAt,
  });
  const { attachment, session } = await createAttachedNostrIdentitySession({
    profileId,
    signer,
    rosterOps,
    appKeySecretKey,
    createdAt,
    encryptedDeviceLabels,
    clientNonce: randomClientNonce(),
  });
  const dckRewrapOp = await createNostrIdentityDckRewrapOp({
    profileId,
    signer,
    rosterOps,
    appKeyPubkey: attachment.appKeyPubkey,
    parentRosterOp: attachment.rosterOp,
  });
  const activeSession: NostrIdentitySession = {
    ...session,
    label: localLabel,
    rosterOps: dckRewrapOp ? [...session.rosterOps, dckRewrapOp] : session.rosterOps,
  };

  await publishSignedIdentityEventJson(attachment.rosterOp.event_json);
  await publishSignedIdentityEventJson(attachment.facetAcceptance.event_json);
  if (dckRewrapOp) {
    await publishSignedIdentityEventJson(dckRewrapOp.event_json);
  }
  saveNostrIdentitySession(activeSession);
  saveStoredDeviceLabel(activeSession.profileId, activeSession.appKeyPubkey, activeSession.label);

  const decoded = nip19.decode(session.appKeyNsec);
  if (decoded.type !== 'nsec') {
    throw new Error('attached Drive AppKey is not an nsec');
  }
  const decodedAppKeySecretKey = decoded.data as Uint8Array;
  return {
    ...(await applySecretKey(decodedAppKeySecretKey, DRIVE_DEFAULT_TREES, {
      nostrIdentityId: activeSession.profileId,
    })),
    session: activeSession,
  };
}

export async function removeDriveProfileAppKeyWithRecovery(
  options: DriveRecoveryRemoveAppKeyOptions,
): Promise<DriveRecoveryRemoveAppKeyResult> {
  const profileId = normalizeProfileId(options.profileId);
  const signer = await createRecoverySigner(options.recovery);
  const rosterOps = await fetchNostrIdentityRosterOps(profileId, options.rosterFetchTimeoutMs);
  if (rosterOps.length === 0) {
    throw new Error('No Drive user found for that profile');
  }

  const dckRotation = { op: null as SignedNostrIdentityRosterOp | null };
  const removal = await removeNostrAppKeyFromIdentity({
    profileId,
    signer,
    rosterOps,
    appKeyPubkey: options.appKeyPubkey,
    reason: options.reason,
    clientNonce: randomClientNonce(),
    rewrapSecrets: async (context) => {
      dckRotation.op = await createNostrIdentityDckRotateAfterRemovalOp({
        profileId,
        signer,
        rosterOps,
        parentRosterOp: context.rosterOp,
      });
      if (!dckRotation.op) {
        return [{
          secretId: 'drive-dck',
          status: 'skipped',
          detail: 'no existing Drive key epoch',
        }];
      }
      return [{
        secretId: 'drive-dck',
        status: 'rotated',
        epoch: dckRotation.op.content.op.op === 'rotate_secret_epoch'
          ? dckRotation.op.content.op.epoch
          : undefined,
      }];
    },
  });

  await publishSignedIdentityEventJson(removal.rosterOp.event_json);
  const dckRotationOp = dckRotation.op;
  if (dckRotationOp) {
    await publishSignedIdentityEventJson(dckRotationOp.event_json);
  }

  const session = appendCurrentNostrIdentitySessionRosterOps(
    profileId,
    [removal.rosterOp, ...(dckRotationOp ? [dckRotationOp] : [])],
    removal.appKeyPubkey,
  );
  return { removal, dckRotationOp, session };
}

/**
 * Create default folders for a new user
 */
async function createDefaultFolders() {
  await createDefaultTrees(CLASSIC_DEFAULT_TREES);
}

async function createDefaultTrees(defaults: readonly DefaultTree[]) {
  try {
    const waitMs = isTestMode ? 15000 : 5000;
    let adapter = await waitForWorkerAdapter(waitMs);
    if (!adapter && isTestMode) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      adapter = await waitForWorkerAdapter(10000);
    }
    if (!adapter) {
      throw new Error('Backend not ready');
    }

    const { createTree } = await import('../actions');
    const { getLocalRootCache } = await import('../treeRootCache');
    const state = nostrStore.getState();
    if (!state.npub) return;

    for (const { name, visibility } of defaults) {
      if (getLocalRootCache(state.npub, name)) continue;
      await createTree(name, visibility, true);
    }
  } catch (e) {
    console.error('Failed to create default folders:', e);
  }
}

async function ensureTestDefaultFolders(): Promise<void> {
  if (!isTestMode) return;

  const state = nostrStore.getState();
  if (!state.npub) return;

  const { getLocalRootCache } = await import('../treeRootCache');
  const defaults = ['public', 'link', 'private'];
  if (defaults.some(name => getLocalRootCache(state.npub!, name))) {
    return;
  }

  const { getRefResolver } = await import('../refResolver');
  const resolver = getRefResolver();

  const entries = await new Promise<{ key: string }[]>((resolve) => {
    let resolved = false;
    const unsub = resolver.list?.(state.npub!, (list) => {
      if (resolved) return;
      resolved = true;
      setTimeout(() => unsub?.(), 0);
      resolve(list);
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsub?.();
        resolve([]);
      }
    }, 1500);
  });

  if (entries.length > 0) return;
  await createDefaultFolders();
}

/**
 * Publish initial profile with npub.cash lightning address
 */
async function publishInitialProfile(npub: string) {
  const lud16 = `${npub}@npub.cash`;

  const event = new NDKEvent(ndk);
  event.kind = 0;
  event.content = JSON.stringify({
    lud16,
  });

  await event.publish();
  console.log('[auth] Published initial profile with lud16:', lud16);
}

/**
 * Logout
 */
export function logout() {
  nostrStore.setPubkey(null);
  nostrStore.setNpub(null);
  nostrStore.setIsLoggedIn(false);
  nostrStore.setSelectedTree(null);
  secretKey = null;
  ndk.signer = undefined;

  stopWebRTC();

  // Dispose wallet
  disposeWallet().catch(e => {
    console.error('Wallet disposal failed:', e);
  });

  localStorage.removeItem(STORAGE_KEY_LOGIN_TYPE);
  localStorage.removeItem(STORAGE_KEY_NSEC);
  currentNostrIdentitySession = null;
}

function saveNostrIdentitySession(session: NostrIdentitySession): void {
  currentNostrIdentitySession = session;
  const stored = serializeDriveIdentitySession(session);
  const sessions = loadStoredNostrIdentitySessions();
  sessions[session.appKeyPubkey] = stored;
  localStorage.setItem(STORAGE_KEY_IRIS_IDENTITY_SESSIONS, JSON.stringify(sessions));
  localStorage.setItem(STORAGE_KEY_IRIS_IDENTITY, JSON.stringify(stored));
  const state = nostrStore.getState();
  if (state.pubkey === session.appKeyPubkey) {
    nostrStore.setState({});
  }
}

function appendCurrentNostrIdentitySessionRosterOps(
  profileId: NostrIdentityId,
  rosterOps: SignedNostrIdentityRosterOp[],
  removedAppKeyPubkey?: string,
): NostrIdentitySession | null {
  if (!currentNostrIdentitySession || currentNostrIdentitySession.profileId !== profileId) {
    return currentNostrIdentitySession;
  }

  const removed = removedAppKeyPubkey ? normalizeHexPubkey(removedAppKeyPubkey) : null;
  if (removed) {
    removeStoredNostrIdentitySession(removed);
  }
  if (removed && currentNostrIdentitySession.appKeyPubkey === removed) {
    currentNostrIdentitySession = null;
    localStorage.removeItem(STORAGE_KEY_IRIS_IDENTITY);
    return null;
  }

  const known = new Set(currentNostrIdentitySession.rosterOps.map((op) => op.op_id));
  const newOps = rosterOps.filter((op) => !known.has(op.op_id));
  if (newOps.length === 0) {
    return currentNostrIdentitySession;
  }
  const session: NostrIdentitySession = {
    ...currentNostrIdentitySession,
    rosterOps: [...currentNostrIdentitySession.rosterOps, ...newOps],
  };
  saveNostrIdentitySession(session);
  return session;
}

function restoreStoredNostrIdentitySession(): NostrIdentitySession | null {
  const activeAccountPubkey = accountsStore.getState().activeAccountPubkey;
  const sessions = loadStoredNostrIdentitySessions();
  const legacyRaw = localStorage.getItem(STORAGE_KEY_IRIS_IDENTITY);
  const legacyStored = legacyRaw ? parseStoredNostrIdentitySession(legacyRaw) : null;
  if (legacyStored?.status === 'pending_device_link') {
    return activateStoredNostrIdentitySession(legacyStored);
  }

  const storedForActiveAccount = activeAccountPubkey ? sessions[activeAccountPubkey] : undefined;
  if (storedForActiveAccount) {
    return activateStoredNostrIdentitySession(storedForActiveAccount);
  }

  if (!legacyRaw) {
    currentNostrIdentitySession = null;
    return null;
  }
  if (!legacyStored) {
    localStorage.removeItem(STORAGE_KEY_IRIS_IDENTITY);
    currentNostrIdentitySession = null;
    return null;
  }
  try {
    const legacySession = restoreDriveIdentitySession(legacyStored);
    saveNostrIdentitySession(legacySession);
    if (activeAccountPubkey && activeAccountPubkey !== legacySession.appKeyPubkey) {
      currentNostrIdentitySession = null;
      return null;
    }
    return activateStoredNostrIdentitySession(legacyStored);
  } catch (error) {
    console.warn('[auth] Ignoring invalid Iris identity session:', error);
    localStorage.removeItem(STORAGE_KEY_IRIS_IDENTITY);
    currentNostrIdentitySession = null;
    return null;
  }
}

function parseStoredNostrIdentitySession(raw: string): StoredNostrIdentitySession | null {
  try {
    return JSON.parse(raw) as StoredNostrIdentitySession;
  } catch (error) {
    console.warn('[auth] Ignoring invalid Iris identity session:', error);
    return null;
  }
}

function activateStoredNostrIdentitySession(stored: StoredNostrIdentitySession): NostrIdentitySession | null {
  try {
    const session = restoreDriveIdentitySession(stored);
    currentNostrIdentitySession = session;
    accountsStore.updateAccount(session.appKeyPubkey, {
      type: 'drive_profile',
      nostrIdentityId: session.profileId,
      nsec: session.appKeyNsec,
    });
    localStorage.setItem(STORAGE_KEY_IRIS_IDENTITY, JSON.stringify(serializeDriveIdentitySession(session)));
    return session;
  } catch (error) {
    console.warn('[auth] Ignoring invalid Iris identity session:', error);
    currentNostrIdentitySession = null;
    return null;
  }
}

function loadStoredNostrIdentitySessions(): Record<string, StoredNostrIdentitySession> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_IRIS_IDENTITY_SESSIONS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const sessions: Record<string, StoredNostrIdentitySession> = {};
    for (const [appKeyPubkey, stored] of Object.entries(parsed)) {
      const normalizedPubkey = normalizeHexPubkey(appKeyPubkey);
      if (!normalizedPubkey || !stored || typeof stored !== 'object') continue;
      sessions[normalizedPubkey] = stored as StoredNostrIdentitySession;
    }
    return sessions;
  } catch {
    return {};
  }
}

export function getStoredNostrIdentitySessionForAccount(appKeyPubkey: string): NostrIdentitySession | null {
  const normalized = normalizeHexPubkey(appKeyPubkey);
  if (!normalized) return null;
  const stored = loadStoredNostrIdentitySessions()[normalized];
  if (!stored) return null;
  try {
    return restoreDriveIdentitySession(stored);
  } catch (error) {
    console.warn('[auth] Ignoring invalid Iris identity session:', error);
    return null;
  }
}

function removeStoredNostrIdentitySession(appKeyPubkey: string): void {
  const normalized = normalizeHexPubkey(appKeyPubkey);
  if (!normalized) return;
  const sessions = loadStoredNostrIdentitySessions();
  delete sessions[normalized];
  localStorage.setItem(STORAGE_KEY_IRIS_IDENTITY_SESSIONS, JSON.stringify(sessions));
}

function createDriveIdentitySession(options: {
  profileId?: NostrIdentityId;
  appKeySecretKey: Uint8Array;
  createdAt?: number;
  clientNonce?: string;
  label?: string;
  encryptedDeviceLabels?: string;
}): NostrIdentitySession {
  const appKeyPubkey = getPublicKey(options.appKeySecretKey);
  const profileId = options.profileId ?? randomProfileId();
  const createdAt = options.createdAt ?? currentUnixSeconds();
  const label = options.label?.trim() || currentBrowserDeviceLabel();
  const bootstrap = signNostrIdentityRosterOp({
    signerSecretKey: options.appKeySecretKey,
    profileId,
    createdAt,
    clientNonce: options.clientNonce ?? randomClientNonce(),
    encryptedDeviceLabels: options.encryptedDeviceLabels,
    op: {
      op: 'add_facet',
      facet: {
        pubkey: appKeyPubkey,
        purposes: ['app_key'],
        capabilities: DRIVE_APP_KEY_ADMIN_CAPABILITIES,
        added_at: createdAt,
      },
    },
  });

  return {
    profileId,
    appKeyPubkey,
    appKeyNpub: nip19.npubEncode(appKeyPubkey),
    appKeyNsec: nip19.nsecEncode(options.appKeySecretKey),
    status: 'active',
    rosterOps: [bootstrap],
    createdAt,
    label,
  };
}

function serializeDriveIdentitySession(session: NostrIdentitySession): StoredNostrIdentitySession {
  return {
    schema: 1,
    profileId: session.profileId,
    appKeyNsec: session.appKeyNsec,
    status: session.status,
    rosterOps: session.rosterOps,
    createdAt: session.createdAt,
    ...(session.label ? { label: session.label } : {}),
    ...(session.pendingDeviceLink ? { pendingDeviceLink: session.pendingDeviceLink } : {}),
    ...(session.pendingDeviceApproval ? { pendingDeviceApproval: session.pendingDeviceApproval } : {}),
  };
}

function restoreDriveIdentitySession(stored: StoredNostrIdentitySession): NostrIdentitySession {
  if (stored.schema !== 1) {
    throw new Error(`unsupported Iris identity session schema ${stored.schema}`);
  }
  const decoded = nip19.decode(stored.appKeyNsec);
  if (decoded.type !== 'nsec') {
    throw new Error('stored Iris identity AppKey is not an nsec');
  }
  const appKeySecretKey = decoded.data as Uint8Array;
  const appKeyPubkey = getPublicKey(appKeySecretKey);
  const rosterOps = Array.isArray(stored.rosterOps) ? stored.rosterOps : [];

  if (stored.status === 'active') {
    const projection = projectNostrIdentityRoster(stored.profileId, rosterOps);
    if (!projection.active_facets[appKeyPubkey]) {
      throw new Error('stored Iris identity AppKey is not active in its Drive roster');
    }
  } else if (stored.status !== 'pending_device_link') {
    throw new Error(`unsupported Iris identity session status ${stored.status}`);
  }

  return {
    profileId: stored.profileId,
    appKeyPubkey,
    appKeyNpub: nip19.npubEncode(appKeyPubkey),
    appKeyNsec: stored.appKeyNsec,
    status: stored.status,
    rosterOps,
    createdAt: Number.isFinite(stored.createdAt) ? stored.createdAt : currentUnixSeconds(),
    ...(stored.label ? { label: stored.label } : {}),
    ...(stored.pendingDeviceLink ? { pendingDeviceLink: stored.pendingDeviceLink } : {}),
    ...(stored.pendingDeviceApproval ? { pendingDeviceApproval: stored.pendingDeviceApproval } : {}),
  };
}

function requireActiveDriveIdentitySession(): NostrIdentitySession {
  const session = currentNostrIdentitySession;
  if (!session || session.status !== 'active') {
    throw new Error('No active Drive user');
  }
  return session;
}

function requireCurrentDriveAdmin(session: NostrIdentitySession): void {
  const projection = projectNostrIdentityRoster(session.profileId, session.rosterOps);
  if (!projection.active_facets[session.appKeyPubkey]?.capabilities?.can_admin_profile) {
    throw new Error('Current Drive key is not an admin');
  }
}

async function currentDriveRosterOps(session: NostrIdentitySession): Promise<SignedNostrIdentityRosterOp[]> {
  const remoteOps = await fetchNostrIdentityRosterOps(session.profileId, 3000);
  return mergeRosterOps(session.rosterOps, remoteOps);
}

async function collectDriveDeviceLabels(
  session: NostrIdentitySession,
  rosterOps: SignedNostrIdentityRosterOp[] = session.rosterOps,
): Promise<Record<string, string>> {
  const labels = readStoredDeviceLabels(session.profileId);
  const dckPlaintext = await currentDriveDckPlaintext(session, rosterOps);
  if (dckPlaintext) {
    for (const op of rosterOps) {
      for (const encrypted of encryptedDeviceLabelPayloadsFromEventJson(op.event_json)) {
        const payload = await decryptDriveDeviceLabelsWithDck(encrypted, dckPlaintext);
        if (payload?.profileId === session.profileId) {
          Object.assign(labels, payload.labels);
        }
      }
    }
  }

  const currentLabel = session.label?.trim() || currentBrowserDeviceLabel();
  if (currentLabel) labels[session.appKeyPubkey] = currentLabel;
  return labels;
}

async function encryptedDeviceLabelsForRecoveryAttach(options: {
  profileId: NostrIdentityId;
  rosterOps: SignedNostrIdentityRosterOp[];
  signer: NostrIdentityEventSigner;
  appKeyPubkey: string;
  label: string;
  updatedAt: number;
}): Promise<string | undefined> {
  if (!options.signer.nip44Decrypt) return undefined;
  const signerPubkey = normalizeHexPubkey(await options.signer.getPublicKey());
  if (!signerPubkey) return undefined;
  const projection = projectNostrIdentityRoster(options.profileId, options.rosterOps);
  const latestEpoch = Object.values(projection.secret_epochs)
    .sort((left, right) => right.epoch - left.epoch)[0];
  const wrapped = latestEpoch?.wrapped_secrets[signerPubkey];
  if (!latestEpoch || !wrapped) return undefined;

  try {
    const dckPlaintext = await options.signer.nip44Decrypt(latestEpoch.signed_by_pubkey, wrapped);
    const labels = readStoredDeviceLabels(options.profileId);
    for (const op of options.rosterOps) {
      for (const encrypted of encryptedDeviceLabelPayloadsFromEventJson(op.event_json)) {
        const payload = await decryptDriveDeviceLabelsWithDck(encrypted, dckPlaintext);
        if (payload?.profileId === options.profileId) {
          Object.assign(labels, payload.labels);
        }
      }
    }
    labels[options.appKeyPubkey] = options.label;
    return encryptDriveDeviceLabelsWithDck({
      schema: DRIVE_DEVICE_LABEL_SCHEMA,
      profileId: options.profileId,
      secretEpoch: latestEpoch.epoch + 1,
      labels,
      updatedAt: options.updatedAt,
    }, dckPlaintext);
  } catch {
    return undefined;
  }
}

function nextSecretEpochNumber(profileId: NostrIdentityId, rosterOps: SignedNostrIdentityRosterOp[]): number {
  const projection = projectNostrIdentityRoster(profileId, rosterOps);
  const latestEpoch = Object.values(projection.secret_epochs)
    .sort((left, right) => right.epoch - left.epoch)[0];
  return (latestEpoch?.epoch ?? 0) + 1;
}

async function currentDriveDckPlaintext(
  session: NostrIdentitySession,
  rosterOps: SignedNostrIdentityRosterOp[] = session.rosterOps,
): Promise<string | null> {
  if (!secretKey) return null;
  const projection = projectNostrIdentityRoster(session.profileId, rosterOps);
  const latestEpoch = Object.values(projection.secret_epochs)
    .sort((left, right) => right.epoch - left.epoch)[0];
  const wrapped = latestEpoch?.wrapped_secrets[session.appKeyPubkey];
  if (!latestEpoch || !wrapped) return null;
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(secretKey, latestEpoch.signed_by_pubkey);
    return nip44.v2.decrypt(wrapped, conversationKey);
  } catch {
    return null;
  }
}

function mergeRosterOps(
  localOps: SignedNostrIdentityRosterOp[],
  remoteOps: SignedNostrIdentityRosterOp[],
): SignedNostrIdentityRosterOp[] {
  const byId = new Map<string, SignedNostrIdentityRosterOp>();
  for (const op of [...localOps, ...remoteOps]) {
    byId.set(op.op_id, op);
  }
  return Array.from(byId.values())
    .sort((left, right) => left.content.created_at - right.content.created_at || left.op_id.localeCompare(right.op_id));
}

async function publishCurrentDriveIdentityRosterOps(session: NostrIdentitySession): Promise<void> {
  for (const op of session.rosterOps) {
    await publishSignedIdentityEventJson(op.event_json);
  }
}

async function publishDriveDeviceLinkRequest(
  session: NostrIdentitySession,
  appKeySecretKey: Uint8Array,
): Promise<void> {
  const request = session.pendingDeviceLink;
  if (!request) return;
  const event = signDeviceLinkRequestEvent({
    signerSecretKey: appKeySecretKey,
    request,
  });
  await publishRawNostrEvent(event);
}

export async function parseDriveDeviceLinkRequestEventForAdmin(
  event: NostrToolsEvent,
  scope: DriveDeviceLinkRequestScope,
): Promise<DriveDeviceLinkRequest | null> {
  try {
    if (event.kind === KIND_NOSTR_IDENTITY_ROSTER_OP) {
      return parseIdentityDriveDeviceLinkRequestEvent(event, scope);
    }
    if (event.kind === KIND_APP_DATA) {
      return parseLegacyDriveDeviceLinkRequestEvent(event, scope);
    }
    return null;
  } catch {
    return null;
  }
}

function parseIdentityDriveDeviceLinkRequestEvent(
  event: NostrToolsEvent,
  scope: DriveDeviceLinkRequestScope,
): DriveDeviceLinkRequest | null {
  try {
    return driveDeviceLinkRequestFromRequest(parseIdentityDeviceLinkRequestEvent(event, scope).request);
  } catch {
    return null;
  }
}

type LegacyDriveDeviceLinkRequestFrame = {
  schema?: unknown;
  profile_id?: unknown;
  admin_app_key_pubkey?: unknown;
  app_key_pubkey?: unknown;
  invite_pubkey?: unknown;
  label?: unknown;
  requested_at?: unknown;
};

function parseLegacyDriveDeviceLinkRequestEvent(
  event: NostrToolsEvent,
  scope: DriveDeviceLinkRequestScope,
): DriveDeviceLinkRequest | null {
  if (!verifyEvent(event)) return null;
  const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1];
  if (dTag !== legacyDriveDeviceLinkRequestDTag(scope.profileId)) return null;

  const frame = JSON.parse(event.content) as LegacyDriveDeviceLinkRequestFrame;
  if (frame.schema !== 1 || frame.profile_id !== scope.profileId) return null;

  const deviceAppKeyPubkey = typeof frame.app_key_pubkey === 'string'
    ? normalizeHexPubkey(frame.app_key_pubkey)
    : null;
  if (!deviceAppKeyPubkey || normalizeHexPubkey(event.pubkey) !== deviceAppKeyPubkey) return null;

  const adminAppKeyPubkey = typeof frame.admin_app_key_pubkey === 'string'
    ? normalizeHexPubkey(frame.admin_app_key_pubkey)
    : null;
  if (adminAppKeyPubkey !== scope.adminAppKeyPubkey) return null;

  const invitePubkey = typeof frame.invite_pubkey === 'string'
    ? normalizeHexPubkey(frame.invite_pubkey)
    : null;
  if (invitePubkey !== scope.invitePubkey) return null;

  const requestedAt = typeof frame.requested_at === 'number'
    ? frame.requested_at
    : Number(frame.requested_at);
  if (!Number.isSafeInteger(requestedAt) || requestedAt <= 0) return null;

  const label = typeof frame.label === 'string' && frame.label.trim()
    ? frame.label.trim()
    : undefined;
  return driveDeviceLinkRequestFromRequest({
    profileId: scope.profileId,
    adminAppKeyPubkey: scope.adminAppKeyPubkey,
    invitePubkey: scope.invitePubkey,
    deviceAppKeyPubkey,
    requestedAt,
    ...(label ? { label } : {}),
  });
}

function driveDeviceLinkRequestFromRequest(request: DeviceLinkRequest): DriveDeviceLinkRequest {
  return {
    id: `${request.profileId}:${request.deviceAppKeyPubkey}:${request.requestedAt}`,
    request,
    pubkey: request.deviceAppKeyPubkey,
    label: request.label,
    requestedAt: request.requestedAt,
  };
}

function legacyDriveDeviceLinkRequestDTag(profileId: NostrIdentityId): string {
  return `iris-drive/${profileId}/app-key-link-request`;
}

function validateDriveDeviceApprovalRequest(
  request: DriveDeviceApprovalRequest,
  session: NostrIdentitySession,
): void {
  if (request.requestType !== DEVICE_APPROVAL_REQUEST_TYPE) {
    throw new Error('Device approval request is not for Drive device linking');
  }
  const profileId = isCompactDriveDeviceApprovalRequest(request) ? undefined : request.profileId;
  const adminAppKeyPubkey = isCompactDriveDeviceApprovalRequest(request) ? undefined : request.adminAppKeyPubkey;
  const expiresAt = isCompactDriveDeviceApprovalRequest(request) ? undefined : request.expiresAt;
  if (profileId !== undefined && profileId !== session.profileId) {
    throw new Error('Device approval request is for another Drive user');
  }
  if (adminAppKeyPubkey !== undefined && adminAppKeyPubkey !== session.appKeyPubkey) {
    throw new Error('Device approval request is for another Drive admin');
  }
  if (expiresAt !== undefined && expiresAt < currentUnixSeconds()) {
    throw new Error('Device approval request has expired');
  }
  const requestedResources = JSON.stringify(request.resources ?? []);
  for (const resource of DRIVE_DEVICE_APPROVAL_RESOURCES) {
    const requiredScopes = resource.scopes ?? [];
    const matching = request.resources?.find((candidate) => (
      candidate.type === resource.type
        && candidate.id === resource.id
        && requiredScopes.every((scope) => candidate.scopes?.includes(scope))
    ));
    if (!matching) {
      throw new Error('Device approval request is missing Drive access scope');
    }
  }
  if (requestedResources.includes(session.appKeyPubkey)) {
    throw new Error('Device approval request should not target the approving AppKey');
  }
}

async function fetchDriveDeviceApprovalReceipt(
  request: FullDriveDeviceApprovalRequest,
  requestSecretKey: Uint8Array,
  timeoutMs = 5000,
): Promise<NostrIdentityDeviceApprovalReceipt | null> {
  await waitForWorkerAdapter(2000).catch(() => null);
  let receipt: NostrIdentityDeviceApprovalReceipt | null = null;

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      sub.stop();
      resolve();
    };
    const filter: NDKFilter<number> = {
      kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP],
      '#p': [request.requestPubkey],
      limit: 50,
    };
    const sub = ndk.subscribe(filter, { closeOnEose: true });
    const timer = setTimeout(finish, timeoutMs);

    sub.on('event', (event) => {
      try {
        const raw = event.rawEvent() as NostrToolsEvent;
        if (!verifyEvent(raw)) return;
        const parsed = parseNostrIdentityDeviceApprovalReceiptEvent(raw, {
          requestSecretKey,
          request,
        });
        receipt = parsed;
        finish();
      } catch {
        // Other fact events can share the request pubkey tag; ignore them.
      }
    });
    sub.on('eose', finish);
  });

  return receipt;
}


async function createRecoverySigner(recovery: DriveRecoveryRequest): Promise<NostrIdentityEventSigner> {
  if (recovery.method === 'nsec') {
    if (!recovery.nsec?.trim()) throw new Error('Enter your secret key');
    return createNostrIdentitySignerFromNsec(recovery.nsec);
  }
  if (recovery.method === 'seed_phrase') {
    if (!recovery.seedWords?.trim()) throw new Error('Enter your seed phrase');
    return createNostrIdentitySignerFromSeedPhrase({
      seedWords: recovery.seedWords,
      ...(recovery.seedPassphrase !== undefined ? { passphrase: recovery.seedPassphrase } : {}),
    });
  }
  if (recovery.method === 'nip07') {
    const nostr = (window as unknown as { nostr?: Parameters<typeof createNostrIdentitySignerFromNip07>[0] }).nostr;
    if (!nostr) throw new Error('No nostr extension found');
    return createNostrIdentitySignerFromNip07(nostr);
  }

  const connection = recovery.nip46Connection?.trim();
  if (!connection) throw new Error('Enter a remote signer');
  const relay = recovery.nip46Relay?.trim();
  const remoteSigner = new NDKNip46Signer(
    ndk,
    connection,
    undefined,
    relay ? [relay] : undefined,
  );
  remoteSigner.timeout = 30_000;
  await remoteSigner.blockUntilReady();
  return createNostrIdentitySignerFromNip46({
    getPublicKey: async () => (await remoteSigner.user()).pubkey,
    signEvent: async (draft) => {
      const event = new NDKEvent(ndk);
      event.kind = draft.kind;
      event.content = draft.content;
      event.tags = draft.tags.map((tag: string[]) => tag.slice());
      event.created_at = draft.created_at;
      await event.sign(remoteSigner);
      return event.rawEvent() as NostrToolsEvent;
    },
    nip44Encrypt: (recipientPubkey, plaintext) => remoteSigner.encrypt(
      ndk.getUser({ pubkey: recipientPubkey }),
      plaintext,
      'nip44',
    ),
    nip44Decrypt: (senderPubkey, ciphertext) => remoteSigner.decrypt(
      ndk.getUser({ pubkey: senderPubkey }),
      ciphertext,
      'nip44',
    ),
  });
}

async function fetchNostrIdentityRosterOps(
  profileId: NostrIdentityId,
  timeoutMs = 5000,
): Promise<SignedNostrIdentityRosterOp[]> {
  await waitForWorkerAdapter(2000).catch(() => null);
  const byId = new Map<string, SignedNostrIdentityRosterOp>();

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      sub.stop();
      resolve();
    };
    const filter: NDKFilter<number> = {
      kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP],
      '#i': [profileId],
      limit: 500,
    };
    const sub = ndk.subscribe(filter, { closeOnEose: true });
    const timer = setTimeout(finish, timeoutMs);

    sub.on('event', (event) => {
      try {
        const raw = event.rawEvent() as NostrToolsEvent;
        if (!verifyEvent(raw)) {
          console.warn('[auth] Ignoring Iris identity roster event with invalid signature');
          return;
        }
        const signed = parseNostrIdentityRosterOpEvent(raw);
        if (signed.content.profile_id === profileId) {
          byId.set(signed.op_id, signed);
        }
      } catch (error) {
        console.warn('[auth] Ignoring invalid Iris identity roster event:', error);
      }
    });
    sub.on('eose', finish);
  });

  return Array.from(byId.values())
    .sort((left, right) => left.content.created_at - right.content.created_at || left.op_id.localeCompare(right.op_id));
}

async function fetchDriveDeviceApprovalCandidates(
  appKeyPubkey: string,
  timeoutMs = 5000,
): Promise<NostrIdentityAppKeyApprovalCandidate[]> {
  const discoveryEvents = await fetchRawNostrEvents(
    nostrIdentityAppKeyApprovalCandidateFilters(appKeyPubkey) as NDKFilter<number>[],
    timeoutMs,
  );
  const profileIds = new Set<NostrIdentityId>();
  for (const event of discoveryEvents) {
    try {
      const op = parseNostrIdentityRosterOpEvent(event);
      profileIds.add(op.content.profile_id);
    } catch {
      // The discovery filter can include non-roster events on noisy relays.
    }
  }
  const rosterEvents: NostrToolsEvent[] = [];
  for (const profileId of profileIds) {
    const ops = await fetchNostrIdentityRosterOps(profileId, timeoutMs);
    for (const op of ops) {
      rosterEvents.push(JSON.parse(op.event_json) as NostrToolsEvent);
    }
  }
  return nostrIdentityAppKeyApprovalCandidatesFromEvents(appKeyPubkey, [
    ...discoveryEvents,
    ...rosterEvents,
  ]);
}

async function fetchRawNostrEvents(
  filters: NDKFilter<number>[],
  timeoutMs = 5000,
): Promise<NostrToolsEvent[]> {
  await waitForWorkerAdapter(2000).catch(() => null);
  const byId = new Map<string, NostrToolsEvent>();

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      sub.stop();
      resolve();
    };
    const sub = ndk.subscribe(filters, { closeOnEose: true });
    const timer = setTimeout(finish, timeoutMs);

    sub.on('event', (event) => {
      const raw = event.rawEvent() as NostrToolsEvent;
      if (!verifyEvent(raw)) {
        console.warn('[auth] Ignoring Iris identity discovery event with invalid signature');
        return;
      }
      byId.set(raw.id, raw);
    });
    sub.on('eose', finish);
  });

  return Array.from(byId.values())
    .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
}

async function discoverRecoverableNostrIdentityRoster(
  signer: NostrIdentityEventSigner,
  timeoutMs = 5000,
): Promise<{ profileId: NostrIdentityId; rosterOps: SignedNostrIdentityRosterOp[] }> {
  const signerPubkey = normalizeHexPubkey(await signer.getPublicKey());
  if (!signerPubkey) throw new Error('Recovery signer pubkey is invalid');

  const candidateProfileIds = await fetchNostrIdentityIdsSelfReferencedByPubkey(signerPubkey, timeoutMs);
  const recoverable: Array<{ profileId: NostrIdentityId; rosterOps: SignedNostrIdentityRosterOp[] }> = [];

  for (const profileId of candidateProfileIds) {
    const rosterOps = await fetchNostrIdentityRosterOps(profileId, timeoutMs);
    const projection = projectNostrIdentityRoster(profileId, rosterOps);
    const capabilities = projection.active_facets[signerPubkey]?.capabilities;
    if (capabilities?.can_admin_profile || capabilities?.can_recover_app_keys) {
      recoverable.push({ profileId, rosterOps });
    }
  }

  if (recoverable.length === 0) {
    throw new Error('No Drive user found for that recovery key');
  }

  return recoverable.sort((left, right) => latestRosterTimestamp(right.rosterOps) - latestRosterTimestamp(left.rosterOps))[0];
}

async function fetchNostrIdentityIdsSelfReferencedByPubkey(
  pubkey: string,
  timeoutMs = 5000,
): Promise<NostrIdentityId[]> {
  await waitForWorkerAdapter(2000).catch(() => null);
  const profileIds = new Set<NostrIdentityId>();

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      sub.stop();
      resolve();
    };
    const filter: NDKFilter<number> = {
      authors: [pubkey],
      kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP, KIND_NOSTR_IDENTITY_FACET_ACCEPTANCE],
      '#p': [pubkey],
      limit: 500,
    };
    const sub = ndk.subscribe(filter, { closeOnEose: true });
    const timer = setTimeout(finish, timeoutMs);

    sub.on('event', (event) => {
      const raw = event.rawEvent() as NostrToolsEvent;
      if (!verifyEvent(raw)) {
        console.warn('[auth] Ignoring Iris identity self-reference event with invalid signature');
        return;
      }
      const profileId = selfReferencedNostrIdentityId(raw, pubkey);
      if (profileId) {
        profileIds.add(profileId);
      }
    });
    sub.on('eose', finish);
  });

  return Array.from(profileIds).sort();
}

function selfReferencedNostrIdentityId(event: NostrToolsEvent, pubkey: string): NostrIdentityId | null {
  if (normalizeHexPubkey(event.pubkey) !== pubkey) return null;
  const tagsSelf = event.tags.some((tag) => tag[0] === 'p' && normalizeHexPubkey(tag[1] ?? '') === pubkey);
  if (!tagsSelf) return null;

  try {
    return parseNostrIdentityRosterOpEvent(event).content.profile_id;
  } catch {
    // This may be a key-acceptance fact event; try that next.
  }

  try {
    return parseNostrIdentityFacetAcceptanceEvent(event).content.profile_id;
  } catch {
    return null;
  }
}

function latestRosterTimestamp(rosterOps: SignedNostrIdentityRosterOp[]): number {
  return rosterOps.reduce((latest, op) => Math.max(latest, op.content.created_at), 0);
}

async function publishSignedIdentityEventJson(eventJson: string): Promise<void> {
  const event = JSON.parse(eventJson) as NostrToolsEvent;
  await publishRawNostrEvent(event);
}

async function publishRawNostrEvent(event: NostrToolsEvent): Promise<void> {
  ndk.subManager.dispatchEvent(event as Parameters<typeof ndk.subManager.dispatchEvent>[0], undefined, true);
  const hasDirectRelays = ndk.pool.relays.size > 0 || (ndk.explicitRelayUrls?.length ?? 0) > 0;
  let directError: unknown = null;
  let directPublished = false;
  if (hasDirectRelays) {
    try {
      const ndkEvent = new NDKEvent(ndk, event);
      await ndkEvent.publish();
      directPublished = true;
    } catch (error) {
      directError = error;
    }
  }

  const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(5000);
  if (adapter) {
    await adapter.publish(event as Parameters<typeof adapter.publish>[0]);
    return;
  }

  if (directError && !directPublished) throw directError;
  if (directPublished) return;
  const ndkEvent = new NDKEvent(ndk, event);
  await ndkEvent.publish();
}

function normalizeProfileId(profileId: NostrIdentityId): NostrIdentityId {
  const trimmed = profileId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(trimmed)) {
    throw new Error('Invalid Iris profile id');
  }
  return trimmed;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomClientNonce(): string {
  return globalThis.crypto?.randomUUID?.() ?? `nonce-${Math.random().toString(36).slice(2)}`;
}

function randomDriveContentKey(): string {
  const bytes = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  }
  if (!bytes.some(Boolean)) {
    bytes.set(generateSecretKey());
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomProfileId(): NostrIdentityId {
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuidV4();
}

function fallbackUuidV4(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ============================================================================
// NIP-44 Encryption/Decryption
// Works with both nsec login (direct) and extension login (via window.nostr)
// ============================================================================

/**
 * Encrypt plaintext for a recipient using NIP-44
 * Works with both nsec and extension login
 */
export async function encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
  if (secretKey) {
    // Direct encryption with secret key
    const conversationKey = nip44.v2.utils.getConversationKey(secretKey, recipientPubkey);
    return nip44.v2.encrypt(plaintext, conversationKey);
  }

  // Extension encryption
  const nostr = (window as unknown as { nostr?: { nip44?: { encrypt: (pk: string, pt: string) => Promise<string> } } }).nostr;
  if (!nostr?.nip44?.encrypt) {
    throw new Error('NIP-44 encryption not available');
  }
  return nostr.nip44.encrypt(recipientPubkey, plaintext);
}

/**
 * Decrypt ciphertext from a sender using NIP-44
 * Works with both nsec and extension login
 */
export async function decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
  if (secretKey) {
    // Direct decryption with secret key
    const conversationKey = nip44.v2.utils.getConversationKey(secretKey, senderPubkey);
    return nip44.v2.decrypt(ciphertext, conversationKey);
  }

  // Extension decryption
  const nostr = (window as unknown as { nostr?: { nip44?: { decrypt: (pk: string, ct: string) => Promise<string> } } }).nostr;
  if (!nostr?.nip44?.decrypt) {
    throw new Error('NIP-44 decryption not available');
  }
  return nostr.nip44.decrypt(senderPubkey, ciphertext);
}
function ensureBootstrapIdentity(): void {
  if (!bootstrapPubkey || !bootstrapSecretKey) {
    const tempKey = generateSecretKey();
    bootstrapSecretKey = tempKey;
    bootstrapPubkey = getPublicKey(tempKey);
  }
}
