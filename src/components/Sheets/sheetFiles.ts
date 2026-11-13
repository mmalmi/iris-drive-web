/**
 * Files in and out of a spreadsheet (CSV and Excel), and the choice of how
 * numbers and dates are written. The Excel code loads only when used.
 *
 * The icon names here are only found by the style generator because of this marker:
 * @unocss-include
 */
import { exportCsv, importCsv } from '../../lib/sheets/commands';
import type { SheetController } from '../../lib/sheets/controller.svelte';
import { NUMBER_FORMATS, browserLocale, formatValue, localeFor } from '../../lib/sheets/format';
import type { MenuItem } from './PopupMenu.svelte';

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The files the spreadsheet can take in, for a file picker. */
export const IMPORT_ACCEPT = `.csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,text/plain,${XLSX_TYPE}`;

export function isSheetFile(file: File): boolean {
  return /\.(csv|tsv|txt|xlsx)$/i.test(file.name) || file.type === XLSX_TYPE || file.type === 'text/csv';
}

/** Brings a CSV or Excel file in as new sheets. */
export async function importFile(ctl: SheetController, file: File): Promise<void> {
  if (!ctl.canEdit) return;
  if (file.size > MAX_IMPORT_BYTES) {
    ctl.say('That file is too large to open as a sheet.');
    return;
  }
  if (/\.xlsx$/i.test(file.name) || file.type === XLSX_TYPE) {
    const [{ importXlsx }, data] = await Promise.all([import('../../lib/sheets/xlsx'), file.arrayBuffer()]);
    importXlsx(ctl, file.name, new Uint8Array(data));
  } else {
    importCsv(ctl, file.name, await file.text());
  }
  ctl.focusGrid();
}

/** Whether the spreadsheet is as it was made: one sheet with nothing in it. */
export function isBlank(ctl: SheetController): boolean {
  const { sheets } = ctl.book;
  if (sheets.length !== 1) return sheets.length === 0;
  const sheet = ctl.book.sheet(sheets[0].id);
  return sheet.cells.size === 0 && sheet.styles.size === 0 && sheet.props.size === 0;
}

/**
 * Fills a blank spreadsheet with a file's content, in place of its empty
 * first sheet. Returns false when the file could not be read.
 */
export async function fillFromFile(ctl: SheetController, fileName: string, data: Uint8Array): Promise<boolean> {
  if (!ctl.canEdit) return false;
  const emptyId = isBlank(ctl) ? ctl.book.sheets[0]?.id ?? null : null;
  const before = ctl.book.sheets.length;
  if (/\.xlsx$/i.test(fileName)) {
    const { importXlsx } = await import('../../lib/sheets/xlsx');
    importXlsx(ctl, fileName, data);
  } else {
    importCsv(ctl, fileName, new TextDecoder().decode(data));
    // The file's sheet takes the empty one's place.
    if (emptyId && ctl.book.sheets.length > before) ctl.book.removeSheet(emptyId);
  }
  ctl.clearUndo();
  return ctl.book.sheets.length > 0 && !(emptyId && ctl.book.sheets.length === 1 && ctl.book.sheets[0].id === emptyId);
}

function save(blob: Blob, name: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name.replace(/[\\/:*?"<>|]/g, ' ');
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

/** The sheet in view as a CSV file. */
export function downloadCsv(ctl: SheetController, title: string): void {
  ctl.commitEdit();
  const sheetName = ctl.book.nameOf(ctl.sheetId) ?? 'Sheet';
  save(new Blob([exportCsv(ctl)], { type: 'text/csv;charset=utf-8' }), `${ctl.sheets.length > 1 ? `${title} - ${sheetName}` : title}.csv`);
}

/** Every sheet as one Excel file. */
export async function downloadXlsx(ctl: SheetController, title: string): Promise<void> {
  ctl.commitEdit();
  const { writeXlsx } = await import('../../lib/sheets/xlsx');
  const data = writeXlsx(ctl.book, ctl.engine);
  save(new Blob([data as BlobPart], { type: XLSX_TYPE }), `${title}.xlsx`);
}

/** Locales offered to choose from, besides following each reader's browser. */
const LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'fi-FI', 'sv-SE', 'pt-BR', 'ja-JP'];

/** "1,234.56 · 11/13/2026": how a locale writes a number and a date. */
function sample(tag: string): string {
  const locale = localeFor(tag);
  return `${formatValue(1234.56, '#,##0.00', locale)} · ${formatValue(46339, NUMBER_FORMATS.date, locale)}`;
}

/** A locale's name, short: "German"; with its region only where the list has the language twice, as "British English". */
function languageName(tag: string): string {
  const language = tag.split('-')[0];
  const alone = LOCALES.filter(other => other.split('-')[0] === language).length <= 1;
  try {
    const names = new Intl.DisplayNames([browserLocale()], { type: 'language' });
    return names.of(alone ? language : tag) ?? tag;
  } catch {
    return tag;
  }
}

/** Choices for how numbers and dates are written in the spreadsheet, for everyone who opens it. */
export function localeMenu(ctl: SheetController): MenuItem[] {
  const current = ctl.book.localeSetting;
  const items: MenuItem[] = [{
    label: `Each reader's own (${sample(browserLocale())})`,
    checked: current === null,
    action: () => ctl.book.setLocale(null),
    testId: 'sheet-locale-auto',
  }];
  for (const tag of LOCALES) {
    items.push({
      label: `${languageName(tag)}: ${sample(tag)}`,
      checked: current === tag,
      divider: items.length === 1,
      action: () => ctl.book.setLocale(tag),
      testId: `sheet-locale-${tag}`,
    });
  }
  if (current && !LOCALES.includes(current)) {
    items.push({ label: `${languageName(current)}: ${sample(current)}`, checked: true, action: () => {}, testId: `sheet-locale-${current}` });
  }
  return items;
}
