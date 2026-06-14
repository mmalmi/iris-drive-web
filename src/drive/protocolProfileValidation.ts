import type { Event } from 'nostr-tools';
import type { SharedFolder, SignedIrisProfileRosterOp } from './protocolTypes';
import { stableStringify } from './protocolJson';
import { parseIrisProfileRosterOpEvent } from './protocolProfileEvents';
import { normalizeIrisProfileRosterOpContent } from './protocolProfileNormalize';

export function validateSignedIrisProfileRosterOps(folder: SharedFolder): void {
  for (const signed of folder.roster_ops ?? []) {
    validateSignedIrisProfileRosterOp(signed);
  }
}

export function signedIrisProfileRosterOpIsValid(signed: SignedIrisProfileRosterOp): boolean {
  try {
    validateSignedIrisProfileRosterOp(signed);
    return true;
  } catch {
    return false;
  }
}

export function validateSignedIrisProfileRosterOp(signed: SignedIrisProfileRosterOp): void {
  try {
    const parsed = parseIrisProfileRosterOpEvent(JSON.parse(signed.event_json) as Event);
    if (
      parsed.op_id !== signed.op_id
      || parsed.signer_pubkey !== signed.signer_pubkey
      || stableStringify(normalizeIrisProfileRosterOpContent(parsed.content))
        !== stableStringify(normalizeIrisProfileRosterOpContent(signed.content))
    ) {
      throw new Error('op event_json does not match op fields');
    }
  } catch (error) {
    throw new Error(`IrisProfile roster ${error instanceof Error ? error.message : String(error)}`);
  }
}
