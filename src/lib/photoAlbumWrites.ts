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
import { albumAdditions, validAlbumName, type Photo } from './photos';
import { DRIVE_TREE_NAME } from './driveWalk';

/** Creates an album as a normal Drive folder, even before any photos are added. */
export async function createAlbum(parent: { scope: string; path: string[] }, name: string): Promise<void> {
  if (!validAlbumName(name)) throw new Error('Choose another album name.');
  const tree = getTree();
  await changeDriveRoot(parent.scope, DRIVE_TREE_NAME, async (root) => {
    for (let depth = 1; depth <= parent.path.length; depth++) {
      const ancestor = await tree.resolvePath(root, parent.path.slice(0, depth));
      if (ancestor && ancestor.type !== LinkType.Dir) throw new Error('A file is in the way of this folder.');
    }
    if (await tree.resolvePath(root, [...parent.path, name])) throw new Error('That name is already in use.');
    const { cid } = await tree.putDirectory([]);
    return setEntryForDriveRoute(tree, root, parent.path, name, { cid, size: 0, type: LinkType.Dir },
      { npub: parent.scope, treeName: DRIVE_TREE_NAME }, nostrStore.getState());
  });
}

/** Adds the photos not in the folder yet, making the folder when there is none; resolves those added. */
export async function addToAlbum(album: { scope: string; path: string[] }, photos: Photo[]): Promise<Photo[]> {
  const tree = getTree();
  let added: Photo[] = [];
  await changeDriveRoot(album.scope, DRIVE_TREE_NAME, async (root) => {
    const folder = album.path.length > 0 ? await tree.resolvePath(root, album.path) : { cid: root, type: LinkType.Dir };
    if (folder && folder.type !== LinkType.Dir) throw new Error('A file already has that name.');
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
