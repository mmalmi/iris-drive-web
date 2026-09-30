# Changelog

## 0.1.16 - 2026-09-30

- Share event and file connections through the common Nostr pubsub and Hashtree runtime.
- Keep existing accounts, device approvals, remote signing, and queued offline changes.
- Scope device verification to the selected message servers and preserve partial query results.

## 0.1.15 - 2026-09-07

- Upgrade to Hashtree runtime 0.5.7, which validates remote content hashes and
  sizes before returning or caching data.
- Pin native test and publishing tools to Hashtree CLI 0.2.142.

## 0.1.14 - 2026-09-05

- Open the current native app download site from Drive setup.

## 0.1.13 - 2026-09-05

- Update the shared Hashtree core, storage, index, Nostr, FIPS transport, and
  browser worker packages to the published TypeScript runtime v0.5.6.

## 0.1.12 - 2026-09-05

- Preserve every file and directory when linked devices replace one kind with
  the other, using a deterministic encrypted per-path role document shared by
  Web and native clients.
- Keep real deletions final across later edits and delete-then-recreate while
  retaining explicit conflict copies for active replacements.
- Route uploads, file and folder actions, collaborative documents, attachments,
  and recordings through the same durable profile Drive mutation path.
- Verify native signed share-access snapshots before accepting invites and
  derive membership, permissions, and key availability from the verified data.
- Stop pending document, attachment, and file writes when their destination
  or active identity changes, and report unavailable conflict metadata instead
  of treating it as an empty tree.

## 0.1.11 - 2026-08-18

- Share revision-pinned, same-origin file links and verify that they load in a
  fresh browser session.
- Make account management and logout visible, with logout purging credentials,
  profile caches, and device-local session state.
- Make device linking fail closed, persist initial roster history durably, and
  synchronize encrypted device names between Web and native clients.
- Synchronize native and Web files through causal root projection, retaining
  tombstones and lossless conflict copies across concurrent edits.
- Scope live FIPS peers to each AppKey roster and revoke removed devices without
  a restart.
- Reduce the production JavaScript bundle and omit analysis-only artifacts from
  normal builds for faster build and test cycles.

## 0.1.10 - 2026-08-06

- Keep device-approval receipt subscriptions open through relay EOSE and
  publish immutable roster history in bounded parallel batches, so linking is
  prompt even with a large roster.
- Emit the shared applied-approval ACK only after the linked browser session is
  durable, and keep roster mutation timestamps strictly ordered for immediate
  post-creation linking.
- Add browser/native device-link coverage in both directions, including
  restart recovery, exact ACK replay and cleanup, and collapse redundant
  viewer release tests into one production-like flow.

## 0.1.9 - 2026-07-20

- Upgrade to FIPS TypeScript 0.0.29 and Hashtree FIPS transport 0.4.6 for
  direct FSP negotiation with legacy FMP fallback.
- Bootstrap WebRTC negotiation through authenticated FIPS WebSocket seeds.
- Pin process and publication gates to Hashtree CLI 0.2.114, whose native
  FIPS endpoint uses the same authenticated seed bootstrap.

## 0.1.8 - 2026-07-17

- Upgrade to immutable Hashtree TypeScript runtime 0.5.1, including Nostr
  adapter 0.2.0 and worker 0.4.1.
- Remove the legacy mesh carrier from Drive while preserving the shared
  adaptive `BlobRouter`, exact provider identity, HTL 10, central hash
  verification, and Blossom-only behavior without an enabled provider bridge.
- Delete the mutable sibling Rust build fallback from browser gates and pin
  process tests and publication to the immutable Hashtree CLI 0.2.99 artifact.

## 0.1.7 - 2026-07-16

- Upgrade to the immutable Hashtree TypeScript 0.5.0 runtime and shared
  adaptive `BlobRouter`. Drive writes remain application-selected while local,
  authenticated P2P, and Blossom reads share one bounded route contract.
- Preserve standalone outbound links, exact provider identities, HTL 10, and
  central corruption checks without adding a Drive-local fallback.

## 0.1.6 - 2026-07-16

- Upgrade to immutable FIPS TypeScript runtime 0.0.26, preserving persisted
  browser identity across reloads and rejecting stale handshake epochs.
- Publish with the installed public Hashtree CLI instead of compiling a mutable
  sibling Rust checkout during the release.

- Pin the shared Hashtree worker to immutable runtime 0.4.4, keeping media
  routes limited to exact configured provider identities with HTL 10.
- Resolve Iris UI from the immutable package instead of a sibling checkout, so
  clean-room builds no longer depend on a mutable local workspace.

## 0.1.5 - 2026-07-16

- Pin the Hashtree worker and FIPS transport to immutable runtime 0.4.3.
- Preserve explicit blob routes during FIPS runtime resync and replay provider
  state across worker replacement.
- Give every browser test a fresh relay namespace so retained discovery events
  cannot leak between release checks.

## 0.1.4 - 2026-07-16

- Move every Iris Kit dependency to its immutable patched release: runtime
  0.2.1 for identity, Hashtree app helpers, and Svelte UI, and runtime 0.2.2
  for release tools, NDK, and NDK cache.
- Preserve the 0.1.3 FIPS, FIPS TCP, Hashtree, and blob-route behavior without
  a wire or routing change.

## 0.1.3 - 2026-07-16

- Pin the browser app to immutable FIPS, FIPS TCP, Hashtree, Iris Kit, and
  Nostr social-graph releases.
- Use explicit Hashtree blob routes with HTL 10, preserving transport and
  corruption failures as errors instead of treating them as misses.
- Keep the standalone FIPS runtime serve-only until an authenticated or
  explicitly configured blob route is available.
- Remove workspace-link build coupling and duplicated identity protocol types.
- Align browser/native interop fixtures with the native profile roster store.
- Update DOMPurify, Happy DOM, and Vite to releases without known OSV
  advisories in the lockfile.
