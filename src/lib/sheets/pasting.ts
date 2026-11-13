/**
 * Pasting what other apps copied: tables with their looks, and pictures,
 * which float over the grid and are stored with the spreadsheet's own
 * attachments. Our own copies of cells go through pasteText in commands.ts.
 */
import type { Rect } from './address';
import type { SheetController } from './controller.svelte';
import { inputToStored } from './edit';
import type { PastedPicture, PastedTable } from './htmlPaste';
import { encodeText, MAX_COLS, MAX_ROWS, type CellStyle, type Sheet } from './model';
import { addObject } from './objects';

/** Pictures larger than this are not taken in. */
const MAX_PICTURE_BYTES = 15 * 1024 * 1024;
/** A new picture fits in this box unless told otherwise. */
const FIT_WIDTH = 480;
const FIT_HEIGHT = 360;

function ensureSize(sheet: Sheet, rows: number, cols: number): void {
  if (rows > sheet.rows.length) sheet.insert('row', sheet.rows.length, rows - sheet.rows.length);
  if (cols > sheet.cols.length) sheet.insert('col', sheet.cols.length, cols - sheet.cols.length);
}

/** Pastes a table from another app at the selection, as one undo step. Returns where it went. */
export function pasteTable(ctl: SheetController, table: PastedTable): Rect | null {
  if (!ctl.canEdit || table.cells.length === 0) return null;
  const sheet = ctl.sheet;
  const rows = table.cells.length;
  const cols = Math.max(1, ...table.cells.map(line => line.length));
  const { r1, c1 } = ctl.selection;
  const target: Rect = { r1, c1, r2: r1 + rows - 1, c2: c1 + cols - 1 };
  if (target.r2 >= MAX_ROWS || target.c2 >= MAX_COLS) {
    ctl.say('That is too large to paste here.');
    return null;
  }
  ctl.book.transact(() => {
    ensureSize(sheet, target.r2 + 1, target.c2 + 1);
    sheet.unmerge(target);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const row = r1 + r;
        const col = c1 + c;
        const cell = table.cells[r][c];
        const area = { r1: row, c1: col, r2: row, c2: col };
        sheet.clearStyle(area);
        if (!cell) {
          sheet.setRaw(row, col, null);
          continue;
        }
        const style: CellStyle = { ...cell.style };
        if (cell.raw !== undefined) {
          sheet.setRaw(row, col, cell.raw);
        } else if (table.fromIris) {
          // Another Iris spreadsheet wrote numbers down exactly; the rest is text.
          sheet.setRaw(row, col, cell.text === '' ? null : encodeText(cell.text));
        } else {
          // Text from elsewhere is read as typed; a formula from another app is kept as text.
          const text = cell.text.startsWith('=') ? `'${cell.text}` : cell.text;
          const stored = inputToStored(text, ctl.book, sheet, style.nf);
          sheet.setRaw(row, col, stored.raw);
          if (stored.format && !style.nf) style.nf = stored.format;
        }
        if (Object.keys(style).length > 0) sheet.patchStyle(area, style);
      }
    }
    for (const merge of table.merges) {
      const block = { r1: r1 + merge.r1, c1: c1 + merge.c1, r2: r1 + merge.r2, c2: c1 + merge.c2 };
      if (block.r2 <= target.r2 && block.c2 <= target.c2) sheet.merge(block);
    }
  });
  ctl.setSelection({ row: target.r1, col: target.c1 }, { row: target.r2, col: target.c2 });
  return target;
}

/** A picture's own size, or null when the data is not a picture a browser can show. */
async function pictureSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    if (typeof createImageBitmap === 'function' && blob.type !== 'image/svg+xml') {
      // Some pictures a page shows are refused here; those are measured as an <img> below.
      const bitmap = await createImageBitmap(blob).catch(() => null);
      if (bitmap) {
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
      }
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { width: image.naturalWidth || 300, height: image.naturalHeight || 150 };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp' };

export interface PictureSpot {
  row: number;
  col: number;
  dx?: number;
  dy?: number;
  width?: number;
  height?: number;
}

/**
 * Stores a picture with the spreadsheet and places it over the grid, at the
 * active cell unless told where. Returns its id, or null when it could not be.
 */
export async function insertPicture(ctl: SheetController, blob: Blob, spot?: PictureSpot): Promise<string | null> {
  const media = ctl.media;
  if (!ctl.canEdit || !media) return null;
  if (!blob.type.startsWith('image/')) return null;
  if (blob.size > MAX_PICTURE_BYTES) {
    ctl.say('That picture is too large.');
    return null;
  }
  const sheetId = ctl.sheetId;
  const size = await pictureSize(blob);
  if (!size) {
    ctl.say('That picture could not be read.');
    return null;
  }
  const extension = EXTENSIONS[blob.type] ?? 'png';
  const file = blob instanceof File && /\.[a-z0-9]+$/i.test(blob.name) ? blob : new File([blob], `picture.${extension}`, { type: blob.type });
  let name: string;
  try {
    name = await media.store(file);
  } catch (error) {
    console.error('[Sheets] Could not store a picture:', error);
    ctl.say('The picture could not be stored.');
    return null;
  }
  if (!ctl.canEdit || ctl.book.nameOf(sheetId) === undefined) return null;
  const sheet = ctl.book.sheet(sheetId);
  const at = spot ?? { row: ctl.active.row, col: ctl.active.col };
  let { width, height } = size;
  if (spot?.width && spot?.height) {
    width = spot.width;
    height = spot.height;
  } else {
    const scale = Math.min(1, FIT_WIDTH / width, FIT_HEIGHT / height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const row = Math.min(at.row, sheet.rows.length - 1);
  const col = Math.min(at.col, sheet.cols.length - 1);
  const id = addObject(sheet, { kind: 'picture', file: name, width: size.width, height: size.height }, {
    row: sheet.rows.ids[row],
    col: sheet.cols.ids[col],
    dx: at.dx ?? 0,
    dy: at.dy ?? 0,
    width,
    height,
  });
  if (ctl.sheetId === sheetId) ctl.selectedObject = id;
  return id;
}

/** The data behind a picture's address: a data: one directly, a web one if its server lets it be read. */
async function fetchPicture(src: string): Promise<Blob | null> {
  try {
    const response = await fetch(src, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.type.startsWith('image/') ? blob : null;
  } catch {
    return null;
  }
}

/** Brings pictures from pasted HTML in, placed relative to the cell the paste started at. */
export async function pastePictures(ctl: SheetController, pictures: PastedPicture[], origin: { row: number; col: number }): Promise<void> {
  let missed = 0;
  for (const picture of pictures) {
    const blob = await fetchPicture(picture.src);
    if (!blob) {
      missed += 1;
      continue;
    }
    const placed = await insertPicture(ctl, blob, {
      row: origin.row + picture.row,
      col: origin.col + picture.col,
      dx: picture.dx,
      dy: picture.dy,
      width: picture.width,
      height: picture.height,
    });
    if (!placed) missed += 1;
  }
  if (missed > 0) ctl.say(missed === 1 ? 'One picture could not be brought in.' : `${missed} pictures could not be brought in.`);
}
