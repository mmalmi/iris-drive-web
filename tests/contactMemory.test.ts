import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import { contactKey, contactMemory, rememberContact } from '../src/stores/contactMemory';
const viewer = 'a'.repeat(64), otherViewer = 'c'.repeat(64), contact = 'b'.repeat(64);
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
});
describe('shared private contact memory integration', () => {
  it('normalizes user IDs and persists initial names per viewing account', () => {
    expect(contactKey(nip19.npubEncode(contact))).toBe(contact);
    expect(contactKey('invalid')).toBe('');
    rememberContact(viewer, nip19.npubEncode(contact), 'Bob');
    rememberContact(viewer, contact, 'Robert');
    expect(contactMemory.get(viewer, contact)?.accepted_name).toBe('Bob');
    expect(contactMemory.get(otherViewer, contact)).toBeNull();
  });
  it('keeps favorites private and records only explicitly approved current names', () => {
    contactMemory.setFavorite(viewer, contact, true, 'Bob');
    expect(contactMemory.get(viewer, contact)?.favorite).toBe(true);
    expect(contactMemory.approve(viewer, contact, 'Robert', 'Bobby', 10)).toBe(false);
    expect(contactMemory.approve(viewer, contact, 'Robert', 'Robert', 11)).toBe(true);
    expect(contactMemory.get(viewer, contact)?.name_changes).toEqual([
      { previous_name: 'Bob', accepted_name: 'Robert', accepted_at_secs: 11 },
    ]);
    expect(contactMemory.get(viewer, contact)?.first_seen_name).toBe('Bob');
    contactMemory.setFavorite(viewer, contact, false, 'Robert');
    expect(contactMemory.get(viewer, contact)?.accepted_name).toBe('Robert');
  });
});
