/**
 * Pictures and charts that float over a sheet's grid.
 *
 * Each one is kept in the sheet's `objects` map under two keys: `o:<id>`
 * says what it is (a picture's file, a chart's settings), `p:<id>` where it
 * is. Someone moving a chart while someone else retitles it keeps both
 * changes; each key is replaced whole, last writer wins. A placement without
 * its content (left by a move that crossed a delete) is not shown.
 *
 * The place is the cell its top left corner is in, by the lasting ids of its
 * row and column, plus a distance into that cell. A picture therefore moves
 * down when rows are added above it, and stays near its place when its row
 * is deleted. The size is in pixels, independent of the cells under it.
 */
import type { Rect } from './address';
import { LOCAL_ORIGIN, newId, type Sheet } from './model';

export type ChartType = 'column' | 'bar' | 'line' | 'pie';

export interface PictureContent {
  kind: 'picture';
  /** The file's name among the document's attachments. */
  file: string;
  /** Size of the picture itself, to keep its shape. */
  width: number;
  height: number;
}

export interface ChartContent {
  kind: 'chart';
  type: ChartType;
  title: string;
  legend: boolean;
  /** The cells the chart shows, by the ids of their first and last rows and columns. */
  r1: string;
  c1: string;
  r2: string;
  c2: string;
  /** Each row is a series rather than each column. */
  byRow?: boolean;
  /** The sheet the cells are on, when not the chart's own. */
  sheet?: string;
}

export type ObjectContent = PictureContent | ChartContent;

export interface Placement {
  /** Ids of the row and column the top left corner is in. */
  row: string;
  col: string;
  /** Pixels from that cell's top left corner. */
  dx: number;
  dy: number;
  width: number;
  height: number;
  /** Higher ones are drawn over lower ones. */
  z: number;
}

/** An object as it shows now: its content, and where it is by position. */
export interface SheetObject {
  id: string;
  content: ObjectContent;
  placement: Placement;
  row: number;
  col: number;
}

export const MIN_OBJECT_SIZE = 24;

function isPlacement(value: unknown): value is Placement {
  const p = value as Placement | null;
  return !!p && typeof p.row === 'string' && typeof p.col === 'string' && typeof p.width === 'number' && typeof p.height === 'number';
}

function isContent(value: unknown): value is ObjectContent {
  const c = value as ObjectContent | null;
  return !!c && (c.kind === 'picture' ? typeof c.file === 'string' : c.kind === 'chart' && typeof c.r1 === 'string');
}

/** The objects on a sheet, lowest first. */
export function listObjects(sheet: Sheet): SheetObject[] {
  const out: SheetObject[] = [];
  for (const [key, value] of sheet.objects.entries()) {
    if (!key.startsWith('o:') || !isContent(value)) continue;
    const id = key.slice(2);
    const placement = sheet.objects.get(`p:${id}`);
    if (!isPlacement(placement)) continue;
    const row = sheet.rows.near(placement.row);
    const col = sheet.cols.near(placement.col);
    if (row < 0 || col < 0) continue;
    out.push({ id, content: value, placement, row, col });
  }
  out.sort((a, b) => (a.placement.z ?? 0) - (b.placement.z ?? 0) || (a.id < b.id ? -1 : 1));
  return out;
}

export function objectById(sheet: Sheet, id: string): SheetObject | null {
  return listObjects(sheet).find(object => object.id === id) ?? null;
}

function topZ(sheet: Sheet): number {
  let z = 0;
  for (const [key, value] of sheet.objects.entries()) {
    if (key.startsWith('p:') && isPlacement(value)) z = Math.max(z, value.z ?? 0);
  }
  return z;
}

/** Adds an object over the others and returns its id. Call inside a transaction for one undo step. */
export function addObject(sheet: Sheet, content: ObjectContent, placement: Omit<Placement, 'z'>): string {
  const id = newId();
  const z = topZ(sheet) + 1;
  sheet.objects.doc?.transact(() => {
    sheet.objects.set(`o:${id}`, content);
    sheet.objects.set(`p:${id}`, { ...placement, z, width: Math.max(MIN_OBJECT_SIZE, Math.round(placement.width)), height: Math.max(MIN_OBJECT_SIZE, Math.round(placement.height)) });
  }, LOCAL_ORIGIN);
  return id;
}

export function placeObject(sheet: Sheet, id: string, placement: Placement): void {
  if (!sheet.objects.has(`o:${id}`)) return;
  sheet.objects.doc?.transact(() => {
    sheet.objects.set(`p:${id}`, {
      ...placement,
      dx: Math.round(placement.dx),
      dy: Math.round(placement.dy),
      width: Math.max(MIN_OBJECT_SIZE, Math.round(placement.width)),
      height: Math.max(MIN_OBJECT_SIZE, Math.round(placement.height)),
    });
  }, LOCAL_ORIGIN);
}

export function changeObject(sheet: Sheet, id: string, content: ObjectContent): void {
  if (!sheet.objects.has(`o:${id}`)) return;
  sheet.objects.doc?.transact(() => sheet.objects.set(`o:${id}`, content), LOCAL_ORIGIN);
}

export function removeObject(sheet: Sheet, id: string): void {
  sheet.objects.doc?.transact(() => {
    sheet.objects.delete(`o:${id}`);
    sheet.objects.delete(`p:${id}`);
  }, LOCAL_ORIGIN);
}

/** Brings an object over all others. */
export function raiseObject(sheet: Sheet, id: string): void {
  const placement = sheet.objects.get(`p:${id}`);
  if (!isPlacement(placement)) return;
  const z = topZ(sheet);
  if ((placement.z ?? 0) >= z) return;
  placeObject(sheet, id, { ...placement, z: z + 1 });
}

/** The cells a chart shows now, or null when they were deleted. `sheet` is the one the cells are on. */
export function chartRect(sheet: Sheet, chart: ChartContent): Rect | null {
  const rows = sheet.rows.span(chart.r1, chart.r2);
  const cols = sheet.cols.span(chart.c1, chart.c2);
  return rows && cols ? { r1: rows[0], r2: rows[1], c1: cols[0], c2: cols[1] } : null;
}

/** A chart's cells by their ids. */
export function rectIds(sheet: Sheet, rect: Rect): Pick<ChartContent, 'r1' | 'c1' | 'r2' | 'c2'> {
  return { r1: sheet.rows.ids[rect.r1], c1: sheet.cols.ids[rect.c1], r2: sheet.rows.ids[rect.r2], c2: sheet.cols.ids[rect.c2] };
}

