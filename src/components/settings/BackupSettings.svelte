<script lang="ts">
  /**
   * Where the Drive is kept besides this device, and how each place stands at
   * a glance. Backups go on in the background while the page is left.
   */
  import { appStore, formatBytes, updateStorageStats } from '../../store';
  import { settingsStore } from '../../stores/settings';
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
  } from '../../lib/backup/backups';
  import { backupStatus, type BackupTone } from '../../lib/backup/backupStatus';
  import { getCurrentNostrIdentitySession, nostrStore } from '../../nostr';
  import { projectNostrIdentityRoster } from '../../drive/protocol';
  import { activeRecoveryPhraseFacets } from '../../drive/recoveryPhrase';

  const runsHere = backupsRunHere();
  const folders = canBackUpToFolder();
  const TONE: Record<BackupTone, string> = {
    ok: 'text-success',
    busy: 'text-accent',
    idle: 'text-text-2',
    problem: 'text-danger',
  };

  let view = $derived($backups);
  let places = $derived(backupPlaces($settingsStore.network.blossomServers, view.records));
  let servers = $derived(places.filter((place) => place.kind === 'server').length);
  let hasFolder = $derived(places.some((place) => place.kind === 'folder'));
  let stats = $derived($appStore.stats);
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
    updateStorageStats();
    const tick = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(tick);
  });

  function add(event: SubmitEvent): void {
    event.preventDefault();
    draftError = addServer(draft) ?? '';
    if (!draftError) draft = '';
  }
</script>

<div class="space-y-6" data-testid="backup-settings">
  <section>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-3">On this device</h3>
    <a
      href="#/settings/storage"
      class="flex items-center gap-3 rounded bg-surface-2 p-3 no-underline transition-colors hover:bg-surface-3"
      data-testid="backup-this-device"
    >
      <span class="i-lucide-laptop shrink-0 text-xl text-text-3"></span>
      <span class="min-w-0 flex-1">
        <span class="block text-sm text-text-1">This device</span>
        <span class="block text-xs text-text-3">Keeps {formatBytes(stats.bytes)} of files you added or opened here</span>
      </span>
      <span class="shrink-0 text-sm text-accent">Storage</span>
      <span class="i-lucide-chevron-right shrink-0 text-text-3"></span>
    </a>
  </section>

  <section>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Backups</h3>
    <p class="text-sm text-text-2 mb-3">
      Places that keep a copy of your Drive. They get it locked: only your account can open it.
    </p>
    {#if !runsHere}
      <p class="mb-3 rounded bg-surface-2 p-3 text-sm text-text-2">Backups for this app are set up in its Backups tab.</p>
    {/if}

    <ul class="list-none divide-y divide-surface-3 rounded bg-surface-2" aria-label="Backups">
      {#each places as place (place.id)}
        {@const record = view.records[place.id]}
        {@const live = view.live[place.id]}
        {@const status = backupStatus(record, view.root, live, now, place.kind)}
        {@const lastServer = place.kind === 'server' && servers === 1}
        <li class="p-3" data-testid="backup-place" aria-label={place.name}>
          <div class="flex items-start gap-3">
            <span class="{place.kind === 'server' ? 'i-lucide-server' : 'i-lucide-folder'} mt-0.5 shrink-0 text-lg text-text-3"></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <span class="min-w-0 truncate text-sm font-medium text-text-1">{place.name}</span>
                <span class="text-xs text-text-3">{place.kind === 'server' ? 'File server' : 'Folder on this computer'}</span>
              </div>
              <div class="text-sm {TONE[status.tone]}" data-testid="backup-status">{status.label}</div>
              {#if status.detail}
                <div class="text-xs text-text-3" data-testid="backup-detail">{status.detail}</div>
              {/if}
              {#if record?.backedUp && !live}
                <div class="text-xs text-text-3">
                  Last backup sent {record.backedUp.sent} new {record.backedUp.sent === 1 ? 'part' : 'parts'} ({formatBytes(record.backedUp.bytesSent)})
                </div>
              {/if}
            </div>
          </div>
          {#if runsHere}
            <div class="mt-2 flex flex-wrap gap-1 pl-8">
              <button class="btn-ghost text-sm" disabled={!!live} onclick={() => backUpNow(place.id)}>Back up now</button>
              <button class="btn-ghost text-sm" disabled={!!live} onclick={() => checkNow(place.id)}>Check</button>
              <button
                class="btn-ghost text-sm text-danger"
                disabled={lastServer}
                title={lastServer ? 'Your Drive needs one file server to reach your other devices' : undefined}
                onclick={() => removePlace(place.id)}
              >Remove</button>
            </div>
          {/if}
        </li>
      {:else}
        <li class="p-3 text-sm text-text-3">No backups yet</li>
      {/each}
    </ul>

    {#if runsHere}
      <form class="mt-3 flex gap-2" novalidate onsubmit={add}>
        <input
          class="input min-w-0 flex-1 text-sm"
          type="url"
          inputmode="url"
          placeholder="https://files.example.com"
          aria-label="File server address"
          bind:value={draft}
          oninput={() => (draftError = '')}
        />
        <button class="btn-primary shrink-0 text-sm" type="submit" disabled={!draft.trim()}>Add file server</button>
      </form>
      {#if draftError}
        <p class="mt-1 text-xs text-danger" role="alert">{draftError}</p>
      {/if}
      {#if folders}
        <button class="btn-ghost mt-2 flex items-center gap-2 text-sm" onclick={addFolder}>
          <span class="i-lucide-folder-plus"></span>
          Back up to a folder on this computer
        </button>
      {/if}
    {/if}
  </section>

  <section>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Friends</h3>
    <p class="text-sm text-text-2">Keeping backups for each other with friends is available in the Iris Drive app.</p>
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
      <p>Sign in on another device with your recovery phrase. Your folders and files reach it from one of your other devices the next time Drive is open there.</p>
      <p class="text-text-1" data-testid="backup-keep-two">If every device is lost, the recovery phrase brings back your account but not your files yet. Keep Drive on two devices.</p>
      <p>A file server you added yourself: add it there too, here under Backup.</p>
      {#if hasFolder}
        <p>A copy in a folder is kept locked as well; Drive cannot read one back yet.</p>
      {/if}
      <a href="#/users/existing" class="inline-block text-accent">Sign in on another device</a>
    </div>
  </section>
</div>
