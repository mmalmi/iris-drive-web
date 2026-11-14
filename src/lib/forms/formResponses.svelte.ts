/**
 * A form's responses, for the account that made it: the ones its devices
 * have stored (see formStore.ts), and new ones taken in while the form is
 * open here.
 *
 * New answers arrive from the relays (see inbox.ts) and are shown at once;
 * they are stored shortly after, a few at a time. A form open only to people
 * in the owner's network keeps answers from keys within its reach in this
 * device's follow graph; others are held back, and looked at again when the
 * graph changes. Nothing waits for a relay.
 */
import type { VerifiedEvent } from 'nostr-tools';
import { nostr } from '../../nostr';
import { getWorkerAdapter } from '../../workerAdapter';
import { socialGraphStore } from '../../utils/socialGraph';
import { usableDistance } from '../followDistance';
import { startBackoffPoll } from '../backoffPoll';
import { readAnswers, type FormData, type Inbox } from './model';
import { createInbox, receiveAnswers, type FormRelay, type ReceivedAnswers } from './inbox';
import { listFormFolder, onOwnDriveChange, readFormFile, writeFormFiles } from './formStore';
import {
  KEY_FILE,
  RESPONSES_DIRECTORY,
  decodeInboxKey,
  decodeResponse,
  encodeInboxKey,
  encodeResponse,
  responseFileName,
  responseIdOf,
  type FormResponse,
} from './responses';

const STORE_AFTER_MS = 600;

// Answers are sent with back-dated times, which a live subscription can pass
// over; the relays are asked again now and then, less and less often.
const ASK_AGAIN_MIN_MS = 3000;
const ASK_AGAIN_MAX_MS = 60_000;

/** The app's relays, as the form inbox uses them. */
export function appRelay(): FormRelay {
  return {
    publish(event) {
      void nostr.publish(event).catch((error: unknown) => console.warn('[Forms] Could not send:', error));
    },
    subscribe(filter, onEvent) {
      const deliver = (event: unknown) => onEvent(event as VerifiedEvent);
      const live = nostr.subscribe(filter);
      live.on('event', deliver);
      let history: ReturnType<typeof nostr.subscribe> | null = null;
      const poll = startBackoffPoll(() => {
        history?.stop();
        history = nostr.subscribe(filter, { closeAfterHistory: true });
        history.on('event', deliver);
      }, { minMs: ASK_AGAIN_MIN_MS, maxMs: ASK_AGAIN_MAX_MS });
      return () => {
        poll.stop();
        history?.stop();
        live.stop();
      };
    },
  };
}

/**
 * Makes a new inbox and keeps its key in My Drive. Resolves to the inbox to
 * put in the form, or null when the key could not be kept: a form whose
 * answers nobody could read is not offered.
 */
export async function setUpInbox(): Promise<Inbox | null> {
  const { inbox, privateKey } = createInbox();
  try {
    await writeFormFiles([{ path: [inbox.pubkey, KEY_FILE], data: encodeInboxKey(inbox.pubkey, privateKey) }]);
    return inbox;
  } catch (error) {
    console.warn('[Forms] Could not keep the form key:', error);
    return null;
  }
}

export class FormResponses {
  /** Newest first. */
  responses = $state.raw<FormResponse[]>([]);
  /** Answers left out for now: their senders are not within the form's reach. */
  heldBack = $state(0);
  /** Whether this account holds the form's key: it made the form, and sees its responses. */
  owner = $state(false);
  /** True until this account's copy has been looked at once. */
  loading = $state(true);

  readonly #form: () => FormData;
  readonly #canEdit: () => boolean;
  readonly #known = new Set<string>();
  readonly #read = new Set<string>();
  readonly #held = new Map<string, ReceivedAnswers>();
  #pending: FormResponse[] = [];
  #storeTimer: ReturnType<typeof setTimeout> | undefined;
  #stopReceiving: (() => void) | null = null;
  #inbox = '';
  #stops: Array<() => void> = [];
  #reading: Promise<void> = Promise.resolve();
  #destroyed = false;

  /** `canEdit`: responses are read only for someone who may edit the form. */
  constructor(form: () => FormData, canEdit: () => boolean) {
    this.#form = form;
    this.#canEdit = canEdit;
    let first = true;
    this.#stops.push(socialGraphStore.subscribe(() => {
      if (first) {
        first = false;
        return;
      }
      void this.#recheckHeld();
    }));
    this.#stops.push(onOwnDriveChange(() => this.refresh()));
  }

  /** Reads what this account has stored for the form; called when the form or the Drive changes. */
  refresh(): void {
    if (this.#destroyed || !this.#canEdit()) return;
    this.#reading = this.#reading.then(() => this.#readStored()).catch((error: unknown) => {
      console.warn('[Forms] Could not read responses:', error);
    });
  }

  async #readStored(): Promise<void> {
    const inbox = this.#form().inbox;
    if (this.#destroyed) return;
    if (!inbox) {
      this.loading = false;
      return;
    }
    if (inbox.pubkey !== this.#inbox) this.#reset(inbox.pubkey);
    const entries = await listFormFolder([inbox.pubkey]);
    if (!this.#stopReceiving) {
      const keyEntry = entries.find((entry) => entry.name === KEY_FILE);
      const data = keyEntry ? await readFormFile(keyEntry) : null;
      const privateKey = data ? decodeInboxKey(data, inbox.pubkey) : null;
      if (privateKey && !this.#destroyed) {
        this.#stopReceiving = receiveAnswers(inbox, privateKey, appRelay(), (received) => void this.#take(received), (id) => this.#known.has(id));
        this.owner = true;
      }
    }
    const found: FormResponse[] = [];
    for (const entry of await listFormFolder([inbox.pubkey, RESPONSES_DIRECTORY])) {
      const id = responseIdOf(entry.name);
      if (!id || this.#read.has(entry.name)) continue;
      this.#read.add(entry.name);
      if (this.#known.has(id)) continue;
      const data = await readFormFile(entry);
      const response = data ? decodeResponse(data) : null;
      if (!response || response.id !== id || this.#known.has(id)) continue;
      this.#known.add(id);
      found.push(response);
    }
    if (found.length > 0) this.#show(found);
    this.loading = false;
  }

  /** The form has another inbox than before: start over with it. */
  #reset(pubkey: string): void {
    this.#stopReceiving?.();
    this.#stopReceiving = null;
    this.#inbox = pubkey;
    this.#known.clear();
    this.#read.clear();
    this.#held.clear();
    this.#pending = [];
    this.responses = [];
    this.heldBack = 0;
    this.owner = false;
  }

  /** Whether the sender is within reach in this device's follow graph. */
  async #within(from: string, reach: number): Promise<boolean> {
    try {
      const distance = usableDistance(await getWorkerAdapter()?.getFollowDistance(from));
      return distance !== null && distance <= reach;
    } catch {
      return false;
    }
  }

  async #take(received: ReceivedAnswers): Promise<void> {
    if (this.#destroyed || this.#known.has(received.id)) return;
    const form = this.#form();
    if (form.who === 'network' && !await this.#within(received.from, form.reach)) {
      this.#held.set(received.id, received);
      this.heldBack = this.#held.size;
      return;
    }
    if (this.#known.has(received.id)) return;
    this.#held.delete(received.id);
    this.heldBack = this.#held.size;
    const response: FormResponse = {
      id: received.id,
      at: received.at,
      // Answers to a form open to anyone come from a throwaway key, which says nothing.
      from: form.who === 'network' ? received.from : null,
      ...(form.who === 'network' && received.author?.profile ? { profile: received.author.profile } : {}),
      ...(form.who === 'network' && received.author?.name ? { name: received.author.name } : {}),
      answers: readAnswers(received.answers),
    };
    this.#known.add(response.id);
    this.#show([response]);
    this.#pending.push(response);
    clearTimeout(this.#storeTimer);
    this.#storeTimer = setTimeout(() => void this.#store(), STORE_AFTER_MS);
  }

  async #recheckHeld(): Promise<void> {
    for (const received of [...this.#held.values()]) await this.#take(received);
  }

  #show(found: FormResponse[]): void {
    this.responses = [...this.responses, ...found].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  }

  async #store(): Promise<void> {
    const batch = this.#pending;
    const inbox = this.#inbox;
    this.#pending = [];
    if (batch.length === 0 || !inbox) return;
    try {
      await writeFormFiles(batch.map((response) => ({
        path: [inbox, RESPONSES_DIRECTORY, responseFileName(response.id)],
        data: encodeResponse(response),
      })));
      for (const response of batch) this.#read.add(responseFileName(response.id));
    } catch (error) {
      console.warn('[Forms] Could not store responses:', error);
      // Kept for the next try; the relays still have them as well.
      if (this.#inbox === inbox) this.#pending = [...batch, ...this.#pending];
      if (!this.#destroyed) this.#storeTimer = setTimeout(() => void this.#store(), STORE_AFTER_MS * 10);
    }
  }

  destroy(): void {
    this.#destroyed = true;
    this.#stopReceiving?.();
    for (const stop of this.#stops) stop();
    clearTimeout(this.#storeTimer);
    // What is not stored yet is stored now; the page is going away.
    void this.#store();
  }
}
