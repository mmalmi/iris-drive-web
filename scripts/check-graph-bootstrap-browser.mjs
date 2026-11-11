import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { SocialGraph } from 'nostr-social-graph';
import ts from 'typescript';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import {
  bridgeBrowserRelay, retainedGraphBytes, seedBrowserDatabase, startGraphBrowserFixture, workerRequest,
} from './graph-browser-fixture.mjs';
import { enforceLoopbackBoundary } from './loopback-browser-boundary.mjs';
import { createDenyProxy, assertWorkerNetworkBlocked } from '../e2e/fixtures/isolatedBrowser.ts';

const networkBoundary = await enforceLoopbackBoundary(fileURLToPath(import.meta.url));

const appDir = fileURLToPath(new URL('..', import.meta.url));
// This locked package exports TypeScript source. Use the project's existing
// compiler to load the same catalog without copying its endpoint values.
const catalogSource = await readFile(new URL(import.meta.resolve('@iris/hashtree-app/defaultRelays')), 'utf8');
const catalogJs = ts.transpileModule(catalogSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { DEFAULT_PUBLIC_RELAYS } = await import(`data:text/javascript;base64,${Buffer.from(catalogJs).toString('base64')}`);
const { values } = parseArgs({ options: { dist: { type: 'string' }, evidence: { type: 'string' }, case: { type: 'string' } } });
assert.ok(!values.case || ['app-policies', 'graph-events', 'restored-account', 'empty', 'public-subset'].includes(values.case), 'Unknown browser case group');
const dist = path.resolve(appDir, values.dist ?? process.env.IRIS_DRIVE_WEB_DIST ?? 'dist');
const evidence = values.evidence ? path.resolve(values.evidence) : null;
if (evidence) await mkdir(path.dirname(evidence), { recursive: true, mode: 0o700 });
const workerAssets = await Promise.all((await readdir(path.join(dist, 'assets')))
  .filter(name => /^hashtree\.worker-.*\.js$/.test(name))
  .map(async name => ({ name, size: (await stat(path.join(dist, 'assets', name))).size })));
const workerAsset = workerAssets.sort((a, b) => b.size - a.size)[0]?.name;
assert.ok(workerAsset, 'Built application worker is missing');
const fixture = await startGraphBrowserFixture(dist);
const denyProxy = await createDenyProxy();
let browser;
let workerDenial;
const cases = [];
const key = new Uint8Array(32).fill(42), owner = getPublicKey(key);
const friend = getPublicKey(new Uint8Array(32).fill(43));
const muted = getPublicKey(new Uint8Array(32).fill(44));
const now = Math.floor(Date.now() / 1000);
const follow = (created_at, target = friend) => finalizeEvent({ kind: 3, created_at, content: '', tags: [['p', target]] }, key);
const mute = (created_at, target = muted) => finalizeEvent({ kind: 10000, created_at, content: '', tags: [['p', target]] }, key);
async function bootstrapSnapshot(root) {
  assert.match(root, /^[0-9a-f]{64}$/);
  const graph = new SocialGraph(root);
  // The trusted HTTP snapshot's discovery-root edge is model data; the
  // independent author lists below are genuine signed synthetic-user events.
  graph.addFollower(root, owner);
  graph.handleEvent([follow(now - 100), mute(now - 99)], true);
  return Buffer.from(await graph.toBinary());
}

async function appPolicyCase(mode, relays) {
  fixture.setWorkerRelayScope(relays);
  const startFrames = fixture.frames.length;
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  const origin = fixture.origin.replace('127.0.0.1', 'drive.localhost');
  await context.grantPermissions(['local-network-access'], { origin });
  const state = { httpBootstrap: 0, abortedBootstrap: 0, sockets: [], remoteHttp: [], pageErrors: [], consoleErrors: [] };
  let releaseHttp;
  const httpGate = new Promise(resolve => { releaseHttp = resolve; });
  page.on('pageerror', error => state.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && state.consoleErrors.length < 12) state.consoleErrors.push(message.text().slice(0,800));
  });
  context.on('requestfailed', request => {
    if (request.url().startsWith('https://graph-api.iris.to/')) state.abortedBootstrap++;
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.origin === fixture.origin) return route.continue();
    if (url.origin === 'https://graph-api.iris.to') {
      state.httpBootstrap++;
      if (mode === 'default-to-empty' || mode === 'restored-account') await httpGate;
      const root = url.searchParams.get('root');
      try { await route.fulfill({ body: await bootstrapSnapshot(root), contentType: 'application/octet-stream',
        headers: { 'x-graph-root': root, 'access-control-allow-origin': '*',
          'access-control-expose-headers': 'x-graph-root' } }); }
      catch (error) { if (!state.abortedBootstrap) throw error; }
      return;
    }
    state.remoteHttp.push(url.origin);
    await route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**', route => {
    const url = new URL(route.url());
    state.sockets.push((url.origin + url.pathname).replace(/\/+$/, ''));
    const configured = new Set(relays.map(relay => relay.replace(/\/+$/, '')));
    if (configured.has(route.url().replace(/\/+$/, ''))) bridgeBrowserRelay(route,
      `${fixture.relayUrl}?configured=${encodeURIComponent(route.url())}`);
    else route.close({ code: 1000, reason: 'Only the owned relay is reachable in this fixture' });
  });
  try {
    await page.goto(`${origin}/blank`);
    await seedBrowserDatabase(page, 'hashtree-settings', 'settings', 'key', [
      { key: 'network', value: { relays, blossomServers: [], negentropyEnabled: false } },
    ], 10);
    if (mode === 'restored-account') await page.evaluate(({ pubkey, npub, nsec }) => {
      localStorage.setItem('hashtree:accounts', JSON.stringify([{ pubkey, npub, nsec, type: 'nsec', addedAt: 1 }]));
      localStorage.setItem('hashtree:activeAccount', pubkey);
    }, { pubkey: owner, npub: nip19.npubEncode(owner), nsec: nip19.nsecEncode(key) });
    await page.addInitScript(({ delayed }) => {
      window.__policyWire = [];
      window.__policyWorkerSockets = [];
      window.__policyFixtureInstalled = false;
      window.__policyRelayAcks = [];
      window.__policyReady = false;
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => {
            if (event.data?.type === 'ready') window.__policyReady = true;
            if (event.data?.type === '__driveFixtureSocket') window.__policyWorkerSockets.push(event.data);
            if (event.data?.type === '__driveFixtureInstalled') window.__policyFixtureInstalled = true;
            if (this.policyRelayRequests?.has(event.data?.id)) {
              window.__policyRelayAcks.push(this.policyRelayRequests.get(event.data.id));
              this.policyRelayRequests.delete(event.data.id);
            }
          });
        }
        postMessage(message, transfer) {
          if (message.type === 'init') this.policyCredentials = [message.config?.pubkey, message.config?.nsec];
          const sameCredentials = message.type === 'setIdentity' && this.policyCredentials
            ? message.pubkey === this.policyCredentials[0] && message.nsec === this.policyCredentials[1] : undefined;
          if (message.type === 'setIdentity') this.policyCredentials = [message.pubkey, message.nsec];
          if (message.type === 'setRelays') {
            this.policyRelayRequests ??= new Map(); this.policyRelayRequests.set(message.id, message.relays);
          }
          window.__policyWire.push({ type: message.type, pubkey: message.config?.pubkey ?? message.pubkey,
            relays: message.config?.relays ?? message.relays,
            graphBootstrap: message.config?.graphBootstrap ?? message.graphBootstrap, sameCredentials });
          super.postMessage(message, transfer);
        }
      };
      if (delayed) {
        const open = IDBFactory.prototype.open;
        let held = false;
        IDBFactory.prototype.open = function (...args) {
          const request = open.apply(this, args);
          if (args[0] === 'hashtree-settings' && !held) {
            held = true;
            request.addEventListener('success', event => {
              if (!window.__releasePolicySettings) {
                event.stopImmediatePropagation();
                window.__policySettingsHeldAt = performance.now();
                window.__releasePolicySettings = () => request.dispatchEvent(new Event('success'));
              }
            }, { capture: true });
          }
          return request;
        };
      }
    }, { delayed: mode === 'delayed-custom' });
    await page.goto(`${origin}/#/`, { waitUntil: 'load' });
    if (mode === 'delayed-custom') {
      await page.waitForFunction(() => window.__policySettingsHeldAt !== undefined);
      await page.waitForFunction(() => performance.now() - window.__policySettingsHeldAt >= 1000);
      assert.ok(await page.locator('#app').evaluate(element => element.childElementCount > 0), 'UI did not mount independently');
      assert.equal((await page.evaluate(() => window.__policyWire)).filter(frame => frame.type === 'init').length, 0);
      assert.equal(state.httpBootstrap, 0); assert.deepEqual(state.sockets, []); assert.deepEqual(state.remoteHttp, []);
      if (evidence) await page.screenshot({ path: evidence.replace(/\.json$/, '-hydration.png') });
      await page.evaluate(() => window.__releasePolicySettings());
    }
    await page.waitForFunction(() => window.__policyReady && window.__workerAdapter && window.__policyFixtureInstalled,
      undefined, { timeout: 15000 });
    const init = (await page.evaluate(() => window.__policyWire)).find(frame => frame.type === 'init');
    assert.deepEqual(init.relays, relays);
    assert.equal(init.graphBootstrap, ['default-enabled', 'default-to-empty', 'restored-account'].includes(mode));
    if (mode === 'restored-account') {
      // The stored account is restored before the worker starts, so the worker starts with its
      // key: no throwaway identity first, and the same credentials are never sent again.
      await page.waitForFunction(expected => window.__nostrStore?.getState?.().pubkey === expected, owner, { timeout: 15000 });
      assert.equal(init.pubkey, owner, 'Restored session did not start the worker with the stored account');
      const identities = (await page.evaluate(() => window.__policyWire)).filter(frame => frame.type === 'setIdentity');
      assert.ok(identities.every(frame => frame.sameCredentials === false), 'Restored session redundantly sent the same credentials');
      releaseHttp();
      return { mode, identityMessages: identities.length, duplicateCredentials: false };
    } else if (mode === 'default-enabled') {
      assert.ok([...new Set(DEFAULT_PUBLIC_RELAYS)].slice(0, 3).includes('wss://relay.ditto.pub'),
        'Ditto is outside the actual three-relay graph sync selection');
      await expect.poll(() => state.httpBootstrap, { timeout: 10000 }).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(pubkey => window.__workerAdapter.getFollows(pubkey), owner),
        { timeout: 15000 }).toEqual([friend]);
      await page.waitForFunction(() => window.__policyWire.some(frame => frame.type === 'attachNostrSource'),
        undefined, { timeout: 15000 });
      await expect.poll(() => fixture.frames.slice(startFrames).some(frame => frame.type === 'NEG-OPEN'
        && frame.catchup && frame.path.includes('relay.ditto.pub')), { timeout: 10000 }).toBe(true);
    } else if (mode === 'default-to-empty') {
      await expect.poll(() => state.httpBootstrap, { timeout: 10000 }).toBe(1);
      await page.waitForFunction(() => window.__policyWire.some(frame => frame.type === 'attachNostrSource'), undefined, { timeout: 15000 });
      const socketsBeforeChange = state.sockets.length;
      const workerSocketsBeforeChange = await page.evaluate(() => window.__policyWorkerSockets.length);
      await page.evaluate(() => {
        for (const store of window.__settingsStoreInstances) store.setNetworkSettings({ relays: [] });
      });
      await page.waitForFunction(() => window.__policyWire.some(frame => frame.type === 'setRelays'
        && frame.graphBootstrap === false && frame.relays.length === 0));
      await page.waitForFunction(() => window.__policyRelayAcks.some(relays => relays.length === 0));
      await expect.poll(() => state.abortedBootstrap, { timeout: 5000 }).toBeGreaterThan(0);
      releaseHttp();
      assert.deepEqual(await page.evaluate(pubkey => window.__workerAdapter.getFollows(pubkey), owner), []);
      await page.waitForFunction(() => window.__policyWire.filter(frame => frame.type === 'attachNostrSource').length >= 2,
        undefined, { timeout: 15000 });
      assert.deepEqual(state.sockets.slice(socketsBeforeChange), [], 'Revoked public transport bootstrap started another socket');
      assert.deepEqual(await page.evaluate(start => window.__policyWorkerSockets.slice(start), workerSocketsBeforeChange), [],
        'Revoked relay settings started another background-worker socket');
    } else {
      await page.waitForFunction(() => window.__policyWire.some(frame => frame.type === 'attachNostrSource'),
        undefined, { timeout: 15000 });
      assert.equal(state.httpBootstrap, 0);
      const permitted = new Set(relays.map(relay => relay.replace(/\/+$/, '')));
      assert.ok(state.sockets.every(socket => permitted.has(socket)), 'A socket escaped the saved relay scope');
      const workerSockets = await page.evaluate(() => window.__policyWorkerSockets);
      assert.ok(workerSockets.every(socket => permitted.has(socket.requested.replace(/\/+$/, ''))),
        'A background-worker socket escaped the saved relay scope');
      if (mode === 'public-subset') {
        await expect.poll(() => fixture.frames.slice(startFrames).some(frame => frame.type === 'NEG-OPEN'
          && frame.catchup && frame.path.includes(encodeURIComponent(relays[0]))), { timeout: 10000 }).toBe(true);
      }
    }
    assert.deepEqual(state.pageErrors, []);
    return { mode, initialBootstrapPermission: init.graphBootstrap, httpBootstrap: state.httpBootstrap,
      abortedBootstrap: state.abortedBootstrap, socketAttempts: state.sockets.length,
      workerRoutingInstalled: true, workerSocketAttempts: (await page.evaluate(() => window.__policyWorkerSockets)).length,
      defaultGraphRelayCoverage: mode === 'default-enabled' ? { dittoNegOpen: true, publicPosts: 0 } : undefined,
      delayedSettingsHeldBeyond500ms: mode === 'delayed-custom', UIIndependent: mode === 'delayed-custom' };
  } catch (error) {
    error.diagnostics = { mode, state, wire: await page.evaluate(() => window.__policyWire),
      workerUrls: page.workers().map(worker => worker.url()) };
    throw error;
  } finally { releaseHttp(); await context.close(); }
}

async function graphEventsCase() {
  fixture.setWorkerRelayScope(null);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const initialFollow = follow(now - 50), initialMute = mute(now - 49);
  fixture.setEvents([initialFollow, initialMute]);
  // Keep the legitimate live subscription open, with its initial history
  // delayed until NEG has fetched exact IDs. This separates both valid paths.
  fixture.deferLiveHistory();
  const startFrames = fixture.frames.length;
  async function start(relay) {
    await page.goto(`${fixture.origin}/blank`);
    await page.evaluate(url => {
      window.policyVersions = [];
      window.policyWorker = new Worker(url, { type: 'module' });
      window.policyWorker.addEventListener('message', event => {
        if (event.data.type === 'socialGraphVersion') window.policyVersions.push(event.data.version);
      });
    }, `/assets/${workerAsset}`);
    await workerRequest(page, { type: 'init', config: {
      storeName: 'drive-graph-policy-browser', pubkey: owner, relays: [relay],
      graphBootstrap: false, blossomServers: [],
    } });
  }
  try {
    await start(fixture.relayUrl);
    await expect.poll(async () => (await workerRequest(page, { type: 'getFollows', pubkey: owner })).pubkeys,
      { timeout: 15000 }).toEqual([friend]);
    fixture.releaseLiveHistory();
    await expect.poll(() => fixture.liveListeners(owner).length, { timeout: 10000 }).toBeGreaterThan(0);
    const lateFollow = follow(now + 1, muted), lateMute = mute(now + 2, friend);
    const versions = await page.evaluate(() => window.policyVersions.length);
    fixture.broadcast(lateFollow); fixture.broadcast(lateMute);
    await expect.poll(async () => (await workerRequest(page, { type: 'getFollows', pubkey: owner })).pubkeys).toEqual([muted]);
    await expect.poll(() => page.evaluate(() => window.policyVersions.length)).toBeGreaterThanOrEqual(versions + 2);
    await workerRequest(page, { type: 'close' });
    const savedBytes = await retainedGraphBytes(page);
    let graph = await SocialGraph.fromBinary(owner, new Uint8Array(savedBytes));
    assert.equal(graph.getListRevision(owner, 3).id, lateFollow.id);
    assert.equal(graph.getListRevision(owner, 10000).id, lateMute.id);
    assert.deepEqual([...graph.getMutedByUser(owner)], [friend]);
    const successful = fixture.frames.slice(startFrames);
    assert.ok(successful.some(frame => frame.type === 'NEG-OPEN'), 'No real graph NEG exchange');
    const fetchedIds = successful.filter(frame => frame.type === 'REQ' && frame.catchup)
      .flatMap(frame => frame.filters.flatMap(filter => filter.ids ?? []));
    assert.ok(fetchedIds.includes(initialFollow.id) && fetchedIds.includes(initialMute.id));
    assert.ok(successful.filter(frame => frame.type === 'REQ' && frame.catchup)
      .every(frame => frame.filters.every(filter => filter.ids?.length > 0)), 'Successful NEG requested broad catch-up');
    const unsupportedStart = fixture.frames.length;
    await start(`${fixture.relayUrl}/unsupported`);
    await expect.poll(() => fixture.frames.slice(unsupportedStart).some(frame => frame.type === 'SOCKET-CLOSE'
      && frame.catchup && frame.path.includes('unsupported')),
      { timeout: 10000 }).toBe(true);
    assert.deepEqual((await workerRequest(page, { type: 'getFollows', pubkey: owner })).pubkeys, [muted]);
    await workerRequest(page, { type: 'close' });
    const unsupported = fixture.frames.slice(unsupportedStart);
    assert.ok(!unsupported.some(frame => frame.type === 'REQ' && frame.catchup
      && frame.filters.some(filter => !filter.ids)), 'Unsupported NEG issued broad graph catch-up REQ');
    const reopenedBytes = await retainedGraphBytes(page);
    assert.deepEqual(reopenedBytes, savedBytes, 'Unsupported NEG modified retained personal graph bytes');
    graph = await SocialGraph.fromBinary(owner, new Uint8Array(reopenedBytes));
    assert.equal(graph.getListRevision(owner, 3).id, lateFollow.id);
    assert.equal(graph.getListRevision(owner, 10000).id, lateMute.id);
    assert.deepEqual([...graph.getMutedByUser(owner)], [friend]);
    assert.deepEqual(pageErrors, []); assert.deepEqual(fixture.errors, []);
    return { mode: 'genuine-NEG-live-events-reload-unsupported', fetchedFollowId: initialFollow.id,
      fetchedMuteId: initialMute.id, retainedFollowId: lateFollow.id, retainedMuteId: lateMute.id,
      exactMissingIdFetch: true, liveSubscriptionsRemain: true, unsupportedPreservesCacheWithoutBroadCatchup: true };
  } finally { await context.close(); }
}

let failure;
try {
  browser = await chromium.launch({ headless: true,
    proxy: { server: denyProxy.url, bypass: '127.0.0.1,localhost,[::1]' } });
  const controlContext = await browser.newContext({ serviceWorkers: 'block' });
  try { workerDenial = await assertWorkerNetworkBlocked(await controlContext.newPage(), denyProxy); }
  finally { await controlContext.close(); }
  if (!values.case || values.case === 'app-policies') {
    for (const [mode, relays] of [
      ['delayed-custom', [fixture.relayUrl]], ['empty', []],
      ['local-only', [`${fixture.relayUrl}/local`]], ['public-subset', [DEFAULT_PUBLIC_RELAYS[0]]],
      ['saved-previous-catalog', ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.nostr.band',
        'wss://relay.snort.social', 'wss://temp.iris.to']],
      ['default-enabled', DEFAULT_PUBLIC_RELAYS], ['default-to-empty', DEFAULT_PUBLIC_RELAYS],
      ['restored-account', DEFAULT_PUBLIC_RELAYS],
    ]) cases.push(await appPolicyCase(mode, relays));
  }
  if (values.case === 'restored-account') cases.push(await appPolicyCase('restored-account', DEFAULT_PUBLIC_RELAYS));
  if (values.case === 'empty') cases.push(await appPolicyCase('empty', []));
  if (values.case === 'public-subset') cases.push(await appPolicyCase('public-subset', [DEFAULT_PUBLIC_RELAYS[0]]));
  if (!values.case || values.case === 'graph-events') cases.push(await graphEventsCase());
} catch (error) { failure = error; }
finally {
  await browser?.close(); await denyProxy.close(); await fixture.close();
  const result = { passed: !failure, networkBoundary, browserProxyWorkerDenial: workerDenial,
    proxyRejected: denyProxy.rejected, fullSuite: !values.case, selectedCaseGroup: values.case, cases,
    failure: failure?.message, diagnostics: failure?.diagnostics, buildDirectory: dist,
    actualApplicationWorkerAsset: workerAsset, fixtureErrors: fixture.errors };
  if (evidence) await writeFile(evidence, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ passed: result.passed, cases: cases.length, failure: result.failure, evidence }));
}
if (failure) throw failure;
