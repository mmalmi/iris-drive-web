/**
 * Splits a formula into tokens.
 *
 * A formula exists in two spellings. People read and type the first, with
 * positions: `=SUM(A1:B2)+Costs!$C$3`. The document keeps the second, where
 * each reference names the row and the column by their lasting ids:
 * `=SUM([c,r]:[c,r])+[sheet!$c,$r]`. A stored formula therefore keeps pointing
 * at the same cells when rows and columns are inserted, removed or moved, by
 * this device or by another one at the same moment, and no formula has to be
 * rewritten when that happens.
 *
 * A reference that could not be tied to ids (an unknown sheet, a cell beyond
 * the edge) stays in the stored formula as typed and counts as unresolved.
 */
import { ERROR_CODES, type ErrorCode } from '../values';

export type RefMode = 'a1' | 'id';

export interface RefEnd {
  /** Column letters in a typed formula, a column id in a stored one. Null in a whole-row reference. */
  col: string | null;
  /** Row number in a typed formula, a row id in a stored one. Null in a whole-column reference. */
  row: string | null;
  absCol: boolean;
  absRow: boolean;
}

export interface RefSpec {
  /** Sheet name in a typed formula, sheet id in a stored one. Null for the formula's own sheet. */
  sheet: string | null;
  a: RefEnd;
  b: RefEnd | null;
  /** False for a typed reference found inside a stored formula. */
  resolved: boolean;
}

export type TokenType =
  | 'num' | 'str' | 'bool' | 'err' | 'op' | 'open' | 'close' | 'sep' | 'func' | 'name' | 'ref' | 'ws' | 'bad';

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
  ref?: RefSpec;
}

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_.(])/;
const CELL_RANGE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7}):(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_.(])/;
const COL_RANGE = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_.(])/;
const ROW_RANGE = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![A-Za-z0-9_.])/;
const SHEET_PREFIX = /^(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!/;
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.]*/;
const ID_END = String.raw`(\$?)([0-9a-z]*),(\$?)([0-9a-z]*)`;
const ID_REF = new RegExp(String.raw`^\[(?:([0-9a-z]+)!)?${ID_END}\](?::\[${ID_END}\])?`);
const OPERATORS = ['<>', '<=', '>=', '+', '-', '*', '/', '^', '&', '=', '<', '>', '%'];

function end(col: string | null, row: string | null, absCol: string, absRow: string): RefEnd {
  return { col: col ? col.toUpperCase() : null, row, absCol: absCol === '$', absRow: absRow === '$' };
}

/** Reads a typed reference without its sheet prefix at the start of `text`. */
function matchPlainRef(text: string): { length: number; a: RefEnd; b: RefEnd | null } | null {
  let m = CELL_RANGE.exec(text);
  if (m) return { length: m[0].length, a: end(m[2], m[4], m[1], m[3]), b: end(m[6], m[8], m[5], m[7]) };
  m = CELL.exec(text);
  if (m) return { length: m[0].length, a: end(m[2], m[4], m[1], m[3]), b: null };
  m = COL_RANGE.exec(text);
  if (m) return { length: m[0].length, a: end(m[2], null, m[1], ''), b: end(m[4], null, m[3], '') };
  m = ROW_RANGE.exec(text);
  if (m) return { length: m[0].length, a: end(null, m[2], '', m[1]), b: end(null, m[4], '', m[3]) };
  return null;
}

export function tokenize(formula: string, mode: RefMode): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const push = (type: TokenType, length: number, ref?: RefSpec) => {
    tokens.push({ type, text: formula.slice(at, at + length), start: at, end: at + length, ...(ref ? { ref } : {}) });
    at += length;
  };

  while (at < formula.length) {
    const rest = formula.slice(at);
    const char = rest[0];

    const space = /^\s+/.exec(rest);
    if (space) {
      push('ws', space[0].length);
      continue;
    }
    if (char === '"') {
      const text = /^"(?:[^"]|"")*"/.exec(rest);
      if (text) push('str', text[0].length);
      else push('bad', rest.length);
      continue;
    }
    if (char === '(' || char === ')') {
      push(char === '(' ? 'open' : 'close', 1);
      continue;
    }
    if (char === ',' || char === ';') {
      push('sep', 1);
      continue;
    }
    if (char === '#') {
      const code = ERROR_CODES.find(candidate => rest.toUpperCase().startsWith(candidate));
      if (code) push('err', code.length);
      else push('bad', 1);
      continue;
    }
    if (char === '[' && mode === 'id') {
      const m = ID_REF.exec(rest);
      if (m) {
        const a: RefEnd = { col: m[3] || null, row: m[5] || null, absCol: m[2] === '$', absRow: m[4] === '$' };
        const b: RefEnd | null = m[6] === undefined
          ? null
          : { col: m[7] || null, row: m[9] || null, absCol: m[6] === '$', absRow: m[8] === '$' };
        push('ref', m[0].length, { sheet: m[1] ?? null, a, b, resolved: true });
      } else {
        push('bad', 1);
      }
      continue;
    }

    // A sheet name followed by "!" starts a reference to another sheet.
    const prefix = SHEET_PREFIX.exec(rest);
    if (prefix) {
      const plain = matchPlainRef(rest.slice(prefix[0].length));
      if (plain) {
        const sheet = prefix[1] !== undefined ? prefix[1].replace(/''/g, "'") : prefix[2];
        push('ref', prefix[0].length + plain.length, { sheet, a: plain.a, b: plain.b, resolved: mode === 'a1' });
      } else {
        push('bad', prefix[0].length);
      }
      continue;
    }

    const plain = matchPlainRef(rest);
    if (plain) {
      push('ref', plain.length, { sheet: null, a: plain.a, b: plain.b, resolved: mode === 'a1' });
      continue;
    }

    const number = NUMBER.exec(rest);
    if (number) {
      push('num', number[0].length);
      continue;
    }

    const word = IDENTIFIER.exec(rest);
    if (word) {
      const after = rest.slice(word[0].length);
      const upper = word[0].toUpperCase();
      if (/^\s*\(/.test(after)) push('func', word[0].length);
      else if (upper === 'TRUE' || upper === 'FALSE') push('bool', word[0].length);
      else push('name', word[0].length);
      continue;
    }

    const operator = OPERATORS.find(candidate => rest.startsWith(candidate));
    if (operator) push('op', operator.length);
    else push('bad', 1);
  }
  return tokens;
}

export function errorCodeOf(text: string): ErrorCode {
  return text.toUpperCase() as ErrorCode;
}

function idEnd(e: RefEnd): string {
  return `${e.absCol ? '$' : ''}${e.col ?? ''},${e.absRow ? '$' : ''}${e.row ?? ''}`;
}

/** Writes a reference the way the document stores it. */
export function writeIdRef(ref: RefSpec): string {
  const first = `[${ref.sheet ? `${ref.sheet}!` : ''}${idEnd(ref.a)}]`;
  return ref.b ? `${first}:[${idEnd(ref.b)}]` : first;
}

/**
 * Rebuilds a formula with every reference replaced by what `replace` returns.
 * Everything else, spacing included, stays as written.
 */
export function rewriteRefs(formula: string, mode: RefMode, replace: (ref: RefSpec, token: Token) => string): string {
  let out = '';
  for (const token of tokenize(formula, mode)) {
    out += token.type === 'ref' && token.ref ? replace(token.ref, token) : token.text;
  }
  return out;
}
