import { AppNostrClient } from '@iris/hashtree-app/nostr';
import {
  createNostrIdentitySignerFromNsec,
  createNostrIdentitySignerFromNip07,
} from '@iris/identity/signers';
import type { EventTemplate } from 'nostr-tools';
import { getRuntimeHtreeServerUrl, getRuntimeNostrRelays } from '../lib/htreeRuntime';
import { settingsStore } from '../stores/settings';

export const nostr = new AppNostrClient();
export type { Event as NostrEvent, Filter as NostrFilter } from 'nostr-tools';
export { createNostrIdentitySignerFromNsec as createNsecSigner };

export function createExtensionSigner() {
  if (!window.nostr) throw new Error('No signing extension found.');
  return createNostrIdentitySignerFromNip07(window.nostr);
}

export function signEvent(event: EventTemplate) {
  return nostr.signEvent(event);
}

export function getNativeDaemonRelayUrl(): string | null {
  return getRuntimeHtreeServerUrl() ? getRuntimeNostrRelays([])[0] ?? null : null;
}

export function getEffectiveNostrRelayUrls(relays: string[]): string[] {
  return [...new Set(getRuntimeNostrRelays(relays).map(url => url.trim().replace(/\/+$/, '')))];
}

export function getNostrRelayUrls(): string[] {
  return getEffectiveNostrRelayUrls(settingsStore.getState().network.relays);
}

export async function configureNostrRelays(relays: string[], timeoutMs = 5000): Promise<void> {
  const { waitForWorkerAdapter } = await import('../lib/workerInit');
  const adapter = await waitForWorkerAdapter(timeoutMs);
  if (adapter) await adapter.setRelays(getEffectiveNostrRelayUrls(relays));
}

if (typeof window !== 'undefined') {
  (window as Window & { __nostr?: AppNostrClient }).__nostr = nostr;
}
