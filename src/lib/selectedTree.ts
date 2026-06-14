import type { TreeVisibility } from '@hashtree/core';
import { nip19 } from 'nostr-tools';
import type { HashTreeEvent, NostrState } from '../nostr/store';

export interface SelectedTreeRouteOptions {
  npub: string;
  treeName: string;
  visibility?: TreeVisibility;
  labels?: string[];
  nowMs?: number;
}

type SelectedTreeState = Pick<NostrState, 'isLoggedIn' | 'pubkey' | 'selectedTree'>;

interface SelectedTreeStore {
  getState(): SelectedTreeState;
  setSelectedTree(tree: HashTreeEvent | null): void;
}

function decodeNpub(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') return null;
    return decoded.data as string;
  } catch {
    return null;
  }
}

function sameLabels(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function sameSelectedTree(a: HashTreeEvent | null, b: HashTreeEvent | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  return a.id === b.id
    && a.pubkey === b.pubkey
    && a.name === b.name
    && a.rootHash === b.rootHash
    && a.rootKey === b.rootKey
    && a.visibility === b.visibility
    && a.encryptedKey === b.encryptedKey
    && a.keyId === b.keyId
    && a.selfEncryptedKey === b.selfEncryptedKey
    && a.selfEncryptedLinkKey === b.selfEncryptedLinkKey
    && a.created_at === b.created_at
    && sameLabels(a.labels, b.labels);
}

export function buildSelectedTreeForOwnRoute(
  state: SelectedTreeState,
  options: SelectedTreeRouteOptions
): HashTreeEvent | null {
  const pubkey = decodeNpub(options.npub);
  if (!pubkey || !state.isLoggedIn || state.pubkey !== pubkey) return null;

  const current = state.selectedTree?.pubkey === pubkey && state.selectedTree.name === options.treeName
    ? state.selectedTree
    : null;
  const createdAt = current?.created_at ?? Math.floor((options.nowMs ?? Date.now()) / 1000);

  return {
    ...(current ?? {
      id: '',
      pubkey,
      name: options.treeName,
      rootHash: '',
      visibility: 'public' as TreeVisibility,
      created_at: createdAt,
    }),
    pubkey,
    name: options.treeName,
    labels: options.labels ?? current?.labels,
    rootHash: current?.rootHash ?? '',
    rootKey: current?.rootKey,
    visibility: options.visibility ?? current?.visibility ?? 'public',
    created_at: createdAt,
  };
}

export function syncSelectedTreeForOwnRoute(store: SelectedTreeStore, options: SelectedTreeRouteOptions): boolean {
  const state = store.getState();
  const next = buildSelectedTreeForOwnRoute(state, options);
  if (!next) return false;
  if (sameSelectedTree(state.selectedTree, next)) return true;
  store.setSelectedTree(next);
  return true;
}
