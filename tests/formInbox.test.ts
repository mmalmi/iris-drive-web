import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, matchFilter, type Filter, type VerifiedEvent } from 'nostr-tools';
import { anonymousSender, createInbox, receiveAnswers, sendAnswers, watchDelivered, type FormRelay, type ReceivedAnswers } from '../src/lib/forms/inbox';

/** A relay in memory: keeps what is published and hands it to every matching subscription. */
function memoryRelay(): FormRelay & { events: VerifiedEvent[] } {
  const events: VerifiedEvent[] = [];
  const subs = new Set<{ filter: Filter; onEvent: (event: VerifiedEvent) => void }>();
  return {
    events,
    publish(event) {
      events.push(event);
      for (const sub of [...subs]) if (matchFilter(sub.filter, event)) sub.onEvent(event);
    },
    subscribe(filter, onEvent) {
      const sub = { filter, onEvent };
      subs.add(sub);
      for (const event of [...events]) if (subs.has(sub) && matchFilter(filter, event)) onEvent(event);
      return () => subs.delete(sub);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('form inbox', () => {
  it('delivers anonymous answers sent before and after the owner listens', async () => {
    const relay = memoryRelay();
    const { inbox, privateKey } = createInbox();
    const sender = anonymousSender();
    const first = await sendAnswers(inbox, { a1: 'Yes' }, sender, relay);

    const got: ReceivedAnswers[] = [];
    const stop = receiveAnswers(inbox, privateKey, relay, (received) => got.push(received));
    await settle();
    await sendAnswers(inbox, { a1: 'No', b2: ['x', 'y'] }, anonymousSender(), relay);
    await settle();
    stop();

    expect(got.map((item) => item.answers)).toEqual([{ a1: 'Yes' }, { a1: 'No', b2: ['x', 'y'] }]);
    expect(got[0]!.id).toBe(first.id);
    expect(first.events).toHaveLength(2);
    expect(got[0]!.from).toBe(sender.pubkey);
    // Relays see only throwaway keys and the inbox key, never who answered.
    expect(relay.events.some((event) => event.pubkey === sender.pubkey || JSON.stringify(event.tags).includes(sender.pubkey))).toBe(false);
  });

  it('tells the owner which key answered, for a person who signs in', async () => {
    const relay = memoryRelay();
    const { inbox, privateKey } = createInbox();
    const secretKey = generateSecretKey();
    await sendAnswers(inbox, { q: 'Hello' }, { pubkey: getPublicKey(secretKey), encrypt: secretKey }, relay);
    const got: ReceivedAnswers[] = [];
    const stop = receiveAnswers(inbox, privateKey, relay, (received) => got.push(received));
    await settle();
    stop();
    expect(got).toHaveLength(1);
    expect(got[0]!.from).toBe(getPublicKey(secretKey));
  });

  it('passes each answer on once, even when a relay sends it twice', async () => {
    const relay = memoryRelay();
    const { inbox, privateKey } = createInbox();
    await sendAnswers(inbox, { q: 'Once' }, anonymousSender(), relay);
    for (const event of [...relay.events]) relay.publish(event);
    const got: ReceivedAnswers[] = [];
    const stop = receiveAnswers(inbox, privateKey, relay, (received) => got.push(received));
    await settle();
    for (const event of [...relay.events]) relay.publish(event);
    await settle();
    stop();
    expect(got).toHaveLength(1);
  });

  it('tells when the relays hold what was sent', async () => {
    const relay = memoryRelay();
    const { inbox } = createInbox();
    const publish = relay.publish.bind(relay);
    const later: VerifiedEvent[] = [];
    relay.publish = (event) => { later.push(event); };
    const sent = await sendAnswers(inbox, { q: 'Hi' }, anonymousSender(), relay);
    let delivered = false;
    const stop = watchDelivered(sent.events, relay, () => { delivered = true; });
    publish(later[0]!);
    await settle();
    expect(delivered).toBe(false);
    publish(later[1]!);
    await settle();
    expect(delivered).toBe(true);
    stop();
  });

  it('reads nothing without the inbox key, or for another form', async () => {
    const relay = memoryRelay();
    const one = createInbox();
    const other = createInbox();
    await sendAnswers(one.inbox, { q: 'For one' }, anonymousSender(), relay);
    expect(() => receiveAnswers(one.inbox, other.privateKey, relay, () => {})).toThrow();
    const got: ReceivedAnswers[] = [];
    const stop = receiveAnswers(other.inbox, other.privateKey, relay, (received) => got.push(received));
    await settle();
    stop();
    expect(got).toHaveLength(0);
  });

  it('does not take answers made with a wrong secret', async () => {
    const relay = memoryRelay();
    const { inbox, privateKey } = createInbox();
    await sendAnswers({ ...inbox, secret: createInbox().inbox.secret }, { q: 'Guess' }, anonymousSender(), relay);
    const got: ReceivedAnswers[] = [];
    const stop = receiveAnswers(inbox, privateKey, relay, (received) => got.push(received));
    await settle();
    stop();
    expect(got).toHaveLength(0);
  });
});
