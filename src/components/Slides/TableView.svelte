<script lang="ts">
  /** A table on a slide: a grid of cells in the table's frame, each with its own text. */
  import type { SlideElement } from '../../lib/slides/model';
  import { cellKey } from '../../lib/slides/table';
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
  let rowTotal = $derived(table.rows.reduce((sum, row) => sum + row.size, 0));
  let colTotal = $derived(table.cols.reduce((sum, col) => sum + col.size, 0));
  let line = $derived(resolveColour(element.stroke, palette, palette.muted));
  let lineWidth = $derived(element.strokeWidth ?? 1.5);
  let editingCell = $derived(editorState && editorState.editingId === element.id ? editorState.editingCell : null);

  /** A cell's fill, and the colour its text reads best in on that fill. */
  function look(key: string, header: boolean): { fill: string | null; color: string } {
    const own = resolveColour(table.cells.get(key)?.fill, palette);
    const fill = own ?? (header ? palette.accent : null);
    if (!fill) return { fill: null, color: style.color };
    if (!own && header) return { fill, color: palette.onAccent };
    return { fill, color: element.color ? style.color : readableOn(fill, palette) };
  }
</script>

<div
  class="el-table"
  style:grid-template-columns={table.cols.map(col => `minmax(0, ${col.size}fr)`).join(' ')}
  style:grid-template-rows={table.rows.map(row => `minmax(0, ${row.size}fr)`).join(' ')}
  style:--line={line ?? 'transparent'}
  style:--line-width="{line ? lineWidth : 0}px"
>
  {#each table.rows as row, index (row.id)}
    {#each table.cols as col (col.id)}
      {@const key = cellKey(row.id, col.id)}
      {@const header = index === 0 && !!element.header}
      {@const seen = look(key, header)}
      <TableCell
        cell={key}
        fragment={table.cells.get(key)?.content ?? null}
        fill={seen.fill}
        color={seen.color}
        bold={header}
        width={element.w * col.size / colTotal}
        height={element.h * row.size / rowTotal}
        valign={style.valign}
        editing={editingCell === key}
        {editorState}
      />
    {/each}
  {/each}
</div>
