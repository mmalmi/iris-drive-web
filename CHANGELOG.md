# Changelog

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
