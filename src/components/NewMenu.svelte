<script lang="ts">
  /**
   * The one place to make or add something: a folder, a document, a
   * spreadsheet, a presentation, a form, a text file, or files and folders from the
   * device. In the sidebar it is the big New button, a square + on its rail.
   * In a folder's header it is a small New button where there is no sidebar,
   * and on a phone a round button at the bottom whose menu rises from the
   * bottom of the screen.
   */
  import Menu, { type MenuItem } from './ui/Menu.svelte';
  import { DOCUMENT_KINDS } from '../lib/documentNames';
  import { open as openCreateModal, type ModalType } from './Modals/CreateModal.svelte';
  import { uploadFiles, uploadDirectory } from '../stores/upload';
  import { readFilesFromWebkitDirectory, supportsDirectoryUpload } from '@iris/hashtree-app/directory';

  interface Props {
    /** `empty`: the button inside an empty folder's message. */
    variant: 'sidebar' | 'rail' | 'folder' | 'empty';
    /** A folder to open first, for when the page shown is not one to add to. */
    goTo?: string | null;
    class?: string;
  }

  let { variant, goTo = null, class: className = '' }: Props = $props();

  const hasDirectorySupport = supportsDirectoryUpload();

  /** The button the menu was opened from, while it is open. */
  let opener = $state<HTMLElement | null>(null);
  let focusLast = $state(false);
  let fabButton: HTMLButtonElement | undefined = $state();
  let filesInput: HTMLInputElement | undefined = $state();
  let folderInput: HTMLInputElement | undefined = $state();

  function create(type: ModalType) {
    return () => {
      go();
      openCreateModal(type);
    };
  }

  function pick(input: () => HTMLInputElement | undefined) {
    return () => {
      go();
      input()?.click();
    };
  }

  function go() {
    if (goTo && window.location.hash !== goTo) window.location.hash = goTo;
  }

  // The kinds' icons come from DOCUMENT_KINDS, which UnoCSS does not read; named here so they are built:
  // i-lucide-file-text text-accent i-lucide-table-2 text-success i-lucide-presentation text-orange-500
  // i-lucide-clipboard-list text-violet-500
  const items: MenuItem[] = [
    { label: 'Folder', icon: 'i-lucide-folder text-warning', testid: 'new-folder', run: create('folder') },
    ...Object.values(DOCUMENT_KINDS)
      .filter((info) => info.ready)
      .map((info) => ({
        label: info.noun[0].toUpperCase() + info.noun.slice(1),
        icon: info.icon,
        testid: `new-${info.kind}`,
        run: create(info.kind),
      })),
    { label: 'Text file', icon: 'i-lucide-file-type', testid: 'new-text-file', run: create('file') },
    { label: 'Upload files', icon: 'i-lucide-file-up', testid: 'upload-files', run: pick(() => filesInput), divider: true },
    ...(hasDirectorySupport
      ? [{ label: 'Upload folder', icon: 'i-lucide-folder-up', testid: 'upload-folder', run: pick(() => folderInput) }]
      : []),
  ];

  function closeMenu(returnFocus: boolean) {
    const from = opener;
    opener = null;
    if (returnFocus) from?.focus();
  }

  function toggle(event: MouseEvent) {
    focusLast = false;
    opener = opener ? null : event.currentTarget as HTMLElement;
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    focusLast = event.key === 'ArrowUp';
    opener = event.currentTarget as HTMLElement;
  }

  /** What each of its buttons has. */
  let trigger = $derived({
    'aria-haspopup': 'menu' as const,
    'aria-expanded': opener !== null,
    'data-testid': 'new-menu',
    onclick: toggle,
    onkeydown: onTriggerKeydown,
  });

  function handleFileUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files?.length) void uploadFiles(Array.from(input.files));
    input.value = '';
  }

  function handleDirUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files?.length) void uploadDirectory(readFilesFromWebkitDirectory(input.files));
    input.value = '';
  }
</script>

<!-- On a phone the folder's New floats, so it takes no room in the header. -->
<div class="{variant === 'folder' ? 'contents sm:relative sm:block md:hidden' : 'relative'} {className}">
  {#if variant === 'empty'}
    <button type="button" class="btn-primary flex items-center gap-1.5" {...trigger} data-testid="empty-folder-new">
      <span class="i-lucide-plus text-lg"></span>
      New
    </button>
  {:else if variant !== 'folder'}
    <button
      type="button"
      class="flex h-14 items-center rounded-2xl text-sm font-medium text-text-1 shadow-sm ring-1 ring-surface-2 transition hover:bg-surface-2 hover:shadow {variant === 'rail' ? 'w-14 justify-center' : 'w-28 gap-3 px-4'} {opener ? 'bg-surface-2' : 'bg-surface-0'}"
      aria-label="New"
      title={variant === 'rail' ? 'New' : undefined}
      {...trigger}
    >
      <span class="i-lucide-plus text-2xl"></span>
      {#if variant === 'sidebar'}<span>New</span>{/if}
    </button>
  {:else}
    <button type="button" class="btn-ghost hidden sm:flex items-center gap-1.5" {...trigger}>
      <span class="i-lucide-plus text-lg"></span>
      New
    </button>
    <button
      bind:this={fabButton}
      type="button"
      class="sm:hidden fixed z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-white shadow-lg shadow-black/25 transition-transform active:scale-95"
      style="right: calc(1rem + env(safe-area-inset-right)); bottom: calc(1.25rem + var(--drive-tabs-height, 0px) + env(safe-area-inset-bottom));"
      title="New"
      aria-label="New"
      {...trigger}
    >
      <span class="i-lucide-plus text-3xl"></span>
    </button>
  {/if}

  {#if opener}
    <Menu
      {items}
      label="New"
      sheet={opener === fabButton}
      align={variant === 'folder' ? 'right' : 'left'}
      width="w-60"
      {focusLast}
      inside={[opener]}
      onClose={closeMenu}
    />
  {/if}

  <input
    bind:this={filesInput}
    type="file"
    multiple
    class="hidden"
    tabindex="-1"
    data-testid={variant === 'folder' ? 'upload-files-input' : undefined}
    onchange={handleFileUpload}
  />
  {#if hasDirectorySupport}
    <input
      bind:this={folderInput}
      type="file"
      webkitdirectory
      class="hidden"
      tabindex="-1"
      data-testid={variant === 'folder' ? 'upload-folder-input' : undefined}
      onchange={handleDirUpload}
    />
  {/if}
</div>
