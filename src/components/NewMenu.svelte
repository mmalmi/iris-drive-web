<script lang="ts">
  /**
   * The one place to make or add something: a folder, a document, a
   * spreadsheet, a presentation, a text file, or files and folders from the
   * device. In the sidebar it is the big New button, a square + on its rail.
   * In a folder's header it is a small New button where there is no sidebar,
   * and on a phone a round button at the bottom whose menu rises from the
   * bottom of the screen.
   */
  import { tick } from 'svelte';
  import { DOCUMENT_KINDS } from '../lib/documentNames';
  import { open as openCreateModal, type ModalType } from './Modals/CreateModal.svelte';
  import { uploadFiles, uploadDirectory } from '../stores/upload';
  import { readFilesFromWebkitDirectory, supportsDirectoryUpload } from '@iris/hashtree-app/directory';

  interface Props {
    variant: 'sidebar' | 'rail' | 'folder';
    /** A folder to open first, for when the page shown is not one to add to. */
    goTo?: string | null;
    class?: string;
  }

  let { variant, goTo = null, class: className = '' }: Props = $props();

  interface Item {
    label: string;
    icon: string;
    testid: string;
    run: () => void;
  }

  const menuId = `new-menu-${Math.random().toString(36).slice(2, 8)}`;
  const hasDirectorySupport = supportsDirectoryUpload();

  let open = $state(false);
  let opener: HTMLElement | null = null;
  let menuRef: HTMLDivElement | undefined = $state();
  let backdropRef: HTMLDivElement | undefined = $state();
  let sidebarButton: HTMLButtonElement | undefined = $state();
  let headerButton: HTMLButtonElement | undefined = $state();
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
  const creating: Item[] = [
    { label: 'Folder', icon: 'i-lucide-folder text-warning', testid: 'new-folder', run: create('folder') },
    ...Object.values(DOCUMENT_KINDS)
      .filter((info) => info.ready)
      .map((info) => ({
        label: info.noun[0].toUpperCase() + info.noun.slice(1),
        icon: info.icon,
        testid: `new-${info.kind}`,
        run: create(info.kind),
      })),
    { label: 'Text file', icon: 'i-lucide-file-type text-text-2', testid: 'new-text-file', run: create('file') },
  ];

  const adding: Item[] = [
    { label: 'Upload files', icon: 'i-lucide-file-up text-text-2', testid: 'upload-files', run: pick(() => filesInput) },
    ...(hasDirectorySupport
      ? [{ label: 'Upload folder', icon: 'i-lucide-folder-up text-text-2', testid: 'upload-folder', run: pick(() => folderInput) }]
      : []),
  ];

  function menuItems(): HTMLElement[] {
    return menuRef ? [...menuRef.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
  }

  async function openMenu(from: HTMLElement, focus: 'first' | 'last' = 'first') {
    opener = from;
    open = true;
    await tick();
    const items = menuItems();
    items[focus === 'first' ? 0 : items.length - 1]?.focus();
  }

  function closeMenu(returnFocus = false) {
    if (!open) return;
    open = false;
    if (returnFocus) opener?.focus();
  }

  function toggle(event: MouseEvent) {
    if (open) closeMenu();
    else void openMenu(event.currentTarget as HTMLElement);
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    void openMenu(event.currentTarget as HTMLElement, event.key === 'ArrowDown' ? 'first' : 'last');
  }

  function choose(item: Item) {
    closeMenu(true);
    item.run();
  }

  function onMenuKeydown(event: KeyboardEvent) {
    const items = menuItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Tab') closeMenu();
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  }

  $effect(() => {
    if (!open) return;
    const isInside = (target: EventTarget | null) => target instanceof Node
      && [menuRef, backdropRef, sidebarButton, headerButton, fabButton].some((node) => node?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.target)) closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    };
    const onNavigate = () => closeMenu();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('hashchange', onNavigate);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('hashchange', onNavigate);
    };
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

  let sheet = $derived(variant === 'folder');
</script>

{#snippet menuItem(item: Item)}
  <button
    type="button"
    role="menuitem"
    tabindex="-1"
    class="flex w-full items-center gap-4 border-none bg-transparent px-5 h-13 text-left text-base text-text-1 outline-none cursor-pointer hover:bg-surface-2 focus-visible:bg-surface-2 sm:gap-3 sm:px-4 sm:h-10 sm:text-sm"
    data-testid={item.testid}
    onclick={() => choose(item)}
  >
    <span class="{item.icon} shrink-0 text-xl sm:text-lg"></span>
    {item.label}
  </button>
{/snippet}

<!-- On a phone the folder's New floats, so it takes no room in the header. -->
<div class="{variant === 'folder' ? 'contents sm:relative sm:block md:hidden' : 'relative'} {className}">
  {#if variant !== 'folder'}
    <button
      bind:this={sidebarButton}
      type="button"
      class="flex h-14 items-center rounded-2xl text-sm font-medium text-text-1 shadow-sm ring-1 ring-surface-2 transition hover:bg-surface-2 hover:shadow {variant === 'rail' ? 'w-14 justify-center' : 'w-28 gap-3 px-4'} {open ? 'bg-surface-2' : 'bg-surface-0'}"
      aria-label="New"
      title={variant === 'rail' ? 'New' : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      data-testid="new-menu"
      onclick={toggle}
      onkeydown={onTriggerKeydown}
    >
      <span class="i-lucide-plus text-2xl"></span>
      {#if variant === 'sidebar'}<span>New</span>{/if}
    </button>
  {:else}
    <button
      bind:this={headerButton}
      type="button"
      class="btn-ghost hidden sm:flex items-center gap-1.5"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      data-testid="new-menu"
      onclick={toggle}
      onkeydown={onTriggerKeydown}
    >
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
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      data-testid="new-menu"
      onclick={toggle}
      onkeydown={onTriggerKeydown}
    >
      <span class="i-lucide-plus text-3xl"></span>
    </button>
  {/if}

  {#if open}
    {#if sheet}
      <!-- On a phone the menu is a sheet over the page; a tap beside it only closes it. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div bind:this={backdropRef} class="sm:hidden fixed inset-0 z-40 bg-black/40" onclick={() => closeMenu()}></div>
    {/if}
    <div
      bind:this={menuRef}
      id={menuId}
      role="menu"
      tabindex="-1"
      aria-label="New"
      class="z-50 overflow-hidden bg-surface-1 shadow-lg ring-1 ring-surface-3 {sheet
        ? 'fixed left-0 right-0 bottom-0 rounded-t-2xl pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:absolute sm:left-auto sm:bottom-auto sm:top-full sm:mt-1 sm:w-60 sm:rounded-xl sm:py-1'
        : 'absolute left-0 top-full mt-1 w-60 rounded-xl py-1'}"
      onkeydown={onMenuKeydown}
    >
      {#each creating as item (item.testid)}
        {@render menuItem(item)}
      {/each}
      <div class="my-1.5 h-px bg-surface-3/70" role="separator"></div>
      {#each adding as item (item.testid)}
        {@render menuItem(item)}
      {/each}
    </div>
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
