# Changelog

## 0.1.45 - 2026-11-26

- Uploading multiple files or folders, unpacking a ZIP archive, deleting a selection, restoring from Trash and adding photos to an album now update the Drive in batches instead of rewriting folders and deletion history once per item.
- Saving or publishing a change no longer re-reads and rewrites past deletion history, and syncing changes across devices skips unchanged folders.
- Opening a large shared folder no longer stalls while computing access badges for each row, and browsing large photo libraries formats date groups faster.
- Downloading folders or selections as a ZIP reads files in parallel and stores already-compressed photos, videos and archives without wasting time re-compressing them.
- Unpacking a ZIP archive now queues safely behind other Drive edits and always clears its progress bar on error; uploading files into an empty Drive now saves them reliably.

## 0.1.44 - 2026-11-25

- A file uploaded to a shared folder before the folder has loaded, as right after joining it, now waits for the folder and lands in it. It used to be saved as your own My Drive instead, which then listed only that file.
- New folder and New file in a shared folder that has not loaded say so instead of starting a new folder in its place.

## 0.1.43 - 2026-11-25

- An upload that has to wait to put a file in its folder now says so after ten seconds, and the notice stays until the wait ends. It used to stand still at "Uploading 1 of 2" without a word.

## 0.1.42 - 2026-11-20

- The browser tab shows the name of the open file, folder, document or place, for example "Taxes - Iris Drive" or "Recent - Iris Drive".

## 0.1.41 - 2026-11-19

- Removing another person’s file from a shared folder returns the latest version to their My Drive. The shared entry stays visible until the owner’s copy is saved.
- Moving your own file from a shared folder to Trash keeps a private recovery copy. Files with unverified ownership stay in place.

## 0.1.40 - 2026-11-19

- Restore personal My Drive files from Trash on an approved device or after signing in with a recovery phrase. Offline deletions sync when the device reconnects.
- Earlier browser-only deletions remain recoverable for their original 30 days on the device that deleted them. Shared items stay in place when file ownership cannot be verified.

## 0.1.36 - 2026-11-18

- Change your display name in Account settings while preserving your username, custom profile fields and tags. If the public update needs a connection, your local name is saved and you can retry.

## 0.1.35 - 2026-11-18

- Keep Storage rows in place as device reports, sync warnings and backup details update.

## 0.1.34 - 2026-11-18

- See offline coverage for each device in Settings → Storage. Expand a row for connection and storage details.
- Clarify how to restore backed-up files if you lose all your devices.

## 0.1.33 - 2026-11-18

- Manage file servers in Settings → Storage → Backups. Choose which servers open files and which keep encrypted backups of your Drive.

## 0.1.32 - 2026-11-18

- Find keyboard shortcuts and answers about sharing, Trash and device storage in Settings → Help.

## 0.1.31 - 2026-11-17

- Reveal text, pictures and shapes on click. Select several objects to reveal them together. PowerPoint import and export preserve supported Appear effects.
- Adjust fill opacity and keep transparent PowerPoint overlays when importing and exporting slides.
- Follow the destination link after moving files. Drive checks the selected versions before moving them.

## 0.1.30 - 2026-11-17

- Restore deleted files and folders from Trash for 30 days in the browser where you deleted them. Use Ctrl+Z or ⌘Z in the file list to undo a deletion.
- Use / to search, F2 to rename, Ctrl/⌘+Enter to open a new tab and Ctrl/⌘+/ to see keyboard shortcuts. Copy links, move files and open sharing from the keyboard.
- Move a selection with cut and paste or drag and drop. If a name is already taken, both items are kept.
- Filter search by folder and file type and see all matches.
- See storage by device on narrow screens and keep device storage reports up to date as the account becomes ready.

## 0.1.28 - 2026-11-16

- Keep a file deleted after another device republishes an older copy of the same folder.
- See which Drive devices are reachable directly or through the mesh. Begin listening for device approvals as soon as a sign-in link opens.

- Open drive.iris.to links in the Iris Drive iPhone app when it is installed.
- Your devices send each other their Drive changes and device list directly over FIPS too, and catch up with Negentropy when they reconnect, so they stay in sync when relays do not answer.
- Show under Storage how much of your Drive each of your devices holds, and in which folders, whether it is in sync and connected, and how much room it has.

## 0.1.23 - 2026-10-04

- Keep the first file added to a new profile while its private folder finishes loading.
- Recover file-sharing connections after a browser reload or temporary route failure.
- Preserve verified cached files for sharing and offline use after restarting the app.

## 0.1.22 - 2026-10-02

- Show the latest shared files after a saved tree is loaded or the worker restarts.
- Keep peer connections and transfers working when a delayed connection offer arrives.
- Find connected file providers without waiting for unrelated peer discovery.

## 0.1.21 - 2026-09-30

- Reduce unnecessary routing traffic and recover peer sessions reliably with the audited FIPS runtime.
- Close canceled peer connections promptly and preserve usable routes during retries.

## 0.1.20 - 2026-09-30

- Recover peer connections sooner when handshake messages or connection answers are lost.

## 0.1.19 - 2026-09-30

- Restore file sharing when a background worker restarts during startup.
- Route larger peer connection offers over paths that can carry them.
- Resume peer connections promptly after authenticated signaling recovers.

## 0.1.18 - 2026-09-30

- Keep message-server requests within common filter limits while preserving
  exact subscription matching and offline history.

## 0.1.17 - 2026-09-30

- Wait for received events to finish saving before completing history queries.
- Return exact event lookups as soon as the verified event is available.
- Reload the cached app while offline without changing the signed-in account.

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
