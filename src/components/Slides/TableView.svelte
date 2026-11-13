<script lang="ts">
  /**
   * A table on a slide: a grid of cells in the table's frame, each with its
   * own text, merged cells spanning several, and its lines drawn on top so
   * that each edge is one line whatever the cells on either side say.
   */
  import type { SlideElement } from '../../lib/slides/model';
  import { cellKey, edgeBorder, lineEdges, rectKeys, type CellBorder } from '../../lib/slides/table';
  import { readableOn, resolveColour, type Palette, type TextStyle } from '../../lib/slides/themes';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import TableCell from './TableCell.svelte';

  interface Props {
    element: SlideElement;
    palette: Palette;
    style: TextStyle;
    editorState?: SlidesEditorState;
  }
  let { element, palette, style, editorState }: Props = $props();

  let table = $derived(element.table!);
  let edges = $derived(lineEdges(table, element.w, element.h));
  let line = $derived(resolveColour(element.stroke, palette, palette.muted));
  let lineWidth = $derived(element.strokeWidth ?? 1.5);
  let editingCell = $derived(editorState && editorState.editingId === element.id ? editorState.editingCell : null);
  /** Cells picked together, to fill, merge or clear at once. */
  let picked = $derived.by(() => {
    const range = editorState?.cellRange;
    if (!range || range.id !== element.id) return null;
    const rect = editorState!.pickedRect;
    return rect ? new Set(rectKeys(table, rect)) : null;
  });

  /** A cell's fill, and the colour its text reads best in on that fill. */
  function look(key: string, header: boolean): { fill: string | null; color: string } {
    const own = resolveColour(table.cells.get(key)?.fill, palette);
    const fill = own ?? (header ? palette.accent : null);
    if (!fill) return { fill: null, color: style.color };
    if (!own && header) return { fill, color: palette.onAccent };
    return { fill, color: element.color ? style.color : readableOn(fill, palette) };
  }

  let fallback = $derived<CellBorder | null>(line ? { width: lineWidth, colour: line } : null);

  /** Every edge between and around cells that has a line, as segments to draw. Edges inside a merged block have none. */
  let segments = $derived.by(() => {
    const out: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; colour: string }> = [];
    const rows = table.rows;
    const cols = table.cols;
    const owner = (r: number, c: number): string | null => {
      const row = rows[r];
      const col = cols[c];
      if (!row || !col) return null;
      const key = cellKey(row.id, col.id);
      return table.covered.get(key) ?? key;
    };
    const key = (r: number, c: number): string | null => (rows[r] && cols[c] ? cellKey(rows[r]!.id, cols[c]!.id) : null);
    const colour = (border: CellBorder) => resolveColour(border.colour, palette, line) ?? line ?? '#888888';
    // Lines across, at the top of each row and under the last.
    for (let r = 0; r <= rows.length; r += 1) {
      for (let c = 0; c < cols.length; c += 1) {
        if (r > 0 && r < rows.length && owner(r - 1, c) === owner(r, c)) continue;
        const border = edgeBorder(table, key(r - 1, c), 'b', key(r, c), 't', fallback);
        if (border) out.push({ x1: edges.xs[c]!, y1: edges.ys[r]!, x2: edges.xs[c + 1]!, y2: edges.ys[r]!, width: border.width, colour: colour(border) });
      }
    }
    // Lines down, at the left of each column and after the last.
    for (let c = 0; c <= cols.length; c += 1) {
      for (let r = 0; r < rows.length; r += 1) {
        if (c > 0 && c < cols.length && owner(r, c - 1) === owner(r, c)) continue;
        const border = edgeBorder(table, key(r, c - 1), 'r', key(r, c), 'l', fallback);
        if (border) out.push({ x1: edges.xs[c]!, y1: edges.ys[r]!, x2: edges.xs[c]!, y2: edges.ys[r + 1]!, width: border.width, colour: colour(border) });
      }
    }
    // Thicker lines go on top, so a line someone set is not hidden under the table's own.
    return out.sort((a, b) => a.width - b.width);
  });
</script>

<div
  class="el-table"
  style:grid-template-columns={table.cols.map(col => `minmax(0, ${col.size}fr)`).join(' ')}
  style:grid-template-rows={table.rows.map(row => `minmax(0, ${row.size}fr)`).join(' ')}
>
  {#each table.rows as row, r (row.id)}
    {#each table.cols as col, c (col.id)}
      {@const key = cellKey(row.id, col.id)}
      {#if !table.covered.has(key)}
        {@const block = table.merges.get(key)}
        {@const header = r === 0 && !!element.header}
        {@const seen = look(key, header)}
        {@const rows = block?.rows ?? 1}
        {@const cols = block?.cols ?? 1}
        <TableCell
          cell={key}
          fragment={table.cells.get(key)?.content ?? null}
          fill={seen.fill}
          color={seen.color}
          bold={header}
          width={edges.xs[c + cols]! - edges.xs[c]!}
          height={edges.ys[r + rows]! - edges.ys[r]!}
          area="{r + 1} / {c + 1} / span {rows} / span {cols}"
          valign={style.valign}
          editing={editingCell === key}
          picked={!!picked?.has(key)}
          {editorState}
        />
      {/if}
    {/each}
  {/each}
  <svg class="el-table-lines" width={element.w} height={element.h} aria-hidden="true">
    {#each segments as segment, index (index)}
      <line x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} stroke={segment.colour} stroke-width={segment.width} stroke-linecap="square" />
    {/each}
  </svg>
</div>
