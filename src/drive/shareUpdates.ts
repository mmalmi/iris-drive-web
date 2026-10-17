import type { Event } from 'nostr-tools';
import { acceptedShares } from './shareLibrary';
import { validateShareAccessUpdate } from './protocolShareSnapshotValidation';

export function applyShareAccessEvent(shareId: string, event: Event): boolean {
  if (!event.tags.some(([name, value]) => name === 'l' && value === 'iris-drive/share-access')) return false;
  acceptedShares.update((records) => records.map((record) => {
    if (record.share_id !== shareId) return record;
    try {
      const access = validateShareAccessUpdate(record.folder, event);
      if (access.updated_at <= (record.folder.access?.updated_at ?? 0)) return record;
      return { ...record, folder: { ...record.folder, access } };
    } catch {
      return record;
    }
  }));
  return true;
}
