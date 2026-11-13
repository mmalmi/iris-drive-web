<script lang="ts">
  /**
   * Conditional formatting: colours and type that cells take on when their
   * value meets a condition, or a colour scale over numbers. Every change
   * shows at once and is one undo step.
   */
  import { parseRectName, rectName } from '../../lib/sheets/address';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import {
    addRule,
    listRules,
    rangeIds,
    readRuleValue,
    removeRule,
    setRule,
    writeRuleValue,
    type ConditionKind,
    type FormatRule,
    type PlacedRule,
    type Rule,
    type RuleStyle,
    type ScaleRule,
  } from '../../lib/sheets/rules';
  import SidePanel from './SidePanel.svelte';

  interface Props {
    ctl: SheetController;
    onclose: () => void;
  }
  let { ctl, onclose }: Props = $props();

  const CONDITIONS: Array<{ kind: ConditionKind; label: string; values: 0 | 1 | 2 }> = [
    { kind: 'gt', label: 'Greater than', values: 1 },
    { kind: 'gte', label: 'Greater than or equal to', values: 1 },
    { kind: 'lt', label: 'Less than', values: 1 },
    { kind: 'lte', label: 'Less than or equal to', values: 1 },
    { kind: 'eq', label: 'Equal to', values: 1 },
    { kind: 'neq', label: 'Not equal to', values: 1 },
    { kind: 'between', label: 'Between', values: 2 },
    { kind: 'outside', label: 'Not between', values: 2 },
    { kind: 'contains', label: 'Text contains', values: 1 },
    { kind: 'notContains', label: 'Text does not contain', values: 1 },
    { kind: 'empty', label: 'Is empty', values: 0 },
    { kind: 'notEmpty', label: 'Is not empty', values: 0 },
  ];
  const FILLS = ['#b7e1cd', '#fce8b2', '#f4c7c3', '#c9daf8', '#e1d5f7', '#57bb8a', '#e67c73'];
  const TEXTS = ['#137333', '#b06000', '#a50e0e', '#1a57b5'];
  const SCALES: Array<{ label: string; colors: ScaleRule['colors'] }> = [
    { label: 'White to green', colors: ['#ffffff', null, '#57bb8a'] },
    { label: 'Red, yellow, green', colors: ['#e67c73', '#ffd666', '#57bb8a'] },
    { label: 'Green, yellow, red', colors: ['#57bb8a', '#ffd666', '#e67c73'] },
    { label: 'White to blue', colors: ['#ffffff', null, '#6d9eeb'] },
  ];

  let editing = $state<string | null>(null);
  let rangeError = $state('');

  let rules = $derived.by(() => {
    void ctl.revision;
    return ctl.hasSheet ? listRules(ctl.sheet).filter(placed => placed.rule.type !== 'valid') : [];
  });
  let current = $derived(rules.find(placed => placed.id === editing) ?? null);

  function summary(placed: PlacedRule): string {
    const rule = placed.rule;
    const where = rectName(placed.rect);
    if (rule.type === 'scale') return `${where} · Colour scale`;
    if (rule.type !== 'format') return where;
    const condition = CONDITIONS.find(item => item.kind === rule.when.kind);
    const values = [rule.when.a, rule.when.b].slice(0, condition?.values ?? 0).map(value => writeRuleValue(value, ctl.engine.locale)).join(' and ');
    return `${where} · ${condition?.label ?? ''}${values ? ` ${values}` : ''}`;
  }

  function add(): void {
    if (!ctl.canEdit) return;
    const sheet = ctl.sheet;
    const id = addRule(sheet, { type: 'format', range: rangeIds(sheet, ctl.selection), when: { kind: 'notEmpty' }, style: { bg: FILLS[0] } });
    editing = id;
  }

  function save(rule: Rule): void {
    if (current) setRule(ctl.sheet, current.id, rule);
  }

  function setRange(text: string): void {
    if (!current) return;
    const rect = parseRectName(text);
    if (!rect || rect.r2 >= ctl.sheet.rows.length || rect.c2 >= ctl.sheet.cols.length) {
      rangeError = 'Write cells like B2:B20.';
      return;
    }
    rangeError = '';
    save({ ...current.rule, range: rangeIds(ctl.sheet, rect) });
  }

  function setKind(kind: ConditionKind): void {
    if (current?.rule.type !== 'format') return;
    save({ ...current.rule, when: { ...current.rule.when, kind } });
  }

  function setValue(which: 'a' | 'b', text: string): void {
    if (current?.rule.type !== 'format') return;
    const when = { ...current.rule.when, [which]: readRuleValue(text, ctl.engine.locale) };
    if (when[which] === undefined) delete when[which];
    save({ ...current.rule, when });
  }

  function setStyle(patch: Partial<Record<keyof RuleStyle, string | 1 | null>>): void {
    if (current?.rule.type !== 'format') return;
    const style: Record<string, unknown> = { ...current.rule.style };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete style[key];
      else style[key] = value;
    }
    save({ ...current.rule, style: style as RuleStyle });
  }

  function useScale(scale: boolean): void {
    if (!current) return;
    const { range, order } = current.rule;
    if (scale && current.rule.type !== 'scale') save({ type: 'scale', range, order, colors: SCALES[0].colors });
    else if (!scale && current.rule.type !== 'format') save({ type: 'format', range, order, when: { kind: 'notEmpty' }, style: { bg: FILLS[0] } });
  }

  function remove(id: string): void {
    removeRule(ctl.sheet, id);
    if (editing === id) editing = null;
  }

  function gradient(colors: ScaleRule['colors']): string {
    return `linear-gradient(to right, ${colors.filter(Boolean).join(', ')})`;
  }

  function sample(rule: FormatRule): string {
    const style = rule.style;
    return [
      style.bg ? `background:${style.bg}` : '',
      style.c ? `color:${style.c}` : style.bg ? 'color:#1a1a1a' : '',
      style.b ? 'font-weight:700' : '',
      style.i ? 'font-style:italic' : '',
      style.s ? 'text-decoration:line-through' : '',
    ].filter(Boolean).join(';');
  }
</script>

<SidePanel title="Conditional formatting" {onclose} testId="format-panel">
  {#if current}
    {@const rule = current.rule}
    <label class="field">
      Apply to cells
      <input type="text" value={rectName(current.rect)} onchange={(event) => setRange((event.target as HTMLInputElement).value)} data-testid="format-range" />
      {#if rangeError}<span class="hint" role="alert">{rangeError}</span>{/if}
    </label>
    <div class="choices" role="radiogroup" aria-label="Kind of rule">
      <button class="choice" class:on={rule.type === 'format'} role="radio" aria-checked={rule.type === 'format'} onclick={() => useScale(false)} data-testid="format-one-colour">One colour</button>
      <button class="choice" class:on={rule.type === 'scale'} role="radio" aria-checked={rule.type === 'scale'} onclick={() => useScale(true)} data-testid="format-scale">Colour scale</button>
    </div>
    {#if rule.type === 'format'}
      {@const condition = CONDITIONS.find(item => item.kind === rule.when.kind)}
      <label class="field">
        Format cells if
        <select value={rule.when.kind} onchange={(event) => setKind((event.target as HTMLSelectElement).value as ConditionKind)} data-testid="format-condition">
          {#each CONDITIONS as choice (choice.kind)}
            <option value={choice.kind}>{choice.label}</option>
          {/each}
        </select>
      </label>
      {#if (condition?.values ?? 0) >= 1}
        <div class="row">
          <input type="text" aria-label="Value" placeholder="Value" value={writeRuleValue(rule.when.a, ctl.engine.locale)} onchange={(event) => setValue('a', (event.target as HTMLInputElement).value)} data-testid="format-value" />
          {#if condition?.values === 2}
            <span class="hint">and</span>
            <input type="text" aria-label="Second value" placeholder="Value" value={writeRuleValue(rule.when.b, ctl.engine.locale)} onchange={(event) => setValue('b', (event.target as HTMLInputElement).value)} data-testid="format-value-2" />
          {/if}
        </div>
      {/if}
      <div class="field">
        Fill
        <div class="swatches">
          <button class="swatch none" class:on={!rule.style.bg} onclick={() => setStyle({ bg: null })} title="No fill" aria-label="No fill"></button>
          {#each FILLS as fill (fill)}
            <button class="swatch" class:on={rule.style.bg === fill} style="background:{fill}" onclick={() => setStyle({ bg: fill })} title={fill} aria-label="Fill {fill}" data-testid="format-fill-{fill.slice(1)}"></button>
          {/each}
        </div>
      </div>
      <div class="field">
        Text
        <div class="swatches">
          <button class="swatch none" class:on={!rule.style.c} onclick={() => setStyle({ c: null })} title="Usual colour" aria-label="Usual text colour"></button>
          {#each TEXTS as color (color)}
            <button class="swatch" class:on={rule.style.c === color} style="background:{color}" onclick={() => setStyle({ c: color })} title={color} aria-label="Text {color}"></button>
          {/each}
          <button class="choice small" class:on={!!rule.style.b} onclick={() => setStyle({ b: rule.style.b ? null : 1 })} aria-label="Bold" aria-pressed={!!rule.style.b}><span class="i-lucide-bold"></span></button>
          <button class="choice small" class:on={!!rule.style.i} onclick={() => setStyle({ i: rule.style.i ? null : 1 })} aria-label="Italic" aria-pressed={!!rule.style.i}><span class="i-lucide-italic"></span></button>
          <button class="choice small" class:on={!!rule.style.s} onclick={() => setStyle({ s: rule.style.s ? null : 1 })} aria-label="Strikethrough" aria-pressed={!!rule.style.s}><span class="i-lucide-strikethrough"></span></button>
        </div>
      </div>
    {:else if rule.type === 'scale'}
      <div class="field">
        Colours, from the lowest number to the highest
        {#each SCALES as scale (scale.label)}
          <button class="scale" class:on={scale.colors.join() === rule.colors.join()} onclick={() => save({ ...rule, colors: scale.colors })} data-testid="format-scale-{scale.label.toLowerCase().replace(/[^a-z]+/g, '-')}">
            <span class="bar" style="background:{gradient(scale.colors)}"></span>{scale.label}
          </button>
        {/each}
      </div>
    {/if}
    <div class="row">
      <button class="btn-ghost" onclick={() => { editing = null; }} data-testid="format-done">Done</button>
      <button class="btn-ghost text-danger" onclick={() => remove(current.id)} data-testid="format-remove"><span class="i-lucide-trash-2"></span> Remove rule</button>
    </div>
  {:else}
    {#if rules.length === 0}
      <p class="hint">Colour cells by their value: high numbers green, overdue dates red, done tasks struck through.</p>
    {/if}
    {#each rules as placed (placed.id)}
      <div class="rule">
        <button class="rule-open" onclick={() => { editing = placed.id; }} data-testid="format-rule">
          {#if placed.rule.type === 'scale'}
            <span class="sample" style="background:{gradient(placed.rule.colors)}"></span>
          {:else if placed.rule.type === 'format'}
            <span class="sample" style={sample(placed.rule)}>123</span>
          {/if}
          <span class="what">{summary(placed)}</span>
        </button>
        <button class="btn-circle btn-ghost delete" onclick={() => remove(placed.id)} title="Remove rule" aria-label="Remove rule"><span class="i-lucide-trash-2"></span></button>
      </div>
    {/each}
    <div class="row">
      <button class="btn-ghost" onclick={add} data-testid="format-add"><span class="i-lucide-plus"></span> Add rule for {rectName(ctl.selection)}</button>
    </div>
  {/if}
</SidePanel>

<style>
  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  .swatch {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 1px solid rgb(var(--surface-3));
    cursor: pointer;
  }

  .swatch.on {
    outline: 2px solid #916dfe;
    outline-offset: 2px;
  }

  .swatch.none {
    background: linear-gradient(135deg, transparent 45%, #e5484d 45%, #e5484d 55%, transparent 55%);
  }

  .choice.small {
    min-width: 30px;
    min-height: 30px;
    padding: 0 6px;
  }

  .scale {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: transparent;
    color: rgb(var(--text-1));
    cursor: pointer;
    text-align: left;
  }

  .scale.on {
    border-color: #916dfe;
  }

  .bar {
    flex: none;
    width: 70px;
    height: 14px;
    border-radius: 3px;
    border: 1px solid rgb(var(--surface-3));
  }

  .rule {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .rule-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: transparent;
    color: rgb(var(--text-1));
    cursor: pointer;
    text-align: left;
  }

  .sample {
    flex: none;
    width: 40px;
    height: 22px;
    line-height: 22px;
    border-radius: 3px;
    text-align: center;
    font-size: 0.75rem;
    border: 1px solid rgb(var(--surface-3));
  }

  .what {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .delete {
    width: 32px;
    height: 32px;
    min-width: 32px;
    min-height: 32px;
  }
</style>
