<script lang="ts" module>
  /**
   * Modal for managing document collaborators/editors
   * Features:
   * - UserRow display for collaborators
   * - Auto-save on add/remove (like React version)
   * - QR Scanner for adding npubs
   * - Search through followed users with B-Tree index
   */

  export interface CollaboratorsTarget {
    npubs: string[];
    onSave?: (npubs: string[]) => void;
  }

  let show = $state(false);
  let target = $state<CollaboratorsTarget | null>(null);

  export function open(t: CollaboratorsTarget) {
    target = t;
    show = true;
  }

  export function close() {
    show = false;
    target = null;
  }
</script>

<script lang="ts">
  import NpubAccessModal from './NpubAccessModal.svelte';

  let localNpubs = $state<string[]>([]);
  $effect(() => {
    if (show && target) {
      localNpubs = [...target.npubs];
    }
  });

  let canEdit = $derived(!!target?.onSave);
  let sections = $derived([{
    id: 'editor',
    label: 'Current editors',
    memberLabel: 'editor',
    npubs: localNpubs,
    emptyText: canEdit ? 'No editors yet. Add one below.' : 'No editors yet.',
    removeTitle: 'Remove editor',
  }]);
  let intro = $derived(
    canEdit
      ? 'Add editors by their npub to merge their edits into this document.'
      : 'Users who can edit this document. Their changes will be merged.'
  );
  let requestAccess = $derived({
    text: 'Share your npub with an editor to request access:',
    shareHref: (userNpub: string) => `${window.location.origin}/#/${userNpub}`,
  });

  function handleClose() {
    close();
  }

  function validateAdd(npub: string): string | null {
    return localNpubs.includes(npub) ? 'This npub is already in the list.' : null;
  }

  async function handleAdd(npub: string): Promise<void> {
    if (!target?.onSave) return;
    const newNpubs = [...localNpubs, npub];
    localNpubs = newNpubs;
    target.onSave(newNpubs);
  }

  async function handleRemove(_sectionId: string, npub: string): Promise<void> {
    if (!target?.onSave) return;
    const newNpubs = localNpubs.filter(item => item !== npub);
    localNpubs = newNpubs;
    target.onSave(newNpubs);
  }
</script>

{#if show && target}
  <NpubAccessModal
    open={show}
    onClose={handleClose}
    title={canEdit ? 'Manage Editors' : 'Editors'}
    {intro}
    {sections}
    {canEdit}
    validateAdd={validateAdd}
    onAdd={(npub) => handleAdd(npub)}
    onRemove={handleRemove}
    initialSectionId="editor"
    addPromptLabel="Add editor"
    {requestAccess}
  />
{/if}
