<script lang="ts">
  /** What is drawn over the slide being edited: selection frames and their handles, guides, what is being drawn, the marquee. */
  import type { Frame, SlideElement } from '../../lib/slides/model';
  import { lineEdges } from '../../lib/slides/table';
  import { frameBox, type Box, type Guide, type Handle } from '../../lib/slides/geometry';
  import type { Tool } from '../../lib/slides/editorState.svelte';

  interface Props {
    /** The selected elements as drawn right now. */
    shown: SlideElement[];
    single: SlideElement | null;
    groupBox: Box | null;
    turning: { box: Box; degrees: number } | null;
    guides: Guide[];
    sketch: Frame | null;
    tool: Tool | null;
    marquee: Box | null;
    scale: number;
    width: number;
    height: number;
    editing: string | null;
  }
  let { shown, single, groupBox, turning, guides, sketch, tool, marquee, scale, width, height, editing }: Props = $props();

  const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
  /** The resize cursor that points the way a handle moves, turned with its frame. */
  function cursorFor(handle: Handle, rotation: number): string {
    const base = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }[handle];
    return CURSORS[Math.round((((base + rotation) % 180) + 180) % 180 / 45) % 4]!;
  }

  function handleStyle(handle: Handle, rotation: number): string {
    const x = handle.includes('w') ? 0 : handle.includes('e') ? 100 : 50;
    const y = handle.includes('n') ? 0 : handle.includes('s') ? 100 : 50;
    return `left:${x}%;top:${y}%;cursor:${cursorFor(handle, rotation)}`;
  }

  /** On a box that is small on screen the middle handles would crowd the corners. */
  function roomFor(handle: Handle, w: number, h: number): boolean {
    return handle.length === 2 || ((handle === 'n' || handle === 's') ? w : h) * scale >= 44;
  }
</script>

<div class="overlay">
  {#each guides as guide, index (index)}
    {#if guide.axis === 'x'}
      <div class="guide" style:left="{guide.pos * scale}px" style:top="{guide.from * scale}px" style:height="{(guide.to - guide.from) * scale}px" style:width="1px"></div>
    {:else}
      <div class="guide" style:top="{guide.pos * scale}px" style:left="{guide.from * scale}px" style:width="{(guide.to - guide.from) * scale}px" style:height="1px"></div>
    {/if}
  {/each}

  {#if single?.table && !single.rot}
    <!-- The lines of a selected table are dragged to make columns wider and rows taller. -->
    {@const grid = lineEdges(single.table, single.w, single.h)}
    {#each grid.xs.slice(1) as x, index (index)}
      <div class="table-line table-line-col" data-handle="col:{index + 1}" style:left="{(single.x + x) * scale}px" style:top="{single.y * scale}px" style:height="{single.h * scale}px" data-testid="table-col-line"></div>
    {/each}
    {#each grid.ys.slice(1) as y, index (index)}
      <div class="table-line table-line-row" data-handle="row:{index + 1}" style:top="{(single.y + y) * scale}px" style:left="{single.x * scale}px" style:width="{single.w * scale}px" data-testid="table-row-line"></div>
    {/each}
  {/if}

  {#each shown as element (element.id)}
    {#if element.type === 'line'}
      {#if single}
        <div class="knob" data-handle="start" style:left="{element.x * scale}px" style:top="{element.y * scale}px"></div>
        <div class="knob" data-handle="end" style:left="{(element.x + element.w) * scale}px" style:top="{(element.y + element.h) * scale}px"></div>
      {:else}
        {@const box = frameBox(element)}
        <div class="frame frame-member" style:left="{box.left * scale}px" style:top="{box.top * scale}px" style:width="{(box.right - box.left) * scale}px" style:height="{(box.bottom - box.top) * scale}px"></div>
      {/if}
    {:else}
      <div
        class="frame"
        class:frame-editing={editing === element.id}
        class:frame-table={element.type === 'table'}
        class:frame-member={!single}
        style:left="{element.x * scale}px"
        style:top="{element.y * scale}px"
        style:width="{element.w * scale}px"
        style:height="{element.h * scale}px"
        style:transform={element.rot ? `rotate(${element.rot}deg)` : undefined}
        data-testid="selection-frame"
      >
        {#if single}
          {#if editing === element.id || element.type === 'table'}
            <!-- While typing, and always for a table, whose inside is for picking cells, the box is moved by its border. -->
            <div class="edge edge-top" data-handle="move"></div>
            <div class="edge edge-right" data-handle="move"></div>
            <div class="edge edge-bottom" data-handle="move"></div>
            <div class="edge edge-left" data-handle="move"></div>
          {/if}
          <div class="rotate-stem"></div>
          <div class="knob knob-rotate" data-handle="rotate" title="Rotate"></div>
          {#each HANDLES as handle (handle)}
            {#if roomFor(handle, element.w, element.h)}
              <div class="knob knob-square" data-handle={handle} style={handleStyle(handle, element.rot)}></div>
            {/if}
          {/each}
        {/if}
      </div>
    {/if}
  {/each}

  {#if groupBox}
    {@const box = turning?.box ?? groupBox}
    <!-- Several things selected are resized and turned as one, by the box around them all. -->
    <div
      class="frame frame-group"
      style:left="{box.left * scale}px"
      style:top="{box.top * scale}px"
      style:width="{(box.right - box.left) * scale}px"
      style:height="{(box.bottom - box.top) * scale}px"
      style:transform={turning ? `rotate(${turning.degrees}deg)` : undefined}
      data-testid="group-frame"
    >
      <div class="rotate-stem"></div>
      <div class="knob knob-rotate" data-group-handle="rotate" title="Rotate"></div>
      {#each HANDLES as handle (handle)}
        {#if roomFor(handle, box.right - box.left, box.bottom - box.top)}
          <div class="knob knob-square" data-group-handle={handle} style={handleStyle(handle, turning?.degrees ?? 0)}></div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if sketch && tool?.kind === 'line'}
    <svg class="sketch-line" width={width} height={height}>
      <line x1={sketch.x * scale} y1={sketch.y * scale} x2={(sketch.x + sketch.w) * scale} y2={(sketch.y + sketch.h) * scale} />
    </svg>
  {:else if sketch}
    <div
      class="sketch"
      class:sketch-round={tool?.kind === 'shape' && tool.shape === 'ellipse'}
      style:left="{sketch.x * scale}px"
      style:top="{sketch.y * scale}px"
      style:width="{sketch.w * scale}px"
      style:height="{(tool?.kind === 'text' ? Math.max(sketch.h, 64) : sketch.h) * scale}px"
      data-testid="sketch"
    ></div>
  {/if}

  {#if marquee}
    <div class="marquee" style:left="{marquee.left * scale}px" style:top="{marquee.top * scale}px" style:width="{(marquee.right - marquee.left) * scale}px" style:height="{(marquee.bottom - marquee.top) * scale}px"></div>
  {/if}
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  /* A pale edge around the line keeps it visible on a slide of the same colour. */
  .frame {
    position: absolute;
    box-sizing: border-box;
    outline: 1.5px solid #916dfe;
    box-shadow: 0 0 0 2.5px rgb(255 255 255 / 0.6);
  }

  .frame-editing {
    outline-style: dashed;
  }

  .frame-member {
    outline-width: 1px;
    outline-color: rgb(145 109 254 / 0.7);
    box-shadow: none;
  }

  .frame-group {
    outline-style: dashed;
  }

  .edge {
    position: absolute;
    pointer-events: auto;
    cursor: move;
  }

  .edge-top,
  .edge-bottom {
    left: 0;
    right: 0;
    height: 10px;
  }

  .edge-left,
  .edge-right {
    top: 0;
    bottom: 0;
    width: 10px;
  }

  .edge-top {
    top: -8px;
  }

  .edge-bottom {
    bottom: -8px;
  }

  .edge-left {
    left: -8px;
  }

  .edge-right {
    right: -8px;
  }

  /* Just outside a table, so its own outer lines can still be dragged. */
  .frame-table .edge-top {
    top: -14px;
  }

  .frame-table .edge-bottom {
    bottom: -14px;
  }

  .frame-table .edge-left {
    left: -14px;
  }

  .frame-table .edge-right {
    right: -14px;
  }

  .table-line {
    position: absolute;
    pointer-events: auto;
  }

  .table-line-col {
    width: 9px;
    margin-left: -4.5px;
    cursor: col-resize;
  }

  .table-line-row {
    height: 9px;
    margin-top: -4.5px;
    cursor: row-resize;
  }

  .table-line::after {
    content: '';
    position: absolute;
    background: #916dfe;
    opacity: 0;
    transition: opacity 0.12s;
  }

  .table-line-col::after {
    left: 3.5px;
    top: 0;
    bottom: 0;
    width: 2px;
  }

  .table-line-row::after {
    top: 3.5px;
    left: 0;
    right: 0;
    height: 2px;
  }

  .table-line:hover::after {
    opacity: 0.8;
  }

  .knob {
    position: absolute;
    width: 11px;
    height: 11px;
    margin: -5.5px 0 0 -5.5px;
    border: 1.5px solid #916dfe;
    border-radius: 50%;
    background: #fff;
    pointer-events: auto;
    cursor: crosshair;
  }

  /* A larger area than the eye sees, so handles are easy to hit, most of all by finger. */
  .knob::after {
    content: '';
    position: absolute;
    inset: -7px;
  }

  @media (pointer: coarse) {
    .knob::after {
      inset: -14px;
    }
  }

  .knob-square {
    border-radius: 2px;
  }

  .knob-rotate {
    left: 50%;
    top: -26px;
    cursor: grab;
  }

  .rotate-stem {
    position: absolute;
    left: 50%;
    top: -22px;
    width: 1.5px;
    height: 22px;
    margin-left: -0.75px;
    background: #916dfe;
  }

  .guide {
    position: absolute;
    background: #f0389b;
  }

  .marquee {
    position: absolute;
    border: 1px solid #916dfe;
    background: rgb(145 109 254 / 0.12);
  }

  .sketch {
    position: absolute;
    box-sizing: border-box;
    border: 1.5px dashed #916dfe;
    background: rgb(145 109 254 / 0.1);
  }

  .sketch-round {
    border-radius: 50%;
  }

  .sketch-line {
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
  }

  .sketch-line line {
    stroke: #916dfe;
    stroke-width: 2;
    stroke-dasharray: 6 4;
  }
</style>
