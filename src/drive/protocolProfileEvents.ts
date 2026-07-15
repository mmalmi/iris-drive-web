import {
  buildNostrIdentityFacetAcceptanceEvent as buildIdentityNostrIdentityFacetAcceptanceEvent,
  buildNostrIdentityRosterOpEvent as buildIdentityNostrIdentityRosterOpEvent,
  parseNostrIdentityFacetAcceptanceEvent as parseIdentityNostrIdentityFacetAcceptanceEvent,
  parseNostrIdentityRosterOpEvent as parseIdentityNostrIdentityRosterOpEvent,
  signNostrIdentityFacetAcceptance as signIdentityNostrIdentityFacetAcceptance,
  signNostrIdentityRosterOp as signIdentityNostrIdentityRosterOp,
} from 'nostr-social-graph';
import type { Event } from 'nostr-tools';
import type {
  BuildNostrIdentityFacetAcceptanceEventOptions,
  BuildNostrIdentityRosterOpEventOptions,
  SignedNostrIdentityFacetAcceptance,
  SignedNostrIdentityRosterOp,
} from './protocolTypes';

export function buildNostrIdentityRosterOpEvent(options: BuildNostrIdentityRosterOpEventOptions): Event {
  return buildIdentityNostrIdentityRosterOpEvent(options);
}

export function signNostrIdentityRosterOp(
  options: BuildNostrIdentityRosterOpEventOptions,
): SignedNostrIdentityRosterOp {
  return normalizeSignedRosterOp(signIdentityNostrIdentityRosterOp(options));
}

export function buildNostrIdentityFacetAcceptanceEvent(
  options: BuildNostrIdentityFacetAcceptanceEventOptions,
): Event {
  return buildIdentityNostrIdentityFacetAcceptanceEvent(options);
}

export function signNostrIdentityFacetAcceptance(
  options: BuildNostrIdentityFacetAcceptanceEventOptions,
): SignedNostrIdentityFacetAcceptance {
  return signIdentityNostrIdentityFacetAcceptance(options);
}

export function parseNostrIdentityRosterOpEvent(event: Event): SignedNostrIdentityRosterOp {
  return normalizeSignedRosterOp(parseIdentityNostrIdentityRosterOpEvent(event));
}

export function parseNostrIdentityFacetAcceptanceEvent(event: Event): SignedNostrIdentityFacetAcceptance {
  return parseIdentityNostrIdentityFacetAcceptanceEvent(event);
}

function normalizeSignedRosterOp(signed: SignedNostrIdentityRosterOp): SignedNostrIdentityRosterOp {
  return {
    ...signed,
    content: {
      ...signed.content,
      parents: signed.content.parents ?? [],
    },
  };
}
