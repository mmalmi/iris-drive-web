import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';
import {
  approveDeviceApprovalBootstrap,
  buildDeviceApprovalReceiptEvent,
  DEVICE_APPROVAL_BOOTSTRAP_PREFIX,
  isCompleteDeviceApprovalBootstrapInput,
  NOSTR_IDENTITY_DEVICE_APPROVAL_BOOTSTRAP_MAX_URI_LENGTH,
  NOSTR_IDENTITY_DEVICE_APPROVAL_LABEL_MAX_BYTES,
  NOSTR_IDENTITY_DEVICE_APPROVAL_RECEIPT_TYPE,
  parseDeviceApprovalBootstrap,
  parseDeviceApprovalReceiptEvent,
} from '@iris/identity';
import {
  createDriveDeviceApprovalDraft,
  driveDeviceApprovalRequestSecretKey,
  pendingDriveDeviceApprovalFromDraft,
} from '../src/drive/deviceLink';

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('Drive device approval bootstraps', () => {
  it('creates approval input with only the stable npub, distinct ephemeral npub, 32-byte secret, and label', () => {
    const appKeySecretKey = generateSecretKey();
    const requestSecretKey = generateSecretKey();
    const draft = createDriveDeviceApprovalDraft({
      appKeySecretKey,
      requestSecretKey,
      label: 'Browser',
    });

    expect(draft.url.startsWith(DEVICE_APPROVAL_BOOTSTRAP_PREFIX)).toBe(true);
    expect(draft.url.length).toBeLessThanOrEqual(
      NOSTR_IDENTITY_DEVICE_APPROVAL_BOOTSTRAP_MAX_URI_LENGTH,
    );
    expect(draft).not.toHaveProperty('request');
    expect(draft.bootstrap).toEqual({
      deviceAppKeyNpub: nip19.npubEncode(getPublicKey(appKeySecretKey)),
      requestNpub: nip19.npubEncode(getPublicKey(requestSecretKey)),
      requestSecret: draft.bootstrap.requestSecret,
      label: 'Browser',
    });
    expect(draft.bootstrap.deviceAppKeyNpub).not.toBe(draft.bootstrap.requestNpub);
    expect(Buffer.from(draft.bootstrap.requestSecret, 'base64url')).toHaveLength(32);
    expect(decodeBootstrapPayload(draft.url)).toEqual(draft.bootstrap);
    expect(parseDeviceApprovalBootstrap(draft.url)).toEqual(draft.bootstrap);
    expect(isCompleteDeviceApprovalBootstrapInput(draft.url)).toBe(true);
  });

  it('approves the stable key directly from the bootstrap without request metadata', () => {
    const adminSecretKey = generateSecretKey();
    const draft = createDriveDeviceApprovalDraft({
      label: 'Phone',
    });

    const approval = approveDeviceApprovalBootstrap({
      bootstrap: draft.bootstrap,
      profileId: PROFILE_ID,
      rosterOps: [],
      approvedByPubkey: getPublicKey(adminSecretKey),
      approvedAt: 1_782_388_000,
      clientNonce: 'drive-bootstrap-only-approval',
    });

    expect(approval.profile_id).toBe(PROFILE_ID);
    expect(approval.actor_pubkey).toBe(getPublicKey(adminSecretKey));
    expect(approval.op.op).toBe('add_facet');
    expect(approval.op.op === 'add_facet' ? approval.op.facet.pubkey : null)
      .toBe(getPublicKey(draft.appKeySecretKey));
  });

  it('uses an optional label bounded by the shared bootstrap contract', () => {
    const exactLabel = 'x'.repeat(NOSTR_IDENTITY_DEVICE_APPROVAL_LABEL_MAX_BYTES);

    expect(createDriveDeviceApprovalDraft().bootstrap).not.toHaveProperty('label');
    expect(createDriveDeviceApprovalDraft({ label: ` ${exactLabel} ` }).bootstrap.label)
      .toBe(exactLabel);
    expect(() => createDriveDeviceApprovalDraft({ label: `${exactLabel}x` }))
      .toThrow(/label exceeds/);
  });

  it('transports a signed encrypted receipt bound to the bootstrap', () => {
    const adminSecretKey = generateSecretKey();
    const draft = createDriveDeviceApprovalDraft({ label: 'Phone' });
    const receiptEvent = buildDeviceApprovalReceiptEvent({
      signerSecretKey: adminSecretKey,
      bootstrap: draft.bootstrap,
      profileId: PROFILE_ID,
      approvedAt: 1_782_388_101,
    });

    expect(verifyEvent(receiptEvent)).toBe(true);
    expect(receiptEvent.tags).toContainEqual(['type', NOSTR_IDENTITY_DEVICE_APPROVAL_RECEIPT_TYPE]);
    expect(receiptEvent.content).not.toContain(draft.bootstrap.requestSecret);
    expect(parseDeviceApprovalReceiptEvent(receiptEvent, {
      requestSecretKey: draft.requestSecretKey,
      bootstrap: draft.bootstrap,
    })).toMatchObject({
      profileId: PROFILE_ID,
      requestPubkey: getPublicKey(draft.requestSecretKey),
      deviceAppKeyPubkey: getPublicKey(draft.appKeySecretKey),
    });
  });

  it('rejects legacy links, URI suffixes, malformed values, and request metadata fields', () => {
    const draft = createDriveDeviceApprovalDraft({
      label: 'Browser',
    });
    const legacyUrl = `iris-drive://app-key-link?app_key=${getPublicKey(draft.appKeySecretKey)}&label=Browser`;
    const payload = decodeBootstrapPayload(draft.url);

    expect(parseDeviceApprovalBootstrap(legacyUrl)).toBeNull();
    expect(isCompleteDeviceApprovalBootstrapInput(legacyUrl)).toBe(false);
    expect(parseDeviceApprovalBootstrap(`nostr:${draft.url}`)).toBeNull();
    expect(parseDeviceApprovalBootstrap(`${draft.url}?relay=wss://example.test`)).toBeNull();
    expect(parseDeviceApprovalBootstrap(`${draft.url}#scan`)).toBeNull();

    for (const extra of [
      'v',
      'deviceAppKeyProof',
      'resources',
      'relay',
      'requestedAt',
      'requestType',
      'expiresAt',
      'profileId',
      'adminAppKeyNpub',
    ]) {
      expect(parseDeviceApprovalBootstrap(
        encodeBootstrapPayload({ ...payload, [extra]: true }),
      )).toBeNull();
    }

    expect(parseDeviceApprovalBootstrap(encodeBootstrapPayload({
      ...payload,
      requestNpub: payload.deviceAppKeyNpub,
    }))).toBeNull();
    expect(parseDeviceApprovalBootstrap(encodeBootstrapPayload({
      ...payload,
      requestSecret: Buffer.alloc(31, 1).toString('base64url'),
    }))).toBeNull();
    expect(parseDeviceApprovalBootstrap(encodeBootstrapPayload({
      ...payload,
      label: 'abcdefghijklmnopq',
    }))).toBeNull();
  });

  it('stores only the bootstrap and ephemeral request secret key for receipt activation', () => {
    const requestSecretKey = generateSecretKey();
    const draft = createDriveDeviceApprovalDraft({
      requestSecretKey,
    });
    const pending = pendingDriveDeviceApprovalFromDraft(draft);

    expect(pending).not.toHaveProperty('request');
    expect(pending.bootstrap).toEqual(draft.bootstrap);
    expect(pending.requestSecretKeyNsec).toMatch(/^nsec1/);
    expect(getPublicKey(driveDeviceApprovalRequestSecretKey(pending)))
      .toBe(getPublicKey(requestSecretKey));
  });

  it('does not treat old invite URLs as approval input', () => {
    expect(parseDeviceApprovalBootstrap('https://drive.iris.to/invite/not-approval')).toBeNull();
    expect(isCompleteDeviceApprovalBootstrapInput('https://drive.iris.to/invite/not-approval'))
      .toBe(false);
  });
});

function decodeBootstrapPayload(url: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(url.slice(DEVICE_APPROVAL_BOOTSTRAP_PREFIX.length), 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

function encodeBootstrapPayload(payload: Record<string, unknown>): string {
  return `${DEVICE_APPROVAL_BOOTSTRAP_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}
