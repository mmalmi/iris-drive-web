import { nip19 } from 'nostr-tools';
import type {
  IrisProfileFacet,
  IrisProfileId,
  IrisProfileKeyPurpose,
  IrisProfileRosterProjection,
  ResolvedShareRecipient,
  ShareRecipient,
  ShareRecipientProfileEvidence,
  ShareRole,
  SharedFolder,
  SignedIrisProfileFacetAcceptance,
  SignedIrisProfileRosterOp,
} from './protocolTypes';
import { isHex32 } from './protocolJson';
import { projectIrisProfileRoster } from './protocolProfileProjection';
import { activeShareKeyRecipients } from './protocolShareAccess';

export function sharedFolderKeyRecipientPubkeys(folder: SharedFolder): string[] {
  const projection = projectIrisProfileRoster(folder.share_id, folder.roster_ops ?? []);
  return activeShareKeyRecipients(folder, projection);
}

export function resolveShareRecipientFromProfileEvidence(
  profileId: IrisProfileId,
  representativePubkey: string,
  rosterOps: SignedIrisProfileRosterOp[],
  acceptances: SignedIrisProfileFacetAcceptance[],
  displayName?: string,
): ResolvedShareRecipient {
  const normalizedRepresentative = representativePubkey.trim().toLowerCase();
  if (!isHex32(normalizedRepresentative)) {
    throw new Error('representative pubkey is invalid');
  }
  const projection = projectIrisProfileRoster(profileId, rosterOps);
  const representativeFacet = projection.active_facets[normalizedRepresentative];
  if (!representativeFacet) {
    throw new Error(`representative pubkey is not active in IrisProfile ${profileId}`);
  }
  if (!representativeHasActiveSelfLink(projection, normalizedRepresentative, representativeFacet, acceptances)) {
    throw new Error('representative pubkey has no active self-signed profile link');
  }
  const appPubkeys = acceptedShareAppPubkeys(projection, acceptances);
  if (appPubkeys.length === 0) {
    throw new Error('resolved IrisProfile has no accepted AppKeys for sharing');
  }
  return {
    profile_id: profileId,
    representative_pubkey: normalizedRepresentative,
    representative_npub: nip19.npubEncode(normalizedRepresentative),
    display_name: displayName ?? representativeFacet.label,
    app_pubkeys: appPubkeys,
    linked_social_pubkeys: acceptedSocialPubkeys(projection, acceptances),
  };
}

export function resolveShareRecipientFromEvidence(
  evidence: ShareRecipientProfileEvidence,
  displayName?: string,
): ResolvedShareRecipient {
  const representativePubkey = evidenceRepresentativePubkey(evidence);
  return resolveShareRecipientFromProfileEvidence(
    evidence.profile_id,
    representativePubkey,
    evidence.roster_ops ?? [],
    evidence.acceptances ?? evidence.facet_acceptances ?? [],
    displayName ?? evidence.display_name,
  );
}

export function shareRecipientsForResolvedRecipient(
  recipient: ResolvedShareRecipient,
  role: ShareRole,
): ShareRecipient[] {
  return recipient.app_pubkeys.map((appPubkey) => ({
    profile_id: recipient.profile_id,
    app_pubkey: appPubkey,
    role,
    representative_npub_hint: recipient.representative_npub,
    display_name: recipient.display_name,
  }));
}

export function representativeHasActiveSelfLink(
  projection: IrisProfileRosterProjection,
  representativePubkey: string,
  facet: IrisProfileFacet,
  acceptances: SignedIrisProfileFacetAcceptance[],
): boolean {
  return (
    facetHasPurpose(facet, 'social_profile')
    && hasActiveFacetAcceptance(projection, representativePubkey, 'social_profile', acceptances)
  ) || (
    facetHasPurpose(facet, 'app_key')
    && hasActiveFacetAcceptance(projection, representativePubkey, 'app_key', acceptances)
  );
}

export function evidenceRepresentativePubkey(evidence: ShareRecipientProfileEvidence): string {
  const pubkey = evidence.representative_pubkey?.trim().toLowerCase();
  if (pubkey) {
    if (!isHex32(pubkey)) throw new Error('representative pubkey is invalid');
    return pubkey;
  }
  const npub = evidence.representative_npub?.trim();
  if (npub) {
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub' && typeof decoded.data === 'string') {
        return decoded.data.toLowerCase();
      }
    } catch {
      throw new Error('representative npub is invalid');
    }
  }
  throw new Error('recipient evidence is missing representative pubkey');
}

export function acceptedShareAppPubkeys(
  projection: IrisProfileRosterProjection,
  acceptances: SignedIrisProfileFacetAcceptance[],
): string[] {
  return Object.values(projection.active_facets)
    .filter((facet) => facetHasPurpose(facet, 'app_key'))
    .filter((facet) => Boolean(facet.capabilities?.can_receive_key_wraps))
    .filter((facet) => hasActiveFacetAcceptance(projection, facet.pubkey, 'app_key', acceptances))
    .map((facet) => facet.pubkey)
    .sort();
}

export function acceptedSocialPubkeys(
  projection: IrisProfileRosterProjection,
  acceptances: SignedIrisProfileFacetAcceptance[],
): string[] {
  return Object.values(projection.active_facets)
    .filter((facet) => facetHasPurpose(facet, 'social_profile'))
    .filter((facet) => hasActiveFacetAcceptance(projection, facet.pubkey, 'social_profile', acceptances))
    .map((facet) => facet.pubkey)
    .sort();
}

export function hasActiveFacetAcceptance(
  projection: IrisProfileRosterProjection,
  facetPubkey: string,
  purpose: IrisProfileKeyPurpose,
  acceptances: SignedIrisProfileFacetAcceptance[],
): boolean {
  return acceptances.some((acceptance) => (
    acceptance.content.facet_pubkey === facetPubkey
    && acceptance.content.profile_id === projection.profile_id
    && acceptance.content.purposes.includes(purpose)
    && isFacetAcceptanceActiveInRoster(acceptance, projection)
  ));
}

export function isFacetAcceptanceActiveInRoster(
  acceptance: SignedIrisProfileFacetAcceptance,
  projection: IrisProfileRosterProjection,
): boolean {
  if (acceptance.content.profile_id !== projection.profile_id) return false;
  const facet = projection.active_facets[acceptance.content.facet_pubkey];
  if (!facet) return false;
  return acceptance.content.purposes.every((purpose) => facetHasPurpose(facet, purpose));
}

export function facetHasPurpose(facet: IrisProfileFacet, purpose: IrisProfileKeyPurpose): boolean {
  return Boolean(facet.purposes?.includes(purpose));
}
