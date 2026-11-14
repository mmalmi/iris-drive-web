/**
 * Who can open a file, folder or document, as far as this device knows.
 * Kept free of UI so lists and headers answer the question the same way.
 */
import type { TreeVisibility } from '@hashtree/core';
import { projectSharedFolderView } from './protocol';
import type { NostrIdentityId } from './protocolTypes';
import type { AcceptedShareRecord } from './shareLibrary';
import { ownedShareAtPath } from './sharePeople';

export type ItemAccess =
  /** Only this person's own devices. */
  | { kind: 'private' }
  /**
   * People who were added or joined, and nobody else. `people` counts the
   * others; `invite` when an invite link lets more people join.
   */
  | { kind: 'people'; people: number; invite?: boolean }
  /** Anyone who has the link can open it. */
  | { kind: 'link'; people: number }
  /** Anyone can find and open it. */
  | { kind: 'public' };

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
  /** How the tree is published, for places that are not a Drive. */
  treeVisibility?: TreeVisibility;
}

function sharedAccess(record: AcceptedShareRecord, appKeyPubkey: string | null | undefined): ItemAccess {
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

/** Null when it is not known, such as a snapshot opened from a link. */
export function itemAccess(options: ItemAccessOptions): ItemAccess | null {
  const { scope, treeName, path, profileId, records } = options;
  if (!scope) return null;
  if (profileId && treeName === 'main') {
    if (scope === profileId) {
      const owned = ownedShareAtPath(path, profileId, records);
      return owned ? sharedAccess(owned.record, options.appKeyPubkey) : { kind: 'private' };
    }
    const joined = records.find((record) => record.share_id === scope && record.local_profile_id === profileId);
    if (joined) return sharedAccess(joined, options.appKeyPubkey);
  }
  switch (options.treeVisibility) {
    case 'public': return { kind: 'public' };
    case 'link-visible': return { kind: 'link', people: 0 };
    case 'private': return { kind: 'private' };
    default: return null;
  }
}

/** A word or two for a badge, and a sentence for its tooltip. */
export function describeItemAccess(access: ItemAccess): { label: string; detail: string; icon: string } {
  const joined = (people: number) => (people === 1 ? '1 person has joined' : `${people} people have joined`);
  const people = (count: number) => (count === 1 ? '1 person' : `${count} people`);
  switch (access.kind) {
    case 'private':
      return { label: 'Private', detail: 'Only you can open this', icon: 'i-lucide-lock' };
    case 'people':
      return {
        label: access.people > 0 ? `Shared with ${access.people}` : 'Shared',
        detail: [
          access.people > 0 ? `Shared with ${people(access.people)}` : 'Shared, nobody has joined yet',
          ...(access.invite ? ['People with the invite link can join'] : []),
        ].join('. '),
        icon: 'i-lucide-users',
      };
    case 'link':
      return {
        label: 'Anyone with the link',
        detail: access.people > 0 ? `Anyone with the link can open this. ${joined(access.people)}.` : 'Anyone with the link can open this',
        icon: 'i-lucide-link',
      };
    case 'public':
      return { label: 'Public', detail: 'Anyone can find and open this', icon: 'i-lucide-globe' };
  }
}
