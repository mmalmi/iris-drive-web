import type { IrisProfileId } from './protocolTypes';
import { isUuid } from './protocolJson';

export function irisProfileRosterOpDTag(profileId: IrisProfileId, clientNonce: string): string {
  return `iris-profile/${profileId}/roster-op/${clientNonce}`;
}

export function irisProfileFacetAcceptanceDTag(profileId: IrisProfileId, clientNonce: string): string {
  return `iris-profile/${profileId}/facet-acceptance/${clientNonce}`;
}

export function shareRosterCheckpointDTag(shareId: IrisProfileId, clientNonce: string): string {
  return `iris-drive/share/${shareId}/roster-checkpoint/${clientNonce}`;
}

export function shareMemberRosterOpDTag(shareId: IrisProfileId, clientNonce: string): string {
  return `iris-drive/share/${shareId}/member-roster-op/${clientNonce}`;
}

export function appKeyLinkRequestDTag(profileId: IrisProfileId): string {
  // Legacy parse-only request coordinate. Current device-link requests are
  // identity fact events addressed by `i`/`p` tags.
  return `iris-drive/${profileId}/app-key-link-request`;
}

export function parseIrisProfileRosterOpDTag(dTag: string): { profileId: IrisProfileId; nonce: string } {
  const rest = dTag.startsWith('iris-profile/') ? dTag.slice('iris-profile/'.length) : '';
  const split = rest.indexOf('/roster-op/');
  if (split <= 0) {
    throw new Error(`invalid IrisProfile roster d tag: ${dTag}`);
  }
  const profileId = rest.slice(0, split);
  const nonce = rest.slice(split + '/roster-op/'.length);
  if (!isUuid(profileId) || !nonce || nonce.includes('/')) {
    throw new Error(`invalid IrisProfile roster d tag: ${dTag}`);
  }
  return { profileId, nonce };
}

export function parseIrisProfileFacetAcceptanceDTag(dTag: string): { profileId: IrisProfileId; nonce: string } {
  const rest = dTag.startsWith('iris-profile/') ? dTag.slice('iris-profile/'.length) : '';
  const split = rest.indexOf('/facet-acceptance/');
  if (split <= 0) {
    throw new Error(`invalid IrisProfile facet acceptance d tag: ${dTag}`);
  }
  const profileId = rest.slice(0, split);
  const nonce = rest.slice(split + '/facet-acceptance/'.length);
  if (!isUuid(profileId) || !nonce || nonce.includes('/')) {
    throw new Error(`invalid IrisProfile facet acceptance d tag: ${dTag}`);
  }
  return { profileId, nonce };
}

export function parseShareRosterCheckpointDTag(dTag: string): { shareId: IrisProfileId; nonce: string } {
  const rest = dTag.startsWith('iris-drive/share/') ? dTag.slice('iris-drive/share/'.length) : '';
  const split = rest.indexOf('/roster-checkpoint/');
  if (split <= 0) {
    throw new Error(`invalid share roster checkpoint d tag: ${dTag}`);
  }
  const shareId = rest.slice(0, split);
  const nonce = rest.slice(split + '/roster-checkpoint/'.length);
  if (!isUuid(shareId) || !nonce || nonce.includes('/')) {
    throw new Error(`invalid share roster checkpoint d tag: ${dTag}`);
  }
  return { shareId, nonce };
}

export function parseShareMemberRosterOpDTag(dTag: string): { shareId: IrisProfileId; nonce: string } {
  const rest = dTag.startsWith('iris-drive/share/') ? dTag.slice('iris-drive/share/'.length) : '';
  const split = rest.indexOf('/member-roster-op/');
  if (split <= 0) {
    throw new Error(`invalid share member roster d tag: ${dTag}`);
  }
  const shareId = rest.slice(0, split);
  const nonce = rest.slice(split + '/member-roster-op/'.length);
  if (!isUuid(shareId) || !nonce || nonce.includes('/')) {
    throw new Error(`invalid share member roster d tag: ${dTag}`);
  }
  return { shareId, nonce };
}
