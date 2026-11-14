<script lang="ts">
  /**
   * Photos: every picture and video in My Drive and in the shared folders
   * this device holds, newest first under date headings, each once; and the
   * albums, the folders that hold them. One opens over the whole screen.
   * Chosen photos go into an album by the content they have. Nothing here
   * waits for a relay: the trees are read as this device has them, and what
   * changes shows when it arrives.
   */
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { nostrStore } from '../nostr';
  import { acceptedShares } from '../drive/shareLibrary';
  import { linkShares } from '../drive/linkShares';
  import { itemAccess } from '../drive/itemAccess';
  import { activeNostrIdentityRootScope, isEditableDriveRouteScope } from '../drive/profileRoute';
  import { ownedShareAtPath, sharePeopleTarget } from '../drive/sharePeople';
  import { currentFullHash, currentPath, getQueryParamsFromHash } from '../lib/router.svelte';
  import { driveRoots, driveScopes } from '../lib/driveRoots';
  import { DRIVE_TREE_NAME, driveHref, driveWalk, driveWalkDone, listFolder, onDriveWalkProgress, startDriveWalk, type DriveRoot } from '../lib/driveWalk';
  import {
    albumHref, arrangePhotos, countLabel, photoAlbums, photoDating, photosFound, photosPage, photosUploadPlace, uniquePhotos,
    type Album, type Photo,
  } from '../lib/photos';
  import { loadPhotoDates, onPhotoDates, photoDatesKnown, readPhotoDates } from '../lib/photoDates';
  import { addToAlbum } from '../lib/photoAlbumWrites';
  import { freeName } from '../lib/driveClipboard';
  import { createDriveShareLinkVariants, folderCopyHref } from '../lib/shareUrls';
  import { ensureMediaStreamingReady } from '../lib/mediaStreamingSetup';
  import { getTree } from '../store';
  import { getTreeRootSync, subscribeToTreeRoot } from '../stores/treeRoot';
  import { uploadFilesWithPaths } from '../stores/upload';
  import { showToast, toast } from '../stores/toast';
  import { open as openShareModal } from './Modals/ShareModal.svelte';
  import AccessBadge from './AccessBadge.svelte';
  import AlbumList from './AlbumList.svelte';
  import AlbumPicker from './AlbumPicker.svelte';
  import PhotoGrid from './PhotoGrid.svelte';
  import PhotoViewer from './PhotoViewer.svelte';

  const OPEN_PARAM = 'open';
  /** How long a reload waits for this device to say what My Drive holds before showing it as empty. */
  const ROOTS_GRACE_MS = 2000;

  let ownProfileId = $derived(activeNostrIdentityRootScope($nostrStore));
  let ownScope = $derived(ownProfileId ?? $nostrStore.npub);
  let scopeKey = $derived(driveScopes(ownProfileId, $nostrStore.npub, $acceptedShares).join('\n'));
  /** Goes up whenever one of the trees changes. */
  let treesChanged = $state(0);
  let roots = $derived.by(() => {
    void treesChanged;
    return driveRoots(ownProfileId, $nostrStore.npub, $acceptedShares);
  });

  /** Every copy of every photo found. */
  let found = $state.raw<Photo[]>([]);
  let walkDone = $state(false);
  /** This device has said what My Drive holds, or has had time to. */
  let ownRootHeard = $state(false);
  let graceOver = $state(false);
  let walking = $derived(!walkDone || !(ownRootHeard || graceOver || roots.some((root) => root.scope === ownScope)));
  let taken = $state.raw<ReadonlyMap<string, number | null>>(new Map());
  let ready = $state(false);
  /** What the last walk to finish found, shown until the walk of a changed tree finishes. */
  let settled: { scopes: string; photos: Photo[] } = { scopes: '', photos: [] };

  let dating = $derived(photoDating(found, taken));
  let albums = $derived(photoAlbums(found, dating));
  let page = $derived(photosPage($currentPath));
  /** The album shown: an address in My Drive of a folder since shared is the shared folder's. */
  let albumPlace = $derived.by(() => {
    if (page.kind !== 'album') return null;
    const owned = page.scope === ownProfileId ? ownedShareAtPath(page.path, ownProfileId, $acceptedShares) : null;
    return owned ? { scope: owned.record.share_id, path: owned.rest } : { scope: page.scope, path: page.path };
  });
  let album = $derived(albumPlace ? albums.find((item) => item.scope === albumPlace.scope && item.path.join('/') === albumPlace.path.join('/')) ?? null : null);
  let albumName = $derived(album?.name ?? albumPlace?.path.at(-1) ?? roots.find((root) => root.scope === albumPlace?.scope)?.label ?? '');
  let shown = $derived(page.kind === 'album' ? album?.photos ?? [] : page.kind === 'timeline' ? uniquePhotos(found) : []);
  let groups = $derived(arrangePhotos(shown, dating));
  let ordered = $derived(groups.flatMap((group) => group.photos));

  let openKey = $derived(getQueryParamsFromHash($currentFullHash).get(OPEN_PARAM));
  let openIndex = $derived(openKey ? ordered.findIndex((photo) => photo.href.slice(2) === openKey) : -1);
  /** The open photo was opened from the grid, so Back closes it. */
  let openedHere = false;
  let fileInput: HTMLInputElement | undefined = $state();
  /** Where the files chosen next are uploaded. */
  let uploadInto: { scope: string; path: string[] } | null = null;

  const selected = new SvelteSet<string>();
  let chosen = $derived(ordered.filter((photo) => selected.has(photo.href)));
  let picking = $state(false);

  const canWrite = (scope: string) => isEditableDriveRouteScope(scope, $nostrStore, $acceptedShares);
  let albumWritable = $derived(!!albumPlace && canWrite(albumPlace.scope));
  /** Where new albums go: the Photos folder of My Drive. */
  let photosPlace = $derived(ownScope ? photosUploadPlace(ownScope, ownProfileId, $acceptedShares) : null);
  let pickable = $derived(albums.filter((item) => item.key !== album?.key && canWrite(item.scope)));
  let photosFolderNames = $derived.by(() => {
    const place = photosPlace;
    const root = place ? roots.find((item) => item.scope === place.scope) : null;
    if (!place || !root) return new Set<string>();
    const depth = place.path.length + 1;
    return new Set((driveWalk(root)?.found ?? [])
      .filter(({ path }) => path.length === depth && path.slice(0, -1).join('/') === place.path.join('/'))
      .map(({ entry }) => entry.name));
  });

  function accessOf(item: { scope: string; path: string[] }) {
    return itemAccess({
      scope: item.scope,
      treeName: DRIVE_TREE_NAME,
      path: item.path,
      profileId: ownProfileId,
      appKeyPubkey: $nostrStore.pubkey,
      records: $acceptedShares,
      linkShares: $linkShares,
    });
  }

  function collect(list: DriveRoot[]) {
    const now = list.flatMap((root) => photosFound(root, driveWalk(root)?.found ?? []));
    const done = driveWalkDone(list);
    if (settled.scopes !== scopeKey) settled = { scopes: scopeKey, photos: [] };
    if (done) {
      settled.photos = now;
    } else {
      const seen = new Set(now.map((photo) => photo.href));
      now.push(...settled.photos.filter((photo) => !seen.has(photo.href)));
    }
    found = now;
    walkDone = done;
    readPhotoDates(now);
  }

  // Each tree is watched, so a change, here or from another device, shows.
  $effect(() => {
    const scopes = scopeKey.split('\n').filter(Boolean);
    const own = ownScope;
    let frame = 0;
    let heard = false;
    const stops = scopes.map((scope) => subscribeToTreeRoot(scope, DRIVE_TREE_NAME, () => {
      heard ||= scope === own;
      // Read again in one go, with what was heard by then.
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        treesChanged += 1;
        if (heard) ownRootHeard = true;
      });
    }));
    return () => {
      for (const stop of stops) stop();
      cancelAnimationFrame(frame);
    };
  });

  $effect(() => {
    startDriveWalk(roots);
    collect(roots);
  });

  // What was chosen on one page is let go of on another.
  $effect(() => {
    void $currentPath;
    untrack(() => selected.clear());
  });

  onMount(() => {
    let walkFrame = 0;
    let datesFrame = 0;
    const stopWalk = onDriveWalkProgress(() => {
      if (!walkFrame) walkFrame = requestAnimationFrame(() => { walkFrame = 0; collect(roots); });
    });
    const stopDates = onPhotoDates(() => {
      if (!datesFrame) datesFrame = requestAnimationFrame(() => { datesFrame = 0; taken = new Map(photoDatesKnown()); });
    });
    taken = new Map(photoDatesKnown());
    void loadPhotoDates();
    // Pictures come from the app's own address once it can serve them.
    void ensureMediaStreamingReady().finally(() => { ready = true; });
    const grace = setTimeout(() => { graceOver = true; }, ROOTS_GRACE_MS);
    return () => {
      clearTimeout(grace);
      stopWalk();
      stopDates();
      cancelAnimationFrame(walkFrame);
      cancelAnimationFrame(datesFrame);
    };
  });

  function openHref(photo: Photo): string {
    return `#${$currentPath}?${new URLSearchParams({ [OPEN_PARAM]: photo.href.slice(2) })}`;
  }

  /** A plain click opens the photo here; with a key held it opens elsewhere, as a link does. */
  function opensHere(event: MouseEvent) {
    openedHere = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  function step(index: number) {
    const photo = ordered[index];
    // Stepping replaces the open photo, so Back still closes.
    if (photo) window.location.replace(openHref(photo));
  }

  function close() {
    const key = openKey;
    if (openedHere) history.back();
    else window.location.replace(`#${$currentPath}`);
    openedHere = false;
    // Focus goes back to the photo it was on.
    void tick().then(() => {
      if (!key) return;
      const tile = document.querySelector<HTMLElement>(`[data-photo="${CSS.escape(`#/${key}`)}"]`);
      tile?.focus({ preventScroll: false });
    });
  }

  // A photo asked for that is not here, once all has been read, is no photo to show.
  $effect(() => {
    if (openKey && openIndex < 0 && !walking && graceOver) window.location.replace(`#${$currentPath}`);
    if (!openKey) openedHere = false;
  });

  function toggle(photo: Photo) {
    if (selected.has(photo.href)) selected.delete(photo.href);
    else selected.add(photo.href);
  }

  // Escape lets go of what is chosen, unless a dialog or a field has it.
  function onWindowKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || selected.size === 0 || event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    event.preventDefault();
    selected.clear();
  }

  async function addChosen(target: { scope: string; path: string[] }, name: string) {
    const photos = chosen;
    picking = false;
    try {
      const added = await addToAlbum(target, photos);
      selected.clear();
      const href = albumHref(target.scope, target.path);
      showToast('success', added.length > 0 ? `Added ${countLabel(added)} to ${name}` : `Already in ${name}`, 6000, {
        label: 'Open',
        run: () => { window.location.hash = href; },
      });
    } catch (error) {
      console.warn('[Photos] Could not add to the album:', error);
      toast.error(`Could not add to ${name}`);
    }
  }

  function share() {
    const place = albumPlace;
    if (!place) return;
    const root = roots.find((item) => item.scope === place.scope);
    const folder = place.path.length === 0
      ? root?.cid
      : (root ? driveWalk(root)?.found.find(({ path }) => path.join('/') === place.path.join('/'))?.entry.cid : undefined);
    const here = `${window.location.origin}${window.location.pathname}`;
    const current = `${here}${driveHref(place.scope, place.path)}`;
    const [primary, secondary] = createDriveShareLinkVariants({
      permalinkUrl: folder ? `${here}${folderCopyHref(folder, albumName)}` : null,
      currentUrl: current,
      routeScope: place.scope,
      isPermalink: false,
    });
    const people = albumWritable
      ? sharePeopleTarget({ scope: place.scope, treeName: DRIVE_TREE_NAME, path: place.path, profileId: ownProfileId, records: $acceptedShares })
      : null;
    openShareModal(primary?.url ?? current, secondary?.url ?? null, people, true, null);
  }

  /** The names in a folder, so an upload does not replace a different photo of the same name. */
  async function namesIn(scope: string, path: string[]): Promise<Set<string>> {
    const root = getTreeRootSync(scope, DRIVE_TREE_NAME);
    if (!root) return new Set();
    const folder = path.length > 0 ? await getTree().resolvePath(root, path, AbortSignal.timeout(4000)).catch(() => null) : { cid: root };
    if (!folder) return new Set();
    return new Set((await listFolder(folder.cid))?.map((entry) => entry.name) ?? []);
  }

  function chooseFiles(place: { scope: string; path: string[] } | null) {
    if (!place) return;
    uploadInto = place;
    fileInput?.click();
  }

  async function upload(place: { scope: string; path: string[] }, files: File[]) {
    if (files.length === 0) return;
    const names = await namesIn(place.scope, place.path);
    const named = files.map((file) => {
      const name = freeName(file.name, names);
      names.add(name);
      return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
    });
    try {
      await uploadFilesWithPaths(
        named.map((file) => ({ file, relativePath: [...place.path, file.name].join('/') })),
        { drive: { scope: place.scope, treeName: DRIVE_TREE_NAME }, dirPath: [] },
      );
    } catch {
      toast.error(files.length === 1 ? `Could not upload ${files[0]!.name}` : 'Could not upload the photos');
    }
  }

  function onFilesChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    const place = uploadInto ?? photosPlace;
    uploadInto = null;
    if (place) void upload(place, files);
  }

  const tab = 'flex h-8 items-center rounded-full px-3 text-sm no-underline transition-colors';
  const action = 'btn-ghost flex h-8 shrink-0 items-center gap-1.5 px-3 text-xs no-underline lg:text-sm max-sm:w-8 max-sm:justify-center max-sm:px-0';
</script>

<svelte:window onkeydown={onWindowKeyDown} />

{#snippet empty(icon: string, text: string, testid: string)}
  <div class="flex flex-col items-center gap-3 px-4 py-16 text-center text-sm text-text-2" data-testid={testid}>
    <span class="{icon} text-4xl text-text-3/70"></span>
    {text}
  </div>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col" data-testid="photos-view">
  {#if selected.size > 0}
    <div class="flex min-h-13 shrink-0 items-center gap-1 border-b border-surface-2 bg-accent/10 px-1.5 py-2 lg:px-3 lg:py-3" data-testid="photos-selection-bar">
      <button
        type="button"
        class="btn-circle shrink-0 text-text-2 hover:bg-surface-3 hover:text-text-1"
        title="Cancel (Esc)"
        aria-label="Cancel"
        onclick={() => selected.clear()}
        data-testid="photos-selection-cancel"
      >
        <span class="i-lucide-x text-lg"></span>
      </button>
      <span class="min-w-0 flex-1 truncate font-medium text-text-1" data-testid="photos-selection-count">{chosen.length} selected</span>
      <button
        type="button"
        class="flex h-9 shrink-0 items-center gap-2 rounded-full px-3 text-sm font-medium text-text-1 hover:bg-surface-3"
        onclick={() => (picking = true)}
        disabled={!ownScope}
        data-testid="photos-add-to-album"
      >
        <span class="i-lucide-image-plus text-lg"></span>
        Add to album
      </button>
    </div>
  {:else if page.kind === 'album'}
    <div class="flex min-h-13 shrink-0 items-center gap-1.5 border-b border-surface-2 px-2 py-2 lg:gap-2 lg:px-4 lg:py-3" data-testid="album-header">
      <a href="#/photos/albums" class="btn-circle shrink-0 text-text-2 no-underline hover:bg-surface-2 hover:text-text-1" title="Albums" aria-label="Albums" data-testid="album-back">
        <span class="i-lucide-arrow-left text-lg"></span>
      </a>
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-1.5">
          <h1 class="truncate text-base font-medium text-text-1 lg:text-xl" data-testid="album-title">{albumName}</h1>
          {#if albumPlace}
            {@const access = accessOf(albumPlace)}
            {#if access && access.kind !== 'private'}<AccessBadge {access} class="text-sm text-text-3" />{/if}
          {/if}
        </div>
        {#if album}<div class="text-xs text-text-2" data-testid="album-header-count">{countLabel(album.photos)}</div>{/if}
      </div>
      <button type="button" class={action} onclick={share} title="Share" aria-label="Share" data-testid="album-share">
        <span class="i-lucide-share text-base"></span><span class="max-sm:hidden">Share</span>
      </button>
      {#if albumWritable}
        <button type="button" class={action} onclick={() => chooseFiles(albumPlace)} title="Add photos" aria-label="Add photos" data-testid="album-add-photos">
          <span class="i-lucide-image-plus text-base"></span><span class="max-sm:hidden">Add photos</span>
        </button>
      {/if}
      {#if albumPlace}
        <a href={driveHref(albumPlace.scope, albumPlace.path)} class={action} title="Open folder" aria-label="Open folder" data-testid="album-open-folder">
          <span class="i-lucide-folder-open text-base"></span><span class="max-sm:hidden">Open folder</span>
        </a>
      {/if}
    </div>
  {:else}
    <div class="flex min-h-13 shrink-0 items-center gap-2 border-b border-surface-2 px-3 py-2 lg:px-5 lg:py-3">
      <h1 class="sr-only">Photos</h1>
      <span class="i-lucide-image shrink-0 text-lg text-accent lg:text-xl"></span>
      <nav class="flex items-center gap-1" aria-label="Photos">
        <a href="#/photos" aria-current={page.kind === 'timeline' ? 'page' : undefined} class="{tab} {page.kind === 'timeline' ? 'bg-accent/12 font-medium text-accent' : 'text-text-2 hover:bg-surface-2'}" data-testid="photos-tab">Photos</a>
        <a href="#/photos/albums" aria-current={page.kind === 'albums' ? 'page' : undefined} class="{tab} {page.kind === 'albums' ? 'bg-accent/12 font-medium text-accent' : 'text-text-2 hover:bg-surface-2'}" data-testid="albums-tab">Albums</a>
      </nav>
      {#if walking && found.length > 0}
        <span class="i-lucide-loader-2 animate-spin text-sm text-text-3" title="Still looking"></span>
      {/if}
      <!-- Where there are none yet, the message below offers it. -->
      {#if photosPlace && found.length > 0}
        <button type="button" class="{action} ml-auto" onclick={() => chooseFiles(photosPlace)} title="Upload" aria-label="Upload" data-testid="photos-upload">
          <span class="i-lucide-upload text-base"></span><span class="max-sm:hidden">Upload</span>
        </button>
      {/if}
    </div>
  {/if}

  <div class="flex-1 overflow-auto" data-scroll-root data-testid="photos-scroll">
    {#if found.length === 0 && walking}
      <div class="flex justify-center py-16 text-text-3">
        <span class="i-lucide-loader-2 animate-spin text-2xl" title="Looking for photos"></span>
      </div>
    {:else if page.kind === 'albums'}
      {#if albums.length > 0}
        <AlbumList {albums} {ready} {accessOf} />
      {:else}
        {@render empty('i-lucide-images', 'Folders with photos and videos show up here as albums', 'albums-empty')}
      {/if}
    {:else if ordered.length > 0}
      <PhotoGrid {groups} {ready} {selected} {openHref} onopen={opensHere} ontoggle={toggle} />
    {:else if page.kind === 'album'}
      {#if !walking}{@render empty('i-lucide-image', 'No photos here', 'album-empty')}{/if}
    {:else}
      <div class="flex flex-col items-center gap-3 px-4 py-16 text-center text-sm text-text-2" data-testid="photos-empty">
        <span class="i-lucide-image text-4xl text-text-3/70"></span>
        Photos and videos in your Drive show up here
        {#if photosPlace}
          <button type="button" class="btn-primary mt-1 flex items-center gap-1.5" onclick={() => chooseFiles(photosPlace)} data-testid="photos-empty-upload">
            <span class="i-lucide-upload text-base"></span>
            Upload
          </button>
        {/if}
      </div>
    {/if}
  </div>

  <input
    bind:this={fileInput}
    type="file"
    multiple
    accept="image/*,video/*"
    class="hidden"
    tabindex="-1"
    onchange={onFilesChosen}
    data-testid="photos-upload-input"
  />
</div>

{#if openIndex >= 0}
  <PhotoViewer photos={ordered} index={openIndex} dateOf={dating} onstep={step} onclose={close} />
{/if}

{#if picking}
  <AlbumPicker
    albums={pickable}
    {ready}
    taken={photosFolderNames}
    onpick={(item: Album) => void addChosen(item, item.name)}
    oncreate={(name) => { if (photosPlace) void addChosen({ scope: photosPlace.scope, path: [...photosPlace.path, name] }, name); }}
    onclose={() => (picking = false)}
  />
{/if}
