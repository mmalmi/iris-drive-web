<script lang="ts">
  /**
   * Where the Drive is kept besides this device, and how each place stands at
   * a glance, below this device's own space on the Storage page. Backups go
   * on in the background while the page is left.
   */
  import FileServerActivity from './FileServerActivity.svelte';
  import { appStore, formatBytes } from '../../store';
  import { DEFAULT_NETWORK_SETTINGS, settingsStore, type BlossomServerConfig } from '../../stores/settings';
  import {
    addFolder,
    addServer,
    backUpNow,
    backupPlaces,
    backups,
    backupsRunHere,
    canBackUpToFolder,
    checkNow,
    removePlace,
    startBackups,
    type BackupPlace,
  } from '../../lib/backup/backups';
  import { backupStatus, normalizeServerUrl, serverName, type BackupTone } from '../../lib/backup/backupStatus';
  import { getEmbeddedDaemonBlossomServer } from '../../lib/runtimeNetwork';
  import { getCurrentNostrIdentitySession, nostrStore } from '../../nostr';
  import { projectNostrIdentityRoster } from '../../drive/protocol';
  import { activeRecoveryPhraseFacets } from '../../drive/recoveryPhrase';
  import { DRIVE_APP_DOWNLOAD_URL } from '../../lib/appBrand';

  const runsHere = backupsRunHere();
  const folders = canBackUpToFolder();
  const deviceServer = getEmbeddedDaemonBlossomServer();
  const TONE: Record<BackupTone, string> = {
    ok: 'text-success',
    busy: 'text-accent',
    idle: 'text-text-2',
    problem: 'text-danger',
  };

  let view = $derived($backups);
  let configuredServers = $derived($settingsStore.network.blossomServers);
  let places = $derived(backupPlaces(configuredServers, view.records));
  let serverBackups = $derived(new Map(places.filter((place) => place.url).map((place) => [place.url, place])));
  let folderBackups = $derived(places.filter((place) => place.kind === 'folder'));
  let usageByUrl = $derived(new Map($appStore.blossomBandwidth.servers.map((server) => [settingsUrl(server.url), server])));
  let editingServers = $state(false);
  let saveNewServer = $state(false);
  let serverConfigs = $derived.by(() => {
    const byUrl = new Map<string, BlossomServerConfig>();
    for (const server of configuredServers) {
      const url = settingsUrl(server.url);
      if (url === deviceServer?.url) continue;
      const existing = byUrl.get(url);
      byUrl.set(url, { url, read: server.read || !!existing?.read, write: server.write || !!existing?.write });
    }
    return [...byUrl.values()];
  });
  let shownServers = $derived(editingServers ? serverConfigs : serverConfigs.filter((server) => serverBackups.has(server.url)));
  let now = $state(Date.now());
  let draft = $state('');
  let draftError = $state('');
  // True with a recovery phrase, null without one, undefined when signed out.
  let recoveryPhrase = $derived.by((): true | null | undefined => {
    void $nostrStore;
    const session = getCurrentNostrIdentitySession();
    if (!session || session.status !== 'active') return undefined;
    const projection = projectNostrIdentityRoster(session.profileId, session.rosterOps);
    return activeRecoveryPhraseFacets(projection).length > 0 ? true : null;
  });

  $effect(() => {
    startBackups();
    const tick = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(tick);
  });

  function settingsUrl(url: string): string {
    return normalizeServerUrl(url) ?? url;
  }

  function add(event: SubmitEvent): void {
    event.preventDefault();
    draftError = addServer(draft, !editingServers || saveNewServer) ?? '';
    if (!draftError) {
      draft = '';
      saveNewServer = false;
    }
  }

  function setServerPermission(url: string, key: 'read' | 'write', enabled: boolean) {
    settingsStore.setNetworkSettings({
      blossomServers: configuredServers.map((server) => settingsUrl(server.url) === url ? { ...server, [key]: enabled } : server),
    });
    if (key === 'write' && enabled && runsHere) {
      const place = serverBackups.get(url);
      if (place) void backUpNow(place.id);
    }
  }

  function removeServer(url: string, place: BackupPlace | undefined) {
    if (place) {
      void removePlace(place.id, { removeServer: true });
      return;
    }
    settingsStore.setNetworkSettings({
      blossomServers: configuredServers.filter((server) => settingsUrl(server.url) !== url),
    });
  }

  function resetServers() {
    settingsStore.setNetworkSettings({ blossomServers: DEFAULT_NETWORK_SETTINGS.blossomServers });
    editingServers = false;
  }
</script>

{#snippet backupDetails(place: BackupPlace)}
  {@const record = view.records[place.id]}
  {@const live = view.live[place.id]}
  {@const status = backupStatus(record, view.root, live, now, place.kind)}
  <div class="text-sm {TONE[status.tone]}" data-testid="backup-status">{status.label}</div>
  {#if status.detail}
    <div class="text-xs text-text-3" data-testid="backup-detail">{status.detail}</div>
  {/if}
  {#if record?.backedUp && !live}
    <div class="text-xs text-text-3">
      Last backup sent {record.backedUp.sent} new {record.backedUp.sent === 1 ? 'part' : 'parts'} ({formatBytes(record.backedUp.bytesSent)})
    </div>
  {/if}
{/snippet}

{#snippet backupActions(place: BackupPlace, lastServer = false)}
  <button class="btn-ghost text-sm" disabled={!!view.live[place.id]} onclick={() => backUpNow(place.id)}>Back up now</button>
  <button class="btn-ghost text-sm" disabled={!!view.live[place.id]} onclick={() => checkNow(place.id)}>Check</button>
  <button
    class="btn-ghost text-sm text-danger"
    disabled={lastServer}
    title={lastServer ? 'Your Drive needs one file server to reach your other devices' : undefined}
    onclick={() => removePlace(place.id)}
  >Remove</button>
{/snippet}

<div class="space-y-6" data-testid="backup-settings">
  <section>
    <div class="mb-1 flex items-center justify-between gap-2">
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide">Backups</h3>
      <button
        class="btn-ghost text-xs"
        aria-expanded={editingServers}
        onclick={() => { editingServers = !editingServers; saveNewServer = false; }}
      >
        {editingServers ? 'Done' : 'Manage file servers'}
      </button>
    </div>
    <p class="text-sm text-text-2 mb-3">
      {#if editingServers}
        <strong>Read files</strong> lets Drive open your files and files shared with you. <strong>Save backups</strong> keeps an encrypted copy of your Drive on the server.
      {:else}
        Only your account can open these encrypted copies of your Drive.
      {/if}
    </p>
    {#if !runsHere}
      <p class="mb-3 rounded bg-surface-2 p-3 text-sm text-text-2">Backups for this app are set up in its Backups tab.</p>
    {/if}

    <ul class="list-none divide-y divide-surface-3 rounded bg-surface-2" aria-label="Backups">
      {#if editingServers && deviceServer}
        {@const usage = usageByUrl.get(deviceServer.url)}
        <li class="flex items-start gap-3 p-3" aria-label={serverName(deviceServer.url)}>
          <span class="i-lucide-server mt-0.5 shrink-0 text-lg text-text-3"></span>
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium text-text-1">{serverName(deviceServer.url)}</div>
            <div class="text-xs text-text-3">File server in the Iris app on this device</div>
            <div class="text-xs text-text-3">↑ {formatBytes(usage?.bytesSent ?? 0)} · ↓ {formatBytes(usage?.bytesReceived ?? 0)}</div>
          </div>
        </li>
      {/if}
      {#each shownServers as server (server.url)}
        {@const place = serverBackups.get(server.url)}
        {@const name = serverName(server.url)}
        {@const usage = usageByUrl.get(server.url)}
        {@const lastServer = !!place && serverBackups.size === 1 && runsHere}
        <li class="p-3" data-testid={place ? 'backup-place' : undefined} aria-label={name}>
          <div class="flex items-start gap-3">
            <span class="i-lucide-server mt-0.5 shrink-0 text-lg text-text-3"></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <span class="min-w-0 truncate text-sm font-medium text-text-1">{name}</span>
                <span class="text-xs text-text-3">File server</span>
              </div>
              {#if place}
                {@render backupDetails(place)}
              {/if}
              {#if editingServers}
                <div class="text-xs text-text-3">↑ {formatBytes(usage?.bytesSent ?? 0)} · ↓ {formatBytes(usage?.bytesReceived ?? 0)}</div>
              {/if}
            </div>
          </div>
          {#if editingServers || (place && runsHere)}
            <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-8">
              {#if editingServers}
                <label class="flex items-center gap-1 text-sm text-text-2">
                  <input type="checkbox" class="accent-accent" checked={server.read} onchange={(event) => setServerPermission(server.url, 'read', event.currentTarget.checked)} />
                  Read files
                </label>
                <label class="flex items-center gap-1 text-sm text-text-2">
                  <input
                    type="checkbox"
                    class="accent-accent"
                    checked={server.write}
                    disabled={!!(place && view.live[place.id])}
                    onchange={(event) => setServerPermission(server.url, 'write', event.currentTarget.checked)}
                  />
                  Save backups
                </label>
                <button
                  class="btn-ghost text-sm text-danger"
                  disabled={lastServer}
                  title={lastServer ? 'Your Drive needs one file server to reach your other devices' : undefined}
                  onclick={() => removeServer(server.url, place)}
                >Remove</button>
              {:else if place}
                {@render backupActions(place, lastServer)}
              {/if}
            </div>
          {/if}
        </li>
      {/each}
      {#each folderBackups as place (place.id)}
        <li class="p-3" data-testid="backup-place" aria-label={place.name}>
          <div class="flex items-start gap-3">
            <span class="i-lucide-folder mt-0.5 shrink-0 text-lg text-text-3"></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <span class="min-w-0 truncate text-sm font-medium text-text-1">{place.name}</span>
                <span class="text-xs text-text-3">Folder on this computer</span>
              </div>
              {@render backupDetails(place)}
            </div>
          </div>
          {#if runsHere}
            <div class="mt-2 flex flex-wrap gap-1 pl-8">
              {@render backupActions(place)}
            </div>
          {/if}
        </li>
      {/each}
      {#if !shownServers.length && !folderBackups.length && !(editingServers && deviceServer)}
        <li class="p-3 text-sm text-text-3">{editingServers ? 'No file servers configured' : 'No backups yet'}</li>
      {/if}
    </ul>

    {#if runsHere || editingServers}
      <form class="mt-3 space-y-2" novalidate onsubmit={add}>
        <div class="flex gap-2">
          <input
            class="input min-w-0 flex-1 text-sm"
            type="url"
            inputmode="url"
            placeholder="https://files.example.com"
            aria-label="File server address"
            bind:value={draft}
            oninput={() => (draftError = '')}
          />
          <button class="btn-primary shrink-0 text-sm" type="submit" disabled={!draft.trim()}>
            {editingServers ? 'Add file server' : 'Add backup server'}
          </button>
        </div>
        {#if editingServers}
          <label class="flex items-center gap-2 text-sm text-text-2">
            <input type="checkbox" class="accent-accent" bind:checked={saveNewServer} />
            Save a backup on this server
          </label>
        {/if}
      </form>
      {#if draftError}
        <p class="mt-1 text-xs text-danger" role="alert">{draftError}</p>
      {/if}
    {/if}
    {#if folders}
      <button class="btn-ghost mt-2 flex items-center gap-2 text-sm" onclick={addFolder}>
        <span class="i-lucide-folder-plus"></span>
        Back up to a folder on this computer
      </button>
    {/if}
    {#if editingServers}
      <button class="btn-ghost mt-2 text-xs text-text-3" onclick={resetServers} disabled={Object.keys(view.live).length > 0}>
        Reset file servers to defaults
      </button>
      <FileServerActivity />
    {/if}
  </section>

  <section>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Friends</h3>
    <p class="text-sm text-text-2">
      {#if runsHere}
        You and a friend can keep backups for each other with the
        <a class="text-accent underline" href={DRIVE_APP_DOWNLOAD_URL} target="_blank" rel="noreferrer">Iris Drive app</a>.
      {:else}
        Open the Backups tab to set up backups with a friend.
      {/if}
    </p>
  </section>

  <section>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">If you lose this device</h3>
    <div class="space-y-2 rounded bg-surface-2 p-3 text-sm text-text-2" data-testid="backup-restore">
      {#if recoveryPhrase}
        <p class="flex items-start gap-2 text-text-1" data-testid="backup-recovery-phrase">
          <span class="i-lucide-circle-check mt-0.5 shrink-0 text-success"></span>
          <span>Your recovery phrase is set up.</span>
        </p>
      {:else if recoveryPhrase === null}
        <p class="flex items-start gap-2 text-text-1" data-testid="backup-recovery-phrase">
          <span class="i-lucide-circle-alert mt-0.5 shrink-0 text-danger"></span>
          <span>You have no recovery phrase yet. <a href="#/settings/account/recovery" class="text-accent">Create recovery phrase</a></span>
        </p>
      {/if}
      <p>Sign in on a new device with your recovery phrase and your files come back from the file servers above. If you added a file server of your own, add it on the new device too.</p>
      {#if folderBackups.length}
        <p>A copy in a folder is encrypted as well; Drive cannot read one back yet.</p>
      {/if}
      <a href="#/users/existing" class="inline-block text-accent">Sign in on another device</a>
    </div>
  </section>
</div>
