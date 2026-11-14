import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  buildLinkShareNotes,
  buildShareLinkNotes,
  canSetLinkAccess,
  linkShareCovering,
  linkShareOf,
  linkShareUrl,
  linkSource,
  linkSubjectAt,
  linkTargetAt,
  linkTreeName,
  mergeLinkShares,
  readLinkShareNote,
  readShareLinkNote,
  type LinkShare,
} from '../src/drive/linkShares';
import { describeItemAccess, itemAccess } from '../src/drive/itemAccess';
import { addShareRecipients, createSharedFolder } from '../src/drive/shareAdmin';
import type { AcceptedShareRecord } from '../src/drive/shareLibrary';

const ME = '11111111-1111-4111-8111-111111111111';
const GUEST = '44444444-4444-4444-8444-444444444444';
const SHARE = '22222222-2222-4222-8222-222222222222';
const NPUB = nip19.npubEncode(getPublicKey(generateSecretKey()));

function link(overrides: Partial<LinkShare> = {}): LinkShare {
  return { profile: ME, path: 'Trip', npub: NPUB, tree: 'Trip', key: 'ab'.repeat(33), access: 'link', at: 1000, ...overrides };
}

/** A folder `source` of my Drive, shared with people. */
function shared(source: string, overrides: Partial<AcceptedShareRecord> & { owner?: string } = {}): AcceptedShareRecord {
  return {
    share_id: SHARE,
    local_profile_id: ME,
    accepted_at: 1,
    invite_payload: '',
    shortcuts: [],
    folder: { owner_profile_id: overrides.owner ?? ME, source_path: source, display_name: 'Trip' } as AcceptedShareRecord['folder'],
    ...overrides,
  };
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

  it('gives an address that opens a folder, or a document or a file as itself, with the key only for a link', () => {
    expect(linkShareUrl(link())).toBe(`https://drive.iris.to/#/${NPUB}/Trip?k=${'ab'.repeat(33)}`);
    expect(linkShareUrl(link({ path: 'Plans/Notes.irisdoc', tree: 'Notes', access: 'public', key: '' })))
      .toBe(`https://drive.iris.to/#/${NPUB}/Notes/Notes.irisdoc`);
    expect(linkShareUrl(link({ path: 'Trip/plan 1.txt', tree: 'plan 1.txt', file: true, access: 'public', key: '' })))
      .toBe(`https://drive.iris.to/#/${NPUB}/plan%201.txt/plan%201.txt`);
    // Something inside a linked folder, through the folder's link.
    expect(linkShareUrl(link(), 'https://drive.iris.to', ['Day 1', 'map.png']))
      .toBe(`https://drive.iris.to/#/${NPUB}/Trip/Day%201/map.png?k=${'ab'.repeat(33)}`);
  });

  it('names a new link after the item, without taking a name in use', () => {
    expect(linkTreeName({ path: ['Plans', 'Budget.irissheet'] }, NPUB, [])).toBe('Budget');
    expect(linkTreeName({ path: ['Trip'] }, NPUB, [link({ path: 'Old/Trip' })])).toBe('Trip (2)');
    expect(linkTreeName({ path: ['Trip'] }, NPUB, [link()])).toBe('Trip');
    expect(linkTreeName({ path: ['public'] }, NPUB, [])).toBe('public (2)');
    expect(linkTreeName({ path: ['plan.txt'] }, NPUB, [])).toBe('plan.txt');
    // A whole shared folder is named after the folder.
    expect(linkTreeName({ path: [], share: SHARE }, NPUB, [], 'Team')).toBe('Team');
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
    expect(itemAccess({ ...mine, path: ['Trip', 'plan.txt'], linkShares: [link()] })).toEqual({ kind: 'link' });
    expect(itemAccess({ ...mine, path: ['Trip'], linkShares: [link({ access: 'public' })] })).toEqual({ kind: 'public' });
    expect(itemAccess({ ...mine, path: ['Trip'], linkShares: [link({ access: 'off' })] })).toEqual({ kind: 'private' });
    expect(describeItemAccess({ kind: 'link' })).toMatchObject({ label: 'Anyone with the link', detail: 'Anyone with the link can view this' });
  });
});

describe('items shared with people that also open by link', () => {
  it('keeps naming an item by its place in My Drive once it is shared, so its link stays', () => {
    const records = [shared('Trip')];
    expect(linkSubjectAt({ scope: ME, path: ['Trip'] }, ME, records)).toEqual({ path: ['Trip'] });
    // Opened inside the shared folder, the folder and what is in it are still their places in My Drive.
    expect(linkSubjectAt({ scope: SHARE, path: [] }, ME, records)).toEqual({ path: ['Trip'] });
    expect(linkSubjectAt({ scope: SHARE, path: ['plan.txt'] }, ME, records)).toEqual({ path: ['Trip', 'plan.txt'] });
    // A shared document is in its shared folder under its own name.
    const doc = [shared('Plans/Notes.irisdoc')];
    expect(linkSubjectAt({ scope: SHARE, path: ['Notes.irisdoc'] }, ME, doc)).toEqual({ path: ['Plans', 'Notes.irisdoc'] });
    expect(linkSubjectAt({ scope: SHARE, path: ['beside.txt'] }, ME, doc)).toEqual({ path: ['beside.txt'], share: SHARE });
    // A folder someone else shared is named by the folder.
    const theirs = [shared('Their Trip', { owner: GUEST })];
    expect(linkSubjectAt({ scope: SHARE, path: [] }, ME, theirs)).toEqual({ path: [], share: SHARE });
    expect(linkSubjectAt({ scope: 'elsewhere', path: ['a'] }, ME, theirs)).toBeNull();
    expect(linkSubjectAt({ scope: ME, path: [] }, ME, [])).toBeNull();
  });

  it('publishes the newest version from the shared folder, whoever changed it', () => {
    const records = [shared('Trip')];
    expect(linkSource(link(), records)).toEqual({ scope: SHARE, path: [] });
    expect(linkSource(link({ path: 'Trip/Day 1' }), records)).toEqual({ scope: SHARE, path: ['Day 1'] });
    expect(linkSource(link({ path: 'Plans/Notes.irisdoc' }), [shared('Plans/Notes.irisdoc')])).toEqual({ scope: SHARE, path: ['Notes.irisdoc'] });
    // Until it is shared with people, from My Drive.
    expect(linkSource(link(), [])).toEqual({ scope: ME, path: ['Trip'] });
    expect(linkSource(link({ share: SHARE, path: '' }), [])).toEqual({ scope: SHARE, path: [] });
  });

  it('finds a whole shared folder’s link, and what it covers', () => {
    const whole = link({ share: SHARE, path: '', profile: GUEST, key: '' });
    expect(linkShareCovering(['Day 1', 'map.png'], ME, [whole], SHARE)).toBe(whole);
    expect(linkShareCovering([], ME, [whole], SHARE)).toBe(whole);
    // Not the same as a path of My Drive.
    expect(linkShareCovering(['Day 1'], ME, [whole])).toBeNull();
    expect(linkShareOf([], ME, [link()], SHARE)).toBeNull();
  });

  it('says the link is the wider access, and the tooltip names both', () => {
    const records = [shared('Trip', { join_links: [{ v: 1, share_id: SHARE, owner_profile_id: ME, admin: 'a', name: 'Trip', role: 'editor', key: 'k' }] })];
    const owner = { treeName: 'main', profileId: ME, records, linkShares: [link()] };
    const inMyDrive = itemAccess({ ...owner, scope: ME, path: ['Trip'] });
    expect(inMyDrive).toEqual({ kind: 'link', shared: { people: 0, invite: true } });
    // The owner works inside the shared folder: the same answer there.
    expect(itemAccess({ ...owner, scope: SHARE, path: ['plan.txt'] })).toEqual(inMyDrive);
    expect(describeItemAccess(inMyDrive!)).toEqual({
      label: 'Anyone with the link',
      detail: 'Anyone with the link can view this. Shared with people, nobody has joined yet. People with the invite link can join',
      icon: 'i-lucide-link',
    });
    expect(describeItemAccess({ kind: 'public', shared: { people: 2 } }).detail).toBe('Anyone can find and open this. Shared with 2 people');
    // Turned off, it is shared with people again, and nothing more.
    expect(itemAccess({ ...owner, linkShares: [link({ access: 'off' })], scope: SHARE, path: [] })?.kind).toBe('people');
    // Someone the folder is shared with sees what its admin told them.
    const guestView = { treeName: 'main', profileId: ME, records: [shared('Theirs', { owner: GUEST })] };
    expect(itemAccess({ ...guestView, scope: SHARE, path: ['a.txt'], linkShares: [link({ share: SHARE, path: '', profile: GUEST, key: '' })] }))
      .toEqual({ kind: 'link', shared: { people: 0 } });
    expect(itemAccess({ ...guestView, scope: SHARE, path: ['a.txt'], linkShares: [] })?.kind).toBe('people');
  });

  it('offers General access for a single file, in My Drive and in a shared folder', () => {
    const records = [shared('Trip', { owner: GUEST })];
    expect(linkTargetAt({ scope: ME, treeName: 'main', path: ['plan.txt'], profileId: ME, records })).toEqual({ scope: ME, path: ['plan.txt'] });
    expect(linkTargetAt({ scope: SHARE, treeName: 'main', path: ['plan.txt'], profileId: ME, records })).toEqual({ scope: SHARE, path: ['plan.txt'] });
    expect(linkTargetAt({ scope: 'npub1someone', treeName: 'main', path: ['plan.txt'], profileId: ME, records })).toBeNull();
    expect(linkTargetAt({ scope: ME, treeName: 'photos', path: ['plan.txt'], profileId: ME, records })).toBeNull();
    expect(linkTargetAt({ scope: ME, treeName: 'main', path: ['plan.txt'], profileId: null, records })).toBeNull();
  });

  it('tells the people a folder is shared with that it opens by link, never the key, and only from an admin', () => {
    const ownerSecret = generateSecretKey();
    const guestSecret = generateSecretKey();
    const strangerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const guestPubkey = getPublicKey(guestSecret);
    let folder = createSharedFolder({
      signerSecretKey: ownerSecret, ownerProfileId: ME, ownerDevices: [{ pubkey: ownerPubkey }],
      sourcePath: 'Trip', displayName: 'Trip', createdAt: 100,
    });
    folder = addShareRecipients(folder, ownerSecret, [{ profile_id: GUEST, app_pubkey: guestPubkey, role: 'editor', display_name: 'Guest' }], 110);
    const theirRecord = shared('Trip', { share_id: folder.share_id, local_profile_id: GUEST, folder });
    const record = link({ npub: nip19.npubEncode(ownerPubkey) });

    const [note] = buildShareLinkNotes(ownerSecret, record, { share: folder.share_id, inner: [] }, [guestPubkey], 120);
    expect(note!.content).not.toContain(record.key);
    expect(readShareLinkNote(note!, guestSecret, GUEST, [theirRecord])).toEqual({
      ...record, share: folder.share_id, path: '', key: '',
    });
    // Not for a folder they are not in.
    expect(readShareLinkNote(note!, guestSecret, GUEST, [])).toBeNull();
    // An editor cannot say so, and a note naming another device's link is not taken in.
    const [fromGuest] = buildShareLinkNotes(guestSecret, link({ npub: nip19.npubEncode(guestPubkey) }), { share: folder.share_id, inner: [] }, [ownerPubkey], 120);
    const ownerRecord = shared('Trip', { share_id: folder.share_id, folder });
    expect(readShareLinkNote(fromGuest!, ownerSecret, ME, [ownerRecord])).toBeNull();
    const [forged] = buildShareLinkNotes(ownerSecret, link({ npub: nip19.npubEncode(getPublicKey(strangerSecret)) }), { share: folder.share_id, inner: [] }, [guestPubkey], 120);
    expect(readShareLinkNote(forged!, guestSecret, GUEST, [theirRecord])).toBeNull();

    // Only an admin's device can change it; the owner's own Drive always can.
    expect(canSetLinkAccess({ scope: folder.share_id, path: [] }, ME, ownerPubkey, [ownerRecord])).toBe(true);
    expect(canSetLinkAccess({ scope: folder.share_id, path: [] }, GUEST, guestPubkey, [theirRecord])).toBe(false);
    expect(canSetLinkAccess({ scope: ME, path: ['plan.txt'] }, ME, ownerPubkey, [])).toBe(true);
  });
});
