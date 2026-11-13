import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  buildShareAddedNotices,
  readShareAddedNotice,
  SHARE_ADDED_LABEL,
  type ShareAddedNotice,
} from '../src/drive/shareJoinLink';

const owner = generateSecretKey();
const phone = generateSecretKey();
const laptop = generateSecretKey();
const stranger = generateSecretKey();
const notice: ShareAddedNotice = {
  v: 1,
  share_id: '123e4567-e89b-42d3-a456-426614174011',
  owner_profile_id: '123e4567-e89b-42d3-a456-426614174022',
  name: 'Tax papers 2026',
  role: 'editor',
};

describe('notices of a folder shared directly', () => {
  it('makes one notice per device that only that device can read', () => {
    const events = buildShareAddedNotices(owner, notice, [getPublicKey(phone), getPublicKey(laptop), getPublicKey(phone)], 1000);
    expect(events).toHaveLength(2);
    expect(readShareAddedNotice(events[0]!, phone)).toEqual(notice);
    expect(readShareAddedNotice(events[1]!, laptop)).toEqual(notice);
    // A notice for another device, or read with the wrong key, is ignored.
    expect(readShareAddedNotice(events[0]!, laptop)).toBeNull();
    expect(readShareAddedNotice(events[1]!, stranger)).toBeNull();
  });

  it('shows relays only a label, the device and an opaque name', () => {
    const [event] = buildShareAddedNotices(owner, notice, [getPublicKey(phone)], 1000);
    const published = JSON.stringify(event);
    expect(published).not.toContain(notice.share_id);
    expect(published).not.toContain(notice.owner_profile_id);
    expect(published).not.toContain('Tax papers');
    expect(event!.tags.map(([name]) => name).sort()).toEqual(['d', 'l', 'p']);
    expect(event!.tags).toContainEqual(['l', SHARE_ADDED_LABEL]);
    expect(event!.tags).toContainEqual(['p', getPublicKey(phone)]);
    expect(event!.tags.find(([name]) => name === 'd')![1]).toMatch(/^[0-9a-f]{64}$/);
    // The same folder and device keep the same name, so a newer notice replaces the older.
    const [again] = buildShareAddedNotices(owner, { ...notice, role: 'reader' }, [getPublicKey(phone)], 2000);
    expect(again!.tags.find(([name]) => name === 'd')).toEqual(event!.tags.find(([name]) => name === 'd'));
  });

  it('ignores plaintext, tampered and mislabelled notices', () => {
    const plaintext = finalizeEvent({
      kind: 30078,
      created_at: 1000,
      content: JSON.stringify(notice),
      tags: [['l', SHARE_ADDED_LABEL], ['p', getPublicKey(phone)]],
    }, owner);
    expect(readShareAddedNotice(plaintext, phone)).toBeNull();
    const [event] = buildShareAddedNotices(owner, notice, [getPublicKey(phone)], 1000);
    // As it would arrive from a relay: a fresh object with a changed field.
    expect(readShareAddedNotice(JSON.parse(JSON.stringify({ ...event!, created_at: 1001 })), phone)).toBeNull();
    const relabelled = finalizeEvent({ ...event!, tags: event!.tags.filter(([name]) => name !== 'l') }, owner);
    expect(readShareAddedNotice(relabelled, phone)).toBeNull();
  });
});
