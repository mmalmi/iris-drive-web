/**
 * Tables as text: tab-separated for the clipboard, comma-separated for files.
 * Both quote a cell that holds the separator, a line break or a quote, the
 * way other spreadsheets write and expect them.
 */

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let at = 0;
  const source = text.replace(/^﻿/, '');
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = '';
  };
  while (at < source.length) {
    const char = source[at];
    if (char === '"' && cell === '') {
      // A quoted cell runs to the closing quote; two quotes inside it stand for one.
      at += 1;
      for (;;) {
        const close = source.indexOf('"', at);
        if (close < 0) {
          cell += source.slice(at);
          at = source.length;
          break;
        }
        cell += source.slice(at, close);
        if (source[close + 1] === '"') {
          cell += '"';
          at = close + 2;
        } else {
          at = close + 1;
          break;
        }
      }
      // Anything between the closing quote and the separator belongs to the cell.
      while (at < source.length && source[at] !== delimiter && source[at] !== '\n' && source[at] !== '\r') {
        cell += source[at];
        at += 1;
      }
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
      at += 1;
    } else if (char === '\n' || char === '\r') {
      endRow();
      at += char === '\r' && source[at + 1] === '\n' ? 2 : 1;
    } else {
      cell += char;
      at += 1;
    }
  }
  // A final line break ends the last row; it does not start an empty one.
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

function writeDelimited(rows: string[][], delimiter: string, lineEnd: string): string {
  const needsQuotes = new RegExp(`["\\n\\r${delimiter === '\t' ? '\\t' : delimiter}]`);
  return rows
    .map(row => row.map(cell => (needsQuotes.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(delimiter))
    .join(lineEnd);
}

/** Reads cells copied from a spreadsheet: tabs between cells, a line per row. */
export function parseClipboardTable(text: string): string[][] {
  return parseDelimited(text, '\t');
}

export function writeClipboardTable(rows: string[][]): string {
  return writeDelimited(rows, '\t', '\n');
}

/** The separator a CSV file uses, judged by its first lines. */
function guessDelimiter(text: string): string {
  const sample = text.slice(0, 10_000);
  let best = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t']) {
    let count = 0;
    let quoted = false;
    for (const char of sample) {
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** A CSV file's rows, and the separator it used: ";" usually means numbers are written with a decimal comma. */
export function readCsv(text: string): { rows: string[][]; delimiter: string } {
  const delimiter = guessDelimiter(text);
  return { rows: parseDelimited(text, delimiter), delimiter };
}

export function parseCsv(text: string): string[][] {
  return readCsv(text).rows;
}

/** Comma-separated, or semicolon-separated where numbers have a decimal comma, as spreadsheets there expect. */
export function writeCsv(rows: string[][], delimiter = ','): string {
  return `${writeDelimited(rows, delimiter, '\r\n')}\r\n`;
}
