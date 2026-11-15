<script lang="ts" module>
  /**
   * Modal for creating new files, folders, or trees
   */
  import type { TreeVisibility } from '@hashtree/core';
  import { DOCUMENT_KINDS, type DocumentKind } from '../../lib/documentNames';

  export type ModalType = 'file' | 'folder' | 'tree' | DocumentKind;

  let show = $state(false);
  let modalType = $state<ModalType>('file');
  let treeVisibility = $state<TreeVisibility>('public');
  let modalInput = $state('');

  export function open(type: ModalType, visibility: TreeVisibility = 'public') {
    modalType = type;
    treeVisibility = visibility;
    modalInput = '';
    show = true;
  }

  export function close() {
    show = false;
    modalInput = '';
  }

  export function setVisibility(v: TreeVisibility) {
    treeVisibility = v;
  }
</script>

<script lang="ts">
  import { createFile, createFolder, createTree, createDocument } from '../../actions';
  import { routeStore } from '../../stores';
  import VisibilityPicker from '@iris/hashtree-app/VisibilityPicker.svelte';
  import MakePublicDialog from './MakePublicDialog.svelte';
  let confirmation = $state<MakePublicDialog>();

  let route = $derived($routeStore);

  let isCreating = $state(false);
  let inputRef = $state<HTMLInputElement | null>(null);

  // Focus input when modal opens
  $effect(() => {
    if (show && inputRef) {
      inputRef.focus();
    }
  });

  let isFolder = $derived(modalType === 'folder');
  let isTree = $derived(modalType === 'tree');
  let documentKind = $derived(modalType in DOCUMENT_KINDS ? DOCUMENT_KINDS[modalType as DocumentKind] : null);
  let isDocument = $derived(!!documentKind);

  let title = $derived(
    isTree
      ? 'New Folder'
      : isDocument
        ? documentKind!.newLabel
        : isFolder
          ? 'New Folder'
          : 'New File'
  );
  let placeholder = $derived(
    isDocument
      ? `${documentKind!.noun[0].toUpperCase()}${documentKind!.noun.slice(1)} name...`
      : isTree
        ? 'Folder name...'
        : isFolder
          ? 'Folder name...'
          : 'File name...'
  );

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (isTree && treeVisibility === 'public' && modalInput.trim() && !isCreating) {
      confirmation?.open();
      return;
    }
    void create();
  }

  async function create() {
    const name = modalInput.trim();
    if (!name || isCreating) return;

    if (isTree) {
      isCreating = true;
      await createTree(name, treeVisibility);
      isCreating = false;
      close();
    } else if (isDocument) {
      isCreating = true;
      const folderName = route.npub && route.treeName ? await createDocument(name, documentKind!.kind) : null;
      close();
      if (folderName) {
        const newPath = [...route.path, folderName].map(encodeURIComponent).join('/');
        const linkKeyParam = route.params.get('k') ? `?k=${route.params.get('k')}` : '';
        window.location.hash = `/${route.npub}/${route.treeName}/${newPath}${linkKeyParam}`;
      }
      isCreating = false;
    } else if (isFolder) {
      isCreating = true;
      await createFolder(name);
      isCreating = false;
      close();
    } else {
      createFile(name, '');
      close();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70" data-scroll-lock
    onclick={close}
  >
    <div
      class="bg-surface-1 rounded-lg shadow-lg p-6 w-full max-w-md mx-4"
      onclick={(e) => e.stopPropagation()}
      onkeydown={handleKeyDown}
    >
      <h2 class="text-lg font-semibold mb-4">{title}</h2>
      <form onsubmit={handleSubmit}>
        <input
          bind:this={inputRef}
          type="text"
          bind:value={modalInput}
          placeholder={placeholder}
          class="input w-full mb-4"
        />

        <!-- Visibility picker for trees and new documents -->
        {#if isTree || (isDocument && !route.treeName)}
          <div class="mt-4 mb-4">
            <VisibilityPicker value={treeVisibility} onchange={setVisibility} />
          </div>
        {/if}

        <div class="flex justify-end gap-2">
          <button type="button" onclick={close} class="btn-ghost">Cancel</button>
          <button type="submit" class="btn-success" disabled={isCreating}>
            {isCreating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  </div>
  {#if isTree}
    <MakePublicDialog bind:this={confirmation} name={modalInput.trim()} item="this folder and its contents" onconfirm={create} />
  {/if}
{/if}
