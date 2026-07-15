import type { SocialGraph } from 'nostr-social-graph';
import { nip19 } from 'nostr-tools';

export interface ShareContactCandidate {
  pubkey: string;
  npub?: string;
  displayName?: string;
  nip05?: string;
  nostrIdentityId?: string;
  linkedNpubs?: string[];
  shareRecipientEvidenceJson?: string;
}

export interface RankedShareContact {
  representative_npub: string;
  pubkey: string;
  display_name: string;
  nostr_identity_id?: string;
  linked_npubs: string[];
  recipient_evidence_json?: string;
  score: number;
}

type ShareSocialGraph = Pick<SocialGraph, 'getFollowDistance' | 'followedByFriendsCount'>;

export function rankShareContacts(
  query: string,
  candidates: ShareContactCandidate[],
  graph?: ShareSocialGraph,
  limit = 20,
): RankedShareContact[] {
  const normalizedQuery = query.trim().toLowerCase();
  return candidates
    .map((candidate) => rankedShareContact(candidate, normalizedQuery, graph))
    .filter((contact): contact is RankedShareContact => contact !== null)
    .sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name))
    .slice(0, limit);
}

export function representativeNpub(pubkeyOrNpub: string): string | null {
  const pubkey = representativePubkey(pubkeyOrNpub);
  return pubkey ? nip19.npubEncode(pubkey) : null;
}

export function representativePubkey(pubkeyOrNpub: string): string | null {
  const value = pubkeyOrNpub.trim().replace(/^nostr:/i, '');
  if (!value) return null;
  if (value.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(value);
      return decoded.type === 'npub' && typeof decoded.data === 'string'
        ? decoded.data.toLowerCase()
        : null;
    } catch {
      return null;
    }
  }
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return value.toLowerCase();
  }
  return null;
}

function rankedShareContact(
  candidate: ShareContactCandidate,
  query: string,
  graph?: ShareSocialGraph,
): RankedShareContact | null {
  const npub = representativeNpub(candidate.npub ?? candidate.pubkey);
  if (!npub) return null;
  const display = candidate.displayName?.trim() || candidate.nip05?.trim() || npub.slice(0, 12);
  const haystack = [
    display,
    candidate.nip05,
    npub,
    candidate.nostrIdentityId,
    ...(candidate.linkedNpubs ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (query && !haystack.includes(query)) return null;

  const followDistance = graph?.getFollowDistance(candidate.pubkey);
  const friendFollowers = graph?.followedByFriendsCount(candidate.pubkey) ?? 0;
  const graphScore = followDistance === undefined || followDistance < 0
    ? 0
    : Math.max(0, 1 - followDistance / 8);
  const queryScore = query && display.toLowerCase().startsWith(query) ? 1 : query ? 0.6 : 0.4;
  const socialScore = graphScore + Math.min(friendFollowers, 20) / 100;
  const linkedNpubs = (candidate.linkedNpubs ?? [])
    .map(representativeNpub)
    .filter((linkedNpub): linkedNpub is string => linkedNpub !== null);

  return {
    representative_npub: npub,
    pubkey: candidate.pubkey.toLowerCase(),
    display_name: display,
    nostr_identity_id: candidate.nostrIdentityId,
    linked_npubs: Array.from(new Set([npub, ...linkedNpubs])).sort(),
    recipient_evidence_json: candidate.shareRecipientEvidenceJson,
    score: queryScore + socialScore,
  };
}
