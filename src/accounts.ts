/**
 * Multi-account management for HashTree Explorer
 * Stores multiple accounts and allows switching between them
 * Uses Svelte writable stores instead of Zustand
 */
import { writable, get } from 'svelte/store';
import { nip19, getPublicKey } from 'nostr-tools';

// Storage key for accounts list
const STORAGE_KEY_ACCOUNTS = 'hashtree:accounts';
const STORAGE_KEY_ACTIVE_ACCOUNT = 'hashtree:activeAccount';

export type AccountType = 'nsec' | 'extension' | 'drive_profile';

export interface Account {
  pubkey: string;
  npub: string;
  type: AccountType;
  name?: string;
  nsec?: string; // Only for nsec accounts
  nostrIdentityId?: string;
  addedAt: number;
}

interface AccountsState {
  accounts: Account[];
  activeAccountPubkey: string | null;
}

// Create the Svelte store
function createAccountsStore() {
  const { subscribe, set, update } = writable<AccountsState>({
    accounts: [],
    activeAccountPubkey: null,
  });

  const store = {
    subscribe,

    setAccounts: (accounts: Account[]) => {
      update(state => ({ ...state, accounts: normalizeAccounts(accounts) }));
    },

    setActiveAccount: (pubkey: string | null) => {
      update(state => ({ ...state, activeAccountPubkey: pubkey }));
    },

    addAccount: (account: Account) => {
      update(state => {
        const existingIndex = findMatchingAccountIndex(state.accounts, account);
        if (existingIndex >= 0) {
          const existing = state.accounts[existingIndex];
          const merged: Account = {
            ...existing,
            ...account,
            addedAt: existing.addedAt || account.addedAt,
          };
          const newAccounts = state.accounts.slice();
          newAccounts[existingIndex] = merged;
          let activeAccountPubkey = state.activeAccountPubkey;
          if (activeAccountPubkey === existing.pubkey && existing.pubkey !== merged.pubkey) {
            activeAccountPubkey = merged.pubkey;
            saveActiveAccountToStorage(activeAccountPubkey);
          }
          saveAccountsToStorage(newAccounts);
          return { ...state, accounts: newAccounts, activeAccountPubkey };
        }
        const newAccounts = [...state.accounts, account];
        saveAccountsToStorage(newAccounts);
        return { ...state, accounts: newAccounts };
      });
    },

    updateAccount: (pubkey: string, patch: Partial<Account>) => {
      update(state => {
        const index = state.accounts.findIndex(
          a => a.pubkey === pubkey || (patch.nostrIdentityId && a.nostrIdentityId === patch.nostrIdentityId)
        );
        if (index < 0) return state;
        const existing = state.accounts[index];
        const newAccounts = state.accounts.slice();
        const updated = { ...existing, ...patch, pubkey };
        newAccounts[index] = updated;
        let activeAccountPubkey = state.activeAccountPubkey;
        if (activeAccountPubkey === existing.pubkey && existing.pubkey !== updated.pubkey) {
          activeAccountPubkey = updated.pubkey;
          saveActiveAccountToStorage(activeAccountPubkey);
        }
        const normalizedAccounts = normalizeAccounts(newAccounts);
        saveAccountsToStorage(normalizedAccounts);
        return { ...state, accounts: normalizedAccounts, activeAccountPubkey };
      });
    },

    removeAccount: (pubkey: string): boolean => {
      const state = get(accountsStore);
      // Don't allow removing the last account
      if (state.accounts.length <= 1) {
        return false;
      }

      const newAccounts = state.accounts.filter(a => a.pubkey !== pubkey);
      saveAccountsToStorage(newAccounts);

      let newActiveAccountPubkey = state.activeAccountPubkey;
      // If removing active account, switch to another
      if (state.activeAccountPubkey === pubkey && newAccounts.length > 0) {
        newActiveAccountPubkey = newAccounts[0].pubkey;
        localStorage.setItem(STORAGE_KEY_ACTIVE_ACCOUNT, newAccounts[0].pubkey);
      }

      set({ accounts: newAccounts, activeAccountPubkey: newActiveAccountPubkey });
      return true;
    },

    // Get current state synchronously (for compatibility with Zustand patterns)
    getState: (): AccountsState => get(accountsStore),

    // Set state directly (for compatibility with Zustand patterns)
    setState: (newState: Partial<AccountsState>) => {
      update(state => ({ ...state, ...newState }));
    },
  };

  return store;
}

export const accountsStore = createAccountsStore();

export function getAccountIdentityKey(account: Pick<Account, 'nostrIdentityId' | 'pubkey' | 'type'>): string {
  return account.nostrIdentityId ? `iris-profile:${account.nostrIdentityId}` : `${account.type}:${account.pubkey}`;
}

function isSameAccountIdentity(a: Account, b: Account): boolean {
  if (a.nostrIdentityId && b.nostrIdentityId) {
    return a.nostrIdentityId === b.nostrIdentityId;
  }
  return a.pubkey === b.pubkey;
}

function findMatchingAccountIndex(accounts: Account[], account: Account): number {
  return accounts.findIndex(existing => isSameAccountIdentity(existing, account));
}

function normalizeAccounts(accounts: Account[]): Account[] {
  return accounts.reduce<Account[]>((normalized, account) => {
    const existingIndex = findMatchingAccountIndex(normalized, account);
    if (existingIndex < 0) {
      normalized.push(account);
      return normalized;
    }

    const existing = normalized[existingIndex];
    normalized[existingIndex] = {
      ...existing,
      ...account,
      addedAt: existing.addedAt || account.addedAt,
    };
    return normalized;
  }, []);
}

/**
 * Save accounts to localStorage (nsec stored for nsec accounts)
 */
function saveAccountsToStorage(accounts: Account[]) {
  const data = accounts.map(a => ({
    pubkey: a.pubkey,
    npub: a.npub,
    type: a.type,
    name: a.name,
    nsec: a.nsec,
    nostrIdentityId: a.nostrIdentityId,
    addedAt: a.addedAt,
  }));
  localStorage.setItem(STORAGE_KEY_ACCOUNTS, JSON.stringify(data));
}

/**
 * Load accounts from localStorage
 */
function loadAccountsFromStorage(): Account[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY_ACCOUNTS);
    if (!data) return [];
    return JSON.parse(data) as Account[];
  } catch {
    return [];
  }
}

/**
 * Get active account pubkey from localStorage
 */
function getActiveAccountFromStorage(): string | null {
  return localStorage.getItem(STORAGE_KEY_ACTIVE_ACCOUNT);
}

/**
 * Save active account to localStorage
 */
export function saveActiveAccountToStorage(pubkey: string | null) {
  if (pubkey) {
    localStorage.setItem(STORAGE_KEY_ACTIVE_ACCOUNT, pubkey);
  } else {
    localStorage.removeItem(STORAGE_KEY_ACTIVE_ACCOUNT);
  }
}

/**
 * Create account from nsec
 */
export function createAccountFromNsec(
  nsec: string,
  options: { type?: AccountType; nostrIdentityId?: string; name?: string } = {},
): Account | null {
  try {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') return null;
    const secretKey = decoded.data as Uint8Array;
    const pubkey = getPublicKey(secretKey);
    return {
      pubkey,
      npub: nip19.npubEncode(pubkey),
      type: options.type ?? 'nsec',
      name: options.name?.trim() || undefined,
      nsec,
      nostrIdentityId: options.nostrIdentityId,
      addedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Create account for extension (pubkey already known)
 */
export function createExtensionAccount(pubkey: string): Account {
  return {
    pubkey,
    npub: nip19.npubEncode(pubkey),
    type: 'extension',
    addedAt: Date.now(),
  };
}

/**
 * Check if window.nostr is available
 */
export function hasNostrExtension(): boolean {
  return typeof window !== 'undefined' && !!window.nostr;
}

/**
 * Initialize accounts store from localStorage
 */
export function initAccountsStore() {
  const storedAccounts = loadAccountsFromStorage();
  const accounts = normalizeAccounts(storedAccounts);
  if (accounts.length !== storedAccounts.length) {
    saveAccountsToStorage(accounts);
  }
  const activeAccountPubkey = getActiveAccountFromStorage();

  accountsStore.setState({
    accounts,
    activeAccountPubkey: activeAccountPubkey && accounts.some(a => a.pubkey === activeAccountPubkey)
      ? activeAccountPubkey
      : accounts.length > 0 ? accounts[0].pubkey : null,
  });
}
