import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, nip44, finalizeEvent, type Event } from 'nostr-tools';
import * as Y from 'yjs';
import { encodeAwarenessUpdate, Awareness } from 'y-protocols/awareness';
import {
  LIVE_KIND,
  LIVE_MESSAGE_KIND,
  LiveChannel,
  readAwarenessUpdate,
  writeAwarenessUpdate,
  type LiveIdentity,
  type LiveTransport,
} from '../src/lib/yjs/liveChannel';
import { deriveLiveKey, secretId, type LiveKey, type LivePlace } from '../src/lib/yjs/liveKeys';
import { LivePresence, presenceColor, type PresenceUser } from '../src/lib/yjs/presence.svelte';
import { accountLiveAccess, driveLiveAccess, shareLiveAccess } from '../src/lib/yjs/liveAccess';
import { fipsLiveTransport, resetLiveFipsService, type LiveFipsNode } from '../src/lib/yjs/liveTransports';
import { DocumentSession, LIVE_ORIGIN } from '../src/lib/yjs/documentStore';
import { addShareRecipients, createSharedFolder, revokeShareMember } from '../src/drive/shareAdmin';
import { signNostrIdentityRosterOp } from '../src/drive/protocol';

const PLACE: LivePlace = { scope: '123e4567-e89b-42d3-a456-426614174301', treeName: 'main', path: ['Plans', 'Budget.irisdoc'] };
const encoder = new TextEncoder();

function keyFor(secret: string, epoch = 1, place = PLACE): LiveKey {
  const bytes = encoder.encode(secret);
  return deriveLiveKey('share', bytes, secretId('share', epoch, bytes), place);
}

/** Relays, as far as live messages need them: whatever is sent reaches every listener of its topic. */
class Bus {
  readonly sent: Event[] = [];
  private readonly listeners = new Set<{ topics: string[]; receive: (event: Event) => void }>();
  dropping = false;

  transport(): LiveTransport {
    return {
      listen: (topics, receive) => {
        const listener = { topics, receive };
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      send: (event) => {
        this.sent.push(event);
        if (this.dropping) return;
        const topic = event.tags.find(tag => tag[0] === 'd')?.[1] ?? '';
        for (const listener of [...this.listeners]) {
          if (listener.topics.includes(topic)) queueMicrotask(() => listener.receive(structuredClone(event)));
        }
      },
    };
  }
}

interface Member {
  secret: Uint8Array;
  key: string;
  ydoc: Y.Doc;
  presence: LivePresence;
  channel: LiveChannel;
}

function user(key: string, name: string): PresenceUser {
  return { name, key, id: key, color: presenceColor(key) };
}

/** The access list everyone in a test reads: device key to the person it belongs to. */
class AccessList {
  readonly devices = new Map<string, LiveIdentity>();
  add(key: string, name: string, canEdit = true): void {
    this.devices.set(key, { id: `profile-of-${name}`, name, npub: null, canEdit });
  }
  identify = (key: string): LiveIdentity | null => this.devices.get(key) ?? null;
}

function member(bus: Bus, name: string, options: { canEdit?: boolean; access?: AccessList; listed?: boolean; claims?: string } = {}): Member {
  const secret = generateSecretKey();
  const key = getPublicKey(secret);
  const access = options.access ?? defaultAccess;
  if (options.listed !== false) access.add(key, name, options.canEdit ?? true);
  const ydoc = new Y.Doc();
  // What it says about itself in its awareness state; receivers go by the access list.
  const presence = new LivePresence(ydoc, user(key, options.claims ?? name));
  const channel = new LiveChannel({
    ydoc,
    presence,
    transports: [bus.transport()],
    deviceSecretKey: secret,
    canEdit: () => options.canEdit ?? true,
    identify: access.identify,
  });
  return { secret, key, ydoc, presence, channel };
}

let defaultAccess = new AccessList();

/** A message as a member could make it by hand: an inner event signed by `signer`, sent under a fresh session key. */
function forge(bus: Bus, key: LiveKey, signer: Uint8Array, body: Record<string, string>, options: { client?: number; createdAt?: number; topic?: string } = {}): Event {
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  const message = finalizeEvent({
    kind: LIVE_MESSAGE_KIND,
    created_at: createdAt,
    tags: [['d', options.topic ?? key.topic], ['c', String(options.client ?? 7)], ['n', String(Date.now())]],
    content: JSON.stringify(body),
  }, signer);
  const event = finalizeEvent({
    kind: LIVE_KIND, created_at: createdAt, tags: [['d', key.topic]],
    content: nip44.v2.encrypt(JSON.stringify(message), key.key),
  }, generateSecretKey());
  bus.transport().send(event);
  return event;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** A Yjs update that writes `words`, from a document of its own. */
function updateWith(words: string): Uint8Array {
  const ydoc = new Y.Doc();
  ydoc.getText('body').insert(0, words);
  return Y.encodeStateAsUpdate(ydoc);
}

const text = (who: Member) => who.ydoc.getText('body').toString();

beforeEach(() => {
  vi.useFakeTimers();
  defaultAccess = new AccessList();
});

afterEach(() => {
  vi.useRealTimers();
  resetLiveFipsService();
});

describe('live keys', () => {
  it('derives the same key and topic for everyone with the same secret and document', () => {
    expect(keyFor('epoch secret')).toEqual(keyFor('epoch secret'));
  });

  it('gives each document, secret and epoch a topic of its own', () => {
    const topics = new Set([
      keyFor('epoch secret').topic,
      keyFor('another secret').topic,
      keyFor('epoch secret', 1, { ...PLACE, path: ['Plans', 'Other.irisdoc'] }).topic,
      keyFor('epoch secret', 1, { ...PLACE, scope: '123e4567-e89b-42d3-a456-426614174302' }).topic,
      deriveLiveKey('drive', encoder.encode('epoch secret'), 'x', PLACE).topic,
    ]);
    expect(topics.size).toBe(5);
    expect(keyFor('a', 1).id).not.toBe(keyFor('b', 1).id);
  });

  it('makes topics that say nothing about the document or the key', () => {
    const { key, topic } = keyFor('epoch secret');
    expect(topic).toMatch(/^[0-9a-f]{64}$/);
    for (const part of [PLACE.scope, PLACE.treeName, ...PLACE.path, 'Budget']) expect(topic).not.toContain(part);
    expect(topic).not.toContain(Buffer.from(key).toString('hex'));
    expect(key).toHaveLength(32);
  });
});

describe('live channel', () => {
  it('shows who else is in the document, as the access list names them', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const bob = member(bus, 'Bob');
    const key = keyFor('s');
    alice.channel.setKeys([key]);
    bob.channel.setKeys([key]);
    await vi.advanceTimersByTimeAsync(300);
    expect(bob.presence.peers.map(peer => [peer.name, peer.key, peer.id])).toEqual([['Alice', alice.key, 'profile-of-Alice']]);
    expect(alice.presence.peers.map(peer => peer.name)).toEqual(['Bob']);

    alice.presence.set('sheet', { id: 's1', a: ['r1', 'c1'], f: ['r1', 'c1'] });
    await vi.advanceTimersByTimeAsync(300);
    expect(bob.presence.others[0]?.sheet).toEqual({ id: 's1', a: ['r1', 'c1'], f: ['r1', 'c1'] });
  });

  it('sends nothing relays could read: an ephemeral kind, a one-time key, the topic and an expiry', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice Secretname');
    const key = keyFor('s');
    alice.channel.setKeys([key]);
    alice.ydoc.getText('body').insert(0, 'confidential words');
    await vi.advanceTimersByTimeAsync(300);
    expect(bus.sent.length).toBeGreaterThan(1);
    for (const event of bus.sent) {
      expect(event.kind).toBe(LIVE_KIND);
      expect(event.kind).toBeGreaterThanOrEqual(20000);
      expect(event.kind).toBeLessThan(30000);
      expect(event.pubkey).not.toBe(alice.key);
      expect(event.tags.map(tag => tag[0])).toEqual(['d', 'expiration']);
      expect(event.tags[0]![1]).toBe(key.topic);
      const raw = JSON.stringify(event);
      for (const secret of ['confidential', 'Secretname', 'Alice', alice.key, PLACE.scope, 'Budget']) expect(raw).not.toContain(secret);
    }
    expect(new Set(bus.sent.map(event => event.pubkey)).size).toBe(1);
  });

  it('signs every message with the device key, for this topic and this moment', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const key = keyFor('s');
    alice.channel.setKeys([key]);
    alice.ydoc.getText('body').insert(0, 'hi');
    await vi.advanceTimersByTimeAsync(300);
    const sequences: number[] = [];
    for (const event of bus.sent) {
      const message = JSON.parse(nip44.v2.decrypt(event.content, key.key)) as Event;
      expect(message.kind).toBe(LIVE_MESSAGE_KIND);
      expect(message.pubkey).toBe(alice.key);
      expect(message.tags.find(tag => tag[0] === 'd')?.[1]).toBe(key.topic);
      expect(message.tags.find(tag => tag[0] === 'c')?.[1]).toBe(String(alice.ydoc.clientID));
      sequences.push(Number(message.tags.find(tag => tag[0] === 'n')?.[1]));
    }
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('brings an edit to the others at once, and the files bring it again without harm', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const bob = member(bus, 'Bob');
    const key = keyFor('s');
    alice.channel.setKeys([key]);
    bob.channel.setKeys([key]);
    await vi.advanceTimersByTimeAsync(300);
    const origins: unknown[] = [];
    bob.ydoc.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));
    alice.ydoc.getText('body').insert(0, 'Hello');
    alice.ydoc.getText('body').insert(5, ' there');
    await vi.advanceTimersByTimeAsync(100);
    expect(text(bob)).toBe('Hello there');
    expect(origins).toEqual([LIVE_ORIGIN]);
    // The same edit arriving again from storage changes nothing.
    Y.applyUpdate(bob.ydoc, Y.encodeStateAsUpdate(alice.ydoc), 'stored');
    expect(text(bob)).toBe('Hello there');
  });

  it('takes edits only from devices that may edit, and nothing from devices not on the list', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const reader = member(bus, 'Reader', { canEdit: false });
    const stranger = member(bus, 'Stranger', { listed: false });
    const key = keyFor('s');
    for (const who of [alice, reader, stranger]) who.channel.setKeys([key]);
    await vi.advanceTimersByTimeAsync(300);
    // A reader's copy that sends edits anyway, and a stranger who has the key.
    forge(bus, key, reader.secret, { u: b64(updateWith('from a reader')) }, { client: reader.ydoc.clientID });
    stranger.ydoc.getText('body').insert(0, 'from a stranger');
    await vi.advanceTimersByTimeAsync(300);
    expect(text(alice)).toBe('');
    expect(alice.presence.peers.map(peer => peer.name)).toEqual(['Reader']);
  });

  it('sends no edits of someone who may only read', async () => {
    const bus = new Bus();
    const reader = member(bus, 'Reader', { canEdit: false });
    reader.channel.setKeys([keyFor('s')]);
    await vi.advanceTimersByTimeAsync(300);
    const before = bus.sent.length;
    reader.ydoc.getText('body').insert(0, 'sorted my own copy');
    await vi.advanceTimersByTimeAsync(300);
    expect(bus.sent.length).toBe(before);
  });

  it('shows a member under their own name whatever name their messages claim', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const bob = member(bus, 'Bob');
    const mallory = member(bus, 'Mallory', { claims: 'Alice' });
    const key = keyFor('s');
    for (const who of [alice, bob, mallory]) who.channel.setKeys([key]);
    await vi.advanceTimersByTimeAsync(300);
    const names = bob.presence.others.map(state => [state.user.name, state.user.key]).sort();
    expect(names).toEqual([['Alice', alice.key], ['Mallory', mallory.key]].sort());
    // Even its user field, as editors read it, is the access list's.
    const shown = bob.presence.awareness.getStates().get(mallory.ydoc.clientID)?.user as PresenceUser;
    expect(shown.name).toBe('Mallory');
    expect(shown.id).toBe('profile-of-Mallory');
  });

  it('lets no member speak as another member or another device', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const bob = member(bus, 'Bob');
    const mallory = member(bus, 'Mallory');
    const key = keyFor('s');
    for (const who of [alice, bob]) who.channel.setKeys([key]);
    await vi.advanceTimersByTimeAsync(300);

    // Signed by Mallory but claiming Alice's device: the signature does not hold.
    const message = finalizeEvent({
      kind: LIVE_MESSAGE_KIND, created_at: Math.floor(Date.now() / 1000),
      tags: [['d', key.topic], ['c', '99'], ['n', '1']], content: JSON.stringify({ u: b64(updateWith('as Alice')) }),
    }, mallory.secret);
    bus.transport().send(finalizeEvent({
      kind: LIVE_KIND, created_at: message.created_at, tags: [['d', key.topic]],
      content: nip44.v2.encrypt(JSON.stringify({ ...message, pubkey: alice.key }), key.key),
    }, generateSecretKey()));
    // Signed by Mallory, speaking for Alice's awareness client: that client is Alice's.
    const forged = new Awareness(new Y.Doc());
    forged.setLocalState({ user: user(alice.key, 'Alice'), cursor: 'somewhere else' });
    const aliceUpdate = writeAwarenessUpdate([{ client: alice.ydoc.clientID, clock: 99, state: { user: user(alice.key, 'Alice'), cursor: 'somewhere else' } }]);
    forge(bus, key, mallory.secret, { a: b64(aliceUpdate) }, { client: alice.ydoc.clientID });
    // Signed by Mallory, for Mallory's client, but holding another client's state.
    forge(bus, key, mallory.secret, { a: b64(encodeAwarenessUpdate(forged, [forged.clientID])) }, { client: mallory.ydoc.clientID });
    await vi.advanceTimersByTimeAsync(300);

    expect(text(bob)).toBe('');
    expect(bob.presence.awareness.getStates().get(alice.ydoc.clientID)?.cursor).toBeUndefined();
    expect(bob.presence.awareness.getStates().has(forged.clientID)).toBe(false);
    expect(bob.presence.others.map(state => state.user.name)).toEqual(['Alice']);
    forged.destroy();
  });

  it('takes a message once, only for its own document, and only while it is new', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const bob = member(bus, 'Bob');
    const key = keyFor('s');
    const elsewhere = keyFor('s', 1, { ...PLACE, path: ['Plans', 'Other.irisdoc'] });
    alice.channel.setKeys([key]);
    await vi.advanceTimersByTimeAsync(300);
    const seen: unknown[] = [];
    alice.ydoc.on('update', (_update: Uint8Array, origin: unknown) => seen.push(origin));

    // Bob's message, taken once and refused when sent again.
    const original = forge(bus, key, bob.secret, { u: b64(updateWith('once')) }, { client: bob.ydoc.clientID });
    await vi.advanceTimersByTimeAsync(50);
    bus.transport().send(structuredClone(original));
    await vi.advanceTimersByTimeAsync(50);
    expect(seen).toHaveLength(1);

    // Bob's message for another document, moved into this one.
    const other = JSON.parse(nip44.v2.decrypt(forge(bus, elsewhere, bob.secret, { u: b64(updateWith('moved')) }).content, elsewhere.key)) as Event;
    bus.transport().send(finalizeEvent({
      kind: LIVE_KIND, created_at: other.created_at, tags: [['d', key.topic]],
      content: nip44.v2.encrypt(JSON.stringify(other), key.key),
    }, generateSecretKey()));
    // Bob's message from an hour ago.
    forge(bus, key, bob.secret, { u: b64(updateWith('old')) }, { createdAt: Math.floor(Date.now() / 1000) - 3600 });
    await vi.advanceTimersByTimeAsync(300);
    expect(text(alice)).toBe('once');
  });

  it('does not show this device to itself, as an earlier page of it before a reload', async () => {
    const bus = new Bus();
    const before = member(bus, 'Alice');
    const key = keyFor('s');
    before.channel.setKeys([key]);
    before.presence.set('cursor', 'somewhere');
    // The page is loaded again: same device key, another awareness client.
    const ydoc = new Y.Doc();
    const presence = new LivePresence(ydoc, user(before.key, 'Alice'));
    const after = new LiveChannel({
      ydoc, presence, transports: [bus.transport()], deviceSecretKey: before.secret,
      canEdit: () => true, identify: defaultAccess.identify,
    });
    after.setKeys([key]);
    before.ydoc.getText('body').insert(0, 'before the reload');
    await vi.advanceTimersByTimeAsync(3000);
    expect([...presence.awareness.getStates().keys()]).toEqual([ydoc.clientID]);
    expect(ydoc.getText('body').toString()).toBe('');
    after.destroy();
  });

  it('sends nothing without a network, and asks for what it missed once back', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    let online = true;
    const ydoc = new Y.Doc();
    const bobSecret = generateSecretKey();
    const presence = new LivePresence(ydoc, user(getPublicKey(bobSecret), 'Bob'));
    defaultAccess.add(getPublicKey(bobSecret), 'Bob');
    const bob = new LiveChannel({
      ydoc, presence, transports: [bus.transport()], deviceSecretKey: bobSecret,
      canEdit: () => true, identify: defaultAccess.identify, online: () => online,
    });
    const key = keyFor('s');
    alice.channel.setKeys([key]);
    bob.setKeys([key]);
    await vi.advanceTimersByTimeAsync(300);
    online = false;
    const sent = bus.sent.length;
    ydoc.getText('body').insert(0, 'written offline');
    alice.ydoc.getText('body').insert(0, 'meanwhile ');
    await vi.advanceTimersByTimeAsync(5000);
    const senders = bus.sent.slice(sent).map(event => (JSON.parse(nip44.v2.decrypt(event.content, key.key)) as Event).pubkey);
    expect(senders).toContain(alice.key);
    expect(senders).not.toContain(getPublicKey(bobSecret));
    expect(text(alice)).toBe('meanwhile ');
    online = true;
    bob.resume();
    await vi.advanceTimersByTimeAsync(500);
    // Alice answers what Bob asked; Bob's own edit reaches her with the files.
    expect(ydoc.getText('body').toString()).toContain('meanwhile');
    bob.destroy();
  });

  it('takes someone away when they leave, and when they go quiet', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const bob = member(bus, 'Bob');
    const carol = member(bus, 'Carol');
    const key = keyFor('s');
    for (const who of [alice, bob, carol]) who.channel.setKeys([key]);
    await vi.advanceTimersByTimeAsync(300);
    expect(alice.presence.peers.map(peer => peer.name).sort()).toEqual(['Bob', 'Carol']);

    bob.channel.destroy();
    await vi.advanceTimersByTimeAsync(50);
    expect(alice.presence.peers.map(peer => peer.name)).toEqual(['Carol']);

    // Carol's tab is closed without a word: she goes after some seconds of silence.
    carol.channel.setKeys([]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(alice.presence.peers.map(peer => peer.name)).toEqual(['Carol']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(alice.presence.peers).toEqual([]);
  });

  it('keeps showing someone who is there, by their heartbeat', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const bob = member(bus, 'Bob');
    const key = keyFor('s');
    alice.channel.setKeys([key]);
    bob.channel.setKeys([key]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(alice.presence.peers.map(peer => peer.name)).toEqual(['Bob']);
  });

  it('gives someone who joins what was written before they came, without the files', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const key = keyFor('s');
    alice.channel.setKeys([key]);
    alice.ydoc.getText('body').insert(0, 'not stored yet');
    await vi.advanceTimersByTimeAsync(300);
    const bob = member(bus, 'Bob');
    bob.channel.setKeys([key]);
    await vi.advanceTimersByTimeAsync(400);
    expect(text(bob)).toBe('not stored yet');
  });

  it('asks again for what a lost message held', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const bob = member(bus, 'Bob');
    const key = keyFor('s');
    alice.channel.setKeys([key]);
    bob.channel.setKeys([key]);
    await vi.advanceTimersByTimeAsync(300);
    bus.dropping = true;
    alice.ydoc.getText('body').insert(0, 'first ');
    await vi.advanceTimersByTimeAsync(100);
    bus.dropping = false;
    alice.ydoc.getText('body').insert(6, 'second');
    await vi.advanceTimersByTimeAsync(4000);
    expect(text(bob)).toBe('first second');
  });

  it('moves to a new key: a removed device hears nothing more and is not heard', async () => {
    const bus = new Bus();
    const alice = member(bus, 'Alice');
    const bob = member(bus, 'Bob');
    const eve = member(bus, 'Eve');
    const first = keyFor('epoch 1', 1);
    const second = keyFor('epoch 2', 2);
    for (const who of [alice, bob, eve]) who.channel.setKeys([first]);
    await vi.advanceTimersByTimeAsync(300);
    expect(eve.presence.peers.map(peer => peer.name).sort()).toEqual(['Alice', 'Bob']);

    defaultAccess.devices.delete(eve.key);
    alice.channel.setKeys([second, first]);
    alice.channel.recheck();
    await vi.advanceTimersByTimeAsync(300);
    expect(alice.presence.peers.map(peer => peer.name)).toEqual(['Bob']);
    // Bob has not seen the new epoch yet: Alice still hears him on the old one.
    bob.ydoc.getText('body').insert(0, 'Bob ');
    await vi.advanceTimersByTimeAsync(300);
    expect(text(alice)).toBe('Bob ');
    bob.channel.setKeys([second, first]);
    bob.channel.recheck();
    await vi.advanceTimersByTimeAsync(300);
    alice.ydoc.getText('body').insert(4, 'and Alice');
    await vi.advanceTimersByTimeAsync(300);
    expect(text(bob)).toBe('Bob and Alice');
    expect(text(eve)).toBe('Bob ');
    // Eve sends on the old key, where Alice and Bob still listen; nobody takes it.
    eve.ydoc.getText('body').insert(0, 'Eve ');
    await vi.advanceTimersByTimeAsync(300);
    expect(text(alice)).toBe('Bob and Alice');
    expect(alice.presence.peers.map(peer => peer.name)).toEqual(['Bob']);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(eve.presence.peers).toEqual([]);
  });
});

describe('awareness updates', () => {
  it('reads and writes them as y-protocols does', () => {
    const awareness = new Awareness(new Y.Doc());
    awareness.setLocalState({ user: { name: 'Ünïcode 名前' } });
    const update = encodeAwarenessUpdate(awareness, [awareness.clientID]);
    const entries = readAwarenessUpdate(update)!;
    expect(entries.map(entry => entry.client)).toEqual([awareness.clientID]);
    expect(entries[0]!.state).toEqual({ user: { name: 'Ünïcode 名前' } });
    expect(writeAwarenessUpdate(entries)).toEqual(update);
    expect(readAwarenessUpdate(new Uint8Array([5, 1]))).toBeNull();
    awareness.destroy();
  });
});

describe('live access', () => {
  const ownerSecret = generateSecretKey();
  const owner = getPublicKey(ownerSecret);
  const ownerProfile = '123e4567-e89b-42d3-a456-426614174201';
  const guestProfile = '123e4567-e89b-42d3-a456-426614174202';
  const readerProfile = '123e4567-e89b-42d3-a456-426614174203';

  function sharedWith() {
    const guestSecret = generateSecretKey();
    const readerSecret = generateSecretKey();
    const folder = addShareRecipients(createSharedFolder({
      signerSecretKey: ownerSecret, ownerProfileId: ownerProfile, ownerDevices: [{ pubkey: owner }],
      sourcePath: 'Plan', displayName: 'Plan', ownerName: 'Olive', createdAt: 100,
    }), ownerSecret, [
      { profile_id: guestProfile, app_pubkey: getPublicKey(guestSecret), role: 'editor', display_name: 'Gus' },
      { profile_id: readerProfile, app_pubkey: getPublicKey(readerSecret), role: 'reader', display_name: 'Rita' },
    ], 110);
    return { folder, guestSecret, readerSecret };
  }

  it('gives every member of a shared folder the same secret, names each device by its owner, and edits to editors', () => {
    const { folder, guestSecret, readerSecret } = sharedWith();
    const guest = getPublicKey(guestSecret);
    const reader = getPublicKey(readerSecret);
    const forOwner = shareLiveAccess(folder, owner, ownerSecret)!;
    const forGuest = shareLiveAccess(folder, guest, guestSecret)!;
    const forReader = shareLiveAccess(folder, reader, readerSecret)!;
    expect(forGuest.secrets[0]!.id).toBe(forOwner.secrets[0]!.id);
    expect(forReader.secrets[0]!.secret).toEqual(forOwner.secrets[0]!.secret);
    expect([...forOwner.devices.keys()].sort()).toEqual([owner, guest, reader].sort());
    expect(forOwner.devices.get(owner)).toMatchObject({ id: ownerProfile, name: 'Olive', canEdit: true });
    expect(forOwner.devices.get(guest)).toMatchObject({ id: guestProfile, name: 'Gus', canEdit: true });
    expect(forOwner.devices.get(reader)).toMatchObject({ id: readerProfile, name: 'Rita', canEdit: false });
    expect(forOwner.devices.get(guest)!.npub).toMatch(/^npub1/);
    expect(shareLiveAccess(folder, getPublicKey(generateSecretKey()), generateSecretKey())).toBeNull();
  });

  it('moves members to a new secret when someone is removed, which the removed one cannot open', () => {
    const { folder, guestSecret, readerSecret } = sharedWith();
    const before = shareLiveAccess(folder, owner, ownerSecret)!;
    const after = revokeShareMember(folder, ownerSecret, guestProfile, 120);
    const forOwner = shareLiveAccess(after, owner, ownerSecret)!;
    const forReader = shareLiveAccess(after, getPublicKey(readerSecret), readerSecret)!;
    expect(forOwner.secrets[0]!.id).not.toBe(before.secrets[0]!.id);
    expect(forOwner.secrets[1]!.id).toBe(before.secrets[0]!.id);
    expect(forReader.secrets[0]!.id).toBe(forOwner.secrets[0]!.id);
    expect(forOwner.devices.has(getPublicKey(guestSecret))).toBe(false);
    expect(shareLiveAccess(after, getPublicKey(guestSecret), guestSecret)).toBeNull();
  });

  it('ignores a removed device on the channel once the access list says so', async () => {
    const { folder, guestSecret } = sharedWith();
    const after = revokeShareMember(folder, ownerSecret, guestProfile, 120);
    let access = shareLiveAccess(folder, owner, ownerSecret)!;
    const bus = new Bus();
    const ydoc = new Y.Doc();
    const presence = new LivePresence(ydoc, user(owner, 'Olive'));
    const channel = new LiveChannel({
      ydoc, presence, transports: [bus.transport()], deviceSecretKey: ownerSecret,
      canEdit: () => true, identify: key => access.devices.get(key) ?? null,
    });
    const keyOf = (secret: Uint8Array, id: string) => deriveLiveKey('share', secret, id, PLACE);
    channel.setKeys(access.secrets.map(item => keyOf(item.secret, item.id)));
    const oldKey = keyOf(access.secrets[0]!.secret, access.secrets[0]!.id);
    forge(bus, oldKey, guestSecret, { u: b64(updateWith('guest, still a member ')) });
    await vi.advanceTimersByTimeAsync(100);
    expect(ydoc.getText('body').toString()).toBe('guest, still a member ');

    access = shareLiveAccess(after, owner, ownerSecret)!;
    channel.setKeys(access.secrets.map(item => keyOf(item.secret, item.id)));
    channel.recheck();
    forge(bus, oldKey, guestSecret, { u: b64(updateWith('after removal')) }, { client: 8 });
    await vi.advanceTimersByTimeAsync(100);
    expect(ydoc.getText('body').toString()).toBe('guest, still a member ');
    channel.destroy();
  });

  it('uses the Drive key for an account\'s own documents, which only its devices hold', () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174299';
    const deviceSecret = generateSecretKey();
    const device = getPublicKey(deviceSecret);
    const capabilities = { can_write_roots: true, can_admin_profile: true, can_receive_secret_wraps: true, can_decrypt_secret_epochs: true };
    const add = signNostrIdentityRosterOp({
      signerSecretKey: deviceSecret, profileId, createdAt: 5,
      op: { op: 'add_facet', facet: { pubkey: device, purposes: ['app_key'], capabilities, added_at: 5 } },
    });
    const dck = 'drive content key of 32 letters';
    const rotate = signNostrIdentityRosterOp({
      signerSecretKey: deviceSecret, profileId, createdAt: 6, parents: [add.op_id],
      op: { op: 'rotate_secret_epoch', epoch: 1, wrapped_secrets: { [device]: nip44.v2.encrypt(dck, nip44.v2.utils.getConversationKey(deviceSecret, device)) } },
    });
    const own = { name: 'Me', npub: null };
    const access = driveLiveAccess(profileId, [add, rotate], device, deviceSecret, own)!;
    expect(access.kind).toBe('drive');
    expect(new TextDecoder().decode(access.secrets[0]!.secret)).toBe(dck);
    expect([...access.devices.entries()]).toEqual([[device, { id: profileId, name: 'Me', npub: null, canEdit: true }]]);
    const stranger = generateSecretKey();
    expect(driveLiveAccess(profileId, [add, rotate], getPublicKey(stranger), stranger, own)).toBeNull();
    expect([...accountLiveAccess(deviceSecret, own).devices.keys()]).toEqual([device]);
  });
});

describe('live messages over the peer network', () => {
  function fakeRuntime(peers: string[]) {
    const sent: Array<{ dst: string; payload: Uint8Array }> = [];
    let handler: ((context: { src: string; payload: Uint8Array }) => void) | null = null;
    const node: LiveFipsNode = {
      registerService: (_port, serve) => {
        handler = serve as typeof handler;
        return () => { handler = null; };
      },
      sendDatagram: async ({ dst, payload }) => { sent.push({ dst, payload }); },
    };
    return {
      runtime: () => ({ node: () => node, connectedPeerIds: () => peers }),
      sent,
      deliver: (src: string, event: Event) => handler?.({ src, payload: encoder.encode(JSON.stringify(event)) }),
    };
  }

  it('sends straight to connected peers that may read the document, and takes only from them', () => {
    const member = getPublicKey(generateSecretKey());
    const stranger = getPublicKey(generateSecretKey());
    const own = getPublicKey(generateSecretKey());
    const fake = fakeRuntime([`02${member}`, `03${stranger}`, `02${own}`]);
    const transport = fipsLiveTransport({ audience: () => new Set([member, own]), ownKey: own, runtime: fake.runtime });
    const received: Event[] = [];
    const stop = transport.listen(['topic-a'], event => received.push(event));
    const event = finalizeEvent({ kind: LIVE_KIND, created_at: 1, tags: [['d', 'topic-a']], content: 'x' }, generateSecretKey());
    transport.send(event);
    expect(fake.sent.map(item => item.dst)).toEqual([`02${member}`]);
    fake.deliver(`02${member}`, event);
    fake.deliver(`03${stranger}`, event);
    fake.deliver(`02${member}`, { ...event, tags: [['d', 'topic-b']] });
    expect(received).toHaveLength(1);
    stop();
    fake.deliver(`02${member}`, event);
    expect(received).toHaveLength(1);
  });
});

describe('edits seen live and storage', () => {
  it('stores a live edit its writer never stored, and not one that storage holds', async () => {
    const writer = new Y.Doc();
    writer.getText('body').insert(0, 'written');
    const update = Y.encodeStateAsUpdate(writer);
    const ydoc = new Y.Doc();
    const commits: number[] = [];
    const session = new DocumentSession({
      ydoc,
      tree: { listDirectory: async () => [], readFile: async () => null },
      writerId: 'device',
      commit: async (change) => { commits.push(change.writes.length); },
    });
    Y.applyUpdate(ydoc, update, LIVE_ORIGIN);
    expect(session.dirty).toBe(false);
    expect(session.holds(update)).toBe(false);
    session.keep(update);
    expect(session.dirty).toBe(true);
    await session.save();
    expect(session.holds(update)).toBe(true);
    session.keep(update);
    expect(session.dirty).toBe(false);
  });
});
