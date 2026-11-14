<script lang="ts">
  /** A spreadsheet opened from a Drive folder: its bars, its grid and its tabs. */
  import { onMount, onDestroy, untrack } from 'svelte';
  import * as Y from 'yjs';
  import DocumentHeader from '../Viewer/DocumentHeader.svelte';
  import { HISTORY_SHORTCUT } from '../Viewer/versionShortcut';
  import { DriveDocument, LIVE_ORIGIN, STORED_ORIGIN } from '../../lib/yjs';
  import { SheetController } from '../../lib/sheets/controller.svelte';
  import { LOCAL_ORIGIN } from '../../lib/sheets/model';
  import FormulaBar from './FormulaBar.svelte';
  import PopupMenu, { type MenuItem } from './PopupMenu.svelte';
  import { freezeItems } from './menus';
  import SheetGrid from './SheetGrid.svelte';
  import SheetTabs from './SheetTabs.svelte';
  import SheetToolbar from './SheetToolbar.svelte';
  import { readSiblingFile, takeImportRequest } from '../../lib/fileImports';
  import { get } from 'svelte/store';
  import { nostrStore } from '../../nostr';
  import { activeNostrIdentityRootScope } from '../../drive/profileRoute';
  import { createIdentityProfileNameStore } from '../../stores/identityProfile';
  import { accountsStore } from '../../accounts';
  import { IMPORT_ACCEPT, downloadCsv, downloadXlsx, fillFromFile, importFile, isBlank, isSheetFile, localeMenu } from './sheetFiles';
  import { printAlone } from '../../lib/printAlone';
  import { rectOf } from '../../lib/sheets/address';
  import { flashPresence, type PresenceState } from '../../lib/yjs/presence.svelte';
  import { sheetPlace } from './PresenceLayer.svelte';
  import { sheetPrintPage } from '../../lib/sheets/print';

  interface Props {
    dirName: string;
    /** Shown once under the bars, to say why the spreadsheet was opened afresh. */
    notice?: string;
    /** Asks for the spreadsheet to be opened afresh from what is stored. */
    onreset: () => void;
  }
  let { dirName, notice = '', onreset }: Props = $props();

  // svelte-ignore state_referenced_locally
  const drive = new DriveDocument(dirName);
  const ctl = new SheetController(drive.ydoc);
  // Comments are signed with this device's key and its owner's identity.
  ctl.authorOf = () => {
    const state = nostrStore.getState();
    if (!state.pubkey) return null;
    const profile = activeNostrIdentityRootScope(state) ?? undefined;
    // The name chosen for the account on this device, else the one its profile gives.
    const chosen = accountsStore.getState().accounts.find(account => account.pubkey === state.pubkey)?.name?.trim();
    const named = get(createIdentityProfileNameStore(profile, state.pubkey));
    const name = chosen || (named.name !== named.fallbackName ? named.name : '');
    return { pubkey: state.pubkey, ...(profile ? { profile } : {}), ...(name ? { name } : {}) };
  };
  ctl.others = () => drive.presence.others;
  // Pictures are kept with the spreadsheet's attachments.
  ctl.media = {
    urlOf: file => drive.attachmentUrls.get(file),
    store: file => drive.addAttachment(file),
  };

  let ready = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();
  let menu = $state.raw<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** True while a file is dragged over the spreadsheet. */
  let dropping = $state(false);
  /** True while a file from the Drive is being brought in. */
  let importing = $state(false);

  /** The sheet open when this spreadsheet was last seen on this device, opened again next time. */
  const openSheetKey = `iris-sheets:open:${window.location.hash.split('?')[0]}`;
  $effect(() => {
    const id = ctl.sheetId;
    if (!ready || !id) return;
    try {
      localStorage.setItem(openSheetKey, id);
    } catch {
      // Not kept; the first sheet opens next time.
    }
  });

  function reopenSheet(): void {
    try {
      const id = localStorage.getItem(openSheetKey);
      if (id) ctl.showSheet(id);
    } catch {
      // Storage is not available here.
    }
  }

  // Where this person is, for the others who have the spreadsheet open: the
  // sheet, and the rows and columns of the selection's corners, which stay
  // right when rows move.
  $effect(() => {
    if (!ready || !ctl.hasSheet) return;
    const { rows, cols } = ctl.sheet;
    const { anchor, focus } = ctl;
    drive.presence.set('sheet', {
      id: ctl.sheetId,
      a: [rows.ids[anchor.row] ?? '', cols.ids[anchor.col] ?? ''],
      f: [rows.ids[focus.row] ?? '', cols.ids[focus.col] ?? ''],
    });
  });

  /** The cells someone else has selected, on the sheet they are on, or null when that is gone. */
  function placeOf(state: PresenceState): { sheetId: string; row: number; col: number } | null {
    const place = sheetPlace(state.sheet);
    if (!place || ctl.book.nameOf(place.id) === undefined) return null;
    const { rows, cols } = ctl.book.sheet(place.id);
    const anchor = { row: rows.indexOf(place.a[0]), col: cols.indexOf(place.a[1]) };
    const focus = { row: rows.indexOf(place.f[0]), col: cols.indexOf(place.f[1]) };
    if (anchor.row < 0 || anchor.col < 0 || focus.row < 0 || focus.col < 0) return null;
    const rect = rectOf(anchor, focus);
    return { sheetId: place.id, row: rect.r1, col: rect.c1 };
  }

  // Going to someone from the header shows their cells, on their sheet, and
  // makes them blink; this person's own selection stays where it is.
  drive.presence.finder = {
    can: state => ready && !versionCtl && placeOf(state) !== null,
    go: (state) => {
      const place = placeOf(state);
      if (!place) return;
      if (place.sheetId !== ctl.sheetId) ctl.showSheet(place.sheetId);
      ctl.reveal(place.row, place.col);
      setTimeout(() => {
        flashPresence(document.querySelector(`[data-testid="sheet-presence"][data-client="${state.clientId}"]`), state.user.color);
      }, 150);
    },
  };

  // Printing, from the toolbar or the browser's own menu, prints the cells in use alone.
  $effect(() => printAlone(() => (ready && ctl.hasSheet ? sheetPrintPage(ctl) : null)));

  onMount(() => {
    // This person's name is looked up now, so their first comment already carries it.
    const state = nostrStore.getState();
    const stopName = state.pubkey ? createIdentityProfileNameStore(activeNostrIdentityRootScope(state) ?? undefined, state.pubkey).subscribe(() => {}) : () => {};
    void (async () => {
      if (!await drive.open()) return;
      ctl.start(drive.canEdit);
      reopenSheet();
      ready = true;
      await bringInRequestedFile();
    })();
    // Someone who may only read can sort their own copy. It cannot take in
    // later changes without mixing the two, so then the stored sheet is shown again.
    drive.ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      if ((origin === STORED_ORIGIN || origin === LIVE_ORIGIN) && ctl.localOnly) onreset();
    });
    return stopName;
  });

  /** Opened from a spreadsheet file in the Drive: its content comes in once (see fileImports.ts). */
  async function bringInRequestedFile(): Promise<void> {
    const fileName = takeImportRequest();
    if (!fileName || !ctl.canEdit || !isBlank(ctl)) return;
    importing = true;
    try {
      const data = await readSiblingFile(fileName);
      if (!data) ctl.say(`${fileName} could not be read.`);
      else if (isBlank(ctl)) await fillFromFile(ctl, fileName, data);
    } finally {
      importing = false;
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    if (!ready || versionCtl || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'f' && key !== 'h') return;
    event.preventDefault();
    ctl.openFind(key === 'h');
  }

  // Access can change while the spreadsheet is open.
  $effect(() => {
    const allowed = drive.canEdit && !ctl.book.tooNew;
    if (ready && ctl.canEdit !== allowed) {
      if (!allowed) ctl.cancelEdit();
      ctl.start(allowed);
    }
  });

  /** An earlier version, shown read-only in place of the spreadsheet. */
  let versionCtl = $state.raw<SheetController | null>(null);
  $effect(() => {
    const shown = drive.preview;
    if (!shown) {
      versionCtl = null;
      return;
    }
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, shown.update);
    const viewed = untrack(() => {
      const made = new SheetController(ydoc);
      made.media = { urlOf: file => drive.attachmentUrls.get(file), store: () => Promise.reject(new Error('An earlier version cannot be changed')) };
      made.start(false);
      // The sheet that is open stays open, when the version has it.
      if (made.book.nameOf(ctl.sheetId) !== undefined) made.showSheet(ctl.sheetId);
      return made;
    });
    versionCtl = viewed;
    return () => {
      viewed.destroy();
      ydoc.destroy();
    };
  });

  /** Makes the spreadsheet what an earlier version holds, as one step undo takes back. */
  async function restoreVersion(update: Uint8Array): Promise<void> {
    const { restoreVersion: restore } = await import('../../lib/yjs/versionHistory');
    ctl.commitEdit();
    restore(drive.ydoc, update, LOCAL_ORIGIN);
  }

  onDestroy(() => {
    ctl.commitEdit();
    drive.destroy();
    ctl.destroy();
  });

  function openMenu(event: MouseEvent): void {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const sheet = ctl.sheet;
    const items: MenuItem[] = [];
    if (ctl.canEdit) {
      items.push({ label: 'Import CSV or Excel file', icon: 'i-lucide-file-up', action: () => fileInput?.click(), testId: 'sheet-import-csv' });
      items.push({ label: 'Version history', icon: 'i-lucide-history', hint: HISTORY_SHORTCUT, action: () => drive.openHistory(), testId: 'version-history' });
    }
    items.push(
      { label: 'Download as Excel', icon: 'i-lucide-file-spreadsheet', action: () => void downloadXlsx(ctl, drive.title), testId: 'sheet-download-xlsx' },
      { label: 'Download as CSV', icon: 'i-lucide-download', action: () => downloadCsv(ctl, drive.title), testId: 'sheet-download-csv' },
    );
    if (ctl.canEdit) {
      items.push(
        {
          label: 'Numbers and dates',
          icon: 'i-lucide-languages',
          divider: true,
          action: () => queueMicrotask(() => { menu = { x: bounds.right - 300, y: bounds.bottom + 4, items: localeMenu(ctl) }; }),
          testId: 'sheet-locale',
        },
        {
          label: 'Freeze first row',
          icon: 'i-lucide-panel-top',
          checked: sheet.freezeRows === 1,
          action: () => sheet.setFreeze(sheet.freezeRows === 1 ? 0 : 1, sheet.freezeCols),
          testId: 'sheet-freeze-row',
        },
        {
          label: 'Freeze first column',
          icon: 'i-lucide-panel-left',
          checked: sheet.freezeCols === 1,
          action: () => sheet.setFreeze(sheet.freezeRows, sheet.freezeCols === 1 ? 0 : 1),
          testId: 'sheet-freeze-column',
        },
        ...freezeItems(ctl).filter(item => !/row 1$|column A$/.test(item.label)).map(item => ({ ...item, divider: false })),
        { label: 'Named ranges', icon: 'i-lucide-tag', divider: true, action: () => { ctl.panel = { kind: 'names' }; }, testId: 'sheet-names' },
      );
    }
    menu = { x: bounds.right - 220, y: bounds.bottom + 4, items };
  }

  async function onFileChosen(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await importFile(ctl, file);
  }

  function ondragover(event: DragEvent): void {
    if (!ready || !ctl.canEdit || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    dropping = true;
  }

  function ondrop(event: DragEvent): void {
    dropping = false;
    const file = event.dataTransfer?.files[0];
    if (!ready || !ctl.canEdit || !file) return;
    event.preventDefault();
    if (isSheetFile(file)) void importFile(ctl, file);
    else if (file.type.startsWith('image/')) {
      // Pictures float over the grid at the active cell, as when pasted.
      const pictures = [...(event.dataTransfer?.files ?? [])].filter(each => each.type.startsWith('image/'));
      void import('../../lib/sheets/pasting').then(async ({ insertPicture }) => {
        for (const picture of pictures) await insertPicture(ctl, picture);
      });
    } else ctl.say('Drop a picture, or a CSV or Excel file to add it as a sheet.');
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="relative flex-1 flex flex-col min-h-0 bg-surface-0"
  data-testid="document-editor"
  {onkeydown}
  {ondragover}
  {ondrop}
  ondragleave={(event) => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) dropping = false; }}
>
  <DocumentHeader {drive} editorMenu>
    {#if ready && ctl.hasSheet && !versionCtl}
      <button onclick={openMenu} class="btn-circle btn-ghost" title="More" aria-label="More" data-testid="sheet-more">
        <span class="i-lucide-ellipsis-vertical text-base"></span>
      </button>
    {/if}
  </DocumentHeader>

  {#if versionCtl}
    {#await import('../Viewer/VersionBar.svelte') then { default: VersionBar }}
      <VersionBar {drive} onrestore={restoreVersion} />
    {/await}
  {/if}
  <div class="flex-1 flex min-h-0">
  <div class="flex-1 flex flex-col min-w-0 min-h-0">
  {#if drive.loading && drive.missing}
    <div class="flex-1 flex items-center justify-center text-text-3 text-sm" data-testid="document-missing">Spreadsheet not found</div>
  {:else if !ready}
    <div class="flex-1 flex items-center justify-center text-text-3" data-testid="document-loading">
      <span class="i-lucide-loader-2 animate-spin"></span>
    </div>
  {:else if versionCtl}
    {#if versionCtl.hasSheet}
      {#key versionCtl}
        <FormulaBar ctl={versionCtl} />
        <SheetGrid ctl={versionCtl} />
        <SheetTabs ctl={versionCtl} />
      {/key}
    {:else}
      <div class="flex-1 flex items-center justify-center text-text-3 text-sm">This version is empty</div>
    {/if}
  {:else if !ctl.hasSheet}
    <div class="flex-1 flex items-center justify-center text-text-3 text-sm" data-testid="sheet-empty">This spreadsheet is empty</div>
  {:else}
    {#if ctl.book.tooNew}
      <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-warning/20" role="alert">
        This spreadsheet was made with a newer version of Iris Drive. Update the app to change it.
      </div>
    {/if}
    {#if notice}
      <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-warning/20" role="status" data-testid="sheet-notice">{notice}</div>
    {/if}
    <SheetToolbar {ctl} />
    <FormulaBar {ctl} />
    <SheetGrid {ctl} />
    <SheetTabs {ctl} />
  {/if}
  </div>
  {#if drive.historyOpen}
    {#await import('../Viewer/VersionHistoryPanel.svelte') then { default: VersionHistoryPanel }}
      <VersionHistoryPanel {drive} />
    {/await}
  {/if}
  </div>
  {#if importing}
    <div class="absolute inset-0 z-40 flex items-center justify-center gap-2 bg-surface-0/80 text-text-2 text-sm" data-testid="sheet-importing">
      <span class="i-lucide-loader-2 animate-spin"></span>
      Opening the file…
    </div>
  {/if}
  {#if dropping}
    <div class="drop-zone" data-testid="sheet-drop-zone">
      <span class="i-lucide-file-up text-2xl"></span>
      Drop to add it as a sheet
    </div>
  {/if}
</div>

<input bind:this={fileInput} type="file" accept={IMPORT_ACCEPT} class="hidden" onchange={onFileChosen} data-testid="sheet-csv-input" />

{#if menu}
  <PopupMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => { menu = null; ctl.focusGrid(); }} />
{/if}

<style>
  .drop-zone {
    position: absolute;
    inset: 8px;
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 2px dashed #916dfe;
    border-radius: 12px;
    background: rgb(145 109 254 / 0.12);
    color: rgb(var(--text-1));
    font-size: 0.95rem;
    pointer-events: none;
  }
</style>
