/**
 * Sending a form's answers to its owner, and taking them in, over Nostr with
 * nostr-double-ratchet.
 *
 * A form carries the public half of an invite: a key and a secret (its
 * inbox). Whoever answers accepts that invite, which makes a session, and
 * sends the answers as the session's first message. Relays see two events
 * from throwaway keys addressed to the inbox key; only someone holding the
 * inbox's private key and the secret can read who answered and what.
 *
 * The invite's inviter is the inbox key itself, not a device of the owner's,
 * so any device or person that holds the private key can take answers in.
 * Nothing here waits for a relay: events are handed over to be sent, and
 * answers are passed on as they arrive.
 */
import { fromHex, toHex } from '@hashtree/core';
import { generateSecretKey, getPublicKey, type Filter, type VerifiedEvent } from 'nostr-tools';
import {
  Invite,
  MESSAGE_EVENT_KIND,
  generateEphemeralKeypair,
  generateSharedSecret,
  type EncryptFunction,
} from 'nostr-double-ratchet';
import type { Answers, Inbox } from './model';

/** The kind of the message inside the session that carries a form's answers. */
export const FORM_ANSWERS_KIND = 30_168;

export interface FormRelay {
  publish(event: VerifiedEvent): void;
  /** Delivers stored events matching the filter, then new ones, until stopped. */
  subscribe(filter: Filter, onEvent: (event: VerifiedEvent) => void): () => void;
}

/** Who sends: their public key and what encrypts as them. */
export interface Sender {
  pubkey: string;
  encrypt: Uint8Array | EncryptFunction;
}

/** Who answered, as they say: their Drive profile and name, sent only by people who sign in. */
export interface AnswerAuthor {
  profile?: string;
  name?: string;
}

export interface ReceivedAnswers {
  /** The id of the invite response, the same wherever it is taken in. */
  id: string;
  /** The key the answers were sent as. */
  from: string;
  /** When they were sent, in Unix seconds. */
  at: number;
  answers: unknown;
  author?: AnswerAuthor;
}

/** A new inbox and its private key, for a new form. */
export function createInbox(): { inbox: Inbox; privateKey: string } {
  const keys = generateEphemeralKeypair();
  return {
    inbox: { pubkey: keys.publicKey, secret: generateSharedSecret() },
    privateKey: toHex(keys.privateKey),
  };
}

/** A key made for one answer, so nothing ties it to the person who sent it. */
export function anonymousSender(): Sender {
  const secretKey = generateSecretKey();
  return { pubkey: getPublicKey(secretKey), encrypt: secretKey };
}

export interface SentAnswers {
  /** The answers' id, as the owner sees it. */
  id: string;
  /** The events that carry them; the answers have arrived once a relay holds both. */
  events: string[];
}

/** Sends the answers; resolves once the events are handed over to be sent. */
export async function sendAnswers(inbox: Inbox, answers: Answers, sender: Sender, relay: FormRelay, author?: AnswerAuthor): Promise<SentAnswers> {
  const invite = new Invite(inbox.pubkey, inbox.secret, inbox.pubkey);
  const { session, event } = await invite.accept(sender.pubkey, sender.encrypt);
  const { event: message } = session.sendEvent({
    kind: FORM_ANSWERS_KIND,
    content: JSON.stringify({ v: 1, answers, ...(author ? { author } : {}) }),
  });
  relay.publish(event);
  relay.publish(message);
  return { id: event.id, events: [event.id, message.id] };
}

/**
 * Calls back once the relays hold every one of `ids`, until stopped. Only
 * reads: nothing that sends waits for it.
 */
export function watchDelivered(ids: string[], relay: FormRelay, onDelivered: () => void): () => void {
  const missing = new Set(ids);
  let stop: (() => void) | null = null;
  let done = false;
  stop = relay.subscribe({ ids }, (event) => {
    missing.delete(event.id);
    if (missing.size > 0 || done) return;
    done = true;
    queueMicrotask(() => stop?.());
    onDelivered();
  });
  return () => stop?.();
}

function readAuthor(value: unknown): AnswerAuthor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { profile, name } = value as Record<string, unknown>;
  const author: AnswerAuthor = {};
  if (typeof profile === 'string' && profile.length <= 128) author.profile = profile;
  if (typeof name === 'string' && name.trim()) author.name = name.trim().slice(0, 100);
  return author.profile || author.name ? author : undefined;
}

function parseMessage(content: string): { answers: unknown; author?: AnswerAuthor } | undefined {
  try {
    const parsed = JSON.parse(content) as { v?: unknown; answers?: unknown; author?: unknown };
    if (!parsed || parsed.v !== 1) return undefined;
    const author = readAuthor(parsed.author);
    return { answers: parsed.answers, ...(author ? { author } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Takes in answers sent to the inbox, old and new, until stopped. Each one is
 * passed on once, in the order it is read.
 */
export function receiveAnswers(
  inbox: Inbox,
  privateKey: string,
  relay: FormRelay,
  onAnswers: (received: ReceivedAnswers) => void,
  /** Answers already kept: their messages are not asked for again. */
  known: (id: string) => boolean = () => false,
): () => void {
  const key = fromHex(privateKey);
  if (getPublicKey(key) !== inbox.pubkey) throw new Error('The key does not open this inbox');
  const invite = new Invite(inbox.pubkey, inbox.secret, inbox.pubkey, key);
  const stops: Array<() => void> = [];
  let stopped = false;

  const stopInvite = invite.listen(key, (filter, onEvent) => relay.subscribe(filter, onEvent), (session, from) => {
    if (stopped) return;
    // The library names the session after the invite response that made it.
    const id = session.name;
    if (known(id)) return;
    let done = false;
    let stop: (() => void) | null = null;
    stop = relay.subscribe({ kinds: [MESSAGE_EVENT_KIND], authors: [session.state.theirNextNostrPublicKey] }, (event) => {
      if (done || stopped) return;
      const rumor = session.receiveEvent(event);
      if (!rumor || rumor.kind !== FORM_ANSWERS_KIND) return;
      const message = parseMessage(rumor.content);
      if (!message) return;
      done = true;
      // The relay may still be inside subscribe(); stop once it has returned.
      queueMicrotask(() => stop?.());
      onAnswers({ id, from, at: rumor.created_at, ...message });
    });
    stops.push(() => stop?.());
  });

  return () => {
    stopped = true;
    stopInvite();
    for (const stop of stops) stop();
  };
}
