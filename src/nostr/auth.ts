/**
 * Nostr Authentication and Encryption
 */
import { generateSecretKey, getPublicKey, nip19, nip44, verifyEvent, type Event as NostrToolsEvent } from 'nostr-tools';
import type { Hash } from '@hashtree/core';
import {
  approveDeviceApprovalBootstrap,
  buildDeviceApprovalReceiptEvent,
  createAttachedNostrIdentitySession,
  createNostrIdentitySignerFromNip07,
  createNostrIdentitySignerFromNsec,
  createNostrIdentitySignerFromSeedPhrase,
  NOSTR_IDENTITY_DEVICE_APPROVAL_LABEL_MAX_BYTES,
  parseDeviceApprovalReceiptEvent,
  parseDeviceApprovalReceiptRosterOp,
  removeNostrAppKeyFromIdentity,
  type DeviceApprovalReceipt as NostrIdentityDeviceApprovalReceipt,
  type NostrIdentityEventSigner,
  type RemoveNostrAppKeyResult,
} from '@iris/identity';
import {
  APP_KEY_WRITER_CAPABILITIES,
  normalizeHexPubkey,
} from 'nostr-social-graph';
import type { Filter } from 'nostr-tools';
import { nostr, createNsecSigner, createExtensionSigner, getNostrRelayUrls } from './client';
import { createRemoteRecoverySigner } from './remoteRecovery';
import { nostrStore } from './store';
import { initHashtreeBackend, getWorkerAdapter, waitForWorkerAdapter } from '../lib/workerInit';
import {
  accountsStore,
  initAccountsStore,
  createAccountFromNsec,
  createExtensionAccount,
  isSessionSignedOut,
  saveActiveAccountToStorage,
  setSessionSignedOut,
} from '../accounts';
import { treeRootRegistry } from '../TreeRootRegistry';
import { profileDriveProjection } from '../drive/profileDriveProjection';
import { needsMigrations, runMigrations } from '../migrations';
import { initWallet, disposeWallet } from '../stores/wallet';
import {
  createDriveDeviceApprovalDraft,
  buildDriveDeviceApprovalAppliedAckEvent,
  driveDeviceApprovalRequestSecretKey,
  pendingDriveDeviceApprovalFromDraft,
  createNostrIdentityDckRotateAfterAddOp,
  createNostrIdentityDckRotateAfterRemovalOp,
  createNostrIdentityDckRewrapOp,
  KIND_NOSTR_IDENTITY_FACET_ACCEPTANCE,
  KIND_NOSTR_IDENTITY_ROSTER_OP,
  type DriveDeviceApprovalBootstrap,
  type PendingDriveDeviceApproval,
  npubToPubkey,
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
  removeStoredDeviceLabels,
  saveStoredDeviceLabel,
  saveStoredDeviceLabels,
} from '../drive/deviceLabels';
import {
  IRIS_IDENTITY_SESSION_STORAGE_KEY,
  loadStoredNostrIdentitySessions,
  removeStoredNostrIdentitySession,
  saveStoredNostrIdentitySessions,
} from './identitySessionStorage';
import {
  DriveRosterLiveCandidateBuffer,
  driveApprovalRosterIsReadyForAppKey,
  fetchAuthoritativeDriveRoster,
  projectDriveRosterFromApprovalReceipt,
  rosterAuthorFilter,
  type DriveRosterAuthorSnapshot,
} from './driveRosterRefresh';
import {
  publishDriveRosterHistory,
  publishDriveRosterThenActivate,
} from './driveRosterPublish';

// Storage keys
const STORAGE_KEY_NSEC = 'hashtree:nsec';
const STORAGE_KEY_LOGIN_TYPE = 'hashtree:loginType';
const STORAGE_KEY_IRIS_IDENTITY = IRIS_IDENTITY_SESSION_STORAGE_KEY;
const STORAGE_KEY_PENDING_DEVICE_APPROVAL = 'iris:drive:pending-device-approval';
const DRIVE_ROOT_NAME = 'main';
const DRIVE_ROOT_APPROVAL_RESOLVE_TIMEOUT_MS = 45_000;

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
const EXISTING_PROFILE_DEFAULT_TREES: readonly DefaultTree[] = [];

let currentNostrIdentitySession: NostrIdentitySession | null = null;
let activeDriveRosterSubscription: { stop(): void } | null = null;
let activeDriveRosterSubscriptionKey = '';
const activeDriveRosterCandidates = new DriveRosterLiveCandidateBuffer();

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
  } else {
    await initHashtreeBackend({ pubkey, nsec: nsecHex });
    const readyAdapter = getWorkerAdapter();
    if (readyAdapter) {
      await readyAdapter.setIdentity(pubkey, nsecHex);
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
  if (isSessionSignedOut()) {
    syncActiveDriveRosterSubscription(null);
    currentNostrIdentitySession = null;
    logT('session is signed out');
    return false;
  }
  restoreStoredNostrIdentitySession();

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

    const signer = createExtensionSigner();
    nostr.signer = signer;

    const pk = await signer.getPublicKey();

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

    const signer = createNsecSigner(nsec);
    nostr.signer = signer;

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

  const signer = createNsecSigner(nsec);
  nostr.signer = signer;

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
  void runPostLoginSetup(nextKey, pk, nsecHex, npubStr, defaultTrees);

  return { nsec, npub: npubStr };
}

async function runPostLoginSetup(
  nextKey: Uint8Array,
  pubkey: string,
  nsecHex: string,
  npubStr: string,
  defaultTrees: readonly DefaultTree[],
): Promise<void> {
  try {
    await initOrUpdateBackendIdentity(pubkey, nsecHex);
  } catch (e) {
    console.error('Backend identity setup failed:', e);
  }

  initWallet(nextKey).catch(e => {
    console.error('Wallet initialization failed:', e);
  });

  try {
    await createDefaultTrees(defaultTrees);
  } catch (e) {
    console.error('Default folder setup failed:', e);
  }

  publishInitialProfile(npubStr).catch(e => {
    console.error('Failed to publish initial profile:', e);
  });
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
  // The local session is the trust anchor for later author-filtered refreshes.
  // Do not expose a usable profile until every operation in that exact trusted
  // baseline is durably available from the relay/worker publication path.
  const applied = await publishDriveRosterThenActivate(
    activeSession.rosterOps,
    publishSignedIdentityEventJson,
    async () => {
      saveStoredDeviceLabel(activeSession.profileId, activeSession.appKeyPubkey, label);
      saveNostrIdentitySession(activeSession);
      return applySecretKey(appKeySecretKey, DRIVE_DEFAULT_TREES, {
        nostrIdentityId: activeSession.profileId,
        name: options.name?.trim() || undefined,
      });
    },
  );
  return {
    ...applied,
    profileId: activeSession.profileId,
  };
}

export function createDriveDeviceApprovalLink(
  options: { label?: string } = {},
): DriveDeviceApprovalLink {
  const label = options.label?.trim() || defaultDeviceApprovalLabel();
  const draft = createDriveDeviceApprovalDraft({ label });
  const appKeyPubkey = getPublicKey(draft.appKeySecretKey);
  const appKeyNsec = nip19.nsecEncode(draft.appKeySecretKey);
  return {
    url: draft.url,
    appKeyNsec,
    appKeyNpub: nip19.npubEncode(appKeyPubkey),
    appKeyPubkey,
    pendingApproval: pendingDriveDeviceApprovalFromDraft(draft),
    ...(draft.bootstrap.label ? { label: draft.bootstrap.label } : {}),
  };
}

function defaultDeviceApprovalLabel(): string {
  const label = currentBrowserDeviceLabel();
  if (new TextEncoder().encode(label).length <= NOSTR_IDENTITY_DEVICE_APPROVAL_LABEL_MAX_BYTES) {
    return label;
  }
  const browser = label.split(' on ', 1)[0].trim();
  return browser || 'Browser';
}

export async function approveDriveDeviceApprovalBootstrap(
  bootstrap: DriveDeviceApprovalBootstrap,
): Promise<NostrIdentitySession> {
  const session = requireActiveDriveIdentitySession();
  requireCurrentDriveAdmin(session);
  if (!secretKey) throw new Error('No active Drive AppKey secret');
  const deviceAppKeyPubkey = npubToPubkey(bootstrap.deviceAppKeyNpub);
  if (!deviceAppKeyPubkey) throw new Error('Invalid Drive device approval stable key');

  const rosterOps = await currentDriveRosterOps(session);
  const approvedAt = nextDriveRosterOpCreatedAt(session.profileId, rosterOps);
  const label = bootstrap.label?.trim();
  const deviceLabels = await collectDriveDeviceLabels(session, rosterOps);
  if (label) {
    deviceLabels[deviceAppKeyPubkey] = label;
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
  const content = approveDeviceApprovalBootstrap({
    bootstrap,
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
  const receiptEvent = buildDeviceApprovalReceiptEvent({
    signerSecretKey: secretKey,
    bootstrap,
    profileId: session.profileId,
    approvedAt,
    subjectPubkey: session.appKeyPubkey,
    rosterOpEvent: JSON.parse(signed.event_json) as NostrToolsEvent,
  });
  // Resolve the complete logical Drive before publishing any approval state.
  // A settings-only/cold session may not have hydrated `main` yet, and
  // acknowledging first would strand the newly approved AppKey without a root
  // key wrap.
  const currentDriveRoot = await resolveCurrentDriveRootForApproval(session.profileId);
  await uploadDriveRootForApproval(currentDriveRoot);
  const approvalRosterOps = [...rosterOps, signed, dckRotationOp];
  await publishDriveIdentityRosterOps(approvalRosterOps);
  const updated = appendCurrentNostrIdentitySessionRosterOps(session.profileId, approvalRosterOps);
  if (!updated) throw new Error('Approved key removed the active Drive user');
  const updatedProjection = projectNostrIdentityRoster(updated.profileId, updated.rosterOps);
  if (!updatedProjection.active_facets[deviceAppKeyPubkey]) {
    throw new Error('Approved Drive key was not added to the active roster');
  }
  // Existing Drive roots were encrypted before this AppKey joined, so their
  // root-key wraps cannot be opened by the new device. Re-publish the current
  // logical root after updating the roster, then publish the receipt last: a
  // device that sees the receipt can immediately resolve the adopted Drive.
  await republishCurrentDriveRootForApproval(currentDriveRoot);
  await publishRawNostrEvent(receiptEvent);
  saveStoredDeviceLabels(updated.profileId, deviceLabels);
  return updated;
}

async function resolveCurrentDriveRootForApproval(
  profileId: NostrIdentityId,
): Promise<{ hash: Hash; key: Hash }> {
  const resolverKey = `${profileId}/${DRIVE_ROOT_NAME}`;
  const { resolveDriveRootProjectionNow } = await import('../stores/treeRootResolver');
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const applied = await Promise.race([
      resolveDriveRootProjectionNow(resolverKey),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Could not resolve the current Drive before approving this device'));
        }, DRIVE_ROOT_APPROVAL_RESOLVE_TIMEOUT_MS);
      }),
    ]);
    const current = treeRootRegistry.getByKey(resolverKey);
    if (!applied || !current?.hash || !current.key) {
      throw new Error('The current Drive projection is incomplete');
    }
    return { hash: current.hash, key: current.key };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function uploadDriveRootForApproval(
  current: { hash: Hash; key: Hash },
): Promise<void> {
  const adapter = await waitForWorkerAdapter();
  if (!adapter?.pushToBlossom) {
    throw new Error('Drive storage is not ready to hand files to the approved device');
  }
  const upload = await adapter.pushToBlossom(current.hash, current.key, DRIVE_ROOT_NAME);
  if (upload.failed > 0) {
    throw new Error(`Could not upload ${upload.failed} Drive blocks for the approved device`);
  }
}

async function republishCurrentDriveRootForApproval(
  current: { hash: Hash; key: Hash },
): Promise<void> {
  const { publishNostrIdentityDriveRootIfAvailable } = await import('../drive/profileDriveRootPublish');
  const published = await publishNostrIdentityDriveRootIfAvailable(DRIVE_ROOT_NAME, {
    hash: current.hash,
    key: current.key,
  });
  if (!published) {
    throw new Error('Could not hand the current Drive root to the approved device');
  }
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
  if (appKeyPubkey !== npubToPubkey(pendingApproval.bootstrap.deviceAppKeyNpub)) {
    throw new Error('Pending Drive AppKey does not match approval request');
  }
  const requestSecretKey = driveDeviceApprovalRequestSecretKey(pendingApproval);
  const approval = await fetchDriveDeviceApprovalReceipt(
    pendingApproval.bootstrap,
    requestSecretKey,
    options.timeoutMs,
  );
  if (!approval) return null;
  const { receipt } = approval;
  const remoteOps = await fetchNostrIdentityRosterOps(
    receipt.profileId,
    options.timeoutMs ?? 5000,
  );
  const receiptRosterOp = parseDeviceApprovalReceiptRosterOp(receipt);
  let anchored;
  try {
    anchored = projectDriveRosterFromApprovalReceipt(
      receipt.profileId,
      receiptRosterOp,
      remoteOps,
    );
  } catch (error) {
    console.warn('[auth] Drive approval roster is not yet complete or authorized:', error);
    return null;
  }
  const { rosterOps } = anchored;
  if (!driveApprovalRosterIsReadyForAppKey(anchored, receiptRosterOp.op_id, appKeyPubkey)) {
    return null;
  }

  const session: NostrIdentitySession = {
    profileId: receipt.profileId,
    appKeyPubkey,
    appKeyNpub: nip19.npubEncode(appKeyPubkey),
    appKeyNsec,
    status: 'active',
    rosterOps,
    createdAt: receipt.approvedAt,
    ...(pendingApproval.bootstrap.label ? { label: pendingApproval.bootstrap.label } : {}),
  };
  // Make the profile scope authoritative before backend setup starts. Existing
  // profiles already have drive roots; activation must adopt them without
  // publishing a competing empty `main` contribution for the new AppKey.
  saveNostrIdentitySession(session);
  await applySecretKey(appKeySecretKey, EXISTING_PROFILE_DEFAULT_TREES, {
    nostrIdentityId: session.profileId,
  });
  const labels = await collectDriveDeviceLabels(session, rosterOps).catch(() => ({
    [session.appKeyPubkey]: session.label ?? currentBrowserDeviceLabel(),
  }));
  saveStoredDeviceLabels(session.profileId, labels);
  const ack = buildDriveDeviceApprovalAppliedAckEvent({
    appKeySecretKey,
    receipt,
    approvalEventId: approval.event.id,
    appliedAt: currentUnixSeconds(),
  });
  await publishRawNostrEvent(ack);
  return {
    nsec: appKeyNsec,
    npub: session.appKeyNpub,
    session,
    receipt,
  };
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
    createdAt: nextDriveRosterOpCreatedAt(session.profileId, rosterOps),
    clientNonce: randomClientNonce(),
    op: {
      op: 'set_capabilities',
      pubkey: target,
      capabilities,
    },
  });

  await publishDriveIdentityRosterOps(rosterOps);
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
    createdAt: nextDriveRosterOpCreatedAt(session.profileId, rosterOps),
    clientNonce: randomClientNonce(),
    op: {
      op: 'tombstone_facet',
      pubkey: target,
      reason: 'removed from Drive settings',
    },
  });

  await publishDriveIdentityRosterOps(rosterOps);
  await publishSignedIdentityEventJson(signed.event_json);
  return appendCurrentNostrIdentitySessionRosterOps(session.profileId, [...rosterOps, signed], target);
}

export async function recoverDriveProfileWithAppKey(
  options: DriveRecoveryAppKeyOptions,
): Promise<{ nsec: string; npub: string; session: NostrIdentitySession }> {
  const signer = await createRecoverySigner(options.recovery);
  try {
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

  const createdAt = nextDriveRosterOpCreatedAt(profileId, rosterOps);
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
  if (session.status !== 'active') {
    throw new Error('Attached Drive AppKey did not create an active session');
  }
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
    ...(await applySecretKey(decodedAppKeySecretKey, EXISTING_PROFILE_DEFAULT_TREES, {
      nostrIdentityId: activeSession.profileId,
    })),
    session: activeSession,
  };
  } finally { await (signer as NostrIdentityEventSigner & { close?(): Promise<void> }).close?.(); }
}

export async function removeDriveProfileAppKeyWithRecovery(
  options: DriveRecoveryRemoveAppKeyOptions,
): Promise<DriveRecoveryRemoveAppKeyResult> {
  const profileId = normalizeProfileId(options.profileId);
  const signer = await createRecoverySigner(options.recovery);
  try {
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
  } finally { await (signer as NostrIdentityEventSigner & { close?(): Promise<void> }).close?.(); }
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
    const rootScope = currentNostrIdentitySession?.status === 'active'
      && currentNostrIdentitySession.appKeyPubkey === state.pubkey
      ? currentNostrIdentitySession.profileId
      : state.npub;

    for (const { name, visibility } of defaults) {
      if (getLocalRootCache(rootScope, name)) continue;
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

  await nostr.publishEvent({ kind: 0, content: JSON.stringify({ lud16 }) });
  console.log('[auth] Published initial profile with lud16:', lud16);
}

/**
 * Logout
 */
export function logout() {
  const accountState = accountsStore.getState();
  const activeAccountPubkey = accountState.activeAccountPubkey
    ?? nostrStore.getState().pubkey;
  const activeAccount = accountState.accounts.find((account) => account.pubkey === activeAccountPubkey);
  const activeProfileId = currentNostrIdentitySession?.profileId ?? activeAccount?.nostrIdentityId;
  const activeNpub = nostrStore.getState().npub;

  const privateRootScopes = new Set([activeProfileId, activeNpub].filter((scope): scope is string => !!scope));
  for (const rootScope of privateRootScopes) {
    for (const key of treeRootRegistry.getAllRecords().keys()) {
      const prefix = `${rootScope}/`;
      if (!key.startsWith(prefix)) continue;
      treeRootRegistry.delete(rootScope, key.slice(prefix.length));
    }
  }
  if (activeProfileId) {
    profileDriveProjection.clear(activeProfileId, DRIVE_ROOT_NAME);
    removeStoredDeviceLabels(activeProfileId);
  }

  if (activeAccountPubkey) {
    accountsStore.forgetAccount(activeAccountPubkey);
  } else {
    saveActiveAccountToStorage(null);
    accountsStore.setActiveAccount(null);
  }
  setSessionSignedOut(true);

  nostrStore.setPubkey(null);
  nostrStore.setNpub(null);
  nostrStore.setIsLoggedIn(false);
  nostrStore.setSelectedTree(null);
  secretKey = null;
  nostr.signer = undefined;

  // Keep the initialized backend reusable for a same-page login, but detach it
  // from the logged-out AppKey. This also stops the AppKey-scoped FIPS runtime.
  const adapter = getWorkerAdapter();
  if (adapter) {
    adapter.setP2PProvider?.(null);
    const anonymousPubkey = getPublicKey(generateSecretKey());
    void adapter.setIdentity(anonymousPubkey).catch((error) => {
      console.warn('[auth] Failed to clear backend identity during logout:', error);
    });
  }

  // Dispose wallet
  disposeWallet().catch(e => {
    console.error('Wallet disposal failed:', e);
  });

  localStorage.removeItem(STORAGE_KEY_LOGIN_TYPE);
  localStorage.removeItem(STORAGE_KEY_NSEC);
  localStorage.removeItem(STORAGE_KEY_IRIS_IDENTITY);
  localStorage.removeItem(STORAGE_KEY_PENDING_DEVICE_APPROVAL);
  syncActiveDriveRosterSubscription(null);
  currentNostrIdentitySession = null;
}

function saveNostrIdentitySession(session: NostrIdentitySession): void {
  currentNostrIdentitySession = session;
  syncActiveDriveRosterSubscription(session);
  const stored = serializeDriveIdentitySession(session);
  const sessions = loadStoredNostrIdentitySessions();
  sessions[session.appKeyPubkey] = stored;
  saveStoredNostrIdentitySessions(sessions);
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
    syncActiveDriveRosterSubscription(null);
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

function replaceCurrentNostrIdentitySessionRosterOps(
  profileId: NostrIdentityId,
  rosterOps: SignedNostrIdentityRosterOp[],
): NostrIdentitySession | null {
  if (!currentNostrIdentitySession || currentNostrIdentitySession.profileId !== profileId) {
    return currentNostrIdentitySession;
  }
  const session: NostrIdentitySession = {
    ...currentNostrIdentitySession,
    rosterOps,
  };
  saveNostrIdentitySession(session);
  return session;
}

function restoreStoredNostrIdentitySession(): NostrIdentitySession | null {
  const activeAccountPubkey = accountsStore.getState().activeAccountPubkey;
  const sessions = loadStoredNostrIdentitySessions();
  const legacyRaw = localStorage.getItem(STORAGE_KEY_IRIS_IDENTITY);
  const legacyStored = legacyRaw ? parseStoredNostrIdentitySession(legacyRaw) : null;

  const storedForActiveAccount = activeAccountPubkey ? sessions[activeAccountPubkey] : undefined;
  if (storedForActiveAccount) {
    return activateStoredNostrIdentitySession(storedForActiveAccount);
  }

  if (!legacyRaw) {
    syncActiveDriveRosterSubscription(null);
    currentNostrIdentitySession = null;
    return null;
  }
  if (!legacyStored) {
    localStorage.removeItem(STORAGE_KEY_IRIS_IDENTITY);
    syncActiveDriveRosterSubscription(null);
    currentNostrIdentitySession = null;
    return null;
  }
  try {
    const legacySession = restoreDriveIdentitySession(legacyStored);
    saveNostrIdentitySession(legacySession);
    if (activeAccountPubkey && activeAccountPubkey !== legacySession.appKeyPubkey) {
      syncActiveDriveRosterSubscription(null);
      currentNostrIdentitySession = null;
      return null;
    }
    return activateStoredNostrIdentitySession(legacyStored);
  } catch (error) {
    console.warn('[auth] Ignoring invalid Iris identity session:', error);
    localStorage.removeItem(STORAGE_KEY_IRIS_IDENTITY);
    syncActiveDriveRosterSubscription(null);
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
    syncActiveDriveRosterSubscription(session);
    accountsStore.updateAccount(session.appKeyPubkey, {
      type: 'drive_profile',
      nostrIdentityId: session.profileId,
      nsec: session.appKeyNsec,
    });
    localStorage.setItem(STORAGE_KEY_IRIS_IDENTITY, JSON.stringify(serializeDriveIdentitySession(session)));
    return session;
  } catch (error) {
    console.warn('[auth] Ignoring invalid Iris identity session:', error);
    syncActiveDriveRosterSubscription(null);
    currentNostrIdentitySession = null;
    return null;
  }
}

/**
 * Keep the active Drive roster live instead of treating the login snapshot as
 * an authorization cache. Root and FIPS admission both read the current
 * session, so a remote device removal takes effect without a reload or a visit
 * to Settings.
 */
function syncActiveDriveRosterSubscription(session: NostrIdentitySession | null): void {
  const key = session?.status === 'active'
    ? `${session.profileId}:${session.appKeyPubkey}`
    : '';
  if (key && key === activeDriveRosterSubscriptionKey && activeDriveRosterSubscription) return;

  activeDriveRosterSubscription?.stop();
  activeDriveRosterSubscription = null;
  activeDriveRosterSubscriptionKey = key;
  activeDriveRosterCandidates.clear();
  if (!session || session.status !== 'active') return;

  const profileId = session.profileId;
  const appKeyPubkey = session.appKeyPubkey;
  const filter: Filter = {
    kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP],
    '#i': [profileId],
  };
  const sub = nostr.subscribe(filter, {
    closeAfterHistory: false,
  });
  sub.on('event', (event) => {
    if (activeDriveRosterSubscriptionKey !== `${profileId}:${appKeyPubkey}`) return;
    try {
      const raw = event as NostrToolsEvent;
      if (!verifyEvent(raw)) return;
      const signed = parseNostrIdentityRosterOpEvent(raw);
      if (signed.content.profile_id !== profileId) return;
      const current = currentNostrIdentitySession;
      if (!current || current.profileId !== profileId || current.appKeyPubkey !== appKeyPubkey) return;
      const anchored = activeDriveRosterCandidates.replay(profileId, current.rosterOps, signed);
      if (anchored.rosterOps.length === current.rosterOps.length) return;
      replaceCurrentNostrIdentitySessionRosterOps(profileId, anchored.rosterOps);
      void import('../stores/treeRootResolver').then(({ refreshDriveRootResolverKey }) => {
        refreshDriveRootResolverKey(`${profileId}/${DRIVE_ROOT_NAME}`);
      });
    } catch (error) {
      console.warn('[auth] Ignoring invalid live Drive roster event:', error);
    }
  });

  activeDriveRosterSubscription = sub;
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

  if (stored.status !== 'active') {
    throw new Error(`unsupported Iris identity session status ${stored.status}`);
  }
  const projection = projectNostrIdentityRoster(stored.profileId, rosterOps);
  if (!projection.active_facets[appKeyPubkey]) {
    throw new Error('stored Iris identity AppKey is not active in its Drive roster');
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
  return fetchNostrIdentityRosterOps(session.profileId, 3000, session.rosterOps);
}

export async function refreshCurrentDriveRosterOps(
  profileId: NostrIdentityId,
  timeoutMs = 3000,
): Promise<SignedNostrIdentityRosterOp[]> {
  const session = currentNostrIdentitySession;
  if (!session || session.status !== 'active' || session.profileId !== profileId) {
    throw new Error('No matching active Drive roster session');
  }
  const appKeyPubkey = session.appKeyPubkey;
  const refreshed = await fetchNostrIdentityRosterOps(profileId, timeoutMs, session.rosterOps);
  const current = currentNostrIdentitySession;
  if (
    !current
    || current.status !== 'active'
    || current.profileId !== profileId
    || current.appKeyPubkey !== appKeyPubkey
  ) {
    throw new Error('Active Drive roster changed during refresh');
  }
  replaceCurrentNostrIdentitySessionRosterOps(profileId, refreshed);
  return refreshed;
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

async function publishDriveIdentityRosterOps(rosterOps: SignedNostrIdentityRosterOp[]): Promise<void> {
  await publishDriveRosterHistory(rosterOps, publishSignedIdentityEventJson);
}

async function fetchDriveDeviceApprovalReceipt(
  bootstrap: DriveDeviceApprovalBootstrap,
  requestSecretKey: Uint8Array,
  timeoutMs = 5000,
): Promise<{ receipt: NostrIdentityDeviceApprovalReceipt; event: NostrToolsEvent } | null> {
  let approval: { receipt: NostrIdentityDeviceApprovalReceipt; event: NostrToolsEvent } | null = null;
  const requestPubkey = npubToPubkey(bootstrap.requestNpub);
  if (!requestPubkey) throw new Error('Invalid Drive device approval request key');
  await waitForWorkerAdapter(2000).catch(() => null);

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      sub.stop();
      resolve();
    };
    const filter: Filter = {
      kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP],
      '#p': [requestPubkey],
      limit: 50,
    };
    const sub = nostr.subscribe(filter, {
      closeAfterHistory: false,
    });
    const timer = setTimeout(finish, timeoutMs);

    sub.on('event', (event) => {
      try {
        const raw = event as NostrToolsEvent;
        if (!verifyEvent(raw)) return;
        const parsed = parseDeviceApprovalReceiptEvent(raw, {
          requestSecretKey,
          bootstrap,
        });
        approval = { receipt: parsed, event: raw };
        finish();
      } catch {
        // Other fact events can share the request pubkey tag; ignore them.
      }
    });

  });

  return approval;
}


async function createRecoverySigner(recovery: DriveRecoveryRequest): Promise<NostrIdentityEventSigner> {
  if (recovery.method === 'nsec') {
    if (!recovery.nsec?.trim()) throw new Error('Enter your secret key');
    return createNostrIdentitySignerFromNsec(recovery.nsec);
  }
  if (recovery.method === 'seed_phrase') {
    if (!recovery.seedWords?.trim()) throw new Error('Enter your recovery phrase');
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
  return createRemoteRecoverySigner(connection, recovery.nip46Relay?.trim());
}

async function fetchNostrIdentityRosterOps(
  profileId: NostrIdentityId,
  timeoutMs = 5000,
  trustedRosterOps?: readonly SignedNostrIdentityRosterOp[],
): Promise<SignedNostrIdentityRosterOp[]> {
  if (trustedRosterOps?.length) {
    await waitForWorkerAdapter(2000).catch(() => null);
    const deadline = Date.now() + timeoutMs;
    const authoritative = await fetchAuthoritativeDriveRoster({
      profileId,
      trustedRosterOps,
      fetchAuthors: (authors) => fetchDriveRosterAuthorSnapshots(profileId, authors, deadline),
    });
    return authoritative.rosterOps;
  }

  return fetchUnanchoredNostrIdentityRosterOps(profileId, timeoutMs);
}

const DRIVE_ROSTER_AUTHOR_BATCH_SIZE = 32;
const DRIVE_ROSTER_EOSE_DRAIN_MS = 250;

async function fetchDriveRosterAuthorSnapshots(
  profileId: NostrIdentityId,
  authors: readonly string[],
  deadline: number,
): Promise<DriveRosterAuthorSnapshot> {
  const batches: string[][] = [];
  for (let offset = 0; offset < authors.length; offset += DRIVE_ROSTER_AUTHOR_BATCH_SIZE) {
    batches.push(authors.slice(offset, offset + DRIVE_ROSTER_AUTHOR_BATCH_SIZE));
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= DRIVE_ROSTER_EOSE_DRAIN_MS) {
    return { rosterOps: [], complete: false };
  }
  const snapshots = await Promise.all(
    batches.map((batch) => fetchDriveRosterAuthorBatch(profileId, batch, remainingMs)),
  );
  const byId = new Map<string, SignedNostrIdentityRosterOp>();
  for (const snapshot of snapshots) {
    for (const op of snapshot.rosterOps) byId.set(op.op_id, op);
  }
  return {
    rosterOps: [...byId.values()],
    complete: snapshots.every((snapshot) => snapshot.complete),
  };
}

async function fetchDriveRosterAuthorBatch(
  profileId: NostrIdentityId,
  authors: readonly string[],
  timeoutMs: number,
): Promise<DriveRosterAuthorSnapshot> {
  const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(timeoutMs);
  if (!adapter?.queryEvents) return { rosterOps: [], complete: false };
  const report = await adapter.queryEvents([rosterAuthorFilter(profileId, authors)], {
    cache: 'network-only', localEcho: false, relays: getNostrRelayUrls(), sources: [], deadline: Date.now() + timeoutMs,
  });
  const expectedAuthors = new Set(authors);
  const byId = new Map<string, SignedNostrIdentityRosterOp>();
  for (const raw of report.events) {
    try {
      if (!verifyEvent(raw) || !expectedAuthors.has(raw.pubkey)) continue;
      const signed = parseNostrIdentityRosterOpEvent(raw);
      if (signed.content.profile_id === profileId) byId.set(signed.op_id, signed);
    } catch { /* Unrelated or invalid signed events cannot authorize a device. */ }
  }
  return { rosterOps: [...byId.values()], complete: report.complete };

}

async function fetchUnanchoredNostrIdentityRosterOps(
  profileId: NostrIdentityId,
  timeoutMs: number,
): Promise<SignedNostrIdentityRosterOp[]> {
  await waitForWorkerAdapter(2000).catch(() => null);
  const byId = new Map<string, SignedNostrIdentityRosterOp>();

  await new Promise<void>((resolve) => {
    let resolved = false;
    let eoseSeen = false;
    let eoseDrainTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (eoseDrainTimer) clearTimeout(eoseDrainTimer);
      sub.stop();
      resolve();
    };
    const scheduleEoseDrain = () => {
      if (eoseDrainTimer) clearTimeout(eoseDrainTimer);
      // This discovery subscription collects signed candidates. Authorization
      // is checked separately against a complete relay roster snapshot.
      eoseDrainTimer = setTimeout(finish, DRIVE_ROSTER_EOSE_DRAIN_MS);
    };
    const filter: Filter = {
      kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP],
      '#i': [profileId],
    };
    const sub = nostr.subscribe(filter, {
      closeAfterHistory: false,
    });
    const timer = setTimeout(finish, timeoutMs);

    sub.on('event', (event) => {
      try {
        const raw = event as NostrToolsEvent;
        if (!verifyEvent(raw)) {
          console.warn('[auth] Ignoring Iris identity roster event with invalid signature');
          return;
        }
        const signed = parseNostrIdentityRosterOpEvent(raw);
        if (signed.content.profile_id === profileId) {
          byId.set(signed.op_id, signed);
        }
        if (eoseSeen) scheduleEoseDrain();
      } catch (error) {
        console.warn('[auth] Ignoring invalid Iris identity roster event:', error);
      }
    });
    sub.on('history', () => {
      eoseSeen = true;
      scheduleEoseDrain();
    });

  });

  return Array.from(byId.values())
    .sort((left, right) => left.content.created_at - right.content.created_at || left.op_id.localeCompare(right.op_id));
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
    const filter: Filter = {
      authors: [pubkey],
      kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP, KIND_NOSTR_IDENTITY_FACET_ACCEPTANCE],
      '#p': [pubkey],
      limit: 500,
    };
    const sub = nostr.subscribe(filter, {
      closeAfterHistory: true,
    });
    const timer = setTimeout(finish, timeoutMs);

    sub.on('event', (event) => {
      const raw = event as NostrToolsEvent;
      if (!verifyEvent(raw)) {
        console.warn('[auth] Ignoring Iris identity self-reference event with invalid signature');
        return;
      }
      const profileId = selfReferencedNostrIdentityId(raw, pubkey);
      if (profileId) {
        profileIds.add(profileId);
      }
    });
    sub.on('history', finish);
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
  await nostr.publish(event);
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

function nextDriveRosterOpCreatedAt(
  profileId: NostrIdentityId,
  rosterOps: SignedNostrIdentityRosterOp[],
): number {
  const accepted = new Set(projectNostrIdentityRoster(profileId, rosterOps).accepted_op_ids);
  return rosterOps.reduce((next, op) => (
    accepted.has(op.op_id) ? Math.max(next, op.content.created_at + 1) : next
  ), currentUnixSeconds());
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
