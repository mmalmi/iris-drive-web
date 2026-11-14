import { describe, expect, it } from 'vitest';
import { LinkType } from '@hashtree/core';
import { formatModified, modifiedAt, withModifiedAt } from '../src/lib/modifiedAt';

const cid = { hash: new Uint8Array(32) };
const at = (date: Date) => Math.floor(date.getTime() / 1000);

describe('when an item last changed', () => {
  it('is read from the entry, in seconds as the native app writes it, and nothing for old entries', () => {
    expect(modifiedAt({ name: 'a', cid, size: 1, type: LinkType.Blob, meta: { modified_at: 1_760_000_000 } })).toBe(1_760_000_000);
    expect(modifiedAt({ name: 'a', cid, size: 1, type: LinkType.Blob })).toBeNull();
    expect(modifiedAt({ name: 'a', cid, size: 1, type: LinkType.Blob, meta: { modified_at: 0 } })).toBeNull();
    expect(modifiedAt({ name: 'a', cid, size: 1, type: LinkType.Blob, meta: { modified_at: '1760000000' } })).toBeNull();
  });

  it('is stamped on a write, keeping what else the entry says about itself', () => {
    const now = new Date('2026-11-14T10:42:30Z');
    expect(withModifiedAt({ whole_file_hash: 'ab' }, now)).toEqual({ whole_file_hash: 'ab', modified_at: at(now) });
    expect(withModifiedAt(undefined, now)).toEqual({ modified_at: at(now) });
  });

  it('is shown as Google Drive shows it: the time today, the day this year, the date before', () => {
    const now = new Date(2026, 10, 14, 15, 0);
    const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(2026, 10, 14, 10, 42));
    expect(formatModified(at(new Date(2026, 10, 14, 10, 42)), now, 'en-US')).toBe(time);
    expect(formatModified(at(new Date(2026, 10, 12, 9, 0)), now, 'en-US')).toBe('Nov 12');
    expect(formatModified(at(new Date(2025, 10, 12, 9, 0)), now, 'en-US')).toBe('Nov 12, 2025');
  });
});
