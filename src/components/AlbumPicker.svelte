<script lang="ts">
  /** Where chosen photos go: a new album, named here, or one there is. */
  import Modal from './ui/Modal.svelte';
  import GridThumbnail from './GridThumbnail.svelte';
  import { countLabel, validAlbumName, type Album } from '../lib/photos';

  interface Props {
    /** The albums photos can be added to. */
    albums: Album[];
    ready: boolean;
    /** Names taken in the folder new albums go in. */
    taken: ReadonlySet<string>;
    onpick: (album: Album) => void;
    oncreate: (name: string) => void;
    onclose: () => void;
  }

  let { albums, ready, taken, onpick, oncreate, onclose }: Props = $props();

  let naming = $state(false);
  let name = $state('');
  let input: HTMLInputElement | undefined = $state();
  let trimmed = $derived(name.trim());
  let invalid = $derived(!!trimmed && !validAlbumName(trimmed));

  $effect(() => {
    if (naming) input?.focus();
  });

  function create(event: SubmitEvent) {
    event.preventDefault();
    if (!trimmed || invalid) return;
    oncreate(trimmed);
  }
</script>

<Modal open onClose={onclose} label="Add to album" panelClass="mx-4 flex max-h-[80vh] w-full max-w-sm flex-col overflow-hidden rounded-lg bg-surface-1 shadow-lg">
  <div class="flex items-center gap-2 px-5 pb-2 pt-4">
    <h2 class="flex-1 text-lg font-semibold text-text-1">Add to album</h2>
    <button type="button" class="btn-circle h-8 w-8 text-text-2 hover:bg-surface-2" onclick={onclose} aria-label="Close" title="Close">
      <span class="i-lucide-x text-lg"></span>
    </button>
  </div>
  {#if naming}
    <form class="flex items-center gap-2 px-5 py-2" onsubmit={create}>
      <input
        bind:this={input}
        bind:value={name}
        type="text"
        class="input min-w-0 flex-1"
        placeholder="Album name"
        aria-label="Album name"
        aria-invalid={invalid}
        data-testid="new-album-name"
      />
      <button type="submit" class="btn-success shrink-0" disabled={!trimmed || invalid} data-testid="new-album-create">Create</button>
    </form>
    {#if trimmed && taken.has(trimmed)}
      <p class="px-5 pb-1 text-xs text-text-2">{trimmed} is there already; the photos go into it.</p>
    {/if}
  {:else}
    <button type="button" class="mx-2 flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2" onclick={() => (naming = true)} data-testid="new-album">
      <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
        <span class="i-lucide-plus text-xl"></span>
      </span>
      <span class="text-sm font-medium text-text-1">New album</span>
    </button>
  {/if}
  <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-scroll-root>
    {#each albums as album (album.key)}
      <button type="button" class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2" onclick={() => onpick(album)} data-testid="album-choice">
        <span class="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-surface-2">
          {#if album.photos[0]}<GridThumbnail cid={album.photos[0].cid} name={album.photos[0].name} kind={album.photos[0].video ? 'video' : 'image'} {ready} fallback />{:else}<span class="absolute inset-0 m-auto i-lucide-images text-lg text-text-3"></span>{/if}
        </span>
        <span class="min-w-0">
          <span class="block truncate text-sm font-medium text-text-1">{album.name}</span>
          <span class="block truncate text-xs text-text-2">{countLabel(album.photos)}</span>
        </span>
      </button>
    {/each}
  </div>
</Modal>
