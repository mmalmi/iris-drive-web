/**
 * When a file or folder last changed: kept with its entry in the Drive, as
 * `modified_at` in Unix seconds, the way the native Iris Drive app writes it.
 * Entries written before it was kept have none, and show none.
 */
import type { TreeEntry } from '@hashtree/core';

const KEY = 'modified_at';
/** Anything earlier is no real time (the native app reads it the same way). */
const EARLIEST = 946_684_800;

export function modifiedAt(entry: Pick<TreeEntry, 'meta'>): number | null {
  const value = entry.meta?.[KEY];
  return typeof value === 'number' && Number.isFinite(value) && value >= EARLIEST ? value : null;
}

/** An entry's details with the time of a change made `now`. */
export function withModifiedAt(meta: Record<string, unknown> | undefined, now = new Date()): Record<string, unknown> {
  return { ...meta, [KEY]: Math.floor(now.getTime() / 1000) };
}

/** As Google Drive shows it: "10:42" today, "Nov 12" this year, "Nov 12, 2025" before. */
export function formatModified(seconds: number, now = new Date(), locale?: string): string {
  const date = new Date(seconds * 1000);
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(locale, date.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The whole date and time, for a hover. */
export function describeModified(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
