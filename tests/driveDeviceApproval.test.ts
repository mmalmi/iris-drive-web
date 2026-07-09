import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  DEVICE_APPROVAL_REQUEST_PREFIX,
  DEVICE_APPROVAL_REQUEST_TYPE,
  DRIVE_DEVICE_APPROVAL_RESOURCES,
  createDriveDeviceApprovalDraft,
  driveDeviceApprovalRequestSecretKey,
  encodeDriveDeviceApprovalRequest,
  isCompleteDriveDeviceApprovalRequestInput,
  isCompactDriveDeviceApprovalRequest,
  parseDriveDeviceApprovalRequest,
  pendingDriveDeviceApprovalFromDraft,
} from '../src/drive/deviceLink';

describe('Drive device approval requests', () => {
  it('creates compact native-compatible request-link QR payloads', () => {
    const appKeySecretKey = generateSecretKey();
    const requestSecretKey = generateSecretKey();
    const draft = createDriveDeviceApprovalDraft({
      appKeySecretKey,
      requestSecretKey,
      requestedAt: 1_782_388_000,
      label: 'Browser',
    });

    expect(draft.url).toMatch(/^iris-drive:\/\/app-key-link\?app_key=[0-9a-f]{64}&label=Browser$/);
    expect(draft.url.length).toBeLessThan(120);
    expect(draft.url).not.toContain('requestSecret');
    expect(draft.url).not.toContain('deviceAppKeyProof');
    expect(draft.request.deviceAppKeyPubkey).toBe(getPublicKey(appKeySecretKey));
    expect(draft.request.requestPubkey).toBe(getPublicKey(requestSecretKey));
    expect(draft.request.requestType).toBe(DEVICE_APPROVAL_REQUEST_TYPE);
    expect(draft.request.resources).toEqual(DRIVE_DEVICE_APPROVAL_RESOURCES);
    expect(draft.request.deviceAppKeyProof).not.toContain(draft.request.requestSecret);

    const parsed = parseDriveDeviceApprovalRequest(draft.url);
    expect(parsed && isCompactDriveDeviceApprovalRequest(parsed)).toBe(true);
    expect(parsed).toEqual({
      format: 'compact_app_key_link',
      deviceAppKeyPubkey: draft.request.deviceAppKeyPubkey,
      requestedAt: 0,
      requestType: DEVICE_APPROVAL_REQUEST_TYPE,
      resources: DRIVE_DEVICE_APPROVAL_RESOURCES,
      label: 'Browser',
    });
    expect(isCompleteDriveDeviceApprovalRequestInput(draft.url)).toBe(true);
    expect(isCompleteDriveDeviceApprovalRequestInput(`nostr:${draft.url}`)).toBe(true);
  });

  it('still parses full legacy approval request URLs', () => {
    const draft = createDriveDeviceApprovalDraft({
      requestedAt: 1_782_388_000,
      label: 'Browser',
    });
    const legacyUrl = encodeDriveDeviceApprovalRequest(draft.request);

    expect(legacyUrl.startsWith(DEVICE_APPROVAL_REQUEST_PREFIX)).toBe(true);
    const parsed = parseDriveDeviceApprovalRequest(legacyUrl);

    expect(parsed && isCompactDriveDeviceApprovalRequest(parsed)).toBe(false);
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
