import type { FipsIdentity } from '@fips/core';
import { openBrowserAnnouncements, type BrowserHashtreeNostrProvider } from '@hashtree/fips-transport/browser';
import { DEFAULT_FIPS_ADVERT_TTL_MS, FIPS_ADVERT_D_TAG, NostrPeerDiscovery } from '@fips/transport-webrtc';

/** Native Drive devices announce in their profile's namespace. The same FIPS
 * node continues to discover public block services in the shared namespace. */
export async function followDriveRosterPeers(
  profileId: string,
  identity: FipsIdentity,
  provider: BrowserHashtreeNostrProvider,
  relays: string[],
  stunServers: string[],
  rosterKeys: () => readonly string[],
): Promise<() => Promise<void>> {
  const scope = `iris-drive:${profileId}`;
  const announcements = await openBrowserAnnouncements(provider.localPeerId, scope, relays, undefined,
    (error) => console.warn('[drive-fips] roster discovery:', error));
  announcements.attach(provider.nostrSource);
  const discovery = new NostrPeerDiscovery({ identity, relays: [], provider: announcements.discovery, discoveryApp: scope });
  const endpoint = { transport: 'webrtc', addr: provider.localPeerId };
  const announce = () => discovery.publishAdvert({ identifier: FIPS_ADVERT_D_TAG, version: 1, endpoints: [endpoint], stunServers });
  let refresh: ReturnType<typeof setInterval> | undefined;
  async function close() {
    clearInterval(refresh);
    discovery.stop();
    await announcements.close();
  }
  try {
    await discovery.subscribeAdverts((event, advert) => {
      if (!rosterKeys().includes(event.pubkey)) return;
      const peer = advert.endpoints.find(({ transport, addr }) => transport === 'webrtc'
        && /^(02|03)[0-9a-f]{64}$/.test(addr) && addr.slice(2) === event.pubkey);
      if (peer && peer.addr !== endpoint.addr && !provider.listConnectedPeerIds().includes(peer.addr)) {
        void provider.node.connect(peer).catch(() => { /* The peer may have gone offline since announcing. */ });
      }
    });
    await announce();
    refresh = setInterval(() => {
      void announce().catch((error) => console.warn('[drive-fips] roster announcement:', error));
    }, DEFAULT_FIPS_ADVERT_TTL_MS / 2);
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
