import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  buildDeviceApprovalRequestEvent,
  buildDeviceApprovalReceiptEvent,
  createDeviceApprovalBootstrap,
  NOSTR_IDENTITY_DEVICE_APPROVAL_BOOTSTRAP_MAX_URI_LENGTH,
  parseDeviceApprovalRequestEvent,
  parseDeviceApprovalReceiptEvent,
} from '@iris/identity';
import {
  DEVICE_APPROVAL_REQUEST_PREFIX,
  DEVICE_APPROVAL_REQUEST_TYPE,
  DRIVE_DEVICE_APPROVAL_RESOURCES,
  createDriveDeviceApprovalDraft,
  driveDeviceApprovalRequestSecretKey,
  encodeDriveDeviceApprovalBootstrap,
  isCompleteDriveDeviceApprovalBootstrapInput,
  parseDriveDeviceApprovalBootstrap,
  pendingDriveDeviceApprovalFromDraft,
} from '../src/drive/deviceLink';

describe('Drive device approval requests', () => {
  it('creates a compact QR containing exactly the stable npub, request npub, and secret', () => {
    const appKeySecretKey = generateSecretKey();
    const requestSecretKey = generateSecretKey();
    const draft = createDriveDeviceApprovalDraft({
      appKeySecretKey,
      requestSecretKey,
      requestedAt: 1_782_388_000,
      label: 'Browser',
    });

    expect(draft.url.startsWith(DEVICE_APPROVAL_REQUEST_PREFIX)).toBe(true);
    expect(draft.url.length).toBeLessThan(NOSTR_IDENTITY_DEVICE_APPROVAL_BOOTSTRAP_MAX_URI_LENGTH);
    expect(draft.request.deviceAppKeyPubkey).toBe(getPublicKey(appKeySecretKey));
    expect(draft.request.requestPubkey).toBe(getPublicKey(requestSecretKey));
    expect(draft.request.requestType).toBe(DEVICE_APPROVAL_REQUEST_TYPE);
    expect(draft.request.resources).toEqual(DRIVE_DEVICE_APPROVAL_RESOURCES);
    expect(draft.request.deviceAppKeyProof).not.toContain(draft.request.requestSecret);

    expect(decodeBootstrapPayload(draft.url)).toEqual({
      deviceAppKeyNpub: createDeviceApprovalBootstrap(draft.request).deviceAppKeyNpub,
      requestNpub: createDeviceApprovalBootstrap(draft.request).requestNpub,
      requestSecret: draft.request.requestSecret,
    });
    expect(parseDriveDeviceApprovalBootstrap(draft.url)).toEqual(
      createDeviceApprovalBootstrap(draft.request),
    );
    expect(isCompleteDriveDeviceApprovalBootstrapInput(draft.url)).toBe(true);
    expect(isCompleteDriveDeviceApprovalBootstrapInput(`nostr:${draft.url}`)).toBe(true);
  });

  it('rejects legacy queries and bootstrap payloads with request metadata', () => {
    const draft = createDriveDeviceApprovalDraft({
      requestedAt: 1_782_388_000,
      label: 'Browser',
    });
    const legacyUrl = `iris-drive://app-key-link?app_key=${draft.request.deviceAppKeyPubkey}&label=Browser`;

    expect(parseDriveDeviceApprovalBootstrap(legacyUrl)).toBeNull();
    expect(isCompleteDriveDeviceApprovalBootstrapInput(legacyUrl)).toBe(false);

    const payload = decodeBootstrapPayload(draft.url);
    for (const extra of ['deviceAppKeyProof', 'resources', 'relay', 'requestedAt']) {
      const invalidUrl = encodeBootstrapPayload({ ...payload, [extra]: true });
      expect(parseDriveDeviceApprovalBootstrap(invalidUrl)).toBeNull();
    }
  });

  it('reconstructs full request metadata only from the separately signed event', () => {
    const draft = createDriveDeviceApprovalDraft({
      requestedAt: 1_782_388_000,
      label: 'Browser',
    });
    const bootstrap = createDeviceApprovalBootstrap(draft.request);
    const url = encodeDriveDeviceApprovalBootstrap(bootstrap);
    const event = buildDeviceApprovalRequestEvent({
      request: draft.request,
      requestSecretKey: draft.request.requestSecretKey,
    });
    const parsed = parseDeviceApprovalRequestEvent(event, bootstrap);
    const { requestSecretKey: _requestSecretKey, ...transportedRequest } = draft.request;

    expect(url.startsWith(DEVICE_APPROVAL_REQUEST_PREFIX)).toBe(true);
    expect(parseDriveDeviceApprovalBootstrap(url)).toEqual(bootstrap);
    expect(parsed).toEqual(transportedRequest);
    expect(JSON.stringify(event)).not.toContain(draft.request.requestSecret);
  });

  it('stores the request secret key separately from the public approval request', () => {
    const requestSecretKey = generateSecretKey();
    const draft = createDriveDeviceApprovalDraft({
      requestSecretKey,
      requestedAt: 1_782_388_100,
    });
    const pending = pendingDriveDeviceApprovalFromDraft(draft);

    expect(pending.request).not.toHaveProperty('requestSecretKey');
    expect(pending.request.requestSecret).toBe(draft.request.requestSecret);
    expect(pending.requestSecretKeyNsec).toMatch(/^nsec1/);
    expect(getPublicKey(driveDeviceApprovalRequestSecretKey(pending))).toBe(draft.request.requestPubkey);
  });

  it('accepts only a receipt bound to the exact persisted request', () => {
    const adminSecretKey = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecretKey);
    const draft = createDriveDeviceApprovalDraft({
      requestedAt: 1_782_388_100,
      profileId: '123e4567-e89b-42d3-a456-426614174000',
      adminAppKeyPubkey: adminPubkey,
    });
    const receipt = buildDeviceApprovalReceiptEvent({
      signerSecretKey: adminSecretKey,
      request: draft.request,
      profileId: '123e4567-e89b-42d3-a456-426614174000',
      approvedAt: 1_782_388_101,
    });

    expect(parseDeviceApprovalReceiptEvent(receipt, {
      requestSecretKey: draft.request.requestSecretKey,
      request: draft.request,
      approvedByPubkey: adminPubkey,
    }).requestPubkey).toBe(draft.request.requestPubkey);
    expect(() => parseDeviceApprovalReceiptEvent(receipt, {
      requestSecretKey: draft.request.requestSecretKey,
      request: {
        ...draft.request,
        requestSecret: Buffer.alloc(32, 9).toString('base64url'),
      },
      approvedByPubkey: adminPubkey,
    })).toThrow(/receipt secret mismatch/);
  });

  it('does not treat old invite URLs as approval requests', () => {
    expect(parseDriveDeviceApprovalBootstrap('https://drive.iris.to/invite/not-approval')).toBeNull();
    expect(isCompleteDriveDeviceApprovalBootstrapInput('https://drive.iris.to/invite/not-approval')).toBe(false);
  });
});

function decodeBootstrapPayload(url: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(url.slice(DEVICE_APPROVAL_REQUEST_PREFIX.length), 'base64url').toString('utf8')) as Record<string, unknown>;
}

function encodeBootstrapPayload(payload: Record<string, unknown>): string {
  return `${DEVICE_APPROVAL_REQUEST_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}
