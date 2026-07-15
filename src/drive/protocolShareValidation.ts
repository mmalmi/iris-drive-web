import type { Event } from 'nostr-tools';
import type { SharedFolder, SignedShareMemberRosterOp } from './protocolTypes';
import { stableStringify } from './protocolJson';
import { parseShareMemberRosterOpEvent } from './protocolShareEvents';
import { normalizeShareMemberRosterOpContent } from './protocolShareNormalize';

export function validateSignedShareMemberRosterOps(folder: SharedFolder): void {
  for (const signed of folder.member_ops ?? []) {
    validateSignedShareMemberRosterOp(signed);
  }
}

export function signedShareMemberRosterOpIsValid(signed: SignedShareMemberRosterOp): boolean {
  try {
    validateSignedShareMemberRosterOp(signed);
    return true;
  } catch {
    return false;
  }
}

export function validateSignedShareMemberRosterOp(signed: SignedShareMemberRosterOp): void {
  try {
    const parsed = parseShareMemberRosterOpEvent(JSON.parse(signed.event_json) as Event);
    if (
      parsed.op_id !== signed.op_id
      || parsed.signer_pubkey !== signed.signer_pubkey
      || stableStringify(normalizeShareMemberRosterOpContent(parsed.content))
        !== stableStringify(normalizeShareMemberRosterOpContent(signed.content))
    ) {
      throw new Error('op event_json does not match op fields');
    }
  } catch (error) {
    throw new Error(`share member roster ${error instanceof Error ? error.message : String(error)}`);
  }
}
