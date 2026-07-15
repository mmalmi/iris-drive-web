import type { BlossomServerConfig } from '../stores/settings';
import {
  getRuntimeBlossomServer,
  getRuntimeBlossomServers,
  getRuntimeNostrRelays,
  normalizeRuntimeServerUrl,
} from './htreeRuntime';

export { normalizeRuntimeServerUrl };

export function getEmbeddedDaemonBlossomServer(): BlossomServerConfig | null {
  return getRuntimeBlossomServer();
}

export function getEffectiveBlossomServers(servers: BlossomServerConfig[]): BlossomServerConfig[] {
  return getRuntimeBlossomServers(servers);
}

export function getEffectiveNostrRelays(relays: string[]): string[] {
  return getRuntimeNostrRelays(relays);
}
