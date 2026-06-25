import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type Event } from 'nostr-tools';
import WebSocket from 'ws';
import {
  signIrisProfileFacetAcceptance,
  signIrisProfileRosterOp,
  type IrisProfileKeyPurpose,
} from '../src/drive/protocol';

export type RecoveryProfile = {
  profileId: string;
  recoverySecretKey: Uint8Array;
  recoveryPubkey: string;
  recoveryNsec: string;
};

export async function publishEvent(relayUrl: string, event: Event): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out publishing event ${event.id}`));
    }, 5000);

    socket.on('open', () => {
      socket.send(JSON.stringify(['EVENT', event]));
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id && msg[2] === true) {
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      } catch {
        // Ignore non-JSON relay chatter.
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export async function seedRecoverableProfile(
  relayUrl: string,
  recoverySecretKey: Uint8Array,
  purpose: IrisProfileKeyPurpose,
): Promise<RecoveryProfile> {
  const profileId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const adminSecretKey = generateSecretKey();
  const adminPubkey = getPublicKey(adminSecretKey);
  const recoveryPubkey = getPublicKey(recoverySecretKey);
  const recoveryNsec = nip19.nsecEncode(recoverySecretKey);

  const bootstrap = signIrisProfileRosterOp({
    signerSecretKey: adminSecretKey,
    profileId,
    createdAt: now,
    clientNonce: `bootstrap-${profileId}`,
    op: {
      op: 'add_facet',
      facet: {
        pubkey: adminPubkey,
        purposes: ['app_key'],
        capabilities: {
          can_write_roots: true,
          can_admin_profile: true,
          can_receive_key_wraps: true,
          can_decrypt_key_epochs: true,
        },
        added_at: now,
        label: 'Admin',
      },
    },
  });
  const addRecovery = signIrisProfileRosterOp({
    signerSecretKey: adminSecretKey,
    profileId,
    parents: [bootstrap.op_id],
    createdAt: now + 1,
    clientNonce: `add-recovery-${profileId}`,
    op: {
      op: 'add_facet',
      facet: {
        pubkey: recoveryPubkey,
        purposes: [purpose],
        capabilities: {
          can_recover_app_keys: true,
          can_receive_key_wraps: true,
          can_decrypt_key_epochs: true,
        },
        added_at: now + 1,
        label: 'Recovery key',
      },
    },
  });
  const recoveryAcceptance = signIrisProfileFacetAcceptance({
    signerSecretKey: recoverySecretKey,
    profileId,
    purposes: [purpose],
    rosterOpId: addRecovery.op_id,
    acceptedAt: now + 2,
    clientNonce: `accept-recovery-${profileId}`,
  });

  await publishEvent(relayUrl, JSON.parse(bootstrap.event_json));
  await publishEvent(relayUrl, JSON.parse(addRecovery.event_json));
  await publishEvent(relayUrl, JSON.parse(recoveryAcceptance.event_json));

  return {
    profileId,
    recoverySecretKey,
    recoveryPubkey,
    recoveryNsec,
  };
}

export function signWithRecoverySecret(profile: RecoveryProfile, draft: Event): Event {
  return finalizeEvent({
    kind: draft.kind,
    content: draft.content,
    created_at: draft.created_at,
    tags: draft.tags.map((tag) => tag.slice()),
  }, profile.recoverySecretKey);
}
