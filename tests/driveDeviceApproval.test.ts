import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  buildDeviceApprovalReceiptEvent,
  parseDeviceApprovalReceiptEvent,
} from '@iris/identity';
import {
  DEVICE_APPROVAL_REQUEST_PREFIX,
  DEVICE_APPROVAL_REQUEST_TYPE,
  DRIVE_DEVICE_APPROVAL_RESOURCES,
  createDriveDeviceApprovalDraft,
  driveDeviceApprovalRequestSecretKey,
  encodeDriveDeviceApprovalRequest,
  isCompleteDriveDeviceApprovalRequestInput,
  parseDriveDeviceApprovalRequest,
  pendingDriveDeviceApprovalFromDraft,
} from '../src/drive/deviceLink';

describe('Drive device approval requests', () => {
  it('creates full native-compatible request-link QR payloads', () => {
    const appKeySecretKey = generateSecretKey();
    const requestSecretKey = generateSecretKey();
    const draft = createDriveDeviceApprovalDraft({
      appKeySecretKey,
      requestSecretKey,
      requestedAt: 1_782_388_000,
      label: 'Browser',
    });

    expect(draft.url.startsWith(DEVICE_APPROVAL_REQUEST_PREFIX)).toBe(true);
    expect(draft.url).not.toContain('app_key=');
    expect(draft.request.deviceAppKeyPubkey).toBe(getPublicKey(appKeySecretKey));
    expect(draft.request.requestPubkey).toBe(getPublicKey(requestSecretKey));
    expect(draft.request.requestType).toBe(DEVICE_APPROVAL_REQUEST_TYPE);
    expect(draft.request.resources).toEqual(DRIVE_DEVICE_APPROVAL_RESOURCES);
    expect(draft.request.deviceAppKeyProof).not.toContain(draft.request.requestSecret);

    expect(parseDriveDeviceApprovalRequest(draft.url)).toEqual({
      requestPubkey: draft.request.requestPubkey,
      deviceAppKeyPubkey: draft.request.deviceAppKeyPubkey,
      requestSecret: draft.request.requestSecret,
      deviceAppKeyProof: draft.request.deviceAppKeyProof,
      requestedAt: draft.request.requestedAt,
      requestType: DEVICE_APPROVAL_REQUEST_TYPE,
      resources: DRIVE_DEVICE_APPROVAL_RESOURCES,
      expiresAt: draft.request.expiresAt,
      label: 'Browser',
    });
    expect(isCompleteDriveDeviceApprovalRequestInput(draft.url)).toBe(true);
    expect(isCompleteDriveDeviceApprovalRequestInput(`nostr:${draft.url}`)).toBe(true);
  });

  it('rejects compact requests that lack proof, request key, and request secret', () => {
    const draft = createDriveDeviceApprovalDraft({
      requestedAt: 1_782_388_000,
      label: 'Browser',
    });
    const legacyUrl = `iris-drive://app-key-link?app_key=${draft.request.deviceAppKeyPubkey}&label=Browser`;

    expect(parseDriveDeviceApprovalRequest(legacyUrl)).toBeNull();
    expect(isCompleteDriveDeviceApprovalRequestInput(legacyUrl)).toBe(false);
  });

  it('parses full approval request URLs', () => {
    const draft = createDriveDeviceApprovalDraft({
      requestedAt: 1_782_388_000,
      label: 'Browser',
    });
    const url = encodeDriveDeviceApprovalRequest(draft.request);

    expect(url.startsWith(DEVICE_APPROVAL_REQUEST_PREFIX)).toBe(true);
    expect(parseDriveDeviceApprovalRequest(url)).toEqual({
      requestPubkey: draft.request.requestPubkey,
      deviceAppKeyPubkey: draft.request.deviceAppKeyPubkey,
      requestSecret: draft.request.requestSecret,
      deviceAppKeyProof: draft.request.deviceAppKeyProof,
      requestedAt: draft.request.requestedAt,
      requestType: DEVICE_APPROVAL_REQUEST_TYPE,
      resources: DRIVE_DEVICE_APPROVAL_RESOURCES,
      expiresAt: draft.request.expiresAt,
      label: 'Browser',
    });
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
        requestSecret: 'different_request_secret_abcdefghijklmnopqrstuvwxyz',
      },
      approvedByPubkey: adminPubkey,
    })).toThrow(/receipt secret mismatch/);
  });

  it('does not treat old invite URLs as approval requests', () => {
    expect(parseDriveDeviceApprovalRequest('https://drive.iris.to/invite/not-approval')).toBeNull();
    expect(isCompleteDriveDeviceApprovalRequestInput('https://drive.iris.to/invite/not-approval')).toBe(false);
  });
});
