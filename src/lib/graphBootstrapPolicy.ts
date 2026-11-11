import { DEFAULT_PUBLIC_RELAYS, RETIRED_PUBLIC_RELAYS } from '@iris/hashtree-app/defaultRelays';

const normalize = (relay: string): string => relay.trim().replace(/\/+$/, '');
const publicRelays = new Set(DEFAULT_PUBLIC_RELAYS.map(normalize));
const retiredRelays = new Set(RETIRED_PUBLIC_RELAYS.map(normalize));

/**
 * Fixed public graph bootstrap is allowed only with the shipped public relay policy.
 * Relays that were shipped once and no longer answer do not count as a custom choice.
 */
export function allowsPublicGraphBootstrap(relays: readonly string[]): boolean {
  const configured = new Set(relays.map(normalize).filter(relay => !retiredRelays.has(relay)));
  return configured.size > 0
    && configured.size === publicRelays.size
    && [...configured].every(relay => publicRelays.has(relay));
}

export interface FipsBootstrapOptions {
  websocketSeedUrls?: readonly string[];
  stunServers?: readonly string[];
}

export function getFipsBootstrapOptions(
  relays: readonly string[],
  explicit: FipsBootstrapOptions = {},
): FipsBootstrapOptions {
  const publicDefaultsAllowed = allowsPublicGraphBootstrap(relays);
  return {
    websocketSeedUrls: explicit.websocketSeedUrls ?? (publicDefaultsAllowed ? undefined : []),
    stunServers: explicit.stunServers ?? (publicDefaultsAllowed ? undefined : []),
  };
}
