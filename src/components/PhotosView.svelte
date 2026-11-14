<script lang="ts">
  /**
   * Photos: every picture and video in My Drive and in the shared folders
   * this device holds, newest first under date headings. One opens over the
   * whole screen; what is uploaded here goes into the Photos folder of My
   * Drive. Nothing here waits for a relay: the trees are read as this device
   * has them, and what changes shows when it arrives.
   */
  import { onMount, tick } from 'svelte';
  import { nostrStore } from '../nostr';
  import { acceptedShares } from '../drive/shareLibrary';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { currentFullHash, getQueryParamsFromHash } from '../lib/router.svelte';
  import { driveRoots, driveScopes } from '../lib/driveRoots';
  import { DRIVE_TREE_NAME, driveWalk, driveWalkDone, listFolder, onDriveWalkProgress, startDriveWalk, type DriveRoot } from '../lib/driveWalk';
  import { arrangePhotos, photoDate, photosFound, photosUploadPlace, type Photo } from '../lib/photos';
  import { loadPhotoDates, onPhotoDates, photoDatesKnown, readPhotoDates } from '../lib/photoDates';
  import { freeName } from '../lib/driveClipboard';
  import { ensureMediaStreamingReady } from '../lib/mediaStreamingSetup';
  import { getTree } from '../store';
  import { getTreeRootSync, subscribeToTreeRoot } from '../stores/treeRoot';
  import { uploadFilesWithPaths } from '../stores/upload';
  import { toast } from '../stores/toast';
  import PhotoTile from './PhotoTile.svelte';
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

  let groups = $derived(arrangePhotos(found, taken));
  let ordered = $derived(groups.flatMap((group) => group.photos));

  let openKey = $derived(getQueryParamsFromHash($currentFullHash).get(OPEN_PARAM));
  let openIndex = $derived(openKey ? ordered.findIndex((photo) => photo.href.slice(2) === openKey) : -1);
  /** The open photo was opened from the grid, so Back closes it. */
  let openedHere = false;
  let fileInput: HTMLInputElement | undefined = $state();

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
    return `#/photos?${new URLSearchParams({ [OPEN_PARAM]: photo.href.slice(2) })}`;
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
    else window.location.replace('#/photos');
    openedHere = false;
    // Focus goes back to the photo it was on.
    void tick().then(() => {
      if (!key) return;
      const tile = document.querySelector<HTMLElement>(`[data-photo="${CSS.escape(`#/${key}`)}"]`);
      tile?.focus({ preventScroll: false });
    });
  }

  // A photo asked for that is not in the Drive, once it has been read through, is no photo to show.
  $effect(() => {
    if (openKey && openIndex < 0 && !walking && graceOver) window.location.replace('#/photos');
    if (!openKey) openedHere = false;
  });

  /** The names in a folder, so an upload does not replace a different photo of the same name. */
  async function namesIn(scope: string, path: string[]): Promise<Set<string>> {
    const root = getTreeRootSync(scope, DRIVE_TREE_NAME);
    if (!root) return new Set();
    const folder = path.length > 0 ? await getTree().resolvePath(root, path, AbortSignal.timeout(4000)).catch(() => null) : { cid: root };
    if (!folder) return new Set();
    return new Set((await listFolder(folder.cid))?.map((entry) => entry.name) ?? []);
  }

  async function upload(files: File[]) {
    if (!ownScope || files.length === 0) return;
    const place = photosUploadPlace(ownScope, ownProfileId, $acceptedShares);
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
    void upload(files);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="photos-view">
  <div class="flex min-h-13 shrink-0 items-center gap-2 border-b border-surface-2 px-3 py-2 lg:px-5 lg:py-3">
    <span class="i-lucide-image shrink-0 text-lg text-accent lg:text-xl"></span>
    <h1 class="text-base font-medium text-text-1 lg:text-xl">Photos</h1>
    {#if walking && found.length > 0}
      <span class="i-lucide-loader-2 animate-spin text-sm text-text-3" title="Still looking"></span>
    {/if}
    <!-- Where there are none yet, the message below offers it. -->
    {#if ownScope && found.length > 0}
      <button
        type="button"
        class="btn-ghost ml-auto flex h-8 items-center gap-1.5 px-3 text-xs lg:text-sm"
        onclick={() => fileInput?.click()}
        data-testid="photos-upload"
      >
        <span class="i-lucide-upload text-base"></span>
        Upload
      </button>
    {/if}
  </div>

  <div class="flex-1 overflow-auto" data-scroll-root data-testid="photos-scroll">
    {#if found.length === 0}
      {#if walking}
        <div class="flex justify-center py-16 text-text-3">
          <span class="i-lucide-loader-2 animate-spin text-2xl" title="Looking for photos"></span>
        </div>
      {:else}
        <div class="flex flex-col items-center gap-3 px-4 py-16 text-center text-sm text-text-2" data-testid="photos-empty">
          <span class="i-lucide-image text-4xl text-text-3/70"></span>
          Photos and videos in your Drive show up here
          {#if ownScope}
            <button type="button" class="btn-primary mt-1 flex items-center gap-1.5" onclick={() => fileInput?.click()} data-testid="photos-empty-upload">
              <span class="i-lucide-upload text-base"></span>
              Upload
            </button>
          {/if}
        </div>
      {/if}
    {:else}
      {#each groups as group (group.key)}
        <section class="pb-3" data-testid="photos-group">
          <h2 class="sticky top-0 z-10 bg-surface-0/95 px-3 py-2 text-sm font-medium text-text-1 backdrop-blur-sm lg:px-5">{group.label}</h2>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-0.5 px-0.5 sm:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] sm:gap-1 sm:px-3 lg:px-5">
            {#each group.photos as photo (photo.href)}
              <PhotoTile {photo} {ready} href={openHref(photo)} onopen={opensHere} />
            {/each}
          </div>
        </section>
      {/each}
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
  <PhotoViewer photos={ordered} index={openIndex} dateOf={(photo) => photoDate(photo, taken)} onstep={step} onclose={close} />
{/if}
