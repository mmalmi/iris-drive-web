import { acceptedShares, upsertAcceptedShare } from './shareLibrary';
import { writable } from 'svelte/store';
import {
  fetchNativeShareState,
  type NativeShareActionResult,
  type NativeSharedFolderView,
} from './nativeShareActions';

export const nativeShares = writable<NativeSharedFolderView[]>([]);

export function applyNativeShareActionResult(
  result: NativeShareActionResult,
): NativeShareActionResult {
  nativeShares.set(result.shares);
  if (result.local_profile_id && result.shared_folders) {
    const profile = result.local_profile_id;
    acceptedShares.update((records) => result.shared_folders!.reduce((next, folder) => upsertAcceptedShare(next, {
      share_id: folder.share_id, local_profile_id: profile, accepted_at: Math.floor(Date.now() / 1000),
      invite_payload: '', folder, shortcuts: [],
    }), records.filter((record) => record.local_profile_id !== profile
      || result.shared_folders!.some((folder) => folder.share_id === record.share_id))));
  }
  return result;
}

export async function refreshNativeShareState(
  fetchState = fetchNativeShareState,
): Promise<NativeShareActionResult> {
  return applyNativeShareActionResult(await fetchState());
}
