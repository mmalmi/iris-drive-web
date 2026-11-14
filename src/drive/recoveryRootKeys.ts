/**
 * Recovery phrase keys and the account's own Drive roots.
 *
 * Every device wraps the key of its latest My Drive root for the account's
 * recovery phrase keys too, not only for its devices. A device signed in with
 * the phrase can then open every device's latest root itself, so the files
 * come back even when no other device is left. Native Iris Drive does the
 * same; wraps for keys a reader does not hold are passed over, so this needs
 * no change to the root format.
 *
 * The phrase's own key is held here, in memory only, from signing in with it
 * until the page closes. It is never stored: once this device has published
 * its own root, which holds the Drive as it saw it, it no longer needs it.
 */
import { getPublicKey, type Event } from 'nostr-tools';
import type { NostrIdentityRosterProjection } from './protocol';

export const RECOVERY_PHRASE_PURPOSE = 'recovery_phrase';

const held = new Map<string, Uint8Array>();

/** Keeps a recovery key for opening roots wrapped for it, until the page closes. */
export function holdRecoveryKey(secretKey: Uint8Array): void {
  held.set(getPublicKey(secretKey), secretKey);
}

export function heldRecoveryKeys(): Uint8Array[] {
  return [...held.values()];
}

/** The account's recovery phrase keys, which its roots are wrapped for too. */
export function recoveryPhraseRecipients(projection: NostrIdentityRosterProjection | null): string[] {
  if (!projection) return [];
  return Object.entries(projection.active_facets)
    .filter(([, facet]) => facet.purposes?.includes(RECOVERY_PHRASE_PURPOSE))
    .map(([pubkey]) => pubkey)
    .sort();
}

/** After a root came in: see `recoveryKeysAfterRoot` in profileDriveRootPublish.ts. */
export function afterRootCameIn(rootScopeId: string, event: Event, deviceSecretKey: Uint8Array): void {
  void import('./profileDriveRootPublish')
    .then((publish) => publish.recoveryKeysAfterRoot(rootScopeId, event, deviceSecretKey))
    .catch(() => {});
}

/** Who a root event's key is wrapped for; empty when it cannot be read. */
export function rootWrapRecipients(event: Pick<Event, 'content'>): Set<string> {
  try {
    const content = JSON.parse(event.content) as { root_key_wraps?: Record<string, unknown> };
    return new Set(Object.keys(content.root_key_wraps ?? {}));
  } catch {
    return new Set();
  }
}
