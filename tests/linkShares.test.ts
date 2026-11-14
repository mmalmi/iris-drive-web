import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  buildLinkShareNotes,
  linkShareCovering,
  linkShareOf,
  linkShareUrl,
  linkTreeName,
  mergeLinkShares,
  readLinkShareNote,
  type LinkShare,
} from '../src/drive/linkShares';
import { describeItemAccess, itemAccess } from '../src/drive/itemAccess';

const ME = '11111111-1111-4111-8111-111111111111';
const NPUB = nip19.npubEncode(getPublicKey(generateSecretKey()));

function link(overrides: Partial<LinkShare> = {}): LinkShare {
  return { profile: ME, path: 'Trip', npub: NPUB, tree: 'Trip', key: 'ab'.repeat(33), access: 'link', at: 1000, ...overrides };
}

describe('items of My Drive shared by link', () => {
  it('keeps the latest decision about each link', () => {
    const on = link();
    const off = link({ access: 'off', at: 2000 });
    expect(mergeLinkShares([on], [off])).toEqual([off]);
    // An older note arriving late changes nothing.
    expect(mergeLinkShares([off], [on])).toEqual([off]);
    const other = link({ tree: 'Notes', path: 'Notes.irisdoc' });
    expect(mergeLinkShares([on], [other])).toEqual([on, other]);
  });

  it('covers what is inside a shared folder, nearest link first, and nothing once turned off', () => {
    const trip = link();
    const day = link({ path: 'Trip/Day 1', tree: 'Day 1', access: 'public' });
    expect(linkShareCovering(['Trip', 'plan.txt'], ME, [trip])).toBe(trip);
    expect(linkShareCovering(['Trip', 'Day 1', 'map.png'], ME, [trip, day])).toBe(day);
    expect(linkShareCovering(['Trips'], ME, [trip])).toBeNull();
    expect(linkShareCovering(['Trip'], 'someone-else', [trip])).toBeNull();
    expect(linkShareCovering(['Trip'], ME, [trip, link({ access: 'off', at: 2000 })])).toBeNull();
    expect(linkShareOf(['Trip'], ME, [trip, link({ access: 'off', at: 2000 })])?.access).toBe('off');
  });

  it('gives an address that opens a folder, or a document as itself, with the key only for a link', () => {
    expect(linkShareUrl(link())).toBe(`https://drive.iris.to/#/${NPUB}/Trip?k=${'ab'.repeat(33)}`);
    expect(linkShareUrl(link({ path: 'Plans/Notes.irisdoc', tree: 'Notes', access: 'public', key: '' })))
      .toBe(`https://drive.iris.to/#/${NPUB}/Notes/Notes.irisdoc`);
  });

  it('names a new link after the item, without taking a name in use', () => {
    expect(linkTreeName(['Plans', 'Budget.irissheet'], NPUB, [])).toBe('Budget');
    expect(linkTreeName(['Trip'], NPUB, [link({ path: 'Old/Trip' })])).toBe('Trip (2)');
    expect(linkTreeName(['Trip'], NPUB, [link()])).toBe('Trip');
    expect(linkTreeName(['public'], NPUB, [])).toBe('public (2)');
  });

  it('tells the account’s other devices, and only they can read it', () => {
    const sender = generateSecretKey();
    const receiver = generateSecretKey();
    const stranger = generateSecretKey();
    const devices = new Set([getPublicKey(sender), getPublicKey(receiver)]);
    const record = link();
    const [note] = buildLinkShareNotes(sender, record, [getPublicKey(receiver)], 100);
    expect(note!.content).not.toContain('Trip');
    expect(readLinkShareNote(note!, receiver, { profile: ME, devices })).toEqual(record);
    expect(readLinkShareNote(note!, stranger, { profile: ME, devices })).toBeNull();
    // From a device outside the account, or about another account, it is not taken in.
    expect(readLinkShareNote(note!, receiver, { profile: ME, devices: new Set([getPublicKey(receiver)]) })).toBeNull();
    expect(readLinkShareNote(note!, receiver, { profile: 'another-profile', devices })).toBeNull();
  });

  it('is what the badge says, beside invite-only sharing', () => {
    const mine = { scope: ME, treeName: 'main', profileId: ME, records: [] };
    expect(itemAccess({ ...mine, path: ['Trip', 'plan.txt'], linkShares: [link()] })).toEqual({ kind: 'link', people: 0 });
    expect(itemAccess({ ...mine, path: ['Trip'], linkShares: [link({ access: 'public' })] })).toEqual({ kind: 'public' });
    expect(itemAccess({ ...mine, path: ['Trip'], linkShares: [link({ access: 'off' })] })).toEqual({ kind: 'private' });
    expect(describeItemAccess({ kind: 'link', people: 0 })).toMatchObject({ label: 'Anyone with the link', detail: 'Anyone with the link can view this' });
  });
});
