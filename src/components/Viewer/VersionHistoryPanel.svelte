<script lang="ts">
  /**
   * Earlier versions of the open document, newest first under the day they
   * are from, each with who saved it. Choosing one shows it in the editor in
   * place of the document; the newest is the document itself. It is read
   * from what this device holds and fills in as saves from elsewhere arrive.
   * On a phone the list covers the screen and steps aside while a version
   * is shown.
   */
  import type { DriveDocument } from '../../lib/yjs';
  import {
    listStoredFiles,
    versionClock,
    versionDay,
    versionMoment,
    versionTimeline,
    versionUpdate,
    type StoredFile,
    type Version,
  } from '../../lib/yjs/versionHistory';
  import { getTree } from '../../store';
  import { nostrStore } from '../../nostr';
  import { getCurrentNostrIdentitySession, loadDriveDeviceLabels } from '../../nostr/auth';
  import { projectNostrIdentityRoster } from '../../drive/protocol';
  import { currentBrowserDeviceLabel, distinctDeviceLabels } from '../../drive/deviceLabels';

  let { drive }: { drive: DriveDocument } = $props();

  // Tests set versions apart by seconds rather than minutes.
  const timing = import.meta.env.VITE_TEST_MODE
    ? (window as Window & { __versionHistory?: { gapMs?: number; spanMs?: number } }).__versionHistory
    : undefined;
  const phone = window.matchMedia('(max-width: 639px)');

  let files = $state.raw<StoredFile[]>([]);
  let listed = $state(false);
  let versions = $derived(versionTimeline(files, timing));
  let opening = $state<number | null>(null);
  let failed = $state('');
  /** Files already read, by hash; versions share most of them. */
  const contents = new Map<string, Uint8Array>();

  // The folder changes with every save, here or arriving from another device.
  $effect(() => {
    const folder = drive.folder;
    if (!folder) return;
    let current = true;
    listStoredFiles(getTree(), folder)
      .then((found) => {
        if (current) files = found;
      })
      .catch((error: unknown) => console.error('[Document] Could not list versions:', error))
      .finally(() => {
        if (current) listed = true;
      });
    return () => {
      current = false;
    };
  });

  /** Names of devices by the start of their key, as their folders are named. */
  let names = $state<Record<string, string>>({});
  const ownWriter = (nostrStore.getState().pubkey ?? '').slice(0, 12);

  // Names this device already holds; nothing waits for a relay.
  $effect(() => {
    let current = true;
    void nameDevices().then((found) => {
      if (current) names = found;
    });
    return () => {
      current = false;
    };
  });

  async function nameDevices(): Promise<Record<string, string>> {
    const session = getCurrentNostrIdentitySession();
    const own = nostrStore.getState().pubkey;
    const keys: Array<{ pubkey: string; label?: string; addedAt?: number }> = [];
    if (session?.status === 'active') {
      const labels = await loadDriveDeviceLabels({ refresh: false }).catch(() => ({} as Record<string, string>));
      const roster = projectNostrIdentityRoster(session.profileId, session.rosterOps);
      for (const facet of Object.values(roster.active_facets)) {
        const ownLabel = facet.pubkey === session.appKeyPubkey ? session.label?.trim() || currentBrowserDeviceLabel() : undefined;
        keys.push({ pubkey: facet.pubkey, label: labels[facet.pubkey]?.trim() || ownLabel, addedAt: facet.added_at });
      }
    }
    if (own && !keys.some(key => key.pubkey === own)) keys.push({ pubkey: own, label: currentBrowserDeviceLabel() });
    return Object.fromEntries(distinctDeviceLabels(keys).map(key => [key.pubkey.slice(0, 12), key.label?.trim() || 'Another device of yours']));
  }

  function who(version: Version): string {
    const known: string[] = [];
    let others = 0;
    for (const writer of version.writers) {
      const name = names[writer];
      if (!name) others += 1;
      else known.push(writer === ownWriter ? `${name} (this device)` : name);
    }
    if (others === 1) known.push(known.length ? 'someone else' : 'Someone else');
    else if (others > 1) known.push(`${others} ${known.length ? 'others' : 'other people'}`);
    return known.join(', ');
  }

  let days = $derived.by(() => {
    const now = Date.now();
    const groups: Array<{ day: string; items: Array<{ version: Version; newest: boolean }> }> = [];
    versions.forEach((version, index) => {
      const day = versionDay(version.time, now);
      const last = groups[groups.length - 1];
      const item = { version, newest: index === 0 };
      if (last?.day === day) last.items.push(item);
      else groups.push({ day, items: [item] });
    });
    return groups;
  });

  let shownTime = $derived(drive.preview?.time ?? null);

  /** Times as the list shows them, with seconds where two would otherwise read the same. */
  let clocks = $derived.by(() => {
    const minutes = versions.map(version => `${versionDay(version.time)} ${versionClock(version.time)}`);
    return new Map(versions.map((version, index) => [
      version.time,
      minutes.indexOf(minutes[index]) !== minutes.lastIndexOf(minutes[index]) ? versionClock(version.time, true) : versionClock(version.time),
    ]));
  });

  async function choose(version: Version, newest: boolean): Promise<void> {
    failed = '';
    if (newest) {
      opening = null;
      drive.preview = null;
      return;
    }
    opening = version.time;
    try {
      const update = await versionUpdate(getTree(), files, version.time, contents);
      if (opening !== version.time) return;
      drive.preview = { time: version.time, update };
      // On a phone the version is shown in place of the list; the bar brings it back.
      if (phone.matches) drive.historyOpen = false;
    } catch (error) {
      console.error('[Document] Could not open the version:', error);
      if (opening === version.time) failed = 'This version is not all on this device yet. Try again in a moment.';
    } finally {
      if (opening === version.time) opening = null;
    }
  }
</script>

<aside class="history" aria-label="Version history" data-testid="version-history-panel">
  <div class="shrink-0 h-12 pl-4 pr-2 flex items-center gap-2 border-b border-surface-2">
    <h2 class="flex-1 text-sm font-semibold text-text-1">Version history</h2>
    <button class="btn-circle btn-ghost" onclick={() => drive.closeHistory()} title="Close" aria-label="Close version history" data-testid="version-history-close">
      <span class="i-lucide-x text-base"></span>
    </button>
  </div>
  <div class="flex-1 min-h-0 overflow-y-auto py-1">
    {#if !listed}
      <div class="flex justify-center py-6 text-text-3"><span class="i-lucide-loader-2 animate-spin"></span></div>
    {:else}
      {#each days as group (group.day)}
        <h3 class="day" data-testid="version-day">{group.day}</h3>
        {#each group.items as { version, newest } (version.time)}
          {@const selected = newest ? shownTime === null : shownTime === version.time}
          <button
            type="button"
            class="version"
            class:selected
            aria-current={selected ? 'true' : undefined}
            onclick={() => void choose(version, newest)}
            data-testid="version-item"
            data-time={version.time}
          >
            <span class="flex items-center gap-2">
              <span class="text-sm font-medium text-text-1">{clocks.get(version.time)}</span>
              {#if opening === version.time}<span class="i-lucide-loader-2 animate-spin text-xs text-text-3"></span>{/if}
            </span>
            {#if newest}<span class="text-xs italic text-text-2">Current version</span>{/if}
            {#if version.restored !== undefined}
              <span class="text-xs text-text-2" data-testid="version-restored">Restored from {versionMoment(version.restored)}</span>
            {/if}
            {#if version.writers.length}
              <span class="flex items-center gap-1.5 text-xs text-text-2 min-w-0">
                <span class="i-lucide-user-round shrink-0"></span><span class="truncate">{who(version)}</span>
              </span>
            {/if}
          </button>
        {/each}
      {/each}
      {#if versions.length < 2}
        <p class="px-4 py-3 text-xs text-text-3">Earlier versions are listed here once there are some.</p>
      {/if}
      {#if failed}
        <p class="px-4 py-2 text-xs text-danger" role="alert">{failed}</p>
      {/if}
    {/if}
  </div>
</aside>

<style>
  .history {
    flex-shrink: 0;
    width: 18rem;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid rgb(var(--surface-2));
    background: rgb(var(--surface-1));
  }

  /* On a phone: a sheet over the whole screen. */
  @media (max-width: 639px) {
    .history {
      position: fixed;
      inset: 0;
      z-index: 50;
      width: auto;
      border-left: none;
    }
  }

  .day {
    padding: 0.75rem 1rem 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: rgb(var(--text-3));
  }

  .version {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    width: 100%;
    padding: 0.5rem 1rem;
    border: none;
    border-left: 3px solid transparent;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .version:hover {
    background: rgb(var(--surface-2) / 0.6);
  }

  .version.selected {
    border-left-color: #916dfe;
    background: rgb(145 109 254 / 0.12);
  }
</style>
