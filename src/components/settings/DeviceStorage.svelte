<script lang="ts">
  /**
   * Each of the account's devices: whether it is connected to this one,
   * whether it has the same version of the Drive, and how much of it it
   * holds and has room for, on one scale, so they can be compared at a
   * glance. A row opens to the folders: what the device holds, not only how
   * much. Adding, naming and removing devices stays on the devices page.
   */
  import { onMount } from 'svelte';
  import { userSettingsKeyLabel } from '@iris/svelte-ui/userSettings';
  import { appStore, formatBytes } from '../../store';
  import { getCurrentNostrIdentitySession, loadDriveDeviceLabels, nostrStore } from '../../nostr';
  import { projectNostrIdentityRoster } from '../../drive/protocol';
  import { currentBrowserDeviceLabel, distinctDeviceLabels } from '../../drive/deviceLabels';
  import { deviceStorage, followDeviceStorage } from '../../lib/deviceStorage';
  import {
    ageLabel,
    appIcon,
    driveSize,
    folderLines,
    fullCopyCount,
    holdingLabel,
    holdsAll,
    spaceLabel,
    syncState,
    SYNC_DETAIL,
    SYNC_LABEL,
    type DeviceRow,
    type SyncState,
  } from '../../lib/deviceStorageView';

  let labels = $state<Record<string, string>>({});
  let open = $state<Record<string, boolean>>({});
  let now = $state(Date.now());

  let held = $derived($deviceStorage);
  let rows = $derived.by((): DeviceRow[] => {
    void $nostrStore;
    const session = getCurrentNostrIdentitySession();
    if (!session || session.status !== 'active') return [];
    const roster = projectNostrIdentityRoster(session.profileId, session.rosterOps ?? []);
    const devices = distinctDeviceLabels(Object.values(roster.active_facets)
      .filter((facet) => facet.purposes?.includes('app_key'))
      .map((facet) => {
        const current = facet.pubkey === session.appKeyPubkey;
        const label = labels[facet.pubkey]?.trim() || (current ? session.label?.trim() || currentBrowserDeviceLabel() : undefined);
        return { pubkey: facet.pubkey, label, addedAt: facet.added_at, current };
      }));
    return devices
      .sort((a, b) => Number(b.current) - Number(a.current)
        || (a.addedAt ?? 0) - (b.addedAt ?? 0)
        || a.pubkey.localeCompare(b.pubkey))
      .map((device) => ({
        pubkey: device.pubkey,
        name: userSettingsKeyLabel(device),
        current: device.current,
        report: held.reports[device.pubkey] ?? null,
      }));
  });
  let drive = $derived(driveSize(rows));
  let copies = $derived(fullCopyCount(rows));
  let deviceKeys = $derived(rows.map((row) => row.pubkey));
  let connected = $derived(new Set($appStore.peers.filter((peer) => peer.state === 'connected').map((peer) => peer.pubkey)));
  const SYNC_TONE: Record<SyncState, string> = { 'in-sync': 'text-success', behind: 'text-warning', ahead: 'text-text-2', apart: 'text-warning' };
  let scale = $derived(Math.max(1, drive?.file_bytes ?? 0, ...rows.map((row) => row.report?.file_bytes ?? 0)));

  const width = (bytes: number, of: number) => `${Math.min(100, (bytes / Math.max(1, of)) * 100)}%`;

  onMount(() => {
    const stopFollowing = followDeviceStorage();
    void (async () => {
      try {
        // Names this device already holds are shown at once; relays only add to them.
        labels = await loadDriveDeviceLabels({ refresh: false });
        labels = await loadDriveDeviceLabels();
      } catch (error) {
        console.warn('[DeviceStorage] Could not load device names:', error);
      }
    })();
    const tick = setInterval(() => { now = Date.now(); }, 30_000);
    return () => {
      clearInterval(tick);
      stopFollowing();
    };
  });
</script>

{#snippet connection(pubkey: string, sync: SyncState | null = null)}
  {@const linked = connected.has(pubkey)}
  <span class="flex items-center gap-1.5 text-xs text-text-3" data-testid="device-storage-status">
    <span class="h-2 w-2 shrink-0 rounded-full {linked ? 'bg-success' : 'bg-text-3 opacity-50'}" aria-hidden="true"></span>
    <span
      data-testid="device-storage-connection"
      title={linked ? 'Linked directly to this device' : 'No direct connection. Changes can still arrive through relays.'}
    >{linked ? 'Connected' : 'Not connected'}</span>
    {#if sync === 'in-sync'}
      <span aria-hidden="true">·</span>
      <span class={SYNC_TONE[sync]} data-testid="device-storage-sync" title={SYNC_DETAIL[sync]}>{SYNC_LABEL[sync]}</span>
    {/if}
  </span>
{/snippet}

{#if rows.length > 0}
  <section class="space-y-3" data-testid="device-storage">
    <div class="flex items-center justify-between">
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide">Your devices</h3>
      <a href="#/settings/user" class="btn-ghost text-xs no-underline">Manage</a>
    </div>
    <p class="min-h-5 text-sm text-text-2" data-testid="device-storage-summary">
      {#if drive}
        {formatBytes(drive.file_bytes)} · {drive.files.toLocaleString('en-US')} {drive.files === 1 ? 'file' : 'files'}
        {#if copies > 0} · {copies} full {copies === 1 ? 'copy' : 'copies'}{/if}
      {/if}
    </p>

    <ul class="devices list-none rounded bg-surface-2 overflow-hidden" aria-label="Your devices">
      {#each rows as row (row.pubkey)}
        {@const report = row.report}
        {@const sync = row.current ? null : syncState(row.pubkey, report, held.versions, deviceKeys)}
        <li data-testid="device-storage-row" aria-label={row.name}>
          <button
            class="w-full p-3 text-left flex items-start gap-3 transition-colors {report ? 'hover:bg-surface-3/40' : 'cursor-default'}"
            disabled={!report}
            aria-expanded={report ? !!open[row.pubkey] : undefined}
            onclick={() => { open = { ...open, [row.pubkey]: !open[row.pubkey] }; }}
          >
            <span class="{appIcon(report?.app ?? '')} mt-0.5 shrink-0 text-lg text-text-3" aria-hidden="true"></span>
            <span class="device-body min-w-0 flex-1 space-y-1.5">
              <span class="device-heading grid items-center gap-x-3 gap-y-0.5">
                <span class="flex min-w-0 items-baseline gap-2 text-sm font-medium text-text-1">
                  <span class="truncate" title={row.name}>{row.name}</span>
                  {#if row.current}<span class="shrink-0 text-xs font-normal text-text-3">This device</span>{/if}
                </span>
                <span class="min-h-5 text-sm {report && holdsAll(report) && report.files > 0 ? 'text-success' : 'text-text-2'}" data-testid="device-storage-held">
                  {report ? holdingLabel(report) : row.current ? '' : 'No report yet'}
                </span>
              </span>
              <span class="block h-1.5 rounded-full bg-surface-3 overflow-hidden" class:invisible={!report} aria-hidden="true">
                <span class="block h-full bg-accent" style="width: {width(report?.held_bytes ?? 0, scale)}"></span>
              </span>
              {#if !row.current}
                <span class="block min-h-4 text-xs">
                  {#if !report}
                    {@render connection(row.pubkey)}
                  {:else if sync && sync !== 'in-sync'}
                    <span class={SYNC_TONE[sync]} data-testid="device-storage-sync" title={SYNC_DETAIL[sync]}>{SYNC_LABEL[sync]}</span>
                  {/if}
                </span>
              {/if}
            </span>
            <span class="i-lucide-chevron-down mt-1 shrink-0 text-text-3 transition-transform {open[row.pubkey] ? 'rotate-180' : ''}" class:invisible={!report} aria-hidden="true"></span>
          </button>
          {#if report && open[row.pubkey]}
            {#if !row.current}
              <div class="pl-11 pr-3 pb-2">
                {@render connection(row.pubkey, sync)}
              </div>
            {/if}
            <div class="flex flex-wrap gap-x-3 gap-y-1 pl-11 pr-3 pb-2 text-xs text-text-3">
              <span>{formatBytes(report.held_bytes)} of {formatBytes(report.file_bytes)} offline</span>
              {#if !row.current}
                <span data-testid="device-storage-space" title="Everything Drive keeps on that device, and the most it may keep">{spaceLabel(report, formatBytes)}</span>
              {/if}
              <span>{ageLabel(row.current ? report.measured_at : held.heard[row.pubkey] ?? report.measured_at, now)}</span>
            </div>
            <ul class="list-none space-y-2 px-3 pb-3 pl-11" data-testid="device-storage-folders">
              {#each folderLines(report) as line, index (index)}
                <li style="padding-left: {line.depth * 0.75}rem">
                  <div class="flex items-baseline justify-between gap-3 text-xs">
                    <span class="min-w-0 truncate text-text-1">{line.label}</span>
                    <span class="shrink-0 text-text-3">
                      {line.held >= line.bytes ? `All ${formatBytes(line.bytes)}` : `${formatBytes(line.held)} of ${formatBytes(line.bytes)}`}
                    </span>
                  </div>
                  <div class="mt-1 h-1 rounded-full bg-surface-3 overflow-hidden" role="presentation">
                    <div class="h-full bg-accent" style="width: {width(line.held, line.bytes)}"></div>
                  </div>
                </li>
              {:else}
                <li class="text-xs text-text-3">No files yet</li>
              {/each}
              {#if report.unread_folders}
                <li class="text-xs text-text-3">Some folders could not be read when it measured.</li>
              {/if}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .device-body {
    container-type: inline-size;
  }

  .device-heading {
    grid-template-columns: minmax(0, 1fr);
  }

  @container (min-width: 20rem) {
    .device-heading {
      grid-template-columns: minmax(0, 1fr) auto;
    }
  }

  .devices > li + li {
    border-top: 1px solid rgb(var(--surface-3));
  }
</style>
