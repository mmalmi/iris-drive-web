import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const componentsRoot = path.resolve(process.cwd(), 'src', 'components');
const settingsRoot = path.join(componentsRoot, 'settings');
const settingsLayoutSource = fs.readFileSync(path.join(settingsRoot, 'SettingsLayout.svelte'), 'utf8');
const appSettingsSource = fs.readFileSync(path.join(settingsRoot, 'AppSettings.svelte'), 'utf8');
const storageSettingsSource = fs.readFileSync(path.join(settingsRoot, 'StorageSettings.svelte'), 'utf8');
const serversSettingsSource = fs.readFileSync(path.join(settingsRoot, 'ServersSettings.svelte'), 'utf8');
const transportUsageSettingsSource = fs.readFileSync(path.join(settingsRoot, 'TransportUsageSettings.svelte'), 'utf8');
const p2pSettingsSource = fs.readFileSync(path.join(settingsRoot, 'P2PSettings.svelte'), 'utf8');
const routerSource = fs.readFileSync(path.join(componentsRoot, 'Router.svelte'), 'utf8');

describe('shared settings layout', () => {
  it('keeps Network as a top-level tab while splitting it into smaller subpages', () => {
    expect(settingsLayoutSource).toContain("id: 'app'");
    expect(settingsLayoutSource).toContain("label: 'App'");
    expect(settingsLayoutSource).toContain("id: 'network'");
    expect(settingsLayoutSource).toContain("label: 'Network'");
    expect(settingsLayoutSource).not.toContain('Account tools, build info, and refresh actions');
    expect(settingsLayoutSource).not.toContain('Cache limits, local storage, and republish tools');
    expect(settingsLayoutSource).not.toContain('Relays, file servers, and peer transport settings');
    expect(settingsLayoutSource).not.toContain('App behavior, storage, and network configuration for this shell.');
    expect(settingsLayoutSource).not.toContain('const settingsGroups =');
    expect(settingsLayoutSource).not.toContain('mx-auto w-full max-w-md');
    expect(settingsLayoutSource).not.toContain('mx-auto w-full max-w-4xl');
    expect(settingsLayoutSource).not.toContain("{ id: 'servers'");
    expect(settingsLayoutSource).not.toContain("{ id: 'p2p'");
    expect(settingsLayoutSource).toContain("id: 'traffic'");
    expect(settingsLayoutSource).toContain("id: 'servers'");
    expect(settingsLayoutSource).toContain("id: 'p2p'");
    expect(settingsLayoutSource).toContain('/settings/network/traffic');
  });

  it('keeps colored icon pills for the top-level settings navigation', () => {
    expect(settingsLayoutSource).toContain('bg-accent/12 text-accent ring-1 ring-accent/20');
    expect(settingsLayoutSource).toContain('bg-amber-500/12 text-amber-500 ring-1 ring-amber-500/20');
    expect(settingsLayoutSource).toContain('bg-sky-500/12 text-sky-500 ring-1 ring-sky-500/20');
  });

  it('routes nested settings paths through the shared layout', () => {
    expect(routerSource).toContain("{ pattern: '/settings/*', id: 'settings' }");
  });

  it('maps legacy network routes onto focused network subpages', () => {
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/storage')) return 'storage';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/network')) return 'network';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/app')) return 'app';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/servers')) return 'servers';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/p2p')) return 'p2p';");
    expect(settingsLayoutSource).toContain("return DEFAULT_TAB;");
    expect(appSettingsSource).not.toContain('max-w-2xl mx-auto');
    expect(storageSettingsSource).not.toContain('max-w-2xl mx-auto');
    expect(transportUsageSettingsSource).not.toContain('max-w-2xl mx-auto');
    expect(p2pSettingsSource).not.toContain('max-w-2xl mx-auto');
  });

  it('shows embedded daemon transport and upstream relays inside one relay section', () => {
    expect(serversSettingsSource).toContain('Relays');
    expect(serversSettingsSource).toContain('Configured upstream relays');
    expect(serversSettingsSource).not.toContain('Local Transport (');
  });
});
