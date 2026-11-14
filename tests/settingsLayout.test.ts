import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const componentsRoot = path.resolve(process.cwd(), 'src', 'components');
const settingsRoot = path.join(componentsRoot, 'settings');
const read = (name: string) => fs.readFileSync(path.join(settingsRoot, name), 'utf8');
const settingsLayoutSource = read('SettingsLayout.svelte');
const accountSettingsSource = read('AccountSettings.svelte');
const aboutSettingsSource = read('AboutSettings.svelte');
const keysSettingsSource = read('KeysSettings.svelte');
const storageSettingsSource = read('StorageSettings.svelte');
const serversSettingsSource = read('ServersSettings.svelte');
const transportUsageSettingsSource = read('TransportUsageSettings.svelte');
const p2pSettingsSource = read('P2PSettings.svelte');
const userSettingsSource = read('UserSettings.svelte');
const routerSource = fs.readFileSync(path.join(componentsRoot, 'Router.svelte'), 'utf8');

describe('shared settings layout', () => {
  it('puts Account, Storage and About first and network, keys and developer details under Advanced', () => {
    const [main, advanced] = settingsLayoutSource.split('const advancedTabs');
    for (const id of ['account', 'storage', 'about']) expect(main).toContain(`id: '${id}'`);
    for (const id of ['network', 'keys', 'developer']) {
      expect(main).not.toContain(`id: '${id}'`);
      expect(advanced).toContain(`id: '${id}'`);
    }
    expect(settingsLayoutSource).toContain("const DEFAULT_TAB: TabId = 'account';");
    expect(settingsLayoutSource).toContain('aria-label="Advanced"');
    expect(settingsLayoutSource).toContain('aria-expanded={advancedOpen}');
    expect(settingsLayoutSource).toContain('let advancedOpen = $state(false);');
    expect(settingsLayoutSource).not.toContain("label: 'App'");
  });

  it('splits Network into usage, servers and direct connections', () => {
    expect(settingsLayoutSource).toContain("id: 'traffic'");
    expect(settingsLayoutSource).toContain("id: 'servers'");
    expect(settingsLayoutSource).toContain("id: 'p2p'");
    expect(settingsLayoutSource).toContain('/settings/network/${id}');
    expect(settingsLayoutSource).not.toContain('FIPS');
    expect(settingsLayoutSource).not.toContain('Blossom');
  });

  it('keeps colored icon pills for the settings navigation', () => {
    expect(settingsLayoutSource).toContain('bg-emerald-500/12 text-emerald-500 ring-1 ring-emerald-500/20');
    expect(settingsLayoutSource).toContain('bg-amber-500/12 text-amber-500 ring-1 ring-amber-500/20');
    expect(settingsLayoutSource).toContain('bg-sky-500/12 text-sky-500 ring-1 ring-sky-500/20');
  });

  it('routes nested settings paths through the shared layout', () => {
    expect(routerSource).toContain("{ pattern: '/settings/*', id: 'settings' }");
  });

  it('maps older settings addresses onto the pages that now hold them', () => {
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/user') || path.startsWith('/settings/identity')) return 'account';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/app')) return 'account';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/storage')) return 'storage';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/network')) return 'network';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/servers')) return 'servers';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/p2p')) return 'p2p';");
    expect(settingsLayoutSource).toContain('return DEFAULT_TAB;');
    for (const source of [accountSettingsSource, storageSettingsSource, transportUsageSettingsSource, p2pSettingsSource]) {
      expect(source).not.toContain('max-w-2xl mx-auto');
    }
  });

  it('keeps keys off the everyday pages and the secret key hidden until asked for', () => {
    for (const source of [accountSettingsSource, aboutSettingsSource, storageSettingsSource]) {
      expect(source).not.toMatch(/getNsec|nsec|npub|secret key/i);
    }
    expect(keysSettingsSource).toContain('let revealedSecretKey = $state<string | null>(null);');
    expect(keysSettingsSource).toContain('controls your account');
  });

  it('does not offer to take away the last device that can manage the account', () => {
    expect(userSettingsSource).toContain('onRevokeAdmin={adminCount > 1 ? revokeAdmin : undefined}');
  });

  it('shows embedded daemon transport and upstream relays inside one relay section', () => {
    expect(serversSettingsSource).toContain('Relays');
    expect(serversSettingsSource).toContain('Configured upstream relays');
    expect(serversSettingsSource).not.toContain('Local Transport (');
  });
});
