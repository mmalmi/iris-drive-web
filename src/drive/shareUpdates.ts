import { get } from 'svelte/store';
import type { Event } from 'nostr-tools';
import { acceptedShares } from './shareLibrary';
import { validateShareAccessUpdate } from './protocolShareSnapshotValidation';

export function applyShareAccessEvent(shareId: string, event: Event): boolean {
  if (!event.tags.some(([name, value]) => name === 'l' && value === 'iris-drive/share-access')) return false;
  let changed = false;
  const records = get(acceptedShares).map((record) => {
    if (record.share_id !== shareId) return record;
    // A valid update is stamped with its event time, so an older or replayed
    // event can never apply and needs no signature check.
    if (event.created_at <= (record.folder.access?.updated_at ?? 0)) return record;
    try {
      const access = validateShareAccessUpdate(record.folder, event);
      if (access.updated_at <= (record.folder.access?.updated_at ?? 0)) return record;
      changed = true;
      return { ...record, folder: { ...record.folder, access } };
    } catch {
      return record;
    }
  });
  // The backfill replays access events already applied; only a newer one is a change.
  if (changed) acceptedShares.set(records);
  return true;
}
