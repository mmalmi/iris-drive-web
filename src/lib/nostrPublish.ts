import type { Event, EventTemplate } from 'nostr-tools';
import { nostr } from '../nostr';

export async function publishEvent(event: Event | EventTemplate): Promise<Event> {
  const signed = 'sig' in event ? event : await nostr.signEvent(event);
  await nostr.publish(signed);
  return signed;
}
