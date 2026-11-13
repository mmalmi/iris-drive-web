<script lang="ts">
  /** A spreadsheet opened from a Drive folder: its bars, its grid and its tabs. */
  import { onMount, onDestroy } from 'svelte';
  import DocumentHeader from '../Viewer/DocumentHeader.svelte';
  import { DriveDocument, STORED_ORIGIN } from '../../lib/yjs';
  import { SheetController } from '../../lib/sheets/controller.svelte';
  import FormulaBar from './FormulaBar.svelte';
  import PopupMenu, { type MenuItem } from './PopupMenu.svelte';
  import SheetGrid from './SheetGrid.svelte';
  import SheetTabs from './SheetTabs.svelte';
  import SheetToolbar from './SheetToolbar.svelte';
  import { IMPORT_ACCEPT, downloadCsv, downloadXlsx, importFile, isSheetFile, localeMenu } from './sheetFiles';

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

  let ready = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();
  let menu = $state.raw<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** True while a file is dragged over the spreadsheet. */
  let dropping = $state(false);

  onMount(() => {
    void (async () => {
      if (!await drive.open()) return;
      ctl.start(drive.canEdit);
      ready = true;
    })();
    // Someone who may only read can sort their own copy. It cannot take in
    // later changes without mixing the two, so then the stored sheet is shown again.
    drive.ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === STORED_ORIGIN && ctl.localOnly) onreset();
    });
  });

  function onkeydown(event: KeyboardEvent): void {
    if (!ready || !(event.ctrlKey || event.metaKey) || event.altKey) return;
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
          checked: sheet.freezeRows > 0,
          action: () => sheet.setFreeze(sheet.freezeRows > 0 ? 0 : 1, sheet.freezeCols),
          testId: 'sheet-freeze-row',
        },
        {
          label: 'Freeze first column',
          icon: 'i-lucide-panel-left',
          checked: sheet.freezeCols > 0,
          action: () => sheet.setFreeze(sheet.freezeRows, sheet.freezeCols > 0 ? 0 : 1),
          testId: 'sheet-freeze-column',
        },
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
    else ctl.say('Drop a CSV or Excel file to add it as a sheet.');
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
  <DocumentHeader {drive}>
    {#if ready && ctl.hasSheet}
      <button onclick={openMenu} class="btn-circle btn-ghost" title="More" aria-label="More" data-testid="sheet-more">
        <span class="i-lucide-ellipsis-vertical text-base"></span>
      </button>
    {/if}
  </DocumentHeader>

  {#if drive.loading && drive.missing}
    <div class="flex-1 flex items-center justify-center text-text-3 text-sm" data-testid="document-missing">Spreadsheet not found</div>
  {:else if !ready}
    <div class="flex-1 flex items-center justify-center text-text-3" data-testid="document-loading">
      <span class="i-lucide-loader-2 animate-spin"></span>
    </div>
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
