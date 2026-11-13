import { describe, expect, it } from 'vitest';
import { recentDisplay, timeAgo } from '../src/lib/recentDisplay';
import type { AcceptedShareRecord } from '../src/drive/shareLibrary';

const ME = 'my-profile';
const shares = [{ share_id: 'trip-share', folder: { display_name: 'Trip' } }] as unknown as AcceptedShareRecord[];

describe('how recent items are shown', () => {
  it('calls my own Drive "My Drive", not by its internal name', () => {
    expect(recentDisplay({ type: 'tree', label: 'main', path: `/${ME}/main`, npub: ME, treeName: 'main' }, ME, shares))
      .toEqual({ name: 'My Drive', icon: 'i-lucide-hard-drive text-text-2' });
  });

  it('names a shared folder by its name', () => {
    expect(recentDisplay({ type: 'tree', label: 'main', path: '/trip-share/main', npub: 'trip-share', treeName: 'main' }, ME, shares).name)
      .toBe('Trip');
  });

  it('shows documents by title with their kind', () => {
    expect(recentDisplay({ type: 'dir', label: 'Budget.irissheet', path: `/${ME}/main/Budget.irissheet` }, ME, shares))
      .toEqual({ name: 'Budget', icon: 'i-lucide-table-2 text-success' });
  });

  it('says how long ago in plain words', () => {
    const now = Date.UTC(2026, 10, 14, 12);
    expect(timeAgo(now - 10_000, now)).toBe('Just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});
