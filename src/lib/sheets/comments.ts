/**
 * Comments on cells, kept in the sheet's `notes` map.
 *
 * Every message is its own entry, written once, under a new id: two people
 * answering at the same moment both keep their words. A message names its
 * cell by the ids of its row and column, so it follows the cell as rows move,
 * and the thread it belongs to by the id of the thread's first message.
 * Resolving a thread is a separate entry `r:<thread>`, so resolving never
 * loses an answer written at the same time; reopening removes it.
 *
 * Everyone who can open the spreadsheet reads the comments; writing them
 * takes the right to edit.
 */
import { LOCAL_ORIGIN, newId, type Sheet } from './model';

export interface CommentAuthor {
  /** The key this device writes with, as hex. */
  pubkey: string;
  /** The person's identity, when the device belongs to one. */
  profile?: string;
  /** Their name as it was when writing, for when nothing better is known. */
  name?: string;
}

export interface CommentMessage {
  /** "rowId:colId" of the cell. */
  cell: string;
  /** Id of the thread's first message; the first message names itself. */
  thread: string;
  author: CommentAuthor;
  /** Milliseconds since 1970. */
  time: number;
  text: string;
}

export interface CommentThread {
  id: string;
  cell: string;
  messages: Array<CommentMessage & { id: string }>;
  resolved: { by: CommentAuthor; time: number } | null;
}

export const MAX_COMMENT_LENGTH = 4000;

function isMessage(value: unknown): value is CommentMessage {
  const message = value as CommentMessage | null;
  return !!message && typeof message.cell === 'string' && typeof message.thread === 'string' && typeof message.text === 'string' && !!message.author;
}

/** Every thread on the sheet, oldest first, each with its messages in order. */
export function listThreads(sheet: Sheet): CommentThread[] {
  const threads = new Map<string, CommentThread>();
  for (const [id, value] of sheet.notes.entries()) {
    if (id.startsWith('r:') || !isMessage(value)) continue;
    let thread = threads.get(value.thread);
    if (!thread) threads.set(value.thread, thread = { id: value.thread, cell: value.cell, messages: [], resolved: null });
    thread.messages.push({ ...value, id });
    // The cell is where the thread was started.
    if (id === value.thread) thread.cell = value.cell;
  }
  for (const thread of threads.values()) {
    thread.messages.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
    const resolved = sheet.notes.get(`r:${thread.id}`) as CommentThread['resolved'] | undefined;
    thread.resolved = resolved && typeof resolved.time === 'number' ? resolved : null;
  }
  return [...threads.values()]
    .filter(thread => thread.messages.length > 0)
    .sort((a, b) => a.messages[0].time - b.messages[0].time);
}

/** Whether a cell is still there. */
function cellAlive(sheet: Sheet, cell: string): boolean {
  const at = cell.indexOf(':');
  return sheet.rows.indexOf(cell.slice(0, at)) >= 0 && sheet.cols.indexOf(cell.slice(at + 1)) >= 0;
}

/** The threads on cells that are still there. */
export function liveThreads(sheet: Sheet): CommentThread[] {
  return listThreads(sheet).filter(thread => cellAlive(sheet, thread.cell));
}

/** The cells, as "rowId:colId", that have a thread not resolved yet. */
export function openThreadCells(sheet: Sheet): Set<string> {
  const cells = new Set<string>();
  if (sheet.notes.size === 0) return cells;
  for (const thread of listThreads(sheet)) if (!thread.resolved) cells.add(thread.cell);
  return cells;
}

export function threadsAt(sheet: Sheet, row: number, col: number): CommentThread[] {
  const cell = `${sheet.rows.ids[row]}:${sheet.cols.ids[col]}`;
  return listThreads(sheet).filter(thread => thread.cell === cell);
}

/** Writes a message: a new thread on a cell, or an answer in `thread`. Returns its id. */
export function addComment(sheet: Sheet, cell: string, author: CommentAuthor, text: string, thread?: string, now = Date.now()): string | null {
  const clean = text.trim().slice(0, MAX_COMMENT_LENGTH);
  if (!clean) return null;
  const id = newId();
  const message: CommentMessage = { cell, thread: thread ?? id, author, time: now, text: clean };
  sheet.notes.doc?.transact(() => {
    sheet.notes.set(id, message);
    // Answering a resolved thread opens it again.
    if (thread && sheet.notes.has(`r:${thread}`)) sheet.notes.delete(`r:${thread}`);
  }, LOCAL_ORIGIN);
  return id;
}

export function resolveThread(sheet: Sheet, thread: string, by: CommentAuthor, now = Date.now()): void {
  sheet.notes.doc?.transact(() => sheet.notes.set(`r:${thread}`, { by, time: now }), LOCAL_ORIGIN);
}

export function reopenThread(sheet: Sheet, thread: string): void {
  sheet.notes.doc?.transact(() => sheet.notes.delete(`r:${thread}`), LOCAL_ORIGIN);
}

/** Removes one message. Removing a thread's first message removes the whole thread. */
export function deleteComment(sheet: Sheet, id: string): void {
  sheet.notes.doc?.transact(() => {
    const message = sheet.notes.get(id);
    if (!isMessage(message)) return;
    if (message.thread === id) {
      for (const [key, value] of [...sheet.notes.entries()]) {
        if (key === `r:${id}` || (isMessage(value) && value.thread === id)) sheet.notes.delete(key);
      }
    } else {
      sheet.notes.delete(id);
    }
  }, LOCAL_ORIGIN);
}

/** Whether a message was written by this person: by this device, or by another of theirs. */
export function isOwn(author: CommentAuthor, me: CommentAuthor | null): boolean {
  return !!me && (author.pubkey === me.pubkey || (!!author.profile && author.profile === me.profile));
}
