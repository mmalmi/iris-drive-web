<script lang="ts">
  /**
   * Said above an earlier version while it is shown in place of the
   * document, with what can be done with it: restore it as the document's
   * next edit, or make a new document of it.
   */
  import type { DriveDocument } from '../../lib/yjs';
  import { versionMoment } from '../../lib/yjs/versionHistory';
  import { showToast } from '../../stores/toast';

  interface Props {
    drive: DriveDocument;
    /** Makes the document what the version holds, as one edit of this editor. */
    onrestore: (update: Uint8Array) => void | Promise<void>;
  }
  let { drive, onrestore }: Props = $props();

  let busy = $state<'' | 'restore' | 'copy'>('');
  let preview = $derived(drive.preview);

  async function restore(): Promise<void> {
    const shown = drive.preview;
    if (!shown || busy) return;
    busy = 'restore';
    try {
      await drive.restoreVersion(shown.time, () => onrestore(shown.update));
      drive.closeHistory();
      showToast('success', `Restored the version from ${versionMoment(shown.time)}`);
    } catch (error) {
      console.error('[Document] Could not restore the version:', error);
      showToast('error', 'Could not restore this version.');
    } finally {
      busy = '';
    }
  }

  async function copy(): Promise<void> {
    const shown = drive.preview;
    if (!shown || busy) return;
    busy = 'copy';
    try {
      const title = await drive.makeCopy(shown.update);
      showToast('success', `Made a copy: ${title}`, 6000);
    } catch (error) {
      console.error('[Document] Could not copy the version:', error);
      showToast('error', 'Could not make a copy of this version.');
    } finally {
      busy = '';
    }
  }
</script>

{#if preview}
  <div class="bar" role="status" data-testid="version-bar">
    <span class="i-lucide-history shrink-0 text-base text-text-2"></span>
    <span class="flex-1 min-w-[12rem] text-sm text-text-1">Viewing a version from {versionMoment(preview.time)}</span>
    <!-- On a phone the buttons keep their icons and the shortest words. -->
    <div class="ml-auto flex items-center gap-1.5 shrink-0">
      {#if !drive.historyOpen}
        <button class="btn-ghost flex items-center gap-1.5" onclick={() => { drive.historyOpen = true; }} title="All versions" aria-label="All versions" data-testid="version-list">
          <span class="i-lucide-list"></span><span class="max-sm:hidden">Versions</span>
        </button>
      {/if}
      <button class="btn-ghost flex items-center gap-1.5" onclick={() => void copy()} disabled={!!busy} title="Make a copy" aria-label="Make a copy" data-testid="version-copy">
        <span class={busy === 'copy' ? 'i-lucide-loader-2 animate-spin' : 'i-lucide-copy'}></span><span class="max-sm:hidden">Make a copy</span>
      </button>
      <button class="btn bg-accent text-white hover:bg-accent/85 flex items-center gap-1.5" onclick={() => void restore()} disabled={!!busy} data-testid="version-restore">
        <span class={busy === 'restore' ? 'i-lucide-loader-2 animate-spin' : 'i-lucide-rotate-ccw'}></span><span>Restore<span class="max-sm:hidden"> this version</span></span>
      </button>
      <button class="btn-circle btn-ghost" onclick={() => drive.closeHistory()} title="Back to the document (Esc)" aria-label="Back to the document" data-testid="version-bar-close">
        <span class="i-lucide-x text-base"></span>
      </button>
    </div>
  </div>
{/if}

<style>
  .bar {
    flex-shrink: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    min-height: 3rem;
    padding: 0.4rem 0.5rem 0.4rem 1rem;
    border-bottom: 1px solid rgb(var(--surface-2));
    background: rgb(145 109 254 / 0.1);
  }
</style>
