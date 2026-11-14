/**
 * Presence and live edits for one open document, between everyone who has
 * it open, sent without waiting for anyone to answer.
 *
 * The files stay the storage of record. Every edit is also stored by its
 * writer as usual, so a message that is lost changes nothing: the files bring
 * the same update a moment later and Yjs merges duplicates.
 *
 * What travels is a Nostr event of an ephemeral kind, which relays forward
 * and do not keep. It is signed with a key made for this one opening of the
 * document and tagged only with the document's topic and an expiry, so
 * relays learn neither the document nor who is in it. Its content is NIP-44
 * v2, encrypted with the document's live key (liveKeys.ts), and holds the
 * message itself: an event signed by the sender's device key, tagged with
 *
 *   d  the topic, so it cannot be replayed into another document
 *   c  the awareness client it speaks for
 *   n  a sequence number, and with `created_at` the time it was sent
 *
 * and with JSON content:
 *
 *   a  an awareness update for that client alone (base64)
 *   u  a Yjs update, taken only from a device that may edit (base64)
 *   q  a state vector: the sender asks for what it does not have (base64)
 *
 * The encryption only shows that someone who may read sent it. The device's
 * signature says who: a message is taken only from a device on the access
 * list, once, and shown under the name the list gives that device's owner,
 * never one the message claims.
 *
 * The same events go to relays and, as datagrams, to connected peers.
 */
import * as Y from 'yjs';
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent, type Event } from 'nostr-tools';
import { base64 } from '@scure/base';
import { LIVE_ORIGIN, STORED_ORIGIN } from './documentStore';
import { TAB_ORIGIN } from './tabSync';
import type { LiveKey } from './liveKeys';
import { presenceColor, type LivePresence, type PresenceUser } from './presence.svelte';

/** What travels; ephemeral, so relays do not store it. */
export const LIVE_KIND = 20078;
/** The message inside, signed by the sending device. Never sent on its own. */
export const LIVE_MESSAGE_KIND = 20079;

/** Edits made within this time go out together. */
const UPDATE_BATCH_MS = 40;
/** Where someone is goes out at most this often. */
const AWARENESS_INTERVAL_MS = 250;
/**
 * An open copy says it is still there this often, and is taken to have left
 * after missing about three of these. A closed tab cannot always say goodbye:
 * its last message may die with it.
 */
const HEARTBEAT_MS = 2000;
const PEER_TIMEOUT_MS = 6500;
/** Messages older than this, or this far ahead, are not taken; relays drop them after it. */
const MAX_AGE_S = 120;
/** NIP-44 encrypts at most 65535 bytes; larger edits arrive with the files. */
const MAX_CONTENT = 60_000;
/** Asking the others again for missing edits waits at least this long. */
const ASK_INTERVAL_MS = 3000;

export interface LiveTransport {
  /** Starts passing on events of these topics; returns what stops it. */
  listen(topics: string[], receive: (event: Event) => void): () => void;
  /** Sends without waiting for any answer. */
  send(event: Event): void;
}

/** Who a device belongs to, as the access list says. */
export interface LiveIdentity {
  /** The person: a Drive profile id, else the device's key. */
  id: string;
  name: string;
  npub: string | null;
  canEdit: boolean;
}

export interface LiveChannelOptions {
  ydoc: Y.Doc;
  presence: LivePresence;
  transports: LiveTransport[];
  /** Signs every message this copy sends. */
  deviceSecretKey: Uint8Array;
  /** Edits are sent only while this person may change the document. */
  canEdit: () => boolean;
  /** Who a device belongs to; null for a device that may not take part. */
  identify: (deviceKey: string) => LiveIdentity | null;
  /** Called with each update taken in from someone else. */
  onRemoteUpdate?: (update: Uint8Array) => void;
  /**
   * False while there is no network. Nothing is sent then: it could not
   * arrive while it still mattered, and the files carry the edits.
   */
  online?: () => boolean;
  now?: () => number;
}

interface LiveBody {
  a?: string;
  u?: string;
  q?: string;
}

interface Peer {
  deviceKey: string;
  seen: number;
}

interface AwarenessEntry {
  client: number;
  clock: number;
  state: Record<string, unknown> | null;
}

/** The entries of an awareness update, or null when it cannot be read. */
export function readAwarenessUpdate(update: Uint8Array): AwarenessEntry[] | null {
  let pos = 0;
  const readVarUint = (): number => {
    let value = 0;
    let factor = 1;
    for (;;) {
      const byte = update[pos++];
      if (byte === undefined || factor > 2 ** 49) throw new RangeError('truncated');
      value += (byte & 0x7f) * factor;
      if (byte < 0x80) return value;
      factor *= 128;
    }
  };
  try {
    const entries: AwarenessEntry[] = [];
    const count = readVarUint();
    for (let index = 0; index < count; index += 1) {
      const client = readVarUint();
      const clock = readVarUint();
      const length = readVarUint();
      if (pos + length > update.length) return null;
      const state = JSON.parse(new TextDecoder().decode(update.subarray(pos, pos + length))) as unknown;
      pos += length;
      if (state !== null && (typeof state !== 'object' || Array.isArray(state))) return null;
      entries.push({ client, clock, state: state as Record<string, unknown> | null });
    }
    return pos === update.length ? entries : null;
  } catch {
    return null;
  }
}

/** An awareness update in the form y-protocols reads. */
export function writeAwarenessUpdate(entries: AwarenessEntry[]): Uint8Array {
  const bytes: number[] = [];
  const writeVarUint = (input: number): void => {
    let value = input;
    while (value > 0x7f) {
      bytes.push(0x80 | (value % 128));
      value = Math.floor(value / 128);
    }
    bytes.push(value);
  };
  writeVarUint(entries.length);
  for (const entry of entries) {
    writeVarUint(entry.client);
    writeVarUint(entry.clock);
    const state = new TextEncoder().encode(JSON.stringify(entry.state));
    writeVarUint(state.length);
    for (const byte of state) bytes.push(byte);
  }
  return Uint8Array.from(bytes);
}

export class LiveChannel {
  readonly #options: LiveChannelOptions;
  readonly #ydoc: Y.Doc;
  readonly #presence: LivePresence;
  readonly #now: () => number;
  readonly #sessionKey = generateSecretKey();
  readonly #session = getPublicKey(this.#sessionKey);
  readonly #deviceKey: string;
  #keys: LiveKey[] = [];
  /** Messages already taken, by id, until they are too old to be taken anyway. */
  readonly #taken = new Map<string, number>();
  readonly #peers = new Map<number, Peer>();
  #stopListening: Array<() => void> = [];
  #pending: Uint8Array[] = [];
  #sequence = 0;
  #updateTimer: ReturnType<typeof setTimeout> | undefined;
  #awarenessTimer: ReturnType<typeof setTimeout> | undefined;
  #askTimer: ReturnType<typeof setTimeout> | undefined;
  #lastAwarenessAt = 0;
  #lastAskAt = 0;
  readonly #heartbeat: ReturnType<typeof setInterval>;
  readonly #sweep: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(options: LiveChannelOptions) {
    this.#options = options;
    this.#ydoc = options.ydoc;
    this.#presence = options.presence;
    this.#now = options.now ?? Date.now;
    this.#deviceKey = getPublicKey(options.deviceSecretKey);
    this.#ydoc.on('update', this.#onUpdate);
    this.#presence.awareness.on('update', this.#onAwareness);
    this.#heartbeat = setInterval(() => this.#beat(), HEARTBEAT_MS);
    this.#sweep = setInterval(() => this.#dropQuiet(), 1000);
  }

  /** The topics listened to, the one sent on first. */
  get topics(): string[] {
    return this.#keys.map(key => key.topic);
  }

  /**
   * The keys of the document: the current one, which messages are sent
   * with, then earlier ones that are still listened to while everyone moves
   * over. No keys stops the channel until there are some again.
   */
  setKeys(keys: LiveKey[]): void {
    if (this.#closed) return;
    const same = keys.length === this.#keys.length
      && keys.every((key, index) => key.id === this.#keys[index]!.id && key.topic === this.#keys[index]!.topic);
    if (same) return;
    const before = this.#keys[0]?.topic;
    this.#keys = keys;
    for (const stop of this.#stopListening.splice(0)) stop();
    if (keys.length === 0) {
      this.#forget(() => true);
      return;
    }
    const topics = keys.map(key => key.topic);
    for (const transport of this.#options.transports) {
      try {
        this.#stopListening.push(transport.listen(topics, this.#receive));
      } catch (error) {
        console.warn('[live] Could not listen:', error);
      }
    }
    // On a new key: here, and what is missing, please.
    if (keys[0]!.topic !== before) this.#send({ ...this.#awarenessBody(), q: base64.encode(Y.encodeStateVector(this.#ydoc)) });
  }

  /** Back on the network: here again, and what was missed meanwhile, please. */
  resume(): void {
    if (this.#keys.length === 0 || this.#closed) return;
    this.#send({ ...this.#awarenessBody(), q: base64.encode(Y.encodeStateVector(this.#ydoc)) });
  }

  /** Stops showing copies whose devices may no longer take part. Called after access changed. */
  recheck(): void {
    this.#forget(peer => !this.#options.identify(peer.deviceKey));
    this.#presence.refresh();
  }

  /** Tells the others this copy has gone, and stops. */
  destroy(): void {
    if (this.#closed) return;
    this.#flush();
    removeAwarenessStates(this.#presence.awareness, [this.#presence.awareness.clientID], 'local');
    this.#closed = true;
    for (const stop of this.#stopListening.splice(0)) stop();
    clearInterval(this.#heartbeat);
    clearInterval(this.#sweep);
    clearTimeout(this.#updateTimer);
    clearTimeout(this.#awarenessTimer);
    clearTimeout(this.#askTimer);
    this.#ydoc.off('update', this.#onUpdate);
    this.#presence.awareness.off('update', this.#onAwareness);
    this.#forget(() => true);
  }

  readonly #onUpdate = (update: Uint8Array, origin: unknown): void => {
    // Others read stored edits themselves; another tab sends its own.
    if (origin === STORED_ORIGIN || origin === LIVE_ORIGIN || origin === TAB_ORIGIN) return;
    if (this.#keys.length === 0 || !this.#options.canEdit()) return;
    this.#pending.push(update);
    this.#updateTimer ??= setTimeout(() => this.#flush(), UPDATE_BATCH_MS);
  };

  readonly #onAwareness = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const own = this.#presence.awareness.clientID;
    if (origin === LIVE_ORIGIN || origin === 'timeout') return;
    if (change.removed.includes(own)) {
      this.#sendAwareness();
      return;
    }
    if (change.added.includes(own) || change.updated.includes(own)) this.#sendAwarenessSoon();
  };

  #flush(): void {
    clearTimeout(this.#updateTimer);
    this.#updateTimer = undefined;
    if (this.#pending.length === 0) return;
    const update = this.#pending.length === 1 ? this.#pending[0]! : Y.mergeUpdates(this.#pending);
    this.#pending = [];
    this.#send({ u: base64.encode(update) });
  }

  #awarenessBody(): LiveBody {
    this.#lastAwarenessAt = this.#now();
    clearTimeout(this.#awarenessTimer);
    this.#awarenessTimer = undefined;
    const awareness = this.#presence.awareness;
    return { a: base64.encode(encodeAwarenessUpdate(awareness, [awareness.clientID])) };
  }

  #sendAwareness(): void {
    this.#send(this.#awarenessBody());
  }

  #sendAwarenessSoon(): void {
    const wait = this.#lastAwarenessAt + AWARENESS_INTERVAL_MS - this.#now();
    if (wait <= 0) this.#sendAwareness();
    else this.#awarenessTimer ??= setTimeout(() => this.#sendAwareness(), wait);
  }

  /** Still here: a newer clock on the same state, so the others keep showing this copy. */
  #beat(): void {
    const state = this.#presence.awareness.getLocalState();
    if (state && this.#keys.length > 0) this.#presence.awareness.setLocalState(state);
  }

  #askSoon(): void {
    if (this.#askTimer) return;
    const wait = Math.max(300, this.#lastAskAt + ASK_INTERVAL_MS - this.#now());
    this.#askTimer = setTimeout(() => {
      this.#askTimer = undefined;
      this.#lastAskAt = this.#now();
      this.#send({ q: base64.encode(Y.encodeStateVector(this.#ydoc)) });
    }, wait);
  }

  #send(body: LiveBody): void {
    const key = this.#keys[0];
    if (!key || this.#closed || this.#options.online?.() === false) return;
    const now = this.#now();
    this.#sequence = Math.max(this.#sequence + 1, now);
    const createdAt = Math.floor(now / 1000);
    const message = finalizeEvent({
      kind: LIVE_MESSAGE_KIND,
      created_at: createdAt,
      tags: [['d', key.topic], ['c', String(this.#presence.awareness.clientID)], ['n', String(this.#sequence)]],
      content: JSON.stringify(body),
    }, this.#options.deviceSecretKey);
    const content = JSON.stringify(message);
    if (content.length > MAX_CONTENT) return;
    const event = finalizeEvent({
      kind: LIVE_KIND,
      created_at: createdAt,
      tags: [['d', key.topic], ['expiration', String(createdAt + MAX_AGE_S)]],
      content: nip44.v2.encrypt(content, key.key),
    }, this.#sessionKey);
    for (const transport of this.#options.transports) {
      try {
        transport.send(event);
      } catch (error) {
        console.warn('[live] Could not send:', error);
      }
    }
  }

  readonly #receive = (event: Event): void => {
    if (this.#closed || event?.kind !== LIVE_KIND || event.pubkey === this.#session || !Array.isArray(event.tags)) return;
    const topic = event.tags.find(tag => tag[0] === 'd')?.[1];
    const key = this.#keys.find(item => item.topic === topic);
    if (!key || typeof event.content !== 'string') return;
    let message: Event;
    try {
      message = JSON.parse(nip44.v2.decrypt(event.content, key.key)) as Event;
    } catch {
      return;
    }
    // Tabs of this browser share edits among themselves (tabSync.ts), and an
    // earlier page of this one, as before a reload, is not someone else.
    if (message?.pubkey === this.#deviceKey) return;
    const sender = this.#check(message, key.topic);
    if (!sender) return;
    const { deviceKey, clientId, identity } = sender;
    // Nobody else speaks for this copy.
    if (clientId === this.#presence.awareness.clientID) return;
    const known = this.#peers.get(clientId);
    // A copy's client stays with the device that first spoke for it.
    if (known && known.deviceKey !== deviceKey && this.#now() - known.seen < PEER_TIMEOUT_MS) return;
    this.#peers.set(clientId, { deviceKey, seen: this.#now() });
    // Someone new: they hear from this copy at once, not at its next heartbeat.
    if (!known) this.#sendAwarenessSoon();

    let body: LiveBody;
    try {
      body = JSON.parse(message.content) as LiveBody;
    } catch {
      return;
    }
    if (typeof body?.a === 'string') this.#applyAwareness(body.a, clientId, deviceKey, identity);
    if (typeof body?.u === 'string' && identity.canEdit) this.#applyUpdate(body.u);
    if (typeof body?.q === 'string') this.#answer(body.q);
  };

  /** The device that signed a message, when it may take part and the message is for here, now, and new. */
  #check(message: Event, topic: string): { deviceKey: string; clientId: number; identity: LiveIdentity } | null {
    if (!message || typeof message !== 'object' || message.kind !== LIVE_MESSAGE_KIND || !Array.isArray(message.tags)) return null;
    const tag = (name: string) => message.tags.find(item => Array.isArray(item) && item[0] === name)?.[1];
    if (tag('d') !== topic || typeof message.content !== 'string') return null;
    const clientId = Number(tag('c'));
    if (!Number.isSafeInteger(clientId) || clientId < 0 || !/^\d+$/.test(tag('n') ?? '')) return null;
    const nowSeconds = this.#now() / 1000;
    if (typeof message.created_at !== 'number' || Math.abs(message.created_at - nowSeconds) > MAX_AGE_S) return null;
    if (typeof message.id !== 'string' || this.#taken.has(message.id)) return null;
    const identity = this.#options.identify(message.pubkey);
    if (!identity) return null;
    let valid = false;
    try {
      valid = verifyEvent(message);
    } catch {
      valid = false;
    }
    if (!valid) return null;
    this.#taken.set(message.id, message.created_at);
    return { deviceKey: message.pubkey, clientId, identity };
  }

  /**
   * Shows where a copy is. Its update must speak for its own client alone,
   * and the person is the one the access list names, whatever it says.
   */
  #applyAwareness(encoded: string, clientId: number, deviceKey: string, identity: LiveIdentity): void {
    let entries: AwarenessEntry[] | null;
    try {
      entries = readAwarenessUpdate(base64.decode(encoded));
    } catch {
      return;
    }
    if (!entries || entries.length !== 1 || entries[0]!.client !== clientId) return;
    const { clock, state } = entries[0]!;
    const user: PresenceUser = {
      name: identity.name,
      color: presenceColor(identity.id),
      key: deviceKey,
      id: identity.id,
      ...(identity.npub ? { npub: identity.npub } : {}),
    };
    try {
      applyAwarenessUpdate(this.#presence.awareness, writeAwarenessUpdate([{ client: clientId, clock, state: state && { ...state, user } }]), LIVE_ORIGIN);
    } catch {
      // Not an awareness update after all.
    }
  }

  #applyUpdate(encoded: string): void {
    let update: Uint8Array;
    try {
      update = base64.decode(encoded);
      Y.applyUpdate(this.#ydoc, update, LIVE_ORIGIN);
    } catch (error) {
      console.warn('[live] Could not apply an edit:', error);
      return;
    }
    this.#options.onRemoteUpdate?.(update);
    // Something it builds on was lost on the way: ask for it.
    if (this.#ydoc.store.pendingStructs || this.#ydoc.store.pendingDs) this.#askSoon();
  }

  /** Sends someone what they asked for, when this copy has any of it. */
  #answer(encoded: string): void {
    if (!this.#options.canEdit()) return;
    let theirs: Map<number, number>;
    let vector: Uint8Array;
    try {
      vector = base64.decode(encoded);
      theirs = Y.decodeStateVector(vector);
    } catch {
      return;
    }
    const mine = Y.decodeStateVector(Y.encodeStateVector(this.#ydoc));
    if (![...mine].some(([client, clock]) => clock > (theirs.get(client) ?? 0))) return;
    // Several may answer; a moment apart, the same answer twice changes nothing.
    setTimeout(() => {
      if (!this.#closed) this.#send({ u: base64.encode(Y.encodeStateAsUpdate(this.#ydoc, vector)) });
    }, Math.floor(Math.random() * 150));
  }

  #dropQuiet(): void {
    const now = this.#now();
    this.#forget(peer => now - peer.seen > PEER_TIMEOUT_MS);
    const oldest = now / 1000 - MAX_AGE_S;
    for (const [id, createdAt] of this.#taken) {
      if (createdAt < oldest) this.#taken.delete(id);
    }
  }

  #forget(gone: (peer: Peer) => boolean): void {
    const removed: number[] = [];
    for (const [clientId, peer] of this.#peers) {
      if (!gone(peer)) continue;
      this.#peers.delete(clientId);
      removed.push(clientId);
    }
    const shown = removed.filter(clientId => this.#presence.awareness.getStates().has(clientId));
    if (shown.length > 0) removeAwarenessStates(this.#presence.awareness, shown, 'timeout');
  }
}
