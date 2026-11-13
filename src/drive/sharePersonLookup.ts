import { verifyEvent, type Event, type Filter } from 'nostr-tools';
import { nostr } from '../nostr';
import { getCurrentNostrIdentitySession, getSecretKey } from '../nostr/auth';
import { publishEvent } from '../lib/nostrPublish';
import {
  KIND_NOSTR_IDENTITY_FACET_ACCEPTANCE,
  KIND_NOSTR_IDENTITY_ROSTER_OP,
  parseNostrIdentityFacetAcceptanceEvent,
  parseNostrIdentityRosterOpEvent,
  resolveShareRecipientFromProfileEvidence,
  signNostrIdentityFacetAcceptance,
  type NostrIdentityId,
  type ResolvedShareRecipient,
  type SignedNostrIdentityFacetAcceptance,
  type SignedNostrIdentityRosterOp,
} from './protocol';

/**
 * Finding the devices of a person to add to a shared folder by their key.
 *
 * A folder key is given to devices, so adding someone means learning which
 * devices are theirs. Their Drive profile's device list is on relays; each
 * device also says there, once, that it belongs to that profile, which is
 * what lets someone else trust the list. This is the one place sharing waits
 * for relays, and only when a person is being added.
 */

const LOOKUP_MS = 8000;
const ACCEPTANCE_KEY = 'iris-drive.share-acceptance.v1';

/** Say once, for this device, that it belongs to its Drive profile, so others can add it to folders. */
export async function publishOwnShareAcceptance(): Promise<void> {
  const session = getCurrentNostrIdentitySession();
  const secretKey = getSecretKey();
  if (!session || session.status !== 'active' || !secretKey) return;
  const added = (session.rosterOps ?? [])
    .filter((op) => op.content.op.op === 'add_facet' && op.content.op.facet.pubkey === session.appKeyPubkey)
    .sort((a, b) => a.content.created_at - b.content.created_at || a.op_id.localeCompare(b.op_id))
    .at(-1);
  if (!added) return;
  const marker = `${session.profileId}:${session.appKeyPubkey}:${added.op_id}`;
  try {
    if (localStorage.getItem(ACCEPTANCE_KEY) === marker) return;
  } catch {
    // Without storage it is sent again next time, which is harmless.
  }
  const acceptance = signNostrIdentityFacetAcceptance({
    signerSecretKey: secretKey,
    profileId: session.profileId,
    purposes: ['app_key'],
    rosterOpId: added.op_id,
    acceptedAt: Math.floor(Date.now() / 1000),
  });
  await publishEvent(JSON.parse(acceptance.event_json) as Event);
  try {
    localStorage.setItem(ACCEPTANCE_KEY, marker);
  } catch {
    // See above.
  }
}

/** Collect events until relays have sent what they hold, or the time is up. */
function collect(filter: Filter, timeoutMs: number): Promise<Event[]> {
  return new Promise((resolve) => {
    const events: Event[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub.stop();
      resolve(events);
    };
    const sub = nostr.subscribe(filter, { closeAfterHistory: true });
    const timer = setTimeout(finish, timeoutMs);
    sub.on('event', (event: Event) => {
      try {
        if (verifyEvent(event)) events.push(event);
      } catch {
        // Ignore what does not verify.
      }
    });
    sub.on('history', finish);
  });
}

function profileIdOf(event: Event): NostrIdentityId | null {
  try {
    return parseNostrIdentityRosterOpEvent(event).content.profile_id;
  } catch {
    // Not a roster change; it may be an acceptance.
  }
  try {
    return parseNostrIdentityFacetAcceptanceEvent(event).content.profile_id;
  } catch {
    return null;
  }
}

/**
 * The Drive user behind a key and the devices to add for them, or null when
 * relays know of none. Only a profile the key itself has signed for counts.
 */
export async function findShareRecipient(pubkey: string, timeoutMs = LOOKUP_MS): Promise<ResolvedShareRecipient | null> {
  const kinds = [...new Set([KIND_NOSTR_IDENTITY_ROSTER_OP, KIND_NOSTR_IDENTITY_FACET_ACCEPTANCE])];
  const own = await collect({ kinds, authors: [pubkey], '#p': [pubkey], limit: 200 }, timeoutMs);
  const profileIds = [...new Set(own.map(profileIdOf).filter((id): id is NostrIdentityId => Boolean(id)))];
  for (const profileId of profileIds) {
    const events = await collect({ kinds, '#i': [profileId], limit: 1000 }, timeoutMs);
    const rosterOps: SignedNostrIdentityRosterOp[] = [];
    const acceptances: SignedNostrIdentityFacetAcceptance[] = [];
    for (const event of [...own, ...events]) {
      try {
        rosterOps.push(parseNostrIdentityRosterOpEvent(event));
        continue;
      } catch {
        // Try it as an acceptance.
      }
      try {
        acceptances.push(parseNostrIdentityFacetAcceptanceEvent(event));
      } catch {
        // Neither.
      }
    }
    const unique = <T extends { op_id?: string; event_json: string }>(items: T[]) =>
      [...new Map(items.map((item) => [item.event_json, item])).values()];
    try {
      return resolveShareRecipientFromProfileEvidence(
        profileId,
        pubkey,
        unique(rosterOps).filter((op) => op.content.profile_id === profileId)
          .sort((a, b) => a.content.created_at - b.content.created_at || a.op_id.localeCompare(b.op_id)),
        unique(acceptances),
      );
    } catch {
      // This profile cannot be used; try the next one.
    }
  }
  return null;
}
