/** Continuing a run of cells when its corner is dragged: 1, 2 → 3, 4; Mon → Tue. */
import { DAY_NAMES, MONTH_NAMES } from './dates';
import { decodeRaw, isFormula, type CellRaw } from './model';

export interface FillSource {
  raw: CellRaw | undefined;
  /** The cell shows its number as a date. */
  isDate: boolean;
}

/** One filled cell: either a new value, or a copy of the source cell at `source`. */
export interface FillStep {
  source: number;
  value?: number | string;
}

function constantStep(numbers: number[]): number | null {
  if (numbers.length < 2) return null;
  const step = numbers[1] - numbers[0];
  for (let index = 2; index < numbers.length; index += 1) {
    if (Math.abs(numbers[index] - numbers[index - 1] - step) > 1e-9 * Math.max(1, Math.abs(step))) return null;
  }
  return step;
}

const NAME_LISTS = [
  DAY_NAMES,
  DAY_NAMES.map(name => name.slice(0, 3)),
  MONTH_NAMES,
  MONTH_NAMES.map(name => name.slice(0, 3)),
];

/** Writes a name in the capitals of the example: mon → tue, MON → TUE. */
function likeExample(name: string, example: string): string {
  if (example === example.toUpperCase()) return name.toUpperCase();
  if (example === example.toLowerCase()) return name.toLowerCase();
  return name;
}

function nameSeries(texts: string[]): ((position: number) => string) | null {
  for (const list of NAME_LISTS) {
    const lower = list.map(name => name.toLowerCase());
    const indexes = texts.map(text => lower.indexOf(text.trim().toLowerCase()));
    if (indexes.some(index => index < 0)) continue;
    // May ("May" is both the full and the short name) is taken as whichever list comes first.
    let step = 1;
    if (indexes.length > 1) {
      step = (indexes[1] - indexes[0] + list.length) % list.length;
      const regular = indexes.every((index, i) => i === 0 || (index - indexes[i - 1] + list.length) % list.length === step);
      if (!regular || step === 0) continue;
    }
    const start = indexes[0];
    return position => likeExample(list[(((start + position * step) % list.length) + list.length) % list.length], texts[0].trim());
  }
  return null;
}

/**
 * What goes into `count` cells that continue `lane`. With `backwards` the
 * cells lie before the lane, nearest first.
 */
export function planFill(lane: FillSource[], count: number, backwards = false): FillStep[] {
  const size = lane.length;
  /** Position in the continued series of the k-th new cell; the lane itself is 0..size-1. */
  const position = (k: number) => (backwards ? -1 - k : size + k);
  const copy = (k: number): FillStep => ({ source: ((position(k) % size) + size) % size });
  const steps = (make: (pos: number, k: number) => FillStep): FillStep[] => Array.from({ length: count }, (_unused, k) => make(position(k), k));
  const copies = () => steps((_pos, k) => copy(k));
  if (size === 0 || lane.some(cell => cell.raw === undefined || isFormula(cell.raw))) return copies();

  const values = lane.map(cell => decodeRaw(cell.raw));
  if (values.every(value => typeof value === 'number')) {
    const numbers = values as number[];
    const step = size === 1 ? (lane[0].isDate ? 1 : null) : constantStep(numbers);
    if (step === null) return copies();
    return steps((pos, k) => ({ ...copy(k), value: Number((numbers[0] + step * pos).toPrecision(15)) }));
  }

  if (values.every(value => typeof value === 'string')) {
    const texts = values as string[];
    const names = nameSeries(texts);
    if (names) return steps((pos, k) => ({ ...copy(k), value: names(pos) }));

    // Text ending in a number: Item 1, Item 2 …
    const parts = texts.map(text => /^(.*?)(\d+)$/.exec(text));
    if (parts.every(Boolean) && parts.every(part => (part as RegExpExecArray)[1] === (parts[0] as RegExpExecArray)[1])) {
      const numbers = parts.map(part => Number((part as RegExpExecArray)[2]));
      const step = size === 1 ? 1 : constantStep(numbers);
      const width = (parts[0] as RegExpExecArray)[2].length;
      const padded = (parts[0] as RegExpExecArray)[2].startsWith('0') && width > 1;
      if (step !== null) {
        return steps((pos, k) => {
          const number = numbers[0] + step * pos;
          if (number < 0) return copy(k);
          return { ...copy(k), value: `${(parts[0] as RegExpExecArray)[1]}${padded ? String(number).padStart(width, '0') : number}` };
        });
      }
    }
  }
  return copies();
}
