import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  DEVICE_APPROVAL_REQUEST_PREFIX,
  DEVICE_APPROVAL_REQUEST_TYPE,
  DRIVE_DEVICE_APPROVAL_RESOURCES,
  createDriveDeviceApprovalDraft,
  driveDeviceApprovalRequestSecretKey,
  isCompleteDriveDeviceApprovalRequestInput,
  parseDriveDeviceApprovalRequest,
  pendingDriveDeviceApprovalFromDraft,
} from '../src/drive/deviceLink';

describe('Drive device approval requests', () => {
  it('creates scoped canonical NostrIdentity approval QR payloads', () => {
    const appKeySecretKey = generateSecretKey();
    const requestSecretKey = generateSecretKey();
    const draft = createDriveDeviceApprovalDraft({
      appKeySecretKey,
      requestSecretKey,
      requestedAt: 1_782_388_000,
      label: 'Browser',
    });

    expect(draft.url.startsWith(DEVICE_APPROVAL_REQUEST_PREFIX)).toBe(true);
    expect(draft.request.deviceAppKeyPubkey).toBe(getPublicKey(appKeySecretKey));
    expect(draft.request.requestPubkey).toBe(getPublicKey(requestSecretKey));
    expect(draft.request.requestType).toBe(DEVICE_APPROVAL_REQUEST_TYPE);
    expect(draft.request.resources).toEqual(DRIVE_DEVICE_APPROVAL_RESOURCES);
    expect(draft.request.deviceAppKeyProof).not.toContain(draft.request.requestSecret);

    const parsed = parseDriveDeviceApprovalRequest(draft.url);
    expect(parsed).toEqual({
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

  it('stores request secrets separately from the public approval request', () => {
    const requestSecretKey = generateSecretKey();
    const draft = createDriveDeviceApprovalDraft({
      requestSecretKey,
      requestedAt: 1_782_388_100,
    });
    const pending = pendingDriveDeviceApprovalFromDraft(draft);

    expect(pending.request).not.toHaveProperty('requestSecretKey');
    expect(pending.requestSecretKeyNsec).toMatch(/^nsec1/);
    expect(getPublicKey(driveDeviceApprovalRequestSecretKey(pending))).toBe(draft.request.requestPubkey);
  });

  it('does not treat old invite URLs as approval requests', () => {
    expect(parseDriveDeviceApprovalRequest('https://drive.iris.to/invite/not-approval')).toBeNull();
    expect(isCompleteDriveDeviceApprovalRequestInput('https://drive.iris.to/invite/not-approval')).toBe(false);
  });
});
