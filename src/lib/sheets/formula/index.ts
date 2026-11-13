/** The formula language: reading, calculating and the functions it knows. */
import './functions/math';
import './functions/logic';
import './functions/text';
import './functions/lookup';
import './functions/date';

export { FUNCTIONS, evaluateFormula, type EvalHost, type EvalScope } from './evaluate';
export { FormulaSyntaxError, callsAny, collectRefs, parseFormula, type Node } from './parser';
export { rewriteRefs, tokenize, writeIdRef, type RefEnd, type RefMode, type RefSpec, type Token } from './tokens';

/** Functions whose answer changes without any cell changing. */
export const VOLATILE_FUNCTIONS: ReadonlySet<string> = new Set(['NOW', 'TODAY', 'RAND', 'RANDBETWEEN']);
