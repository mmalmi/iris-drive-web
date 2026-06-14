import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools';
import {
  KIND_SHARE_MEMBER_ROSTER_OP,
  KIND_SHARE_ROSTER_CHECKPOINT,
  SHARE_MEMBER_ROSTER_SCHEMA,
  SHARE_ROSTER_CHECKPOINT_SCHEMA,
  type BuildShareRosterCheckpointEventOptions,
  type IrisProfileId,
  type ShareMemberRosterOpContent,
  type ShareMemberRosterProjection,
  type ShareRosterCheckpointContent,
  type SharedFolder,
  type SignedIrisProfileRosterOp,
  type SignedShareMemberRosterOp,
  type SignedShareRosterCheckpoint,
} from './protocolTypes';
import {
  currentUnixSeconds,
  parseObject,
  randomClientNonce,
  requireIdentifier,
  requireKind,
  requireValidSignature,
  stableStringify,
} from './protocolJson';
import {
  parseShareMemberRosterOpDTag,
  parseShareRosterCheckpointDTag,
  shareRosterCheckpointDTag,
} from './protocolDtags';
import { projectIrisProfileRoster } from './protocolProfileProjection';
import { validateSignedIrisProfileRosterOps } from './protocolProfileValidation';
import {
  activeShareAppKeyPubkeys,
  activeShareKeyRecipients,
  latestKeyEpoch,
  sharedFolderAppKeyCanAdmin,
  shareMemberViews,
  tombstonedShareAppKeyPubkeys,
} from './protocolShareAccess';
import { projectSharedFolderMemberRoster } from './protocolShareProjection';
import { normalizeShareMemberRosterOpContent, validateShareMemberRosterOp } from './protocolShareNormalize';
import { validateSignedShareMemberRosterOps } from './protocolShareValidation';

export function buildShareRosterCheckpointEvent(options: BuildShareRosterCheckpointEventOptions): Event {
  const signerPubkey = getPublicKey(options.signerSecretKey);
  if (!sharedFolderAppKeyCanAdmin(options.folder, projectIrisProfileRoster(
    options.folder.share_id,
    options.folder.roster_ops ?? [],
  ), signerPubkey)) {
    throw new Error('current AppKey cannot administer this share');
  }
  const createdAt = options.createdAt ?? currentUnixSeconds();
  const clientNonce = options.clientNonce ?? randomClientNonce();
  const content = shareRosterCheckpointContent(options.folder, signerPubkey, clientNonce, createdAt);
  return finalizeEvent({
    kind: KIND_SHARE_ROSTER_CHECKPOINT,
    content: JSON.stringify(content),
    created_at: createdAt,
    tags: [
      ['d', shareRosterCheckpointDTag(options.folder.share_id, clientNonce)],
      ['i', options.folder.share_id],
      ['p', signerPubkey],
    ],
  }, options.signerSecretKey);
}

export function signShareRosterCheckpoint(
  options: BuildShareRosterCheckpointEventOptions,
): SignedShareRosterCheckpoint {
  return parseShareRosterCheckpointEvent(buildShareRosterCheckpointEvent(options));
}

export function parseShareRosterCheckpointEvent(event: Event): SignedShareRosterCheckpoint {
  requireKind(event, KIND_SHARE_ROSTER_CHECKPOINT);
  const dTag = requireIdentifier(event);
  const { shareId, nonce } = parseShareRosterCheckpointDTag(dTag);
  requireValidSignature(event);
  const content = parseObject(event.content) as unknown as ShareRosterCheckpointContent;
  if (content.schema !== SHARE_ROSTER_CHECKPOINT_SCHEMA) {
    throw new Error(`unsupported share roster checkpoint schema ${content.schema}`);
  }
  if (content.share_id !== shareId) {
    throw new Error(`share checkpoint d tag ${shareId} does not match content ${content.share_id}`);
  }
  if (content.client_nonce !== nonce) {
    throw new Error(`share checkpoint d tag nonce ${nonce} does not match content ${content.client_nonce}`);
  }
  if (content.created_at !== event.created_at) {
    throw new Error(`share checkpoint created_at ${event.created_at} does not match content ${content.created_at}`);
  }
  if (content.signer_pubkey !== event.pubkey) {
    throw new Error(`share checkpoint signer ${event.pubkey} does not match content ${content.signer_pubkey}`);
  }
  return {
    checkpoint_id: event.id,
    signer_pubkey: event.pubkey,
    content,
    event_json: JSON.stringify(event),
  };
}

export function parseShareMemberRosterOpEvent(event: Event): SignedShareMemberRosterOp {
  requireKind(event, KIND_SHARE_MEMBER_ROSTER_OP);
  const dTag = requireIdentifier(event);
  const { shareId, nonce } = parseShareMemberRosterOpDTag(dTag);
  requireValidSignature(event);
  const content = normalizeShareMemberRosterOpContent(
    parseObject(event.content) as unknown as ShareMemberRosterOpContent,
  );
  if (content.schema !== SHARE_MEMBER_ROSTER_SCHEMA) {
    throw new Error(`unsupported share member roster schema ${content.schema}`);
  }
  if (content.share_id !== shareId) {
    throw new Error(`share member roster d tag ${shareId} does not match content ${content.share_id}`);
  }
  if (content.client_nonce !== nonce) {
    throw new Error(`share member roster d tag nonce ${nonce} does not match content ${content.client_nonce}`);
  }
  if (content.created_at !== event.created_at) {
    throw new Error(`share member roster created_at ${event.created_at} does not match content ${content.created_at}`);
  }
  if (content.actor_pubkey !== event.pubkey) {
    throw new Error(`share member roster signer ${event.pubkey} does not match actor ${content.actor_pubkey}`);
  }
  validateShareMemberRosterOp(content.op);
  return {
    op_id: event.id,
    signer_pubkey: event.pubkey,
    content,
    event_json: JSON.stringify(event),
  };
}

export function validateShareRosterCheckpoint(
  folder: SharedFolder,
  checkpoint: SignedShareRosterCheckpoint,
): void {
  validateSignedIrisProfileRosterOps(folder);
  validateSignedShareMemberRosterOps(folder);
  const parsed = parseShareRosterCheckpointEvent(JSON.parse(checkpoint.event_json) as Event);
  if (
    parsed.checkpoint_id !== checkpoint.checkpoint_id
    || parsed.signer_pubkey !== checkpoint.signer_pubkey
    || stableStringify(parsed.content) !== stableStringify(checkpoint.content)
  ) {
    throw new Error('share roster checkpoint event_json does not match checkpoint fields');
  }
  const projection = projectIrisProfileRoster(folder.share_id, folder.roster_ops ?? []);
  if (!sharedFolderAppKeyCanAdmin(folder, projection, checkpoint.signer_pubkey)) {
    throw new Error('share roster checkpoint signer cannot administer this share');
  }
  const expected = shareRosterCheckpointContent(
    folder,
    checkpoint.signer_pubkey,
    checkpoint.content.client_nonce,
    checkpoint.content.created_at,
  );
  if (stableStringify(expected) !== stableStringify(checkpoint.content)) {
    throw new Error('share roster checkpoint does not match share roster projection');
  }
}

export function shareRosterCheckpointContent(
  folder: SharedFolder,
  signerPubkey: string,
  clientNonce: string,
  createdAt: number,
): ShareRosterCheckpointContent {
  const projection = projectIrisProfileRoster(folder.share_id, folder.roster_ops ?? []);
  const memberProjection = projectSharedFolderMemberRoster(folder, projection);
  const currentKeyEpoch = latestKeyEpoch(projection);
  const missingKeyWrapPubkeys = currentKeyEpoch === undefined
    ? []
    : activeShareKeyRecipients(folder, projection)
      .filter((pubkey) => !projection.key_epochs[String(currentKeyEpoch)]?.wrapped_dck[pubkey]);
  return {
    schema: SHARE_ROSTER_CHECKPOINT_SCHEMA,
    share_id: folder.share_id,
    signer_pubkey: signerPubkey,
    roster_head_op_ids: shareRosterHeadOpIds(folder.share_id, folder.roster_ops ?? []),
    ...(memberProjection.accepted_op_ids.length
      ? {
        member_roster_head_op_ids: shareMemberRosterHeadOpIds(
          folder.share_id,
          folder.member_ops ?? [],
          memberProjection,
        ),
        accepted_member_op_count: memberProjection.accepted_op_ids.length,
      }
      : {}),
    accepted_op_count: projection.accepted_op_ids.length,
    rejected_op_count: projection.rejected_op_ids.length,
    ...(memberProjection.rejected_op_ids.length
      ? { rejected_member_op_count: memberProjection.rejected_op_ids.length }
      : {}),
    active_app_key_pubkeys: activeShareAppKeyPubkeys(folder, projection),
    tombstoned_app_key_pubkeys: tombstonedShareAppKeyPubkeys(folder, projection),
    current_key_epoch: currentKeyEpoch,
    ...(missingKeyWrapPubkeys.length ? { missing_key_wrap_pubkeys: missingKeyWrapPubkeys } : {}),
    members: shareMemberViews(folder, projection),
    client_nonce: clientNonce,
    created_at: createdAt,
  };
}

export function shareRosterHeadOpIds(shareId: IrisProfileId, ops: SignedIrisProfileRosterOp[]): string[] {
  const projection = projectIrisProfileRoster(shareId, ops);
  const accepted = new Set(projection.accepted_op_ids);
  const parented = new Set<string>();
  for (const op of ops) {
    if (!accepted.has(op.op_id)) continue;
    for (const parent of op.content.parents ?? []) {
      if (accepted.has(parent)) parented.add(parent);
    }
  }
  return projection.accepted_op_ids.filter((opId) => !parented.has(opId)).sort();
}

export function shareMemberRosterHeadOpIds(
  shareId: IrisProfileId,
  ops: SignedShareMemberRosterOp[],
  projection: ShareMemberRosterProjection,
): string[] {
  const accepted = new Set(projection.accepted_op_ids);
  const parented = new Set<string>();
  for (const op of ops) {
    if (op.content.share_id !== shareId || !accepted.has(op.op_id)) continue;
    for (const parent of op.content.parents ?? []) {
      if (accepted.has(parent)) parented.add(parent);
    }
  }
  return projection.accepted_op_ids.filter((opId) => !parented.has(opId)).sort();
}
