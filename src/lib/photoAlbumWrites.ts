/**
 * Adding photos to an album: their entries go into its folder by the content
 * they already have, as copying a file in Drive does. Nothing is uploaded
 * again, so a photo of a shared folder goes into My Drive as freely.
 */
import { LinkType } from '@hashtree/core';
import { getTree } from '../store';
import { nostrStore } from '../nostr';
import { changeDriveRoot } from '../drive/driveRootChange';
import { setEntryForDriveRoute } from '../drive/profileDriveRouteEntry';
import { albumAdditions, type Photo } from './photos';
import { DRIVE_TREE_NAME } from './driveWalk';

/** Adds the photos not in the folder yet, making the folder when there is none; resolves those added. */
export async function addToAlbum(album: { scope: string; path: string[] }, photos: Photo[]): Promise<Photo[]> {
  const tree = getTree();
  let added: Photo[] = [];
  await changeDriveRoot(album.scope, DRIVE_TREE_NAME, async (root) => {
    const folder = album.path.length > 0 ? await tree.resolvePath(root, album.path) : { cid: root, type: LinkType.Dir };
    const there = folder?.type === LinkType.Dir ? await tree.listDirectory(folder.cid) : [];
    const additions = albumAdditions(there, photos);
    added = additions.map(({ photo }) => photo);
    let next = root;
    for (const { name, photo } of additions) {
      next = await setEntryForDriveRoute(
        tree,
        next,
        album.path,
        name,
        { cid: photo.cid, size: photo.size, type: photo.type },
        { npub: album.scope, treeName: DRIVE_TREE_NAME },
        nostrStore.getState(),
      );
    }
    return additions.length > 0 ? next : null;
  });
  return added;
}
