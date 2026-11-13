/** Turns a formula's text into a tree that can be calculated. */
import { SheetError } from '../values';
import { errorCodeOf, tokenize, type RefMode, type RefSpec, type Token } from './tokens';

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; v: SheetError }
  | { t: 'empty' }
  | { t: 'ref'; ref: RefSpec }
  | { t: 'name'; name: string }
  | { t: 'un'; op: '-' | '+'; x: Node }
  | { t: 'pct'; x: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'call'; name: string; args: Node[] };

export class FormulaSyntaxError extends Error {}

const BINARY_PRECEDENCE: Record<string, number> = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5,
};

class Parser {
  private readonly tokens: Token[];
  private at = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens.filter(token => token.type !== 'ws');
  }

  parse(): Node {
    if (this.tokens.length === 0) throw new FormulaSyntaxError('The formula is empty');
    const node = this.expression(0);
    const extra = this.peek();
    if (extra) throw new FormulaSyntaxError(`Did not expect "${extra.text}"`);
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token | undefined {
    const token = this.tokens[this.at];
    this.at += 1;
    return token;
  }

  private expression(minPrecedence: number): Node {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (!token || token.type !== 'op') break;
      const precedence = BINARY_PRECEDENCE[token.text];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();
      // Every operator here groups from the left: 2^3^2 is (2^3)^2, as in other spreadsheets.
      const right = this.expression(precedence + 1);
      left = { t: 'bin', op: token.text, l: left, r: right };
    }
    return left;
  }

  private unary(): Node {
    const token = this.peek();
    if (token?.type === 'op' && (token.text === '-' || token.text === '+')) {
      this.next();
      return { t: 'un', op: token.text, x: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let node = this.primary();
    while (this.peek()?.type === 'op' && this.peek()?.text === '%') {
      this.next();
      node = { t: 'pct', x: node };
    }
    return node;
  }

  private primary(): Node {
    const token = this.next();
    if (!token) throw new FormulaSyntaxError('The formula ends too early');
    switch (token.type) {
      case 'num':
        return { t: 'num', v: Number(token.text) };
      case 'str':
        return { t: 'str', v: token.text.slice(1, -1).replace(/""/g, '"') };
      case 'bool':
        return { t: 'bool', v: token.text.toUpperCase() === 'TRUE' };
      case 'err':
        return { t: 'err', v: new SheetError(errorCodeOf(token.text)) };
      case 'ref':
        return { t: 'ref', ref: token.ref as RefSpec };
      case 'name':
        return { t: 'name', name: token.text };
      case 'func':
        return this.call(token.text.toUpperCase());
      case 'open': {
        const inner = this.expression(0);
        if (this.next()?.type !== 'close') throw new FormulaSyntaxError('A closing bracket is missing');
        return inner;
      }
      default:
        throw new FormulaSyntaxError(`Did not expect "${token.text}"`);
    }
  }

  private call(name: string): Node {
    this.next(); // the opening bracket
    const args: Node[] = [];
    if (this.peek()?.type === 'close') {
      this.next();
      return { t: 'call', name, args };
    }
    for (;;) {
      const token = this.peek();
      if (!token) throw new FormulaSyntaxError('A closing bracket is missing');
      if (token.type === 'sep' || token.type === 'close') args.push({ t: 'empty' });
      else args.push(this.expression(0));
      const after = this.next();
      if (!after) throw new FormulaSyntaxError('A closing bracket is missing');
      if (after.type === 'close') break;
      if (after.type !== 'sep') throw new FormulaSyntaxError(`Did not expect "${after.text}"`);
    }
    return { t: 'call', name, args };
  }
}

/** Parses a formula. `text` starts with "=". Throws FormulaSyntaxError. */
export function parseFormula(text: string, mode: RefMode): Node {
  return new Parser(tokenize(text.slice(1), mode)).parse();
}

/** Every reference a formula mentions, in the order they appear. */
export function collectRefs(node: Node, into: RefSpec[] = []): RefSpec[] {
  switch (node.t) {
    case 'ref':
      into.push(node.ref);
      break;
    case 'un':
    case 'pct':
      collectRefs(node.x, into);
      break;
    case 'bin':
      collectRefs(node.l, into);
      collectRefs(node.r, into);
      break;
    case 'call':
      for (const arg of node.args) collectRefs(arg, into);
      break;
    default:
  }
  return into;
}

/** The names of ranges a formula uses, as written. */
export function collectNames(node: Node, into: string[] = []): string[] {
  switch (node.t) {
    case 'name':
      into.push(node.name);
      break;
    case 'un':
    case 'pct':
      collectNames(node.x, into);
      break;
    case 'bin':
      collectNames(node.l, into);
      collectNames(node.r, into);
      break;
    case 'call':
      for (const arg of node.args) collectNames(arg, into);
      break;
    default:
  }
  return into;
}

export function callsAny(node: Node, names: ReadonlySet<string>): boolean {
  switch (node.t) {
    case 'un':
    case 'pct':
      return callsAny(node.x, names);
    case 'bin':
      return callsAny(node.l, names) || callsAny(node.r, names);
    case 'call':
      return names.has(node.name) || node.args.some(arg => callsAny(arg, names));
    default:
      return false;
  }
}
