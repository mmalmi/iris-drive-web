/**
 * Nostr Authentication and Encryption
 */
import { generateSecretKey, getPublicKey, nip19, nip44, type Event as NostrToolsEvent } from 'nostr-tools';
import {
  createAttachedIrisIdentitySession,
  createIrisIdentitySignerFromNip07,
  createIrisIdentitySignerFromNip46,
  createIrisIdentitySignerFromNsec,
  createIrisIdentitySignerFromSeedPhrase,
  normalizeHexPubkey,
  removeIrisAppKeyFromProfile,
  type IrisIdentityEventSigner,
  type RemoveIrisAppKeyResult,
} from '@iris/identity';
import type { NDKFilter } from 'ndk';
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
  createIrisProfileDckRotateAfterRemovalOp,
  createIrisProfileDckRewrapOp,
  KIND_IRIS_PROFILE_ROSTER_OP,
  parseDeviceLinkInvite,
  parseIrisProfileRosterOpEvent,
  projectIrisProfileRoster,
  signIrisProfileRosterOp,
  type IrisIdentitySession,
  type IrisProfileCapabilities,
  type IrisProfileId,
  type SignedIrisProfileRosterOp,
  type StoredIrisIdentitySession,
} from '../drive/protocol';

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
  profileId: IrisProfileId;
  recovery: DriveRecoveryRequest;
  label?: string;
  rosterFetchTimeoutMs?: number;
}

export interface DriveRecoveryRemoveAppKeyOptions {
  profileId: IrisProfileId;
  recovery: DriveRecoveryRequest;
  appKeyPubkey: string;
  reason?: string;
  rosterFetchTimeoutMs?: number;
}

export interface DriveRecoveryRemoveAppKeyResult {
  removal: RemoveIrisAppKeyResult;
  dckRotationOp: SignedIrisProfileRosterOp | null;
  session: IrisIdentitySession | null;
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

let currentIrisIdentitySession: IrisIdentitySession | null = null;

const DRIVE_APP_KEY_ADMIN_CAPABILITIES: IrisProfileCapabilities = {
  can_write_roots: true,
  can_admin_profile: true,
  can_recover_app_keys: true,
  can_receive_key_wraps: true,
  can_decrypt_key_epochs: true,
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

export function getCurrentIrisIdentitySession(): IrisIdentitySession | null {
  return currentIrisIdentitySession;
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
  restoreStoredIrisIdentitySession();

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
  accountOptions: { irisProfileId?: IrisProfileId } = {},
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
    type: accountOptions.irisProfileId ? 'drive_profile' : 'nsec',
    irisProfileId: accountOptions.irisProfileId,
  });
  if (account) {
    accountsStore.addAccount(account);
    if (accountOptions.irisProfileId) {
      accountsStore.updateAccount(account.pubkey, {
        type: 'drive_profile',
        irisProfileId: accountOptions.irisProfileId,
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

export async function createDriveProfile(): Promise<{ nsec: string; npub: string }> {
  const appKeySecretKey = generateSecretKey();
  const session = createDriveIdentitySession({
    appKeySecretKey,
    label: 'This device',
  });
  saveIrisIdentitySession(session);
  return applySecretKey(appKeySecretKey, DRIVE_DEFAULT_TREES, {
    irisProfileId: session.profileId,
  });
}

export async function linkDriveDevice(inviteInput: string): Promise<{ nsec: string; npub: string; session: IrisIdentitySession } | null> {
  const invite = parseDeviceLinkInvite(inviteInput);
  if (!invite) return null;
  const session = createPendingDeviceLinkSession({
    invite,
    label: 'This device',
  });
  const decoded = nip19.decode(session.appKeyNsec);
  if (decoded.type !== 'nsec') return null;
  const appKeySecretKey = decoded.data as Uint8Array;
  saveIrisIdentitySession(session);
  const login = await applySecretKey(appKeySecretKey, [], {
    irisProfileId: session.profileId,
  });
  return { ...login, session };
}

export async function recoverDriveProfileWithAppKey(
  options: DriveRecoveryAppKeyOptions,
): Promise<{ nsec: string; npub: string; session: IrisIdentitySession }> {
  const profileId = normalizeProfileId(options.profileId);
  const signer = await createRecoverySigner(options.recovery);
  const rosterOps = await fetchIrisProfileRosterOps(profileId, options.rosterFetchTimeoutMs);
  if (rosterOps.length === 0) {
    throw new Error('No identity roster events found for that profile');
  }

  const { attachment, session } = await createAttachedIrisIdentitySession({
    profileId,
    signer,
    rosterOps,
    label: options.label ?? 'This app',
    clientNonce: randomClientNonce(),
  });
  const dckRewrapOp = await createIrisProfileDckRewrapOp({
    profileId,
    signer,
    rosterOps,
    appKeyPubkey: attachment.appKeyPubkey,
    parentRosterOp: attachment.rosterOp,
  });
  const activeSession: IrisIdentitySession = {
    ...session,
    rosterOps: dckRewrapOp ? [...session.rosterOps, dckRewrapOp] : session.rosterOps,
  };

  await publishSignedIdentityEventJson(attachment.rosterOp.event_json);
  await publishSignedIdentityEventJson(attachment.facetAcceptance.event_json);
  if (dckRewrapOp) {
    await publishSignedIdentityEventJson(dckRewrapOp.event_json);
  }
  saveIrisIdentitySession(activeSession);

  const decoded = nip19.decode(session.appKeyNsec);
  if (decoded.type !== 'nsec') {
    throw new Error('attached Drive AppKey is not an nsec');
  }
  const appKeySecretKey = decoded.data as Uint8Array;
  return {
    ...(await applySecretKey(appKeySecretKey, DRIVE_DEFAULT_TREES, {
      irisProfileId: activeSession.profileId,
    })),
    session: activeSession,
  };
}

export async function removeDriveProfileAppKeyWithRecovery(
  options: DriveRecoveryRemoveAppKeyOptions,
): Promise<DriveRecoveryRemoveAppKeyResult> {
  const profileId = normalizeProfileId(options.profileId);
  const signer = await createRecoverySigner(options.recovery);
  const rosterOps = await fetchIrisProfileRosterOps(profileId, options.rosterFetchTimeoutMs);
  if (rosterOps.length === 0) {
    throw new Error('No identity roster events found for that profile');
  }

  let dckRotationOp: SignedIrisProfileRosterOp | null = null;
  const removal = await removeIrisAppKeyFromProfile({
    profileId,
    signer,
    rosterOps,
    appKeyPubkey: options.appKeyPubkey,
    reason: options.reason,
    clientNonce: randomClientNonce(),
    rewrapSecrets: async (context) => {
      dckRotationOp = await createIrisProfileDckRotateAfterRemovalOp({
        profileId,
        signer,
        rosterOps,
        parentRosterOp: context.rosterOp,
      });
      if (!dckRotationOp) {
        return [{
          secretId: 'drive-dck',
          status: 'skipped',
          detail: 'no existing Drive key epoch',
        }];
      }
      return [{
        secretId: 'drive-dck',
        status: 'rotated',
        epoch: dckRotationOp.content.op.op === 'rotate_key_epoch'
          ? dckRotationOp.content.op.epoch
          : undefined,
      }];
    },
  });

  await publishSignedIdentityEventJson(removal.rosterOp.event_json);
  if (dckRotationOp) {
    await publishSignedIdentityEventJson(dckRotationOp.event_json);
  }

  const session = appendCurrentIrisIdentitySessionRosterOps(
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
  event.content = JSON.stringify({ lud16 });

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
  currentIrisIdentitySession = null;
}

function saveIrisIdentitySession(session: IrisIdentitySession): void {
  currentIrisIdentitySession = session;
  const stored = serializeDriveIdentitySession(session);
  const sessions = loadStoredIrisIdentitySessions();
  sessions[session.appKeyPubkey] = stored;
  localStorage.setItem(STORAGE_KEY_IRIS_IDENTITY_SESSIONS, JSON.stringify(sessions));
  localStorage.setItem(STORAGE_KEY_IRIS_IDENTITY, JSON.stringify(stored));
}

function appendCurrentIrisIdentitySessionRosterOps(
  profileId: IrisProfileId,
  rosterOps: SignedIrisProfileRosterOp[],
  removedAppKeyPubkey?: string,
): IrisIdentitySession | null {
  if (!currentIrisIdentitySession || currentIrisIdentitySession.profileId !== profileId) {
    return currentIrisIdentitySession;
  }

  const removed = removedAppKeyPubkey ? normalizeHexPubkey(removedAppKeyPubkey) : null;
  if (removed) {
    removeStoredIrisIdentitySession(removed);
  }
  if (removed && currentIrisIdentitySession.appKeyPubkey === removed) {
    currentIrisIdentitySession = null;
    localStorage.removeItem(STORAGE_KEY_IRIS_IDENTITY);
    return null;
  }

  const known = new Set(currentIrisIdentitySession.rosterOps.map((op) => op.op_id));
  const newOps = rosterOps.filter((op) => !known.has(op.op_id));
  if (newOps.length === 0) {
    return currentIrisIdentitySession;
  }
  const session: IrisIdentitySession = {
    ...currentIrisIdentitySession,
    rosterOps: [...currentIrisIdentitySession.rosterOps, ...newOps],
  };
  saveIrisIdentitySession(session);
  return session;
}

function restoreStoredIrisIdentitySession(): IrisIdentitySession | null {
  const activeAccountPubkey = accountsStore.getState().activeAccountPubkey;
  const sessions = loadStoredIrisIdentitySessions();
  const storedForActiveAccount = activeAccountPubkey ? sessions[activeAccountPubkey] : undefined;
  if (storedForActiveAccount) {
    return activateStoredIrisIdentitySession(storedForActiveAccount);
  }

  const legacyRaw = localStorage.getItem(STORAGE_KEY_IRIS_IDENTITY);
  if (!legacyRaw) {
    currentIrisIdentitySession = null;
    return null;
  }
  try {
    const legacyStored = JSON.parse(legacyRaw) as StoredIrisIdentitySession;
    const legacySession = restoreDriveIdentitySession(legacyStored);
    saveIrisIdentitySession(legacySession);
    if (activeAccountPubkey && activeAccountPubkey !== legacySession.appKeyPubkey) {
      currentIrisIdentitySession = null;
      return null;
    }
    return activateStoredIrisIdentitySession(legacyStored);
  } catch (error) {
    console.warn('[auth] Ignoring invalid Iris identity session:', error);
    localStorage.removeItem(STORAGE_KEY_IRIS_IDENTITY);
    currentIrisIdentitySession = null;
    return null;
  }
}

function activateStoredIrisIdentitySession(stored: StoredIrisIdentitySession): IrisIdentitySession | null {
  try {
    const session = restoreDriveIdentitySession(stored);
    currentIrisIdentitySession = session;
    accountsStore.updateAccount(session.appKeyPubkey, {
      type: 'drive_profile',
      irisProfileId: session.profileId,
      nsec: session.appKeyNsec,
    });
    localStorage.setItem(STORAGE_KEY_IRIS_IDENTITY, JSON.stringify(serializeDriveIdentitySession(session)));
    return session;
  } catch (error) {
    console.warn('[auth] Ignoring invalid Iris identity session:', error);
    currentIrisIdentitySession = null;
    return null;
  }
}

function loadStoredIrisIdentitySessions(): Record<string, StoredIrisIdentitySession> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_IRIS_IDENTITY_SESSIONS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const sessions: Record<string, StoredIrisIdentitySession> = {};
    for (const [appKeyPubkey, stored] of Object.entries(parsed)) {
      const normalizedPubkey = normalizeHexPubkey(appKeyPubkey);
      if (!normalizedPubkey || !stored || typeof stored !== 'object') continue;
      sessions[normalizedPubkey] = stored as StoredIrisIdentitySession;
    }
    return sessions;
  } catch {
    return {};
  }
}

function removeStoredIrisIdentitySession(appKeyPubkey: string): void {
  const normalized = normalizeHexPubkey(appKeyPubkey);
  if (!normalized) return;
  const sessions = loadStoredIrisIdentitySessions();
  delete sessions[normalized];
  localStorage.setItem(STORAGE_KEY_IRIS_IDENTITY_SESSIONS, JSON.stringify(sessions));
}

function createDriveIdentitySession(options: {
  profileId?: IrisProfileId;
  appKeySecretKey: Uint8Array;
  createdAt?: number;
  clientNonce?: string;
  label?: string;
}): IrisIdentitySession {
  const appKeyPubkey = getPublicKey(options.appKeySecretKey);
  const profileId = options.profileId ?? randomProfileId();
  const createdAt = options.createdAt ?? currentUnixSeconds();
  const label = options.label ?? 'This device';
  const bootstrap = signIrisProfileRosterOp({
    signerSecretKey: options.appKeySecretKey,
    profileId,
    createdAt,
    clientNonce: options.clientNonce ?? randomClientNonce(),
    op: {
      op: 'add_facet',
      facet: {
        pubkey: appKeyPubkey,
        purposes: ['app_key'],
        capabilities: DRIVE_APP_KEY_ADMIN_CAPABILITIES,
        added_at: createdAt,
        label,
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

function serializeDriveIdentitySession(session: IrisIdentitySession): StoredIrisIdentitySession {
  return {
    schema: 1,
    profileId: session.profileId,
    appKeyNsec: session.appKeyNsec,
    status: session.status,
    rosterOps: session.rosterOps,
    createdAt: session.createdAt,
    ...(session.label ? { label: session.label } : {}),
    ...(session.pendingDeviceLink ? { pendingDeviceLink: session.pendingDeviceLink } : {}),
  };
}

function restoreDriveIdentitySession(stored: StoredIrisIdentitySession): IrisIdentitySession {
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
    const projection = projectIrisProfileRoster(stored.profileId, rosterOps);
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
  };
}

async function createRecoverySigner(recovery: DriveRecoveryRequest): Promise<IrisIdentityEventSigner> {
  if (recovery.method === 'nsec') {
    if (!recovery.nsec?.trim()) throw new Error('Enter your secret key');
    return createIrisIdentitySignerFromNsec(recovery.nsec);
  }
  if (recovery.method === 'seed_phrase') {
    if (!recovery.seedWords?.trim()) throw new Error('Enter your seed phrase');
    return createIrisIdentitySignerFromSeedPhrase({
      seedWords: recovery.seedWords,
      ...(recovery.seedPassphrase !== undefined ? { passphrase: recovery.seedPassphrase } : {}),
    });
  }
  if (recovery.method === 'nip07') {
    const nostr = (window as unknown as { nostr?: Parameters<typeof createIrisIdentitySignerFromNip07>[0] }).nostr;
    if (!nostr) throw new Error('No nostr extension found');
    return createIrisIdentitySignerFromNip07(nostr);
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
  return createIrisIdentitySignerFromNip46({
    getPublicKey: async () => (await remoteSigner.user()).pubkey,
    signEvent: async (draft) => {
      const event = new NDKEvent(ndk);
      event.kind = draft.kind;
      event.content = draft.content;
      event.tags = draft.tags.map((tag) => tag.slice());
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

async function fetchIrisProfileRosterOps(
  profileId: IrisProfileId,
  timeoutMs = 5000,
): Promise<SignedIrisProfileRosterOp[]> {
  await waitForWorkerAdapter(2000).catch(() => null);
  const byId = new Map<string, SignedIrisProfileRosterOp>();

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
      kinds: [KIND_IRIS_PROFILE_ROSTER_OP],
      '#i': [profileId],
      limit: 500,
    };
    const sub = ndk.subscribe(filter, { closeOnEose: true });
    const timer = setTimeout(finish, timeoutMs);

    sub.on('event', (event) => {
      try {
        const signed = parseIrisProfileRosterOpEvent(event.rawEvent() as NostrToolsEvent);
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

async function publishSignedIdentityEventJson(eventJson: string): Promise<void> {
  const event = JSON.parse(eventJson) as NostrToolsEvent;
  ndk.subManager.dispatchEvent(event as Parameters<typeof ndk.subManager.dispatchEvent>[0], undefined, true);
  const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(5000);
  if (adapter) {
    await adapter.publish(event as Parameters<typeof adapter.publish>[0]);
    return;
  }

  const ndkEvent = new NDKEvent(ndk, event);
  await ndkEvent.publish();
}

function normalizeProfileId(profileId: IrisProfileId): IrisProfileId {
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

function randomProfileId(): IrisProfileId {
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
