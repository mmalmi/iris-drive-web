/** What each function is for, shown while a formula is being typed. */

export interface FunctionDoc {
  name: string;
  /** The values it takes, in order; optional ones in square brackets. */
  args: string;
  about: string;
}

const DOCS: Array<[name: string, args: string, about: string]> = [
  ['ABS', 'number', 'A number without its sign.'],
  ['AND', 'condition, [condition, …]', 'TRUE when every condition is true.'],
  ['AVERAGE', 'value, [value, …]', 'The mean of the numbers.'],
  ['AVERAGEIF', 'range, condition, [average_range]', 'The mean of the cells that meet a condition.'],
  ['AVERAGEIFS', 'average_range, range, condition, […]', 'The mean of the cells that meet every condition.'],
  ['CEILING', 'number, [multiple]', 'Rounds up to the nearest multiple.'],
  ['CHAR', 'number', 'The character with that number.'],
  ['CHOOSE', 'index, choice, [choice, …]', 'The choice at a position.'],
  ['CODE', 'text', 'The number of the first character.'],
  ['COLUMN', '[cell]', 'The column number of a cell.'],
  ['COLUMNS', 'range', 'How many columns a range has.'],
  ['CONCATENATE', 'value, [value, …]', 'Joins values into one text.'],
  ['CORREL', 'range, range', 'How closely two sets of numbers move together, from -1 to 1.'],
  ['COUNT', 'value, [value, …]', 'How many of the values are numbers.'],
  ['COUNTA', 'value, [value, …]', 'How many of the cells are not empty.'],
  ['COUNTBLANK', 'range', 'How many of the cells are empty.'],
  ['COUNTIF', 'range, condition', 'How many cells meet a condition, such as ">10" or "done".'],
  ['COUNTIFS', 'range, condition, [range, condition, …]', 'How many rows meet every condition.'],
  ['COUNTUNIQUE', 'value, [value, …]', 'How many different values there are.'],
  ['DATE', 'year, month, day', 'A date from its parts.'],
  ['DATEDIF', 'start, end, unit', 'The time between two dates in "Y", "M" or "D".'],
  ['DATEVALUE', 'text', 'The date written in a text.'],
  ['DAY', 'date', 'The day of the month.'],
  ['DAYS', 'end, start', 'The number of days between two dates.'],
  ['EDATE', 'start, months', 'The date some months later or earlier.'],
  ['EOMONTH', 'start, months', 'The last day of a month some months away.'],
  ['EXACT', 'text, text', 'TRUE when two texts are the same, capitals included.'],
  ['EXP', 'number', 'e raised to a power.'],
  ['FIND', 'search_for, text, [start]', 'Where one text first appears in another; capitals matter.'],
  ['FIXED', 'number, [decimals], [no_commas]', 'A number as text with a set number of decimals.'],
  ['FLOOR', 'number, [multiple]', 'Rounds down to the nearest multiple.'],
  ['FV', 'rate, periods, payment, [present_value], [at_start]', 'What savings grow to at a steady interest rate.'],
  ['HLOOKUP', 'search_key, range, index, [is_sorted]', 'Finds a value in the top row and returns the cell below it.'],
  ['HYPERLINK', 'address, [label]', 'A link to a web address, shown as its label.'],
  ['HOUR', 'time', 'The hour of a time.'],
  ['IF', 'condition, value_if_true, [value_if_false]', 'One value when a condition is true, another when it is not.'],
  ['IFERROR', 'value, [value_if_error]', 'The value, or something else when it is an error.'],
  ['IFNA', 'value, [value_if_na]', 'The value, or something else when nothing was found.'],
  ['IFS', 'condition, value, [condition, value, …]', 'The value beside the first condition that is true.'],
  ['INDEX', 'range, row, [column]', 'The cell at a position in a range.'],
  ['INT', 'number', 'Rounds down to a whole number.'],
  ['ISBLANK', 'cell', 'TRUE when the cell is empty.'],
  ['ISERROR', 'value', 'TRUE when the value is an error.'],
  ['ISEVEN', 'number', 'TRUE when the number is even.'],
  ['ISNA', 'value', 'TRUE when the value is #N/A.'],
  ['ISNUMBER', 'value', 'TRUE when the value is a number.'],
  ['ISODD', 'number', 'TRUE when the number is odd.'],
  ['ISOWEEKNUM', 'date', 'The week of the year, weeks starting on Monday.'],
  ['ISTEXT', 'value', 'TRUE when the value is text.'],
  ['JOIN', 'separator, value, [value, …]', 'Joins values with a separator between them.'],
  ['LARGE', 'range, n', 'The nth largest number.'],
  ['LEFT', 'text, [length]', 'The first characters of a text.'],
  ['LEN', 'text', 'How many characters a text has.'],
  ['LN', 'number', 'The natural logarithm.'],
  ['LOG', 'number, [base]', 'The logarithm, to base 10 unless told otherwise.'],
  ['LOOKUP', 'search_key, search_range, [result_range]', 'Finds a value in a sorted range and returns the matching result.'],
  ['LOWER', 'text', 'Text in small letters.'],
  ['MATCH', 'search_key, range, [type]', 'The position of a value in a row or column. Type 0 finds it exactly.'],
  ['MAX', 'value, [value, …]', 'The largest number.'],
  ['MAXIFS', 'range, criteria_range, condition, […]', 'The largest number among the cells that meet every condition.'],
  ['MEDIAN', 'value, [value, …]', 'The middle number.'],
  ['MID', 'text, start, length', 'Characters from the middle of a text.'],
  ['MIN', 'value, [value, …]', 'The smallest number.'],
  ['MINIFS', 'range, criteria_range, condition, […]', 'The smallest number among the cells that meet every condition.'],
  ['MINUTE', 'time', 'The minute of a time.'],
  ['MOD', 'number, divisor', 'What is left over after dividing.'],
  ['MODE', 'value, [value, …]', 'The number that appears most often.'],
  ['MONTH', 'date', 'The month of a date, 1 to 12.'],
  ['MROUND', 'number, multiple', 'Rounds to the nearest multiple.'],
  ['NETWORKDAYS', 'start, end, [holidays]', 'The working days between two dates.'],
  ['NOT', 'condition', 'TRUE becomes FALSE and FALSE becomes TRUE.'],
  ['NOW', '', 'The date and time right now.'],
  ['NPV', 'rate, payment, [payment, …]', 'What a series of future payments is worth today.'],
  ['OR', 'condition, [condition, …]', 'TRUE when any condition is true.'],
  ['PERCENTILE', 'range, fraction', 'The value below which a share of the numbers fall.'],
  ['PI', '', 'The number π.'],
  ['PMT', 'rate, periods, present_value, [future_value], [at_start]', 'The payment per period on a loan.'],
  ['POWER', 'number, power', 'A number raised to a power.'],
  ['PRODUCT', 'value, [value, …]', 'The numbers multiplied together.'],
  ['PROPER', 'text', 'Text With Each Word Capitalised.'],
  ['PV', 'rate, periods, payment, [future_value], [at_start]', 'What a series of equal payments is worth today.'],
  ['QUARTILE', 'range, quarter', 'The value at a quarter of the way through the numbers.'],
  ['QUOTIENT', 'number, divisor', 'A division without the remainder.'],
  ['RAND', '', 'A random number between 0 and 1.'],
  ['RANDBETWEEN', 'low, high', 'A random whole number in a range.'],
  ['RANK', 'number, range, [ascending]', 'The position of a number among others.'],
  ['REPLACE', 'text, start, length, new_text', 'Replaces part of a text by position.'],
  ['REPT', 'text, times', 'A text repeated.'],
  ['RIGHT', 'text, [length]', 'The last characters of a text.'],
  ['ROUND', 'number, [decimals]', 'Rounds to a number of decimals.'],
  ['ROUNDDOWN', 'number, [decimals]', 'Rounds towards zero.'],
  ['ROUNDUP', 'number, [decimals]', 'Rounds away from zero.'],
  ['ROW', '[cell]', 'The row number of a cell.'],
  ['ROWS', 'range', 'How many rows a range has.'],
  ['SEARCH', 'search_for, text, [start]', 'Where one text first appears in another; capitals do not matter.'],
  ['SECOND', 'time', 'The second of a time.'],
  ['SIGN', 'number', '-1, 0 or 1, by the sign of a number.'],
  ['SMALL', 'range, n', 'The nth smallest number.'],
  ['SQRT', 'number', 'The square root.'],
  ['STDEV', 'value, [value, …]', 'How spread out a sample of numbers is.'],
  ['STDEVP', 'value, [value, …]', 'How spread out a whole set of numbers is.'],
  ['SUBSTITUTE', 'text, search_for, replace_with, [occurrence]', 'Replaces one text with another.'],
  ['SUM', 'value, [value, …]', 'Adds numbers up.'],
  ['SUMIF', 'range, condition, [sum_range]', 'Adds up the cells that meet a condition.'],
  ['SUMIFS', 'sum_range, range, condition, […]', 'Adds up the cells that meet every condition.'],
  ['SUMPRODUCT', 'range, [range, …]', 'Multiplies ranges cell by cell and adds up the results.'],
  ['SWITCH', 'value, case, result, [case, result, …], [default]', 'The result beside the case that matches a value.'],
  ['TEXT', 'value, format', 'A number or date as text in a format such as "0.00" or "d mmm yyyy".'],
  ['TEXTJOIN', 'separator, skip_empty, value, [value, …]', 'Joins values with a separator, leaving out empty ones if asked.'],
  ['TIME', 'hour, minute, second', 'A time from its parts.'],
  ['TODAY', '', "Today's date."],
  ['TRIM', 'text', 'Text without spaces at its ends or doubled inside.'],
  ['TRUNC', 'number, [decimals]', 'Cuts a number off without rounding.'],
  ['UPPER', 'text', 'Text in capital letters.'],
  ['VALUE', 'text', 'The number written in a text.'],
  ['VAR', 'value, [value, …]', 'The variance of a sample of numbers.'],
  ['VLOOKUP', 'search_key, range, index, [is_sorted]', 'Finds a value in the first column and returns a cell from the same row. Use FALSE for an exact match.'],
  ['WEEKDAY', 'date, [type]', 'The day of the week as a number.'],
  ['WEEKNUM', 'date, [type]', 'The week of the year.'],
  ['WORKDAY', 'start, days, [holidays]', 'The date a number of working days away.'],
  ['XLOOKUP', 'search_key, lookup_range, result_range, [if_missing], [match_mode], [search_mode]', 'Finds a value in one range and returns the matching cell of another.'],
  ['XMATCH', 'search_key, range, [match_mode], [search_mode]', 'The position of a value in a row or column.'],
  ['XOR', 'condition, [condition, …]', 'TRUE when an odd number of conditions are true.'],
  ['YEAR', 'date', 'The year of a date.'],
];

const FUNCTION_DOCS: FunctionDoc[] = DOCS.map(([name, args, about]) => ({ name, args, about }));
const BY_NAME = new Map(FUNCTION_DOCS.map(doc => [doc.name, doc]));

const WORD_BEFORE = new Set(['=', '(', ',', ';', '+', '-', '*', '/', '^', '&', '<', '>', ' ']);

function inText(formula: string, upTo: number): boolean {
  let quoted = false;
  for (let at = 0; at < upTo; at += 1) if (formula[at] === '"') quoted = !quoted;
  return quoted;
}

export interface Completion {
  /** Where the half-typed name starts in the text. */
  start: number;
  end: number;
  matches: FunctionDoc[];
}

/** The functions whose name starts with the word being typed at the caret. */
export function completionAt(text: string, caret: number): Completion | null {
  if (!text.startsWith('=') || inText(text, caret)) return null;
  if (/[A-Za-z0-9_.(]/.test(text[caret] ?? '')) return null;
  let start = caret;
  while (start > 1 && /[A-Za-z0-9.]/.test(text[start - 1])) start -= 1;
  const word = text.slice(start, caret).toUpperCase();
  if (word === '' || !/^[A-Z]/.test(word) || !WORD_BEFORE.has(text[start - 1])) return null;
  const matches = FUNCTION_DOCS.filter(doc => doc.name.startsWith(word)).slice(0, 7);
  return matches.length > 0 ? { start, end: caret, matches } : null;
}

export interface CallHint {
  doc: FunctionDoc;
  /** Which of the function's values the caret is in, counting from 0. */
  argument: number;
}

/** The function whose brackets the caret is inside. */
export function callAt(text: string, caret: number): CallHint | null {
  if (!text.startsWith('=')) return null;
  const open: Array<{ name: string; argument: number }> = [];
  let quoted = false;
  let word = '';
  for (let at = 1; at < caret; at += 1) {
    const char = text[at];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === '(') {
      open.push({ name: word.toUpperCase(), argument: 0 });
    } else if (char === ')') {
      open.pop();
    } else if ((char === ',' || char === ';') && open.length > 0) {
      open[open.length - 1].argument += 1;
    }
    word = /[A-Za-z0-9.]/.test(char) ? word + char : '';
  }
  for (let depth = open.length - 1; depth >= 0; depth -= 1) {
    const doc = BY_NAME.get(open[depth].name);
    if (doc) return { doc, argument: open[depth].argument };
    if (open[depth].name !== '') return null;
  }
  return null;
}

/** A function's values as separate pieces, to highlight the one being typed. */
export function argumentList(doc: FunctionDoc): string[] {
  return doc.args === '' ? [] : doc.args.split(', ');
}
