import type { UserIndexEntry } from '../stores/searchIndex';
import {
  rankShareContacts,
  representativePubkey,
  representativeNpub,
  type RankedShareContact,
  type ShareContactCandidate,
} from './shareContacts';
import {
  resolveShareRecipientFromEvidence,
  type ShareRecipientProfileEvidence,
} from './protocol';

export type { RankedShareContact } from './shareContacts';

export interface ShareContactGraphLookup {
  getFollowDistance?: (pubkey: string) => number | Promise<number>;
  followedByFriendsCount?: (pubkey: string) => number | Promise<number>;
  getFollowedByFriends?: (pubkey: string) => string[] | Promise<string[]>;
}

export interface SearchShareContactsOptions {
  limit?: number;
  userSearch?: (query: string, limit: number) => Promise<UserIndexEntry[]>;
  graph?: ShareContactGraphLookup | null;
}

export async function searchShareContacts(
  query: string,
  options: SearchShareContactsOptions = {},
): Promise<RankedShareContact[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const evidenceContact = rankedShareContactFromRecipientEvidenceJson(trimmed);
  if (evidenceContact) return [evidenceContact];

  const limit = options.limit ?? 8;
  const userSearch = options.userSearch ?? defaultUserSearch;
  const users = await userSearch(trimmed, Math.max(limit * 3, 12));
  const graph = options.graph === undefined ? await defaultShareContactGraph() : options.graph;
  const rankedUsers = await rankUserShareContacts(trimmed, users, graph, limit);
  const directContact = await rankedShareContactFromRepresentativeInput(trimmed, graph);
  return mergeRankedShareContacts([
    ...rankedUsers,
    ...(directContact ? [directContact] : []),
  ], limit);
}

export async function rankUserShareContacts(
  query: string,
  users: UserIndexEntry[],
  graph?: ShareContactGraphLookup | null,
  limit = 8,
): Promise<RankedShareContact[]> {
  const candidates = shareContactCandidatesFromUsers(users);
  if (!graph) {
    return rankShareContacts(query, candidates, undefined, limit);
  }

  const scores = await Promise.all(candidates.map(async (candidate) => {
    const pubkey = candidate.pubkey.toLowerCase();
    const [distance, friendFollowers] = await Promise.all([
      graph.getFollowDistance ? graph.getFollowDistance(pubkey) : -1,
      friendFollowerCount(graph, pubkey),
    ]);
    return [pubkey, Number(distance), Number(friendFollowers)] as const;
  }));
  const distances = new Map(scores.map(([pubkey, distance]) => [pubkey, distance]));
  const friendFollowerCounts = new Map(scores.map(([pubkey, , count]) => [pubkey, count]));

  return rankShareContacts(query, candidates, {
    getFollowDistance(pubkey: string) {
      return distances.get(pubkey.toLowerCase()) ?? -1;
    },
    followedByFriendsCount(pubkey: string) {
      return friendFollowerCounts.get(pubkey.toLowerCase()) ?? 0;
    },
  }, limit);
}

export function shareContactCandidatesFromUsers(users: UserIndexEntry[]): ShareContactCandidate[] {
  return users.map((user) => ({
    pubkey: user.pubkey,
    npub: user.npub,
    displayName: user.displayName || user.name,
    nip05: user.nip05,
    irisProfileId: user.irisProfileId,
    linkedNpubs: user.linkedNpubs,
    shareRecipientEvidenceJson: user.shareRecipientEvidenceJson,
  }));
}

export function rankedShareContactFromRecipientEvidenceJson(input: string): RankedShareContact | null {
  let evidence: ShareRecipientProfileEvidence;
  try {
    evidence = JSON.parse(input) as ShareRecipientProfileEvidence;
  } catch {
    return null;
  }

  try {
    const resolved = resolveShareRecipientFromEvidence(evidence);
    const linkedNpubs = resolved.linked_social_pubkeys
      .map(representativeNpub)
      .filter((npub): npub is string => npub !== null);
    return {
      representative_npub: resolved.representative_npub,
      pubkey: resolved.representative_pubkey,
      display_name: resolved.display_name || evidence.display_name || resolved.representative_npub.slice(0, 12),
      iris_profile_id: resolved.profile_id,
      linked_npubs: Array.from(new Set([resolved.representative_npub, ...linkedNpubs])).sort(),
      recipient_evidence_json: input,
      score: 10,
    };
  } catch {
    return null;
  }
}

export async function rankedShareContactFromRepresentativeInput(
  input: string,
  graph?: ShareContactGraphLookup | null,
): Promise<RankedShareContact | null> {
  const pubkey = representativePubkey(input);
  if (!pubkey) return null;
  const npub = representativeNpub(pubkey);
  if (!npub) return null;

  const [distance, friendFollowers] = graph
    ? await Promise.all([
      graph.getFollowDistance ? graph.getFollowDistance(pubkey) : -1,
      friendFollowerCount(graph, pubkey),
    ])
    : [-1, 0];
  const graphScore = distance >= 0 ? Math.max(0, 1 - Number(distance) / 8) : 0;
  const socialScore = graphScore + Math.min(Number(friendFollowers), 20) / 100;

  return {
    representative_npub: npub,
    pubkey,
    display_name: npub.slice(0, 12),
    linked_npubs: [npub],
    score: 0.8 + socialScore,
  };
}

function mergeRankedShareContacts(
  contacts: RankedShareContact[],
  limit: number,
): RankedShareContact[] {
  const byNpub = new Map<string, RankedShareContact>();
  for (const contact of contacts) {
    const existing = byNpub.get(contact.representative_npub);
    if (!existing || preferShareContact(contact, existing) === contact) {
      byNpub.set(contact.representative_npub, contact);
    }
  }
  return [...byNpub.values()]
    .sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name))
    .slice(0, limit);
}

function preferShareContact(
  candidate: RankedShareContact,
  existing: RankedShareContact,
): RankedShareContact {
  if (!!candidate.recipient_evidence_json !== !!existing.recipient_evidence_json) {
    return candidate.recipient_evidence_json ? candidate : existing;
  }
  if (!!candidate.iris_profile_id !== !!existing.iris_profile_id) {
    return candidate.iris_profile_id ? candidate : existing;
  }
  if (hasHumanDisplay(candidate) !== hasHumanDisplay(existing)) {
    return hasHumanDisplay(candidate) ? candidate : existing;
  }
  return candidate.score > existing.score ? candidate : existing;
}

function hasHumanDisplay(contact: RankedShareContact): boolean {
  return contact.display_name.trim() !== contact.representative_npub.slice(0, 12);
}

async function friendFollowerCount(graph: ShareContactGraphLookup, pubkey: string): Promise<number> {
  if (graph.followedByFriendsCount) {
    return graph.followedByFriendsCount(pubkey);
  }
  if (graph.getFollowedByFriends) {
    return (await graph.getFollowedByFriends(pubkey)).length;
  }
  return 0;
}

async function defaultUserSearch(query: string, limit: number): Promise<UserIndexEntry[]> {
  const { searchUsers } = await import('../stores/searchIndex');
  return searchUsers(query, limit);
}

async function defaultShareContactGraph(): Promise<ShareContactGraphLookup | null> {
  if (typeof window === 'undefined') return null;
  try {
    const { getWorkerAdapter } = await import('../lib/workerInit');
    return getWorkerAdapter();
  } catch {
    return null;
  }
}
