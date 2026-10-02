import { writable, get } from 'svelte/store';
import { toHex, type CID, type Hash, type RefResolverSubscriptionMetadata, type SubscribeVisibilityInfo } from '@hashtree/core';
import { nostrStore, type NostrState } from '../nostr';
import { treeRootRegistry, type TreeRootRecord } from '../TreeRootRegistry';

export const treeRootStore = writable<CID | null>(null);

export const subscriptionState = new Map<string, {
  decryptedKey: Hash | undefined;
  listeners: Set<(
    hash: Hash | null,
    encryptionKey?: Hash,
    visibilityInfo?: SubscribeVisibilityInfo,
    metadata?: RefResolverSubscriptionMetadata
  ) => void>;
  unsubscribeResolver: (() => void) | null;
  unsubscribeWorker: (() => void) | null;
  workerHydrateRetryTimer: ReturnType<typeof setTimeout> | null;
}>();

export type ResolverListVisibilityEntry = {
  key?: string;
  visibility?: string;
  selfEncryptedLinkKey?: string;
  encryptedKey?: string;
  selfEncryptedKey?: string;
};

export const workerKeyMergeCache = new Map<string, string>();
export const workerRootCacheSync = new Map<string, string>();

export function getNostrState(): NostrState {
  return get(nostrStore) as NostrState;
}

export function getVisibilityInfoFromRegistry(key: string): SubscribeVisibilityInfo | undefined {
  const record = treeRootRegistry.getByKey(key);
  if (!record) return undefined;
  return {
    visibility: record.visibility,
    encryptedKey: record.encryptedKey,
    keyId: record.keyId,
    selfEncryptedKey: record.selfEncryptedKey,
    selfEncryptedLinkKey: record.selfEncryptedLinkKey,
  };
}

export function getWorkerRootSignature(record: TreeRootRecord): string {
  const labels = record.labels?.join(',') ?? '';
  return [
    toHex(record.hash),
    record.key ? toHex(record.key) : '',
    record.visibility,
    record.updatedAt,
    labels,
  ].join(':');
}
