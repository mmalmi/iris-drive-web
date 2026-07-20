# Changelog

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
