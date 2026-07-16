# Changelog

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
