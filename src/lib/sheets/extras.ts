/** What the grid draws besides cells' own content and looks: rules and comment marks. */
import { openThreadCells } from './comments';
import type { Engine } from './engine';
import type { Sheet } from './model';
import type { CellExtras } from './render';
import { RuleLooks } from './rules';

/** Null when the sheet has no rules and no open comments, so drawing stays as fast as before. */
export function cellExtras(sheet: Sheet, engine: Engine): (CellExtras & { rules: RuleLooks }) | null {
  const rules = new RuleLooks(sheet, engine);
  const noted = openThreadCells(sheet);
  if (rules.empty && noted.size === 0) return null;
  return {
    rules,
    any: rules.validation.length > 0 || noted.size > 0,
    look: (row, col) => rules.look(row, col),
    control: (row, col) => {
      const check = rules.validation.length > 0 ? rules.checkAt(row, col)?.check : undefined;
      return check?.kind === 'checkbox' ? 'checkbox' : check?.kind === 'list' ? 'list' : null;
    },
    invalid: (row, col) => rules.validation.length > 0 && rules.invalidAt(row, col),
    commented: (row, col) => noted.size > 0 && noted.has(`${sheet.rows.ids[row]}:${sheet.cols.ids[col]}`),
  };
}
