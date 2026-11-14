/**
 * Connects an open document to the others who have it open (liveChannel.ts):
 * finds the secret this device may use for it, follows key rotation and
 * changes of who may take part, and names this person. Loaded only once a
 * document has opened. Nothing here waits for a relay.
 */
import { getPublicKey } from 'nostr-tools';
import type * as Y from 'yjs';
import { nostrStore, type NostrState } from '../../nostr/store';
import { nostr } from '../../nostr/client';
import { getCurrentNostrIdentitySession, getSecretKey } from '../../nostr/auth';
import { acceptedShares, type AcceptedShareRecord } from '../../drive/shareLibrary';
import { activeShareScope } from '../../drive/shareScope';
import { accountsStore } from '../../accounts';
import { createIdentityProfileNameStore } from '../../stores/identityProfile';
import { accountLiveAccess, driveLiveAccess, shareLiveAccess, type LiveAccess, type OwnAccount } from './liveAccess';
import { LiveChannel } from './liveChannel';
import { deriveLiveKey, type LivePlace } from './liveKeys';
import { fipsLiveTransport, nostrLiveTransport } from './liveTransports';
import type { LivePresence } from './presence.svelte';

/** Browsers slow the timers of a tab hidden for five minutes to once a minute. */
const LONG_HIDDEN_MS = 4 * 60_000;

export interface LiveConnection {
  destroy(): void;
}

export interface ConnectLiveOptions {
  ydoc: Y.Doc;
  presence: LivePresence;
  place: LivePlace;
  canEdit: () => boolean;
  onRemoteUpdate: (update: Uint8Array) => void;
}

function currentAccess(
  scope: string,
  state: NostrState,
  shares: AcceptedShareRecord[],
  deviceKey: string,
  deviceSecretKey: Uint8Array,
  own: OwnAccount,
): LiveAccess | null {
  if (!state.isLoggedIn || state.pubkey !== deviceKey) return null;
  const share = activeShareScope(scope, state, shares);
  if (share) return shareLiveAccess(share.record.folder, deviceKey, deviceSecretKey);
  const session = getCurrentNostrIdentitySession();
  if (session?.status === 'active' && session.profileId === scope && session.appKeyPubkey === deviceKey) {
    return driveLiveAccess(session.profileId, session.rosterOps, deviceKey, deviceSecretKey, own);
  }
  return scope === state.npub ? accountLiveAccess(deviceSecretKey, own) : null;
}

/** Null when this device holds no key it could use, as when only looking at someone's public files. */
export function connectLive(options: ConnectLiveOptions): LiveConnection | null {
  const deviceSecretKey = getSecretKey();
  const deviceKey = nostrStore.getState().pubkey;
  if (!deviceSecretKey || !deviceKey || getPublicKey(deviceSecretKey) !== deviceKey) return null;
  const { presence, place } = options;

  let access: LiveAccess | null = null;
  const channel = new LiveChannel({
    ydoc: options.ydoc,
    presence,
    deviceSecretKey,
    transports: [
      nostrLiveTransport(nostr),
      fipsLiveTransport({ audience: () => new Set(access?.devices.keys()), ownKey: deviceKey }),
    ],
    canEdit: options.canEdit,
    online: () => navigator.onLine,
    // This account's other devices are "You": a second device may not know the account's chosen name.
    identify: (key) => {
      const device = access?.devices.get(key);
      return device && device.id === presence.user.id ? { ...device, name: 'You' } : device ?? null;
    },
    onRemoteUpdate: (update) => {
      // Tests tell edits that came live from ones the files brought.
      if (import.meta.env.VITE_TEST_MODE) {
        const counted = window as Window & { __liveEditsReceived?: number };
        counted.__liveEditsReceived = (counted.__liveEditsReceived ?? 0) + 1;
      }
      options.onRemoteUpdate(update);
    },
  });

  // This account's name, for its own devices: the one chosen on this device, else its profile's.
  const chosen = accountsStore.getState().accounts.find(account => account.pubkey === deviceKey)?.name?.trim();
  let ownName = chosen || presence.user.name;

  // Access is worked out again only when what it depends on changed.
  let inputs: unknown[] = [];
  let shares: AcceptedShareRecord[] = [];
  const follow = (): void => {
    const state = nostrStore.getState();
    const session = getCurrentNostrIdentitySession();
    const next = [state.isLoggedIn, state.pubkey, shares, session, session?.rosterOps, ownName];
    if (next.length === inputs.length && next.every((value, index) => value === inputs[index])) return;
    inputs = next;
    access = currentAccess(place.scope, state, shares, deviceKey, deviceSecretKey, { name: ownName || 'Someone', npub: state.npub });
    channel.setKeys(access ? access.secrets.map(({ id, secret }) => deriveLiveKey(access!.kind, secret, id, place)) : []);
    channel.recheck();
  };
  const stopShares = acceptedShares.subscribe((records) => {
    shares = records;
    follow();
  });
  const stopNostr = nostrStore.subscribe(() => follow());

  const profileId = getCurrentNostrIdentitySession()?.profileId;
  const stopName = chosen ? () => {} : createIdentityProfileNameStore(profileId, deviceKey).subscribe(({ name }) => {
    if (!name || name === ownName) return;
    ownName = name;
    presence.setUser({ ...presence.user, name });
    follow();
  });

  // Leaving the page says goodbye at once, and so does a tab hidden for
  // long, whose heartbeat the browser then slows below what keeps it shown.
  // Coming back says hello.
  let away: Record<string, unknown> | null = null;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  const leave = (): void => {
    if (away) return;
    away = presence.awareness.getLocalState();
    if (away) presence.awareness.setLocalState(null);
  };
  const comeBack = (): void => {
    clearTimeout(hiddenTimer);
    if (away) presence.awareness.setLocalState(away);
    away = null;
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) comeBack();
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') comeBack();
    else hiddenTimer = setTimeout(leave, LONG_HIDDEN_MS);
  };
  window.addEventListener('pagehide', leave);
  window.addEventListener('pageshow', onPageShow);
  const onOnline = (): void => channel.resume();
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    destroy() {
      clearTimeout(hiddenTimer);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      stopName();
      stopShares();
      stopNostr();
      channel.destroy();
    },
  };
}
