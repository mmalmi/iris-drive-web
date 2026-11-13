/**
 * Position keys: short strings that sort the way the things they belong to
 * are ordered. Each slide and each element carries its own key, so moving
 * one is a single value written to that one thing. Two people reordering at
 * the same moment can therefore never duplicate or drop anything: the worst
 * outcome is that one of the two moves wins.
 *
 * A key is a fraction written in base 62; between any two keys there is
 * always another. Things with equal keys are ordered by their id.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

function isKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  for (const char of value) if (!DIGITS.includes(char)) return false;
  // A trailing zero would leave no room in front of the key.
  return !value.endsWith('0');
}

/** A key strictly between `a` and `b`; `b` null means "no upper bound". `a` is '' for "no lower bound". */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let shared = 0;
    while (shared < b.length && (a[shared] ?? '0') === b[shared]) shared += 1;
    if (shared > 0) return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
  }
  const low = a ? DIGITS.indexOf(a[0]!) : 0;
  const high = b !== null ? DIGITS.indexOf(b[0]!) : BASE;
  if (high - low > 1) return DIGITS[Math.floor((low + high) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[low]! + midpoint(a.slice(1), null);
}

function randomTail(random: () => number): string {
  const first = DIGITS[Math.floor(random() * BASE)]!;
  const last = DIGITS[1 + Math.floor(random() * (BASE - 1))]!;
  return first + last;
}

/**
 * A key that sorts after `before` and ahead of `after` (either may be null
 * for an open end). A random tail keeps two devices that insert at the same
 * place from picking the same key.
 */
export function keyBetween(before: string | null | undefined, after: string | null | undefined, random: () => number = Math.random): string {
  const low = isKey(before) ? before : '';
  let high = isKey(after) ? after : null;
  // Equal or crossed neighbours (from concurrent edits): place after the lower one.
  if (high !== null && low >= high) high = null;
  const middle = midpoint(low, high);
  const candidate = middle + randomTail(random);
  return high === null || candidate < high ? candidate : middle;
}

/** `count` ascending keys between two neighbours. */
export function keysBetween(before: string | null | undefined, after: string | null | undefined, count: number, random: () => number = Math.random): string[] {
  const keys: string[] = [];
  let previous = before;
  for (let index = 0; index < count; index += 1) {
    const key = keyBetween(previous, after, random);
    keys.push(key);
    previous = key;
  }
  return keys;
}

export function comparePositions(left: { pos: string; id: string }, right: { pos: string; id: string }): number {
  if (left.pos < right.pos) return -1;
  if (left.pos > right.pos) return 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** What is stored as a key, or a usable stand-in when it is missing or malformed. */
export function readKey(value: unknown): string {
  return isKey(value) ? value : 'V';
}
