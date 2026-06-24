import {
  buildIrisProfileFacetAcceptanceEvent as buildIdentityIrisProfileFacetAcceptanceEvent,
  buildIrisProfileRosterOpEvent as buildIdentityIrisProfileRosterOpEvent,
  parseIrisProfileFacetAcceptanceEvent as parseIdentityIrisProfileFacetAcceptanceEvent,
  parseIrisProfileRosterOpEvent as parseIdentityIrisProfileRosterOpEvent,
  signIrisProfileFacetAcceptance as signIdentityIrisProfileFacetAcceptance,
  signIrisProfileRosterOp as signIdentityIrisProfileRosterOp,
} from '@iris/identity/profileEvents';
import type { Event } from 'nostr-tools';
import type {
  BuildIrisProfileFacetAcceptanceEventOptions,
  BuildIrisProfileRosterOpEventOptions,
  SignedIrisProfileFacetAcceptance,
  SignedIrisProfileRosterOp,
} from './protocolTypes';

export function buildIrisProfileRosterOpEvent(options: BuildIrisProfileRosterOpEventOptions): Event {
  return buildIdentityIrisProfileRosterOpEvent(options);
}

export function signIrisProfileRosterOp(
  options: BuildIrisProfileRosterOpEventOptions,
): SignedIrisProfileRosterOp {
  return normalizeSignedRosterOp(signIdentityIrisProfileRosterOp(options));
}

export function buildIrisProfileFacetAcceptanceEvent(
  options: BuildIrisProfileFacetAcceptanceEventOptions,
): Event {
  return buildIdentityIrisProfileFacetAcceptanceEvent(options);
}

export function signIrisProfileFacetAcceptance(
  options: BuildIrisProfileFacetAcceptanceEventOptions,
): SignedIrisProfileFacetAcceptance {
  return signIdentityIrisProfileFacetAcceptance(options);
}

export function parseIrisProfileRosterOpEvent(event: Event): SignedIrisProfileRosterOp {
  return normalizeSignedRosterOp(parseIdentityIrisProfileRosterOpEvent(event));
}

export function parseIrisProfileFacetAcceptanceEvent(event: Event): SignedIrisProfileFacetAcceptance {
  return parseIdentityIrisProfileFacetAcceptanceEvent(event);
}

function normalizeSignedRosterOp(signed: SignedIrisProfileRosterOp): SignedIrisProfileRosterOp {
  return {
    ...signed,
    content: {
      ...signed.content,
      parents: signed.content.parents ?? [],
    },
  };
}
