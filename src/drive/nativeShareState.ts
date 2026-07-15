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
  return result;
}

export async function refreshNativeShareState(
  fetchState = fetchNativeShareState,
): Promise<NativeShareActionResult> {
  return applyNativeShareActionResult(await fetchState());
}
