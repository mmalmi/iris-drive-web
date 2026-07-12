# Iris Drive

Content-addressed file sync on Nostr.

Source: <https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-drive-web>
Live: <https://drive.iris.to/>

## Features

- Content-addressed file sync with SHA256 merkle trees
- P2P file sync over Nostr-discovered FIPS WebRTC (`fips-overlay-v1`)
- Mutable `npub/path` addresses via Nostr events
- Collaborative editing with Yjs CRDT
- Cashu wallet integration
- Offline-first architecture

## URL Format

Routes use `/#/{npub}/{treeName}/{path...}` where treeName is URL-encoded (e.g. `my%20doc` for `my doc`).

## Iris Drive Protocol

The web shell keeps compatibility with native `iris-drive` protocol state:

- IrisProfile UUID root scopes and AppKey/AppActor root events.
- Signed IrisProfile roster op logs, key epochs, tombstones, and missing-wrap states.
- Entity-oriented shared-folder rosters where signed member ops grant
  IrisProfile UUID role/status access, visible members are projected from that
  log, member ops carry key-roster parent heads for signer authority, and
  AppKeys are subordinate signing/decryption actors.
- Representative npub/contact resolution from signed IrisProfile recipient
  evidence: profile rosters and facet acceptances prove key-to-UUID identity,
  share member rosters own UUID-to-role/status access plus the materialized
  AppKey-to-IrisProfile participant mapping for share-root authorization, and
  `nostr-social-graph` remains a search/ranking hint.
- Share invite bundles with signed roster checkpoints covering AppKey/key-epoch
  and member-roster heads, `Shared with me` projections, shortcuts, and share
  contact ranking with optional `nostr-social-graph` follow-distance hints.
- Pending share invites for representative-npub contacts that do not yet have
  signed IrisProfile evidence. These are core-owned display/contact hints and
  do not grant member authority, AppKey facets, or key wraps.
- `/share-invite/<payload>` renders signed share invite bundles as member/role/key-status projections, can accept them into the local `Shared with me` list, can add My Drive shortcuts, and still links back to `iris-drive://share-invite/...` for app-core/native acceptance. When the web shell has a known local IrisProfileId it must use the profile-aware accept helper so recipient-specific invites cannot be accepted for another member UUID.
- `/share?path=<folder>&name=<optional-name>` is the web-compatible OS entry route for selected-folder sharing. It preserves the folder/name, can rank recipient contacts as display hints, accepts pasted signed recipient-evidence JSON from `idrive shares recipient-evidence`, treats pasted npubs/hex pubkeys as representative-contact pending hints, posts signed recipient evidence to Rust core when present, records representative-only contacts as pending hints when evidence is missing, and otherwise hands off to `iris-drive://share?...`; native/app-core remains responsible for actual share creation and authority changes.

## Web App

```bash
# Development
pnpm run dev

# Build
pnpm run build

# Preview build
pnpm run preview
```

## Testing

```bash
# Browser E2E on the host
pnpm run test:e2e

# Browser E2E in an isolated Linux container
pnpm run test:e2e:docker
```

The Docker wrapper builds `scripts/Dockerfile.e2e-linux`, mounts the repo into `/workspace`, and keeps Linux-only `node_modules`, the pnpm store, and Rust build caches in Docker volumes. Pass a custom command to the wrapper when you want a narrower run, for example:

```bash
pnpm run test:e2e:docker -- pnpm exec playwright test e2e/anchor-links.spec.ts --workers=1
```

Portable hashtree publish:

```bash
pnpm run build
pnpm run smoke:drive:iris
pnpm run publish:drive:iris
```

The Drive web build lives in `dist`. The same artifact works for both the hosted HTTPS deployment and `htree://.../<tree>/index.html` inside Iris. Each publish helper runs `htree add .` inside the built output directory and publishes the CHK-encrypted/shareable root directly, so the resulting URL shape is `htree://nhash.../index.html`, not `.../dist/index.html`.

Portable Cloudflare release:

```bash
# One app
pnpm run release:iris -- drive
pnpm run release:iris -- files

# All apps
pnpm run release:all:iris
```

Each release script performs one build, runs focused tests against that exact build output, publishes the built directory to hashtree, and only then deploys the same directory to Cloudflare. If build or tests fail, neither hashtree nor Cloudflare upload runs.

Frontend debug rule:

- For TypeScript or UI changes, test the app shell from `http://localhost` / `pnpm run dev` while developing.
- After publishing, test the released shell from the immutable `htree://nhash.../index.html` URL or the deployed HTTPS site.
- Do not use the mutable `htree://npub.../<app>` app URL to verify unreleased frontend changes. That mutable tree only updates after the publish/release step, so it can easily serve an older app build while you are debugging new code.

Cloudflare Worker static-assets setup:

```bash
npx wrangler deploy --assets ./dist --name iris-drive --compatibility-date 2026-03-19 --dry-run
```

- Create or reuse one Worker static-assets service per site, for example `iris-drive`.
- The built-in defaults are:
  - `drive` -> Worker `iris-drive`, route `drive.iris.to/*`
  - `files` -> Worker `iris-files` (legacy alias for the Drive web shell)
- Authenticate Wrangler either with `wrangler login` or with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- `pnpm run release:iris -- drive` defaults to the `iris-drive` Worker service and the `drive.iris.to/*` route.
- `pnpm run release:iris -- files` keeps deploying the same Drive web shell to the legacy `iris-files` Worker service.
- Set `CF_WORKER_NAME_*` environment variables only when you want to override the default Worker target. Production routes/domains are only auto-attached when using the built-in Worker name.
- Optionally set `CF_WORKER_COMPATIBILITY_DATE` if you do not want to use the script default.

Cloudflare Pages fallback:

- If you need Pages for a profile with a built-in Worker target, pass `--pages-only` together with `--pages-project` (or set `CF_PAGES_PROJECT_*`).
- If a profile does not have a Worker service yet, you can still set `CF_PAGES_PROJECT_*` instead.
- When both `CF_WORKER_NAME_*` and `CF_PAGES_PROJECT_*` are set for the same profile, the release script deploys to the Worker service.

## License

MIT
