<script lang="ts">
  /**
   * What cells accept: a list to choose from, a checkbox, or numbers or dates
   * in a range. A value that does not fit is refused or marked in red.
   */
  import { parseRectName, rectName } from '../../lib/sheets/address';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { NUMBER_FORMATS } from '../../lib/sheets/format';
  import { addValidation } from '../../lib/sheets/ruleCommands';
  import { listRules, rangeIds, readRuleValue, removeRule, setRule, writeRuleValue, type Check, type PlacedRule, type ValidationRule } from '../../lib/sheets/rules';
  import SidePanel from './SidePanel.svelte';

  interface Props {
    ctl: SheetController;
    /** A new rule of this kind is made for the selection when the panel opens. */
    start?: 'list' | 'checkbox';
    onclose: () => void;
  }
  let { ctl, start, onclose }: Props = $props();

  const KINDS: Array<{ kind: Check['kind']; label: string }> = [
    { kind: 'list', label: 'Choose from a list' },
    { kind: 'checkbox', label: 'Checkbox' },
    { kind: 'number', label: 'Number' },
    { kind: 'date', label: 'Date' },
  ];

  let editing = $state<string | null>(null);
  let rangeError = $state('');

  let rules = $derived.by(() => {
    void ctl.revision;
    return ctl.hasSheet ? listRules(ctl.sheet).filter(placed => placed.rule.type === 'valid') : [];
  });
  let current = $derived(rules.find(placed => placed.id === editing) ?? null);

  /** The different values in the selection, as a first list of choices. */
  function choicesInSelection(): string[] {
    const found: string[] = [];
    const rect = ctl.selection;
    const used = ctl.sheet.usedRect();
    for (let row = rect.r1; row <= Math.min(rect.r2, used?.r2 ?? -1) && found.length < 50; row += 1) {
      for (let col = rect.c1; col <= Math.min(rect.c2, used?.c2 ?? -1); col += 1) {
        const text = ctl.engine.textAt(ctl.sheet, row, col).trim();
        if (text && !found.includes(text)) found.push(text);
      }
    }
    return found.length > 0 ? found : ['Option 1', 'Option 2'];
  }

  function add(kind: Check['kind']): void {
    const check: Check = kind === 'list' ? { kind, items: choicesInSelection() } : kind === 'checkbox' ? { kind } : { kind };
    editing = addValidation(ctl, check, kind === 'list' || kind === 'checkbox');
  }

  // Asked for from the Insert menu: made at once.
  let started = false;
  $effect(() => {
    if (start && !started) {
      started = true;
      add(start);
    }
  });

  function rule(): ValidationRule | null {
    return current?.rule.type === 'valid' ? current.rule : null;
  }

  function save(next: ValidationRule): void {
    if (current) setRule(ctl.sheet, current.id, next);
  }

  function setKind(kind: Check['kind']): void {
    const now = rule();
    if (!now || now.check.kind === kind) return;
    save({ ...now, check: kind === 'list' ? { kind, items: choicesInSelection() } : { kind } });
  }

  function setItems(text: string): void {
    const now = rule();
    if (!now) return;
    const items = [...new Set(text.split(/\n|,/).map(item => item.trim()).filter(Boolean))].slice(0, 500);
    save({ ...now, check: { kind: 'list', items } });
  }

  function setBound(which: 'min' | 'max', text: string): void {
    const now = rule();
    if (!now || (now.check.kind !== 'number' && now.check.kind !== 'date')) return;
    const value = readRuleValue(text, ctl.engine.locale);
    const check = { ...now.check } as Extract<Check, { kind: 'number' | 'date' }>;
    if (typeof value === 'number') check[which] = value;
    else delete check[which];
    save({ ...now, check });
  }

  function setRange(text: string): void {
    const now = rule();
    if (!now) return;
    const rect = parseRectName(text);
    if (!rect || rect.r2 >= ctl.sheet.rows.length || rect.c2 >= ctl.sheet.cols.length) {
      rangeError = 'Write cells like C2:C40.';
      return;
    }
    rangeError = '';
    save({ ...now, range: rangeIds(ctl.sheet, rect) });
  }

  function summary(placed: PlacedRule): string {
    if (placed.rule.type !== 'valid') return '';
    const check = placed.rule.check;
    const what = check.kind === 'list' ? `List: ${check.items.slice(0, 3).join(', ')}${check.items.length > 3 ? ', …' : ''}` : KINDS.find(item => item.kind === check.kind)?.label ?? '';
    return `${rectName(placed.rect)} · ${what}`;
  }

  function remove(id: string): void {
    removeRule(ctl.sheet, id);
    if (editing === id) editing = null;
  }

  const DATE = NUMBER_FORMATS.date;
</script>

<SidePanel title="Data validation" {onclose} testId="validation-panel">
  {#if current && current.rule.type === 'valid'}
    {@const valid = current.rule}
    <label class="field">
      Cells
      <input type="text" value={rectName(current.rect)} onchange={(event) => setRange((event.target as HTMLInputElement).value)} data-testid="validation-range" />
      {#if rangeError}<span class="hint" role="alert">{rangeError}</span>{/if}
    </label>
    <label class="field">
      Allow
      <select value={valid.check.kind} onchange={(event) => setKind((event.target as HTMLSelectElement).value as Check['kind'])} data-testid="validation-kind">
        {#each KINDS as choice (choice.kind)}
          <option value={choice.kind}>{choice.label}</option>
        {/each}
      </select>
    </label>
    {#if valid.check.kind === 'list'}
      <label class="field">
        Choices, one per line
        <textarea rows="5" value={valid.check.items.join('\n')} onchange={(event) => setItems((event.target as HTMLTextAreaElement).value)} data-testid="validation-items"></textarea>
      </label>
    {:else if valid.check.kind === 'number' || valid.check.kind === 'date'}
      {@const format = valid.check.kind === 'date' ? DATE : undefined}
      <div class="row">
        <label class="field">From
          <input type="text" placeholder="Any" value={writeRuleValue(valid.check.min, ctl.engine.locale, format)} onchange={(event) => setBound('min', (event.target as HTMLInputElement).value)} data-testid="validation-min" />
        </label>
        <label class="field">To
          <input type="text" placeholder="Any" value={writeRuleValue(valid.check.max, ctl.engine.locale, format)} onchange={(event) => setBound('max', (event.target as HTMLInputElement).value)} data-testid="validation-max" />
        </label>
      </div>
    {:else}
      <p class="hint">Click a checkbox or press Space to tick it. Ticked is TRUE, so =COUNTIF(B2:B9, TRUE) counts them.</p>
    {/if}
    {#if valid.check.kind !== 'checkbox'}
      <div class="field">
        When a value does not fit
        <label class="check"><input type="radio" name="reject" checked={valid.reject} onchange={() => save({ ...valid, reject: true })} data-testid="validation-reject" /> Refuse it</label>
        <label class="check"><input type="radio" name="reject" checked={!valid.reject} onchange={() => save({ ...valid, reject: false })} data-testid="validation-warn" /> Keep it, marked in red</label>
      </div>
    {/if}
    <div class="row">
      <button class="btn-ghost" onclick={() => { editing = null; }} data-testid="validation-done">Done</button>
      <button class="btn-ghost text-danger" onclick={() => remove(current.id)} data-testid="validation-remove"><span class="i-lucide-trash-2"></span> Remove rule</button>
    </div>
  {:else}
    {#if rules.length === 0}
      <p class="hint">Let cells offer a list to choose from or a checkbox, or accept only numbers or dates in a range.</p>
    {/if}
    {#each rules as placed (placed.id)}
      <div class="row">
        <button class="choice grow" onclick={() => { editing = placed.id; }} data-testid="validation-rule">{summary(placed)}</button>
        <button class="btn-circle btn-ghost" onclick={() => remove(placed.id)} title="Remove rule" aria-label="Remove rule"><span class="i-lucide-trash-2"></span></button>
      </div>
    {/each}
    <div class="field">
      Add for {rectName(ctl.selection)}
      <div class="choices">
        {#each KINDS as choice (choice.kind)}
          <button class="choice" onclick={() => add(choice.kind)} data-testid="validation-add-{choice.kind}">{choice.label}</button>
        {/each}
      </div>
    </div>
  {/if}
</SidePanel>

<style>
  .grow {
    flex: 1;
    min-width: 0;
    justify-content: flex-start;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
