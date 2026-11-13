/**
 * One open document, spreadsheet or presentation: its Yjs document, loaded
 * from and saved to the Drive folder the current route shows.
 *
 * An editor creates one while it is set up, calls `open()` when mounted and
 * `destroy()` when torn down, and reads and edits `ydoc` in between. Loading,
 * saving, keeping tabs in step, attachments, sharing and deleting are the
 * same for every kind and live here.
 */
import { fromStore, get } from 'svelte/store';
import { SvelteMap } from 'svelte/reactivity';
import * as Y from 'yjs';
import { LinkType, nhashEncode, toHex } from '@hashtree/core';
import type { CID, TreeEntry } from '@hashtree/core';
import { getTree } from '../../store';
import { routeStore, getTreeRootSync, treeRootStore } from '../../stores';
import { open as openShareModal } from '../../components/Modals/ShareModal.svelte';
import { acceptedShares } from '../../drive/shareLibrary';
import { sharePeopleTarget } from '../../drive/sharePeople';
import { activeNostrIdentityRootScope } from '../../drive/profileRoute';
import { itemAccess, type ItemAccess } from '../../drive/itemAccess';
import { nostrStore, saveOwnTreeRoot } from '../../nostr';
import type { NostrState } from '../../nostr/store';
import { flushPendingPublishes } from '../../treeRootCache';
import { deleteCurrentFolder } from '../../actions';
import { removeOwnDirectoryForDriveRoute, setEntryForDriveRoute } from '../../drive/profileDriveRouteEntry';
import { DOCUMENT_KINDS, documentKind, documentTitle, snapshotLinkQuery, type DocumentKindInfo } from '../documentNames';
import { getCidFileUrl } from '../mediaUrl';
import { DocumentSession, STORED_ORIGIN, type DocumentChange } from './documentStore';
import { ATTACHMENTS_DIRECTORY, generateImageFilename } from './imageAttachments';
import { documentWriteScope } from './routeScope';
import { connectDocumentTabs } from './tabSync';

// Edits are stored after a short pause, and at least this often while typing without one.
const SAVE_IDLE_MS = 800;
const SAVE_MAX_WAIT_MS = 4000;
// About half a minute of looking for the document before saying it is not there.
const MAX_MISSED_LOADS = 60;

export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error' | 'other-tab';

export interface DriveDocumentOptions {
  /** Called with the folder's entries each time stored content has been applied. */
  onStored?: (entries: TreeEntry[]) => void | Promise<void>;
}

function sameCid(left: CID | null, right: CID | null): boolean {
  if (!left || !right) return left === right;
  return toHex(left.hash) === toHex(right.hash)
    && (left.key ? toHex(left.key) : '') === (right.key ? toHex(right.key) : '');
}

export class DriveDocument {
  readonly ydoc = new Y.Doc();
  /** The folder name, with its extension. */
  readonly dirName: string;
  readonly title: string;
  readonly kind: DocumentKindInfo;

  /** True until the stored content has been read for the first time. */
  loading = $state(true);
  /** True when the folder could not be found after looking for a while. */
  missing = $state(false);
  saveStatus = $state<SaveStatus>('idle');
  /** Where to show each attachment from, by file name. */
  readonly attachmentUrls = new SvelteMap<string, string>();

  readonly #route = fromStore(routeStore);
  readonly #nostr = fromStore<NostrState>(nostrStore);
  readonly #shares = fromStore(acceptedShares);
  readonly #options: DriveDocumentOptions;

  /** Whether the person looking may change the document. Follows access changes. */
  readonly canEdit = $derived.by(() => {
    const route = this.#route.current;
    const nostr = this.#nostr.current;
    const scope = documentWriteScope(route.npub, nostr.npub, nostr, this.#shares.current);
    return !!scope && !!route.treeName && !route.isPermalink;
  });

  /** Who can open the document, or null when that is not known, as for a snapshot. */
  readonly access = $derived.by((): ItemAccess | null => {
    const route = this.#route.current;
    if (route.isPermalink) return null;
    const nostr = this.#nostr.current;
    return itemAccess({
      scope: route.npub,
      treeName: route.treeName,
      path: route.path,
      profileId: activeNostrIdentityRootScope(nostr),
      appKeyPubkey: nostr.pubkey,
      records: this.#shares.current,
    });
  });

  /** Link to the folder that holds the document. */
  readonly backHref = $derived.by(() => {
    const route = this.#route.current;
    if (!route.npub || !route.treeName) return '#/';
    const parent = route.path.slice(0, -1).map(encodeURIComponent).join('/');
    const key = route.params.get('k');
    return `#/${route.npub}/${encodeURIComponent(route.treeName)}${parent ? `/${parent}` : ''}${key ? `?k=${key}` : ''}`;
  });

  #session: DocumentSession | undefined;
  #disconnectTabs: (() => void) | undefined;
  #unsubscribeRoot: (() => void) | undefined;
  #isSaver = false;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #firstUnsavedAt = 0;
  #failedSaves = 0;
  #loadQueue: Promise<unknown> = Promise.resolve();
  #retryLoadTimer: ReturnType<typeof setTimeout> | undefined;
  #missedLoads = 0;
  #documentFound: () => void = () => {};
  #documentCid: CID | null = null;
  // The route can change before the editor is torn down; the document's place does not.
  #documentPath: string[] = [];
  #destroyed = false;
  /**
   * Where this document lives, fixed when it is opened. A save can finish
   * after the user has moved to another page, and must still land here.
   */
  #opened: { npub: string; treeName: string; path: string[]; scope: string; pubkey: string } | null = null;

  constructor(dirName: string, options: DriveDocumentOptions = {}) {
    this.dirName = dirName;
    this.title = documentTitle(dirName);
    this.kind = DOCUMENT_KINDS[documentKind(dirName) ?? 'document'];
    this.#options = options;
  }

  /** True while edits are waiting to be stored. */
  get dirty(): boolean {
    return !!this.#session?.dirty;
  }

  /**
   * Starts loading and saving. Resolves true once the stored content is in
   * `ydoc`, or false when the editor was torn down first. An editor shows its
   * content only after this, never a blank page that is still loading.
   */
  async open(): Promise<boolean> {
    const route = this.#route.current;
    const nostr = this.#nostr.current;
    this.#documentPath = [...route.path];
    const pubkey = nostr.pubkey;
    const writeScope = documentWriteScope(route.npub, nostr.npub, nostr, this.#shares.current);
    if (this.canEdit && pubkey && route.npub && route.treeName && writeScope) {
      this.#opened = {
        npub: route.npub,
        treeName: route.treeName,
        path: [...route.path],
        scope: writeScope,
        pubkey,
      };
    }
    const session = new DocumentSession({
      ydoc: this.ydoc,
      tree: getTree(),
      // Each device has its own key, so its folder is its alone.
      writerId: (pubkey ?? 'viewer').slice(0, 12),
      commit: change => this.commit(change),
      ...(import.meta.env.VITE_TEST_MODE ? (window as Window & { __documentFolding?: { maxChanges?: number; quietMs?: number } }).__documentFolding : undefined),
    });
    // Until this tab is known to be the one that saves, it only shows edits.
    session.setSaver(false);
    this.#session = session;
    this.ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== STORED_ORIGIN) this.#scheduleSave();
    });

    if (this.#opened) {
      this.#disconnectTabs = connectDocumentTabs({
        key: `${this.#opened.npub}/${this.#opened.treeName}/${this.#opened.path.join('/')}`,
        ydoc: this.ydoc,
        onSaver: () => {
          this.#isSaver = true;
          session.setSaver(true);
          if (session.dirty) this.#scheduleSave();
          else if (this.saveStatus === 'other-tab') this.saveStatus = 'idle';
        },
      });
      if (!this.#isSaver) this.saveStatus = 'other-tab';
    }

    document.addEventListener('visibilitychange', this.#handleVisibilityChange);
    window.addEventListener('pagehide', this.#saveBeforeLeaving);
    window.addEventListener('beforeunload', this.#handleBeforeUnload);

    let first = true;
    this.#unsubscribeRoot = treeRootStore.subscribe((root) => {
      // The first value is read below, together with waiting for it.
      if (first) return;
      void this.#loadStored(root);
    });
    first = false;

    await new Promise<void>((resolve) => {
      this.#documentFound = resolve;
      void this.#loadStored(this.#currentRoot());
    });
    if (this.#destroyed) return false;
    this.missing = false;
    this.loading = false;
    return true;
  }

  destroy(): void {
    this.#saveBeforeLeaving();
    this.#destroyed = true;
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    if (this.#retryLoadTimer) clearTimeout(this.#retryLoadTimer);
    document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
    window.removeEventListener('pagehide', this.#saveBeforeLeaving);
    window.removeEventListener('beforeunload', this.#handleBeforeUnload);
    this.#unsubscribeRoot?.();
    this.#disconnectTabs?.();
    // The last save may still be reading the document.
    const session = this.#session;
    void this.#loadQueue.then(() => session?.save()).catch(() => {}).finally(() => {
      session?.destroy();
      this.ydoc.destroy();
    });
  }

  /** Stores document files in the Drive as one root update. */
  async commit(change: DocumentChange): Promise<void> {
    const opened = this.#opened;
    if (!opened || !this.#canWriteOpened()) throw new Error('This document cannot be edited here');
    const { scope, treeName, path: documentPath } = opened;
    const target = { npub: opened.npub, treeName };
    const tree = getTree();
    const files = await Promise.all(change.writes.map(async write => ({
      path: write.path,
      ...(await tree.putFile(write.data)),
    })));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const base = getTreeRootSync(scope, treeName);
      let root = base ?? (await tree.putDirectory([])).cid;
      for (const file of files) {
        root = await setEntryForDriveRoute(
          tree,
          root,
          [...documentPath, ...file.path.slice(0, -1)],
          file.path[file.path.length - 1],
          { cid: file.cid, size: file.size, type: LinkType.Blob },
          target,
          nostrStore.getState(),
        );
      }
      for (const directory of change.removeDirectories) {
        root = await removeOwnDirectoryForDriveRoute(
          tree, root, [...documentPath, ...directory], target, nostrStore.getState(),
        );
      }
      if (!this.#canWriteOpened()) throw new Error('The account changed before the document could be saved');
      // Another write landed while this one was prepared: redo it on the newer Drive.
      if (!sameCid(getTreeRootSync(scope, treeName), base)) continue;
      if (!saveOwnTreeRoot(scope, treeName, root)) throw new Error('This document cannot be edited here');
      // Saves are already spaced by pauses in typing. Announce this one now
      // rather than after the usual second, so other people see it sooner.
      void flushPendingPublishes().catch(() => {});
      return;
    }
    throw new Error('The Drive kept changing while saving');
  }

  /**
   * Stores a file beside the document and returns the name to refer to it by.
   * `attachmentUrls` has where to show it from, at once here and after the
   * next load everywhere else.
   */
  async addAttachment(file: File): Promise<string> {
    const filename = generateImageFilename(file);
    const data = new Uint8Array(await file.arrayBuffer());
    await this.commit({ writes: [{ path: [ATTACHMENTS_DIRECTORY, filename], data }], removeDirectories: [] });
    this.attachmentUrls.set(filename, URL.createObjectURL(file));
    return filename;
  }

  /** Stores waiting edits now instead of after the usual pause. */
  async saveNow(): Promise<void> {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    this.#firstUnsavedAt = 0;
    const session = this.#session;
    if (!session || !this.#isCurrentSaver()) return;
    if (!session.dirty) {
      if (this.saveStatus === 'unsaved') this.saveStatus = 'saved';
      return;
    }
    this.saveStatus = 'saving';
    try {
      await session.save();
      this.#failedSaves = 0;
      if (this.#destroyed) return;
      if (session.dirty) this.#scheduleSave();
      else this.saveStatus = 'saved';
    } catch (error) {
      if (this.#destroyed) return;
      console.error('[Document] Save failed:', error);
      this.#failedSaves += 1;
      this.saveStatus = 'error';
      this.#saveTimer = setTimeout(() => void this.saveNow(), Math.min(30_000, 1000 * 2 ** this.#failedSaves));
    }
  }

  /** Opens the share dialog with a read-only copy of the document as it is stored now. */
  async share(): Promise<void> {
    if (this.#session?.dirty) await this.saveNow();
    await this.#loadStored(this.#currentRoot());
    if (!this.#documentCid) return;
    const snapshot = nhashEncode({
      hash: toHex(this.#documentCid.hash),
      decryptKey: this.#documentCid.key ? toHex(this.#documentCid.key) : undefined,
    });
    const link = `${window.location.origin}${window.location.pathname}#/${snapshot}?${snapshotLinkQuery(this.dirName)}`;
    const route = this.#route.current;
    const people = this.canEdit ? sharePeopleTarget({
      scope: route.npub,
      treeName: route.treeName,
      path: route.path,
      profileId: activeNostrIdentityRootScope(this.#nostr.current),
      records: this.#shares.current,
    }) : null;
    openShareModal(link, null, people, Boolean(people));
  }

  /** Asks, then removes the document from the Drive and returns to its folder. */
  async delete(): Promise<void> {
    if (!confirm(`Delete "${this.title}"?`)) return;
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#isSaver = false;
    this.#session?.setSaver(false);
    await deleteCurrentFolder();
  }

  #currentRoot(): CID | null {
    return get(treeRootStore);
  }

  /** Whether the account that opened the document can still write to it. */
  #canWriteOpened(): boolean {
    const state = nostrStore.getState();
    const opened = this.#opened;
    return !!opened && state.pubkey === opened.pubkey
      && documentWriteScope(opened.npub, state.npub, state) === opened.scope;
  }

  #isCurrentSaver(): boolean {
    return this.#isSaver && !!this.#opened && this.#canWriteOpened();
  }

  /**
   * Applies what the Drive now holds for this document. Loads run one after
   * another. Right after a page load the Drive may not be readable yet, so a
   * folder that cannot be found is looked for again.
   */
  #loadStored(root: CID | null): Promise<unknown> {
    const path = this.#documentPath;
    if (this.#retryLoadTimer) clearTimeout(this.#retryLoadTimer);
    this.#retryLoadTimer = undefined;
    this.#loadQueue = this.#loadQueue.then(async () => {
      const session = this.#session;
      if (!session || this.#destroyed) return;
      let found = false;
      try {
        const folder = root ? await getTree().resolvePath(root, path) : null;
        if (folder?.type === LinkType.Dir) {
          const list: TreeEntry[] = await getTree().listDirectory(folder.cid);
          await session.load(list);
          await this.#rememberAttachments(list);
          await this.#options.onStored?.(list);
          this.#documentCid = folder.cid;
          found = true;
        }
      } catch (error) {
        console.error('[Document] Could not read stored updates:', error);
      }
      if (this.#destroyed) return;
      if (found) {
        this.#missedLoads = 0;
        this.#documentFound();
      } else if (this.#missedLoads < MAX_MISSED_LOADS) {
        this.#missedLoads += 1;
        this.#retryLoadTimer = setTimeout(() => void this.#loadStored(this.#currentRoot()), 500);
      } else if (this.loading) {
        this.missing = true;
      }
    });
    return this.#loadQueue;
  }

  /** Attachments are addressed by content, so the same link works in a Drive and in a snapshot. */
  async #rememberAttachments(list: TreeEntry[]): Promise<void> {
    const folder = list.find(entry => entry.name === ATTACHMENTS_DIRECTORY && entry.type === LinkType.Dir);
    if (!folder) return;
    for (const entry of await getTree().listDirectory(folder.cid)) {
      if (entry.type !== LinkType.Dir && !this.attachmentUrls.has(entry.name)) {
        this.attachmentUrls.set(entry.name, getCidFileUrl(entry.cid, entry.name));
      }
    }
  }

  #scheduleSave(): void {
    if (!this.#isCurrentSaver()) return;
    const now = Date.now();
    this.#firstUnsavedAt ||= now;
    this.saveStatus = 'unsaved';
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    const wait = Math.max(0, Math.min(SAVE_IDLE_MS, this.#firstUnsavedAt + SAVE_MAX_WAIT_MS - now));
    this.#saveTimer = setTimeout(() => void this.saveNow(), wait);
  }

  /** Leaving the page must not wait for the pause that normally precedes a save. */
  readonly #saveBeforeLeaving = (): void => {
    if (this.#session?.dirty) void this.saveNow();
  };

  /** Closing the tab in the moment before a save would lose the last words; ask first. */
  readonly #handleBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.#session?.dirty || !this.#isCurrentSaver()) return;
    this.#saveBeforeLeaving();
    event.preventDefault();
  };

  readonly #handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.#saveBeforeLeaving();
  };
}
