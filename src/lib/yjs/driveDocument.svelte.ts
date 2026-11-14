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
import { linkShares } from '../../drive/linkShares';
import { nostrStore, saveOwnTreeRoot } from '../../nostr';
import { accountsStore } from '../../accounts';
import type { NostrState } from '../../nostr/store';
import { flushPendingPublishes } from '../../treeRootCache';
import { deleteCurrentFolder, renameCurrentFolder } from '../../actions';
import { markFolderChanged, removeOwnDirectoryForDriveRoute, setEntryForDriveRoute } from '../../drive/profileDriveRouteEntry';
import { DOCUMENT_KINDS, documentFolderName, documentKind, documentTitle, snapshotLinkQuery, type DocumentKindInfo } from '../documentNames';
import { freeName } from '../driveClipboard';
import { getCidFileUrl } from '../mediaUrl';
import { DocumentSession, LIVE_ORIGIN, STORED_ORIGIN, UPDATES_DIRECTORY, changeFileName, type DocumentChange } from './documentStore';
import { withDriveRootLock } from '../driveRootTabs';
import { ATTACHMENTS_DIRECTORY, generateImageFilename } from './imageAttachments';
import { documentWriteScope } from './routeScope';
import { connectDocumentTabs } from './tabSync';
import { LivePresence, presenceColor, type PresenceUser } from './presence.svelte';
import type { LiveConnection } from './liveConnect';

// Edits are stored after a short pause, and at least this often while typing without one.
const SAVE_IDLE_MS = 800;
const SAVE_MAX_WAIT_MS = 4000;
// About half a minute of looking for the document before saying it is not there.
const MAX_MISSED_LOADS = 60;
// An edit seen live is stored here too when its writer has not stored it by then.
const KEEP_LIVE_AFTER_MS = 30_000;

export type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error' | 'other-tab';

/** An earlier version shown in place of the document. */
export interface VersionPreview {
  /** When the version's last save was made. */
  time: number;
  /** The document as it was then, as one Yjs update. */
  update: Uint8Array;
}

export interface DriveDocumentOptions {
  /** Called with the folder's entries each time stored content has been applied. */
  onStored?: (entries: TreeEntry[]) => void | Promise<void>;
}

/** This person as the others who have a document open see them. */
function ownPresenceUser(): PresenceUser {
  const state = nostrStore.getState();
  const key = state.pubkey ?? '';
  const id = activeNostrIdentityRootScope(state) ?? key;
  const name = accountsStore.getState().accounts.find(account => account.pubkey === key)?.name?.trim() ?? '';
  return { name, color: presenceColor(id), key, id };
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
  /** The document's folder as last read; its files are the document's history. */
  folder = $state.raw<CID | null>(null);
  /** True while the list of earlier versions is open. */
  historyOpen = $state(false);
  /** The earlier version shown, read-only, in place of the document. */
  preview = $state.raw<VersionPreview | null>(null);
  /** Who else has the document open, and where they are in it. */
  readonly presence = new LivePresence(this.ydoc, ownPresenceUser());

  readonly #route = fromStore(routeStore);
  readonly #nostr = fromStore<NostrState>(nostrStore);
  readonly #shares = fromStore(acceptedShares);
  readonly #links = fromStore(linkShares);
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
      linkShares: this.#links.current,
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
  #writerId = 'viewer';
  // The route can change before the editor is torn down; the document's place does not.
  #documentPath: string[] = [];
  #destroyed = false;
  #live: LiveConnection | null = null;
  /** Edits taken in live, kept until their writers are known to have stored them. */
  #liveSeen: Array<{ update: Uint8Array; at: number }> = [];
  #liveSeenTimer: ReturnType<typeof setInterval> | undefined;
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
    // Each device has its own key, so its folder is its alone.
    this.#writerId = (pubkey ?? 'viewer').slice(0, 12);
    const session = new DocumentSession({
      ydoc: this.ydoc,
      tree: getTree(),
      writerId: this.#writerId,
      commit: change => this.commit(change),
      ...(import.meta.env.VITE_TEST_MODE ? (window as Window & { __documentFolding?: { maxChanges?: number; quietMs?: number } }).__documentFolding : undefined),
    });
    // Until this tab is known to be the one that saves, it only shows edits.
    session.setSaver(false);
    this.#session = session;
    this.ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== STORED_ORIGIN && origin !== LIVE_ORIGIN) this.#scheduleSave();
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
    if (route.npub && route.treeName && !route.isPermalink) {
      void this.#connectLive({ scope: route.npub, treeName: route.treeName, path: [...route.path] });
    }
    return true;
  }

  /** Presence and live edits with the others who have the document open, once it has loaded. */
  async #connectLive(place: { scope: string; treeName: string; path: string[] }): Promise<void> {
    try {
      const { connectLive } = await import('./liveConnect');
      if (this.#destroyed) return;
      this.#live = connectLive({
        ydoc: this.ydoc,
        presence: this.presence,
        place,
        canEdit: () => this.canEdit,
        onRemoteUpdate: update => this.#rememberLive(update),
      });
    } catch (error) {
      console.warn('[Document] Others who have it open are not shown:', error);
    }
  }

  /**
   * Someone's live edit is stored by them. Should it still not be stored a
   * while later, as when their tab closed first, it is stored here, so that
   * what was written after it does not hang on content no file has.
   */
  #rememberLive(update: Uint8Array): void {
    if (!this.#isCurrentSaver()) return;
    this.#liveSeen.push({ update, at: Date.now() });
    this.#liveSeenTimer ??= setInterval(() => this.#keepUnstoredLive(), KEEP_LIVE_AFTER_MS / 3);
  }

  #keepUnstoredLive(): void {
    const due = Date.now() - KEEP_LIVE_AFTER_MS;
    const ready = this.#liveSeen.filter(seen => seen.at <= due);
    this.#liveSeen = this.#liveSeen.filter(seen => seen.at > due);
    if (this.#liveSeen.length === 0) {
      clearInterval(this.#liveSeenTimer);
      this.#liveSeenTimer = undefined;
    }
    const session = this.#session;
    if (!session || !this.#isCurrentSaver() || ready.length === 0) return;
    for (const { update } of ready) session.keep(update);
    if (session.dirty) this.#scheduleSave();
  }

  destroy(): void {
    this.#saveBeforeLeaving();
    this.#destroyed = true;
    this.#live?.destroy();
    this.presence.destroy();
    clearInterval(this.#liveSeenTimer);
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
    const { treeName, path: documentPath } = opened;
    const target = { npub: opened.npub, treeName };
    const tree = getTree();
    const files = await Promise.all(change.writes.map(async write => ({
      path: write.path,
      ...(await tree.putFile(write.data)),
    })));

    await this.#writeRoot(async (base) => {
      let root = base;
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
      // The document itself changed, for the folder's Last modified.
      return markFolderChanged(tree, root, documentPath);
    });
  }

  /**
   * Changes the Drive this document is in, as one root update made on its
   * newest version. Tabs of this browser write one after another.
   */
  async #writeRoot(change: (root: CID) => Promise<CID>): Promise<void> {
    const opened = this.#opened;
    if (!opened) throw new Error('This document cannot be edited here');
    const { scope, treeName } = opened;
    const tree = getTree();
    await withDriveRootLock(scope, treeName, async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const base = getTreeRootSync(scope, treeName);
        const root = await change(base ?? (await tree.putDirectory([])).cid);
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
    });
  }

  /** Opens the list of earlier versions, for someone who may change the document. */
  openHistory(): void {
    if (this.canEdit && !this.loading) this.historyOpen = true;
  }

  /**
   * Makes the document an earlier version again: `apply` changes it, as one
   * edit of its editor. What was there is stored first, so that it stays a
   * version of its own, and the restore is stored at once, marked with the
   * time of the version it brought back.
   */
  async restoreVersion(time: number, apply: () => void | Promise<void>): Promise<void> {
    await this.saveNow();
    await apply();
    this.#session?.markNext(`r${time.toString(36)}`);
    await this.saveNow();
  }

  /** Back to the document itself: the list closes and no earlier version is shown. */
  closeHistory(): void {
    this.historyOpen = false;
    this.preview = null;
  }

  /**
   * Puts a new document beside this one that holds `update`, an earlier
   * version, named "Copy of …" and with the same attachments. Its history
   * starts with this copy. Resolves to its title.
   */
  async makeCopy(update: Uint8Array): Promise<string> {
    const opened = this.#opened;
    if (!opened || !this.#canWriteOpened()) throw new Error('This document cannot be copied here');
    const target = { npub: opened.npub, treeName: opened.treeName };
    const tree = getTree();
    const file = await tree.putFile(update);
    const saves = await tree.putDirectory([{ name: changeFileName(Date.now(), 1), cid: file.cid, size: file.size, type: LinkType.Blob }]);
    const updates = await tree.putDirectory([{ name: `${this.#writerId}-0`, cid: saves.cid, size: 0, type: LinkType.Dir }]);
    const entries = [{ name: UPDATES_DIRECTORY, cid: updates.cid, size: 0, type: LinkType.Dir }];
    // Attachments are addressed by content: the copy lists the same ones without storing them again.
    const attachments = this.folder
      ? (await tree.listDirectory(this.folder)).find(entry => entry.name === ATTACHMENTS_DIRECTORY && entry.type === LinkType.Dir)
      : undefined;
    if (attachments) entries.push({ name: ATTACHMENTS_DIRECTORY, cid: attachments.cid, size: attachments.size, type: LinkType.Dir });
    const copy = await tree.putDirectory(entries);

    const parentPath = opened.path.slice(0, -1);
    let name = '';
    await this.#writeRoot(async (root) => {
      const parent = parentPath.length ? await tree.resolvePath(root, parentPath) : { cid: root, type: LinkType.Dir };
      const siblings = parent?.type === LinkType.Dir ? await tree.listDirectory(parent.cid) : [];
      name = freeName(documentFolderName(`Copy of ${this.title}`, this.kind.kind), new Set(siblings.map(entry => entry.name)));
      return setEntryForDriveRoute(tree, root, parentPath, name, { cid: copy.cid, size: 0, type: LinkType.Dir }, target, nostrStore.getState());
    });
    return documentTitle(name);
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
    const folder = this.folder;
    if (!folder) return;
    const snapshot = nhashEncode({
      hash: toHex(folder.hash),
      decryptKey: folder.key ? toHex(folder.key) : undefined,
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

  /**
   * Gives the document another title; the page then opens it under the new
   * one. Resolves false when something beside it already has that name.
   */
  async rename(title: string): Promise<boolean> {
    const name = documentFolderName(title, this.kind.kind);
    if (!title.trim() || name === this.dirName) return true;
    await this.saveNow();
    // Nothing more may be saved to the old name once it is gone.
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    const wasSaver = this.#isSaver;
    this.#isSaver = false;
    this.#session?.setSaver(false);
    let renamed = false;
    try {
      renamed = await renameCurrentFolder(name);
      return renamed;
    } finally {
      // Still here under the old name: go on saving to it.
      if (!renamed && wasSaver && !this.#destroyed) {
        this.#isSaver = true;
        this.#session?.setSaver(true);
      }
    }
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
          if (!sameCid(this.folder, folder.cid)) this.folder = folder.cid;
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
