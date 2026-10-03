import { expect, test as base, type Page } from './fixtures';
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed';
import { verifyEvent } from 'nostr-tools';
import {
  clearAllStorage,
  configureBlossomServers,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils';

const test = base.extend<{ fipsSeedUrl: string }>({
  fipsSeedUrl: async ({}, use) => {
    const seed = await startLocalFipsWebSocketSeed();
    try {
      await use(seed.url);
    } finally {
      await seed.close();
    }
  },
});

interface DriveDevice {
  profileId: string;
  appKeyPubkey: string;
}

interface FipsState {
  active: boolean;
  localPeerId: string;
  localXOnlyPubkey: string;
  connectedPeerIds: string[];
  nostrPeerIds: string[];
  providerPeerIds: string[];
}

async function prepareDrivePage(page: Page, relayUrl: string, seedUrl: string): Promise<void> {
  setupPageErrorHandler(page);
  await page.addInitScript((url: string) => {
    (window as typeof window & { __testFipsWebSocketSeedUrls?: string[] }).__testFipsWebSocketSeedUrls = [url];
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  }, seedUrl);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await clearAllStorage(page);
  await page.evaluate(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await presetLocalRelayInDB(page, relayUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60_000);
  await useLocalRelay(page, relayUrl);
  await configureBlossomServers(page);
  await waitForRelayConnected(page, 30_000);
}

async function fipsState(page: Page): Promise<FipsState> {
  return page.evaluate(async () => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    const runtime = getDriveFipsRuntime();
    const stats = runtime?.getStats();
    return {
      active: stats?.active === true,
      localPeerId: stats?.localPeerId ?? '',
      localXOnlyPubkey: stats?.localXOnlyPubkey ?? '',
      connectedPeerIds: stats?.connectedPeerIds ?? [],
      nostrPeerIds: stats?.nostrPeerIds ?? [],
      providerPeerIds: runtime
        ? await runtime.getP2PProvider().listPeerIds().catch(() => [])
        : [],
    };
  });
}

async function createOwner(page: Page): Promise<DriveDevice> {
  return page.evaluate(async () => {
    const { createDriveProfile, getCurrentNostrIdentitySession } = await import('/src/nostr');
    const created = await createDriveProfile({ name: 'FIPS owner' });
    const session = getCurrentNostrIdentitySession();
    if (!session) throw new Error('Drive owner session was not created');
    return {
      profileId: created.profileId,
      appKeyPubkey: session.appKeyPubkey,
    };
  });
}

async function linkBrowserDevice(ownerPage: Page, devicePage: Page): Promise<DriveDevice> {
  const request = await devicePage.evaluate(async () => {
    const { createDriveDeviceApprovalLink } = await import('/src/nostr');
    const link = createDriveDeviceApprovalLink({ label: 'FIPS browser' });
    (window as typeof window & { __fipsApprovalLink?: unknown }).__fipsApprovalLink = link;
    return {
      appKeyPubkey: link.appKeyPubkey,
      bootstrap: link.pendingApproval.bootstrap,
    };
  });

  await devicePage.evaluate(async () => {
    const link = (window as typeof window & {
      __fipsApprovalLink?: {
        pendingApproval: unknown;
        appKeyNsec: string;
      };
      __fipsApproval?: Promise<DriveDevice>;
    }).__fipsApprovalLink;
    if (!link) throw new Error('Drive device approval link is missing');
    const { activateDriveDeviceApprovalIfApproved } = await import('/src/nostr');
    (window as typeof window & {
      __fipsApproval?: Promise<DriveDevice>;
    }).__fipsApproval = activateDriveDeviceApprovalIfApproved(
      link.pendingApproval as never,
      link.appKeyNsec,
      { timeoutMs: 60_000 },
    ).then((activation) => {
      if (!activation) throw new Error('Drive device approval was not activated');
      return {
        profileId: activation.session.profileId,
        appKeyPubkey: activation.session.appKeyPubkey,
      };
    });
  });

  await ownerPage.evaluate(async (bootstrap) => {
    const { approveDriveDeviceApprovalBootstrap } = await import('/src/nostr');
    await approveDriveDeviceApprovalBootstrap(bootstrap as never);
  }, request.bootstrap);

  const activated = await devicePage.evaluate(() => (
    window as typeof window & { __fipsApproval?: Promise<DriveDevice> }
  ).__fipsApproval);
  expect(activated.appKeyPubkey).toBe(request.appKeyPubkey);
  return activated;
}

async function putWorkerOnlyBlock(
  page: Page,
  label: string,
): Promise<{ hashHex: string; ciphertextHex: string }> {
  return page.evaluate(async (prefix) => {
    const { getTree } = await import('/src/store.ts');
    const adapter = (window as typeof window & {
      __getWorkerAdapter?: () => {
        get(hash: Uint8Array): Promise<Uint8Array | null>;
      } | null;
    }).__getWorkerAdapter?.();
    if (!adapter) throw new Error('worker adapter is not ready');
    const text = `${prefix}-${crypto.randomUUID()}`;
    const data = new TextEncoder().encode(text);
    // Use production HashTree encryption, without publishing a root or its key.
    const { cid } = await getTree().putFile(data);
    const ciphertext = await adapter.get(cid.hash);
    if (!cid.key || !ciphertext) throw new Error('encrypted FIPS source block is missing');
    if (new TextDecoder().decode(ciphertext) === text) throw new Error('source block is not encrypted');
    const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return {
      hashHex: hex(cid.hash),
      ciphertextHex: hex(ciphertext),
    };
  }, label);
}

async function workerHasBlock(page: Page, hashHex: string): Promise<boolean> {
  return page.evaluate(async (hex) => {
    const adapter = (window as typeof window & {
      __getWorkerAdapter?: () => {
        has(hash: Uint8Array): Promise<boolean>;
      } | null;
    }).__getWorkerAdapter?.();
    if (!adapter) throw new Error('worker adapter is not ready');
    const hash = Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
    return adapter.has(hash);
  }, hashHex);
}

async function fetchBlock(
  page: Page,
  hashHex: string,
  peerId?: string,
): Promise<{ ok: boolean; ciphertextHex?: string; error?: string }> {
  return page.evaluate(async ({ hash, peer }) => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    const runtime = getDriveFipsRuntime();
    if (!runtime) throw new Error('Drive FIPS runtime is not active');
    try {
      const data = await runtime.getP2PProvider().fetch(hash, peer, 10);
      return data
        ? { ok: true, ciphertextHex: Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('') }
        : { ok: false, error: 'explicit miss' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, { hash: hashHex, peer: peerId });
}

async function authorizationDiagnostics(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    const {
      getCurrentNostrIdentitySession,
      refreshCurrentDriveRosterOps,
    } = await import('/src/nostr/auth.ts');
    const { nostr } = await import('/src/nostr');
    const session = getCurrentNostrIdentitySession();
    let refresh: unknown;
    try {
      refresh = session
        ? { rosterOps: (await refreshCurrentDriveRosterOps(session.profileId, 3_000)).length }
        : { error: 'no session' };
    } catch (error) {
      refresh = { error: error instanceof Error ? error.message : String(error) };
    }
    return {
      session: session ? {
        profileId: session.profileId,
        appKeyPubkey: session.appKeyPubkey,
        rosterOps: session.rosterOps.map((op) => ({ id: op.op_id, op: op.content.op.op })),
      } : null,
      refresh,
      relays: await (window as any).__getWorkerAdapter?.()?.getRelayStats?.() ?? [],
      fips: getDriveFipsRuntime()?.getStats() ?? null,
    };
  });
}

test('unrelated Drive profiles discover and serve remote-only ciphertext blocks', async ({
  browser,
  page: ownerPage,
  relayUrl,
  fipsSeedUrl,
}) => {
  test.setTimeout(180_000);
  await prepareDrivePage(ownerPage, relayUrl, fipsSeedUrl);
  const owner = await createOwner(ownerPage);
  const readerContext = await browser.newContext();
  const readerPage = await readerContext.newPage();
  try {
    await prepareDrivePage(readerPage, relayUrl, fipsSeedUrl);
    const reader = await createOwner(readerPage);
    expect(reader.profileId).not.toBe(owner.profileId);
    expect(reader.appKeyPubkey).not.toBe(owner.appKeyPubkey);

    await expect.poll(async () => {
      const [ownerState, readerState] = await Promise.all([
        fipsState(ownerPage), fipsState(readerPage),
      ]);
      return {
        ownerConnected: ownerState.connectedPeerIds.some((peer) => peer.slice(2) === reader.appKeyPubkey),
        readerConnected: readerState.connectedPeerIds.some((peer) => peer.slice(2) === owner.appKeyPubkey),
        // The unrelated peer is discovered as a real Hashtree service, not
        // inserted into a roster or an explicit fixture provider route.
        readerHasProvider: readerState.providerPeerIds.some((peer) => peer.slice(2) === owner.appKeyPubkey),
      };
    }, { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toEqual({
      ownerConnected: true,
      readerConnected: true,
      readerHasProvider: true,
    });

    const block = await putWorkerOnlyBlock(ownerPage, 'unrelated-private-ciphertext');
    expect(await workerHasBlock(readerPage, block.hashHex)).toBe(false);
    await expect.poll(
      () => fetchBlock(readerPage, block.hashHex),
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    ).toEqual({ ok: true, ciphertextHex: block.ciphertextHex });
    expect(await workerHasBlock(readerPage, block.hashHex)).toBe(true);
    expect((await fipsState(ownerPage)).nostrPeerIds).toEqual([]);
    expect((await fipsState(readerPage)).nostrPeerIds).toEqual([]);
    expect(await readerPage.evaluate(async (profileId) => {
      const { hasActiveDriveRootScope } = await import('/src/stores/treeRootResolver');
      return hasActiveDriveRootScope(profileId);
    }, owner.profileId)).toBe(false);
  } finally {
    await readerContext.close();
  }
});

test('linked Drive AppKeys share events and remote-only blocks with live revocation', async ({
  browser,
  page: ownerPage,
  relayUrl,
  fipsSeedUrl,
}) => {
  test.setTimeout(240_000);
  await prepareDrivePage(ownerPage, relayUrl, fipsSeedUrl);
  const owner = await createOwner(ownerPage);

  const deviceContext = await browser.newContext();
  const devicePage = await deviceContext.newPage();
  try {
    await prepareDrivePage(devicePage, relayUrl, fipsSeedUrl);
    const device = await linkBrowserDevice(ownerPage, devicePage);
    expect(device.profileId).toBe(owner.profileId);

    await expect.poll(async () => Promise.all(
      [ownerPage, devicePage].map(async (candidate) => {
        const state = await fipsState(candidate);
        return [state.active, state.localXOnlyPubkey] as const;
      }),
    ), { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toEqual([
      [true, owner.appKeyPubkey],
      [true, device.appKeyPubkey],
    ]);

    try {
      await expect.poll(async () => {
        const [ownerState, deviceState] = await Promise.all([
          fipsState(ownerPage),
          fipsState(devicePage),
        ]);
        return [ownerState.providerPeerIds, deviceState.providerPeerIds];
      }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toEqual([
        expect.arrayContaining([`02${device.appKeyPubkey}`, `03${device.appKeyPubkey}`]),
        expect.arrayContaining([`02${owner.appKeyPubkey}`, `03${owner.appKeyPubkey}`]),
      ]);
    } catch (error) {
      console.error('FIPS authorization diagnostics', JSON.stringify(await Promise.all([
        authorizationDiagnostics(ownerPage),
        authorizationDiagnostics(devicePage),
      ]), null, 2));
      throw error;
    }

    await expect.poll(async () => {
      const [ownerState, deviceState] = await Promise.all([
        fipsState(ownerPage),
        fipsState(devicePage),
      ]);
      return [
        ownerState.connectedPeerIds.some((peerId) => peerId.slice(2) === device.appKeyPubkey),
        deviceState.connectedPeerIds.some((peerId) => peerId.slice(2) === owner.appKeyPubkey),
      ];
    }, { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toEqual([
      true,
      true,
    ]);

    // Private event peers share the node with the public ciphertext block service.
    // Publish directly to its peer source so a relay cannot satisfy this assertion.
    const peerEvent = await ownerPage.evaluate(async () => {
      const { nostr } = await import('/src/nostr');
      return nostr.signEvent({ kind: 1, tags: [['t', 'drive-peer-proof']], content: crypto.randomUUID() });
    });
    await devicePage.evaluate(async id => {
      const { nostr } = await import('/src/nostr');
      const win = window as typeof window & { __drivePeerEvents?: string[] };
      win.__drivePeerEvents = [];
      nostr.subscribe({ ids: [id] }).on('event', event => win.__drivePeerEvents!.push(event.id));
    }, peerEvent.id);
    await expect.poll(async () => {
      await ownerPage.evaluate(async event => {
        const { publishThroughDrivePeers } = await import('/e2e/drive-peer-test-helpers.ts');
        await publishThroughDrivePeers(event);
      }, peerEvent);
      return devicePage.evaluate(() => (window as typeof window & { __drivePeerEvents?: string[] }).__drivePeerEvents ?? []);
    }, { timeout: 15000, intervals: [200, 500] }).toEqual([peerEvent.id]);

    const first = await putWorkerOnlyBlock(ownerPage, 'authorized-remote-only');
    expect(await workerHasBlock(devicePage, first.hashHex)).toBe(false);
    await expect.poll(
      () => fetchBlock(devicePage, first.hashHex),
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    ).toEqual({ ok: true, ciphertextHex: first.ciphertextHex });
    expect(await workerHasBlock(devicePage, first.hashHex)).toBe(true);

    const afterRevocation = await putWorkerOnlyBlock(ownerPage, 'revoked-remote-only');
    expect(await workerHasBlock(devicePage, afterRevocation.hashHex)).toBe(false);
    await ownerPage.evaluate(async (appKeyPubkey) => {
      const { removeDriveProfileAppKeyWithAdmin } = await import('/src/nostr');
      await removeDriveProfileAppKeyWithAdmin(appKeyPubkey);
    }, device.appKeyPubkey);

    // No Settings visit or reload: the open roster subscription must update the
    // linked browser, while the bounded FIPS refresh fails closed if relay state
    // cannot establish current authorization.
    await expect.poll(async () => {
      const [ownerState, deviceState, deviceRoster] = await Promise.all([
        fipsState(ownerPage),
        fipsState(devicePage),
        devicePage.evaluate(async () => {
          const { getCurrentNostrIdentitySession } = await import('/src/nostr');
          const { projectNostrIdentityRoster } = await import('/src/drive/protocol');
          const session = getCurrentNostrIdentitySession();
          if (!session) return { received: true, active: false };
          const projection = projectNostrIdentityRoster(session.profileId, session.rosterOps);
          return {
            received: session.rosterOps.some((op) => (
              op.content.op.op === 'tombstone_facet'
              && op.content.op.pubkey === session.appKeyPubkey
            )),
            active: Boolean(projection.active_facets[session.appKeyPubkey]),
          };
        }),
      ]);
      return {
        ownerEventPeers: ownerState.nostrPeerIds,
        deviceEventPeers: deviceState.nostrPeerIds,
        ownerStillConnected: ownerState.connectedPeerIds
          .some((peerId) => peerId.slice(2) === device.appKeyPubkey),
        deviceRoster,
      };
    }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toEqual({
      ownerEventPeers: [],
      deviceEventPeers: [],
      ownerStillConnected: true,
      deviceRoster: { received: true, active: false },
    });

    // Knowing a CID still permits raw ciphertext reads after roster removal;
    // that does not grant the root key or private operation authority.
    const ownerPeerId = (await fipsState(ownerPage)).localPeerId;
    expect(ownerPeerId.slice(2)).toBe(owner.appKeyPubkey);
    const fetched = await fetchBlock(
      devicePage,
      afterRevocation.hashHex,
      ownerPeerId,
    );
    expect(fetched).toEqual({ ok: true, ciphertextHex: afterRevocation.ciphertextHex });
    expect(await workerHasBlock(devicePage, afterRevocation.hashHex)).toBe(true);

    // Exercise the signed-operation authority check directly, independently of
    // event routing. A valid signature from the removed AppKey is insufficient.
    const mutation = await ownerPage.evaluate(async () => {
      const { getCurrentNostrIdentitySession } = await import('/src/nostr');
      const { nostrIdentityRosterParentIds, projectNostrIdentityRoster } = await import('/src/drive/protocol');
      const session = getCurrentNostrIdentitySession();
      if (!session) throw new Error('owner session is missing');
      const projection = projectNostrIdentityRoster(session.profileId, session.rosterOps);
      return {
        profileId: session.profileId,
        parents: nostrIdentityRosterParentIds(session.rosterOps),
        createdAt: Math.max(...session.rosterOps.map((op) => op.content.created_at)) + 1,
        op: {
          op: 'set_capabilities' as const,
          pubkey: session.appKeyPubkey,
          capabilities: { ...projection.active_facets[session.appKeyPubkey].capabilities, can_write_roots: false },
        },
      };
    });
    const unauthorizedEvent = await devicePage.evaluate(async (options) => {
      const { getSecretKey } = await import('/src/nostr');
      const { signNostrIdentityRosterOp } = await import('/src/drive/protocol');
      const secret = getSecretKey();
      if (!secret) throw new Error('removed device test signing key is missing');
      return signNostrIdentityRosterOp({
        ...options,
        signerSecretKey: secret,
        clientNonce: crypto.randomUUID(),
      }).event_json;
    }, mutation);
    expect(verifyEvent(JSON.parse(unauthorizedEvent))).toBe(true);
    const authority = await ownerPage.evaluate(async ({ eventJson, options }) => {
      const { getCurrentNostrIdentitySession, getSecretKey } = await import('/src/nostr');
      const { parseNostrIdentityRosterOpEvent, signNostrIdentityRosterOp } = await import('/src/drive/protocol');
      const { DriveRosterLiveCandidateBuffer } = await import('/src/nostr/driveRosterRefresh');
      const session = getCurrentNostrIdentitySession();
      const secret = getSecretKey();
      if (!session || !secret) throw new Error('owner authority is missing');
      const candidate = parseNostrIdentityRosterOpEvent(JSON.parse(eventJson));
      const rejected = new DriveRosterLiveCandidateBuffer().replay(session.profileId, session.rosterOps, candidate);
      // The same operation signed by the current owner must be accepted, so a
      // malformed payload or parent chain cannot satisfy the denial assertion.
      const control = signNostrIdentityRosterOp({
        ...options,
        signerSecretKey: secret,
        clientNonce: crypto.randomUUID(),
      });
      const accepted = new DriveRosterLiveCandidateBuffer().replay(session.profileId, session.rosterOps, control);
      return {
        revokedSigner: candidate.signer_pubkey,
        unauthorizedAccepted: rejected.projection.accepted_op_ids.includes(candidate.op_id),
        ownerCanWrite: rejected.projection.active_facets[session.appKeyPubkey]?.capabilities?.can_write_roots,
        authorizedControlAccepted: accepted.projection.accepted_op_ids.includes(control.op_id),
      };
    }, { eventJson: unauthorizedEvent, options: mutation });
    expect(authority).toEqual({
      revokedSigner: device.appKeyPubkey,
      unauthorizedAccepted: false,
      ownerCanWrite: true,
      authorizedControlAccepted: true,
    });
    expect(await devicePage.evaluate(async (profileId) => {
      const { hasActiveDriveRootScope } = await import('/src/stores/treeRootResolver');
      return hasActiveDriveRootScope(profileId);
    }, owner.profileId)).toBe(false);
  } finally {
    await deviceContext.close();
  }
});
