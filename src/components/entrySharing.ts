import { LinkType, type TreeEntry } from '@hashtree/core';
import { get } from 'svelte/store';
import { linkOpening, linkShares, linkTargetAt } from '../drive/linkShares';
import { activeNostrIdentityRootScope } from '../drive/profileRoute';
import { acceptedShares } from '../drive/shareLibrary';
import { sharePeopleTarget } from '../drive/sharePeople';
import { createDriveShareLinkVariants, entryCopyHref } from '../lib/shareUrls';
import { nostrStore } from '../nostr';
import { routeStore } from '../stores/route';
import { toast } from '../stores/toast';
import { open as openShareModal } from './Modals/ShareModal.svelte';

function location(path: string[]) {
  const route = get(routeStore);
  return {
    scope: route.npub, treeName: route.treeName, path,
    profileId: activeNostrIdentityRootScope(nostrStore.getState()), records: get(acceptedShares),
  };
}

/** Link sharing stays as configured. A private item's address opens for people who already have access. */
export async function copyEntryLinks(items: { entry: TreeEntry; href: string }[], parent: string[]): Promise<void> {
  const route = get(routeStore);
  const base = window.location.origin + window.location.pathname;
  const links = items.map(({ entry, href }) => {
    const where = location([...parent, entry.name]);
    const target = route.isPermalink ? null : linkTargetAt(where);
    return (target && linkOpening(target, where.profileId, where.records, get(linkShares))) ?? base + href;
  });
  try {
    await navigator.clipboard.writeText(links.join('\n'));
    toast.success(links.length === 1 ? 'Link copied' : `${links.length} links copied`);
  } catch {
    toast.error(links.length === 1 ? 'Could not copy the link' : 'Could not copy the links');
  }
}

export function shareEntry(entry: TreeEntry, href: string, parent: string[], canEdit: boolean): void {
  const route = get(routeStore);
  const where = location([...parent, entry.name]);
  const isDir = entry.type === LinkType.Dir;
  const base = window.location.origin + window.location.pathname;
  const [primary, secondary] = createDriveShareLinkVariants({
    permalinkUrl: base + entryCopyHref(entry),
    currentUrl: base + href,
    routeScope: route.npub,
    isPermalink: route.isPermalink,
  });
  const people = isDir && canEdit && !route.isPermalink ? sharePeopleTarget(where) : null;
  const general = !isDir && !route.isPermalink ? linkTargetAt(where) : null;
  if (primary) openShareModal(primary.url, secondary?.url ?? null, people, true, general);
}
