/**
 * Links in cells. A cell that holds a web address and nothing else links to
 * it, as does a HYPERLINK formula. Only web and mail addresses are opened.
 */

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const OPENABLE = /^(?:https?:\/\/[^/\s]|mailto:[^\s@]+@)/i;

/**
 * The address `text` links to, or null. Typed into a cell, only an address
 * written out (https://… or www.…) counts; given to HYPERLINK (`named`), a
 * bare domain such as example.com does too.
 */
export function linkTarget(text: string, named = false): string | null {
  const address = text.trim();
  if (address === '' || /\s/.test(address)) return null;
  if (SCHEME.test(address)) return OPENABLE.test(address) ? address : null;
  if (/^www\.[^.\s]+\.[^\s]+$/i.test(address)) return `https://${address}`;
  if (named && /^[^./\s]+(\.[^./\s]+)+(\/\S*)?$/.test(address)) return `https://${address}`;
  return null;
}

/** The address as it is shown in the chip under the cell: without the scheme. */
export function shownAddress(href: string): string {
  return href.replace(/^https?:\/\//i, '').replace(/^mailto:/i, '');
}
