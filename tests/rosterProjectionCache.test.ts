import { describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import * as socialGraph from 'nostr-social-graph';
import { projectNostrIdentityRoster } from '../src/drive/protocolProfileProjection';
import { appFacet, signedRosterOp } from './driveProtocolInterop.helpers';

vi.mock('nostr-social-graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-social-graph')>();
  return { ...actual, projectNostrIdentityRoster: vi.fn(actual.projectNostrIdentityRoster) };
});

const PROFILE_ID = '4c5b3a2e-1f60-4a7b-9c8d-0e1f2a3b4c5d';

function roster() {
  const admin = generateSecretKey();
  const device = getPublicKey(generateSecretKey());
  const bootstrap = signedRosterOp(admin, PROFILE_ID, 10, {
    op: 'add_facet',
    facet: appFacet(getPublicKey(admin), 10, 'admin', true, true),
  });
  const addDevice = signedRosterOp(admin, PROFILE_ID, 11, {
    op: 'add_facet',
    facet: appFacet(device, 11, 'device', true, false),
  }, [bootstrap.op_id]);
  return { ops: [bootstrap, addDevice], adminPubkey: getPublicKey(admin), device };
}

describe('roster projection cache', () => {
  it('checks an unchanged roster once and hands each caller its own copy', () => {
    const { ops, adminPubkey, device } = roster();
    const project = vi.mocked(socialGraph.projectNostrIdentityRoster);
    project.mockClear();

    const first = projectNostrIdentityRoster(PROFILE_ID, ops);
    // Callers extend the projection they receive; that must not leak into the next one.
    first.accepted_op_ids.push('added-by-caller');
    delete first.active_facets[device];
    const second = projectNostrIdentityRoster(PROFILE_ID, ops.map((op) => ({ ...op })));

    expect(project).toHaveBeenCalledTimes(1);
    expect(second.accepted_op_ids).toEqual(ops.map((op) => op.op_id));
    expect(Object.keys(second.active_facets).sort()).toEqual([adminPubkey, device].sort());
  });

  it('checks again when any field of an op differs', () => {
    const { ops, device } = roster();
    const trusted = projectNostrIdentityRoster(PROFILE_ID, ops);
    expect(trusted.active_facets[device].capabilities?.can_admin_profile).toBeFalsy();

    const forged = structuredClone(ops);
    const promoted = forged[1].content.op;
    if (promoted.op !== 'add_facet') throw new Error('unexpected fixture');
    promoted.facet.capabilities = { ...promoted.facet.capabilities, can_admin_profile: true };
    const projection = projectNostrIdentityRoster(PROFILE_ID, forged);

    // The signed event no longer matches the claimed fields, so the op is rejected.
    expect(projection.rejected_op_ids).toContain(forged[1].op_id);
    expect(projection.active_facets[device]).toBeUndefined();
  });
});
