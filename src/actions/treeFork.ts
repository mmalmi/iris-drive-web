import { toHex, type CID, type TreeVisibility } from '@hashtree/core';
import { useNostrStore } from '../nostr';
import { getTree } from '../store';
import { navigate } from '../utils/navigate';

export async function forkTree(
  dirCid: CID,
  name: string,
  visibility: TreeVisibility = 'public',
): Promise<{ success: boolean; linkKey?: string }> {
  if (!name) return { success: false };

  const { saveHashtree } = await import('../nostr');
  const { storeLinkKey } = await import('../stores/trees');
  const tree = getTree();

  const nostrState = useNostrStore.getState();
  if (!nostrState.npub || !nostrState.pubkey) return { success: false };

  const shouldReencryptFork = visibility !== 'public' && !dirCid.key;
  let finalCid = dirCid;

  if (shouldReencryptFork) {
    console.log('[Fork] Source is unencrypted, re-encrypting...');

    const rebuildWithEncryption = async (oldCid: CID): Promise<CID> => {
      if (oldCid.key) return oldCid;

      const isDir = await tree.isDirectory(oldCid);
      if (isDir) {
        const entries = await tree.listDirectory(oldCid);
        const newEntries = [];
        for (const entry of entries) {
          const newChildCid = await rebuildWithEncryption(entry.cid);
          newEntries.push({
            name: entry.name,
            cid: newChildCid,
            size: entry.size,
            type: entry.type ?? 0,
            meta: entry.meta,
          });
        }
        return (await tree.putDirectory(newEntries, {})).cid;
      }

      const data = await tree.readFile(oldCid);
      if (!data) return oldCid;
      return (await tree.putFile(data, {})).cid;
    };

    finalCid = await rebuildWithEncryption(finalCid);
    console.log('[Fork] Re-encryption complete');
  }

  useNostrStore.setSelectedTree({
    id: '',
    name,
    pubkey: nostrState.pubkey,
    rootHash: toHex(finalCid.hash),
    rootKey: finalCid.key ? toHex(finalCid.key) : undefined,
    visibility,
    created_at: Math.floor(Date.now() / 1000),
  });

  const result = await saveHashtree(name, finalCid, { visibility });

  if (result.linkKey) {
    storeLinkKey(nostrState.npub, name, result.linkKey);
  }

  if (result.success) {
    const linkKeyParam = result.linkKey ? `?k=${result.linkKey}` : '';
    navigate(`/${encodeURIComponent(nostrState.npub)}/${encodeURIComponent(name)}${linkKeyParam}`);
  }
  return result;
}
