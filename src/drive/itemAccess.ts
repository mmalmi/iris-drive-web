/**
 * Who can open a file, folder or document, as far as this device knows.
 * Kept free of UI so lists and headers answer the question the same way.
 */
import type { TreeVisibility } from '@hashtree/core';
import { projectSharedFolderView } from './protocol';
import type { NostrIdentityId } from './protocolTypes';
import type { AcceptedShareRecord } from './shareLibrary';
import { ownDrivePathInShare, ownedShareAtPath } from './sharePeople';
import { linkShareCovering, type LinkShare } from './linkShares';

/**
 * People who were added or joined. `people` counts the others; `invite` when
 * an invite link lets more people join.
 */
interface SharedWithPeople {
  people: number;
  invite?: boolean;
}

export type ItemAccess =
  /** Only this person's own devices. */
  | { kind: 'private' }
  /** People who were added or joined, and nobody else. */
  | ({ kind: 'people' } & SharedWithPeople)
  /** Anyone who has the link can open it; `shared` when people were also added, who may edit it. */
  | { kind: 'link'; shared?: SharedWithPeople }
  /** Anyone can find and open it; `shared` as for a link. */
  | { kind: 'public'; shared?: SharedWithPeople };

export interface ItemAccessOptions {
  /** The Drive, shared folder or account the route is in. */
  scope: string | null | undefined;
  treeName: string | null | undefined;
  /** Path of the item below the Drive root. */
  path: string[];
  /** The signed-in person's Drive. */
  profileId: NostrIdentityId | null | undefined;
  appKeyPubkey?: string | null;
  records: AcceptedShareRecord[];
  /** Items of My Drive that open by their link. */
  linkShares?: LinkShare[];
  /** How the tree is published, for places that are not a Drive. */
  treeVisibility?: TreeVisibility;
}

function sharedAccess(record: AcceptedShareRecord, appKeyPubkey: string | null | undefined): ItemAccess & { kind: 'people' } {
  let people = 0;
  try {
    const view = projectSharedFolderView(record.folder, [], appKeyPubkey ?? '');
    people = Math.max(0, view.participant_count - 1);
  } catch {
    // A folder whose member list cannot be read is still a shared one.
  }
  // An invite link lets people join, which takes an account and the owner's
  // Drive letting them in; it does not open the folder to anyone.
  return { kind: 'people', people, ...(record.join_links?.length ? { invite: true } : {}) };
}

/** Shared with people and open to anyone with the link: the link is the wider access, so it leads. */
function withLink(access: ItemAccess & { kind: 'people' }, link: LinkShare | null): ItemAccess {
  if (!link) return access;
  const shared: SharedWithPeople = { people: access.people, ...(access.invite ? { invite: true } : {}) };
  return { kind: link.access === 'public' ? 'public' : 'link', shared };
}

/** The link in force over an item of a shared folder: one its owner made in My Drive, or one made in the folder. */
function shareLinkCovering(record: AcceptedShareRecord, inner: string[], profileId: NostrIdentityId, links: LinkShare[]): LinkShare | null {
  const own = ownDrivePathInShare(record, inner);
  return (own ? linkShareCovering(own, profileId, links) : null) ?? linkShareCovering(inner, profileId, links, record.share_id);
}

/** Null when it is not known, such as a snapshot opened from a link. */
export function itemAccess(options: ItemAccessOptions): ItemAccess | null {
  const { scope, treeName, path, profileId, records } = options;
  const links = options.linkShares ?? [];
  if (!scope) return null;
  if (profileId && treeName === 'main') {
    if (scope === profileId) {
      const owned = ownedShareAtPath(path, profileId, records);
      if (owned) return withLink(sharedAccess(owned.record, options.appKeyPubkey), shareLinkCovering(owned.record, owned.rest, profileId, links));
      const link = linkShareCovering(path, profileId, links);
      if (link) return { kind: link.access === 'public' ? 'public' : 'link' };
      return { kind: 'private' };
    }
    const joined = records.find((record) => record.share_id === scope && record.local_profile_id === profileId);
    if (joined) return withLink(sharedAccess(joined, options.appKeyPubkey), shareLinkCovering(joined, path, profileId, links));
  }
  switch (options.treeVisibility) {
    case 'public': return { kind: 'public' };
    case 'link-visible': return { kind: 'link' };
    case 'private': return { kind: 'private' };
    default: return null;
  }
}

/** A word or two for a badge, and a sentence for its tooltip. */
export function describeItemAccess(access: ItemAccess): { label: string; detail: string; icon: string } {
  const people = (count: number) => (count === 1 ? '1 person' : `${count} people`);
  const invite = (shared: SharedWithPeople) => (shared.invite ? ['People with the invite link can join'] : []);
  // Beside a link, the people it is shared with too.
  const alsoShared = (shared: SharedWithPeople | undefined) => (shared
    ? [shared.people > 0 ? `Shared with ${people(shared.people)}` : 'Shared with people, nobody has joined yet', ...invite(shared)]
    : []);
  switch (access.kind) {
    case 'private':
      return { label: 'Private', detail: 'Only you can open this', icon: 'i-lucide-lock' };
    case 'people':
      return {
        label: access.people > 0 ? `Shared with ${access.people}` : 'Shared',
        detail: [access.people > 0 ? `Shared with ${people(access.people)}` : 'Shared, nobody has joined yet', ...invite(access)].join('. '),
        icon: 'i-lucide-users',
      };
    case 'link':
      return {
        label: 'Anyone with the link',
        detail: ['Anyone with the link can view this', ...alsoShared(access.shared)].join('. '),
        icon: 'i-lucide-link',
      };
    case 'public':
      return { label: 'Public', detail: ['Anyone can find and open this', ...alsoShared(access.shared)].join('. '), icon: 'i-lucide-globe' };
  }
}
