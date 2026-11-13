<script lang="ts">
  /** One element of a slide, drawn in slide units. The same drawing serves the editor, thumbnails and presenting. */
  import type { SlideElement } from '../../lib/slides/model';
  import { richTextIsEmpty } from '../../lib/slides/model';
  import { placeholderFor } from '../../lib/slides/layouts';
  import { resolveColour, textStyle, type Palette, type Theme } from '../../lib/slides/themes';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import { fontSizeCss } from '../../lib/slides/richText';
  import { ELLIPSE_INSET, MIN_FIT, TEXT_PAD_Y, clearFit, fitText, roomInside } from '../../lib/slides/fitText';
  import RichText from './RichText.svelte';
  import TextEditor from './TextEditor.svelte';
  import TableView from './TableView.svelte';

  interface Props {
    element: SlideElement;
    theme: Theme;
    palette: Palette;
    layout: string;
    urls: Map<string, string>;
    /** Present only on the canvas: shows hints in empty boxes and hosts the text editor. */
    editorState?: SlidesEditorState;
    /** Goes up when the deck changes, so emptiness is looked at again. */
    revision?: number;
  }
  let { element, theme, palette, layout, urls, editorState, revision = 0 }: Props = $props();

  let editing = $derived(!!editorState && editorState.editingId === element.id);
  let style = $derived(textStyle(element, theme, layout));
  let fill = $derived(element.type === 'shape' ? resolveColour(element.fill, palette, palette.accent) : null);
  let stroke = $derived(resolveColour(element.stroke, palette, element.type === 'line' ? palette.text : null));
  let strokeWidth = $derived(element.strokeWidth ?? (element.type === 'line' ? 4 : 3));
  let empty = $derived.by(() => {
    void revision;
    return !!editorState && richTextIsEmpty(element.content);
  });
  let hint = $derived(
    editorState?.canEdit && empty && !editing && element.type === 'text' ? placeholderFor(element.role) : '',
  );

  // A line is its frame read as a vector; it is drawn inside the upright box around it.
  let line = $derived.by(() => {
    if (element.type !== 'line') return null;
    const left = Math.min(0, element.w);
    const top = Math.min(0, element.h);
    const x1 = -left;
    const y1 = -top;
    const x2 = element.w - left;
    const y2 = element.h - top;
    const length = Math.hypot(element.w, element.h) || 1;
    const ux = element.w / length;
    const uy = element.h / length;
    const head = Math.max(12, strokeWidth * 4);
    const arrow = element.arrow && length > head
      ? {
          // The shaft stops inside the head so its round end does not poke out of the tip.
          shaftX: x2 - ux * head * 0.8,
          shaftY: y2 - uy * head * 0.8,
          points: [
            `${x2},${y2}`,
            `${x2 - ux * head - uy * head * 0.5},${y2 - uy * head + ux * head * 0.5}`,
            `${x2 - ux * head + uy * head * 0.5},${y2 - uy * head - ux * head * 0.5}`,
          ].join(' '),
        }
      : null;
    return { left, top, x1, y1, x2, y2, arrow };
  });

  // Titles, subtitles, body text and the words in a shape shrink to stay inside; see fitText.ts.
  let autofit = $derived((element.type === 'text' && !!element.role) || element.type === 'shape');
  let textBox: HTMLElement | undefined = $state();
  let textInner: HTMLElement | undefined = $state();
  // Text in an ellipse keeps to the rectangle that fits inside the curve.
  let ellipsePadding = $derived(element.shape === 'ellipse'
    ? `${Math.max(8, element.h * ELLIPSE_INSET)}px ${Math.max(12, element.w * ELLIPSE_INSET)}px`
    : undefined);

  function fit(): void {
    if (!textBox || !textInner) return;
    if (element.type === 'shape') fitText(textBox, textInner, roomInside(textBox), MIN_FIT.shape);
    else if (autofit && element.role) fitText(textBox, textInner, element.h - TEXT_PAD_Y * 2, MIN_FIT[element.role]);
    else clearFit(textBox);
  }

  $effect(() => {
    // Anything that changes how the text is laid out calls for fitting it again.
    void [element.w, element.h, element.shape, style.fontSize, style.fontFamily, style.fontWeight, style.lineHeight, autofit, editing, hint];
    fit();
  });

  let imageUrl = $derived(element.type === 'image' && element.src ? urls.get(element.src) : undefined);
  let radius = $derived(element.shape === 'ellipse' ? '50%' : element.shape === 'round' ? `${Math.min(28, Math.min(element.w, element.h) / 4)}px` : '0');
</script>

{#if line}
  <svg
    class="el el-line"
    data-el={element.id}
    data-type="line"
    style:left="{element.x + line.left}px"
    style:top="{element.y + line.top}px"
    width={Math.max(1, Math.abs(element.w))}
    height={Math.max(1, Math.abs(element.h))}
  >
    <!-- A wide invisible stroke makes a thin line easy to grab. -->
    <line class="el-line-hit" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="transparent" stroke-width={Math.max(24, strokeWidth + 16)} />
    <line
      x1={line.x1}
      y1={line.y1}
      x2={line.arrow ? line.arrow.shaftX : line.x2}
      y2={line.arrow ? line.arrow.shaftY : line.y2}
      stroke={stroke ?? palette.text}
      stroke-width={strokeWidth}
      stroke-linecap="round"
    />
    {#if line.arrow}
      <polygon points={line.arrow.points} fill={stroke ?? palette.text} />
    {/if}
  </svg>
{:else}
  <div
    class="el"
    class:el-editing={editing}
    data-el={element.id}
    data-type={element.type}
    style:left="{element.x}px"
    style:top="{element.y}px"
    style:width="{element.w}px"
    style:height="{element.h}px"
    style:transform={element.rot ? `rotate(${element.rot}deg)` : undefined}
  >
    {#if element.type === 'image'}
      {#if imageUrl}
        <img class="el-image" src={imageUrl} alt="" draggable="false" />
      {:else}
        <div class="el-image el-image-missing"></div>
      {/if}
    {:else if element.table}
      <div
        class="el-table-box"
        style:font-family={style.fontFamily}
        style:--cell-size="{style.fontSize}px"
        style:line-height={style.lineHeight}
        style:text-align={style.align}
      >
        <TableView {element} {palette} {style} {editorState} />
      </div>
    {:else}
      {#if element.type === 'shape'}
        <div
          class="el-shape"
          style:background={fill ?? 'transparent'}
          style:border={stroke ? `${strokeWidth}px solid ${stroke}` : undefined}
          style:border-radius={radius}
        ></div>
      {/if}
      {#if element.content}
        <div
          class="el-text"
          class:el-text-shape={element.type === 'shape'}
          bind:this={textBox}
          style:padding={ellipsePadding}
          style:font-family={style.fontFamily}
          style:font-size={fontSizeCss(style.fontSize)}
          style:font-weight={style.fontWeight}
          style:line-height={style.lineHeight}
          style:color={style.color}
          style:text-align={style.align}
          style:justify-content={style.valign === 'middle' ? 'center' : style.valign === 'bottom' ? 'flex-end' : 'flex-start'}
        >
          <div class="el-text-inner" bind:this={textInner}>
            {#if editing && editorState}
              <TextEditor fragment={element.content} {editorState} onChanged={fit} />
            {:else if hint}
              <div class="slide-text el-hint"><p>{hint}</p></div>
            {:else}
              <RichText fragment={element.content} onDrawn={fit} />
            {/if}
          </div>
        </div>
      {/if}
    {/if}
  </div>
{/if}
