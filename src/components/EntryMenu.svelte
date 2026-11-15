<script lang="ts" module>
  import type { TreeEntry } from '@hashtree/core';

  /** What to show a menu for, and where. */
  export interface EntryMenuRequest {
    entry: TreeEntry;
    /** Where the entry opens. */
    href: string;
    /** The point it opens at: the pointer, or below the ⋮ button or the row. */
    x: number;
    y: number;
    /** On a phone it rises from the bottom of the screen, as the New menu does. */
    sheet: boolean;
    /** Where the keyboard goes back to when it closes. */
    opener: HTMLElement | null;
  }
</script>

<script lang="ts">
  /**
   * The menu of a file or folder in the list, from its ⋮ button, a right
   * click or the menu key (a long press on a phone chooses the row instead):
   * what can be done with it, by the same actions and dialogs as everywhere
   * else.
   */
  import { LinkType } from '@hashtree/core';
  import Menu, { type MenuItem } from './ui/Menu.svelte';
  import { deleteEntry, makeCopy } from '../actions';
  import { open as openRenameModal } from './Modals/RenameModal.svelte';
  import { open as openMoveModal } from './Modals/MoveModal.svelte';
  import { open as openShareModal } from './Modals/ShareModal.svelte';
  import { routeStore } from '../stores';
  import { nostrStore } from '../nostr';
  import { acceptedShares } from '../drive/shareLibrary';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { sharePeopleTarget } from '../drive/sharePeople';
  import { linkOpening, linkShares, linkTargetAt } from '../drive/linkShares';
  import { createDriveShareLinkVariants, entryCopyHref } from '../lib/shareUrls';
  import { documentKindInfo, documentTitle } from '../lib/documentNames';
  import { downloadFile, downloadFolderZip } from '../lib/downloadEntry';
  import { isNostrIdentityId } from '../utils/route';
  import { toast } from '../stores/toast';

  interface Props {
    request: EntryMenuRequest;
    /** The folder the entry is in. */
    path: string[];
    canEdit: boolean;
    onClose: (returnFocus: boolean) => void;
  }

  let { request, path, canEdit, onClose }: Props = $props();

  let route = $derived($routeStore);
  let entry = $derived(request.entry);
  let isDir = $derived(entry.type === LinkType.Dir);
  let documentInfo = $derived(isDir ? documentKindInfo(entry.name) : null);
  let title = $derived(documentInfo ? documentTitle(entry.name) : entry.name);
  // In Drive a folder is copied where it is; trees outside it are forked from the folder's page.
  let inDrive = $derived(isNostrIdentityId(route.npub ?? ''));

  /** Where it is, for sharing. */
  let where = $derived({
    scope: route.npub,
    treeName: route.treeName,
    path: [...path, entry.name],
    profileId: activeNostrIdentityRootScope($nostrStore),
    records: $acceptedShares,
  });

  /**
   * As Google Drive's Copy link: the link anyone opens when it opens by link,
   * else its address in Drive, which opens for whoever it is shared with.
   */
  function copyLink() {
    const target = route.isPermalink ? null : linkTargetAt(where);
    const link = (target && linkOpening(target, where.profileId, $acceptedShares, $linkShares))
      ?? `${window.location.origin}${window.location.pathname}${request.href}`;
    navigator.clipboard.writeText(link).then(
      () => toast.success('Link copied'),
      () => toast.error('Could not copy the link'),
    );
  }

  function share() {
    const here = `${window.location.origin}${window.location.pathname}`;
    const [primary, secondary] = createDriveShareLinkVariants({
      permalinkUrl: `${here}${entryCopyHref(entry)}`,
      currentUrl: `${here}${request.href}`,
      routeScope: route.npub,
      isPermalink: route.isPermalink,
    });
    const people = isDir && canEdit && !route.isPermalink ? sharePeopleTarget(where) : null;
    // A single file is not shared with people, but it can open by link.
    const general = !isDir && !route.isPermalink ? linkTargetAt(where) : null;
    if (primary) openShareModal(primary.url, secondary?.url ?? null, people, true, general);
  }

  async function download() {
    try {
      if (isDir) await downloadFolderZip(entry.cid, entry.name);
      else await downloadFile(entry);
    } catch (error) {
      console.warn('[Drive] Could not download:', error);
      toast.error(`Could not download ${title}`);
    }
  }

  function remove() {
    void deleteEntry(entry.name).catch(() => toast.error(`Could not delete ${title}`));
  }

  // Lucide has no filled set; these are its plainest outlines.
  let items = $derived.by((): MenuItem[] => {
    const href = request.href;
    const list: MenuItem[] = [
      { label: 'Open', icon: 'i-lucide-square-arrow-out-up-right', testid: 'row-menu-open', href },
      { label: 'Share', icon: 'i-lucide-share', testid: 'row-menu-share', run: share },
      { label: 'Copy link', icon: 'i-lucide-link', testid: 'row-menu-copy-link', run: copyLink },
    ];
    if (canEdit) {
      list.push(
        { label: 'Rename', icon: 'i-lucide-pencil', testid: 'row-menu-rename', run: () => openRenameModal(entry.name, isDir) },
        { label: 'Move', icon: 'i-lucide-folder-input', testid: 'row-menu-move', run: () => openMoveModal(entry.name, path) },
      );
      // A document's copy would share its live editing with the original, so documents have none.
      if (!documentInfo && inDrive) list.push({ label: 'Make a copy', icon: 'i-lucide-copy', testid: 'row-menu-copy', run: () => void makeCopy([...path, entry.name]) });
    }
    if (!documentInfo) list.push({ label: 'Download', icon: 'i-lucide-download', testid: 'row-menu-download', run: () => void download() });
    if (canEdit) list.push({ label: 'Delete', icon: 'i-lucide-trash-2', testid: 'row-menu-delete', run: remove, danger: true });
    return list;
  });
</script>

<Menu
  {items}
  label={title}
  heading={title}
  at={{ x: request.x, y: request.y }}
  sheet={request.sheet}
  inside={[request.opener]}
  testid="row-menu"
  {onClose}
/>
