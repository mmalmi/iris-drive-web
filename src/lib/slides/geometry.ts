/**
 * Frames on a slide: where their corners are once rotated, how a drag on a
 * handle resizes them, and what a moving frame snaps to.
 */
import type { Frame } from './model';

export interface Point {
  x: number;
  y: number;
}

/** An upright rectangle. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One of the eight resize handles, named by the compass. */
export type Handle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export interface Guide {
  /** 'x': a vertical line at x = pos; 'y': a horizontal line at y = pos. */
  axis: 'x' | 'y';
  pos: number;
  from: number;
  to: number;
}

const RADIANS = Math.PI / 180;

export function rotatePoint(point: Point, centre: Point, degrees: number): Point {
  if (!degrees) return { ...point };
  const cos = Math.cos(degrees * RADIANS);
  const sin = Math.sin(degrees * RADIANS);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
}

export function frameCentre(frame: Frame): Point {
  return { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
}

/** The four corners of a frame as drawn: top-left, top-right, bottom-right, bottom-left. */
export function frameCorners(frame: Frame): Point[] {
  const centre = frameCentre(frame);
  return [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.w, y: frame.y },
    { x: frame.x + frame.w, y: frame.y + frame.h },
    { x: frame.x, y: frame.y + frame.h },
  ].map(corner => rotatePoint(corner, centre, frame.rot));
}

/** The upright box a frame occupies. Works for lines too, whose width or height may be negative. */
export function frameBox(frame: Frame): Box {
  const corners = frameCorners(frame);
  return {
    left: Math.min(...corners.map(corner => corner.x)),
    top: Math.min(...corners.map(corner => corner.y)),
    right: Math.max(...corners.map(corner => corner.x)),
    bottom: Math.max(...corners.map(corner => corner.y)),
  };
}

export function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map(box => box.left)),
    top: Math.min(...boxes.map(box => box.top)),
    right: Math.max(...boxes.map(box => box.right)),
    bottom: Math.max(...boxes.map(box => box.bottom)),
  };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export function boxFromPoints(a: Point, b: Point): Box {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

/** The scale at which a slide fits a space, leaving a margin on each side. */
export function fitScale(availableWidth: number, availableHeight: number, slideWidth: number, slideHeight: number, margin = 0): number {
  const width = Math.max(1, availableWidth - margin * 2);
  const height = Math.max(1, availableHeight - margin * 2);
  return Math.min(width / slideWidth, height / slideHeight);
}

export interface ResizeOptions {
  /** Keep the proportions of the frame. */
  keepRatio?: boolean;
  /** Grow and shrink about the centre instead of the opposite side. */
  fromCentre?: boolean;
  minSize?: number;
}

/**
 * The frame after dragging `handle` by (dx, dy) in slide units. The side or
 * corner opposite the handle stays where it is on the slide, also when the
 * frame is rotated.
 */
export function resizeFrame(start: Frame, handle: Handle, dx: number, dy: number, options: ResizeOptions = {}): Frame {
  const minSize = options.minSize ?? 8;
  // The drag as the frame sees it, before rotation.
  const local = rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -start.rot);
  const horizontal = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const vertical = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  const grow = options.fromCentre ? 2 : 1;
  let w = start.w + horizontal * local.x * grow;
  let h = start.h + vertical * local.y * grow;
  if (options.keepRatio && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    if (horizontal && vertical) {
      // Follow whichever direction was dragged further.
      if (Math.abs(w - start.w) / start.w >= Math.abs(h - start.h) / start.h) h = w / ratio;
      else w = h * ratio;
    } else if (horizontal) {
      h = w / ratio;
    } else {
      w = h * ratio;
    }
    if (w < minSize) {
      w = minSize;
      h = w / ratio;
    }
    if (h < minSize) {
      h = minSize;
      w = h * ratio;
    }
  } else {
    w = Math.max(minSize, w);
    h = Math.max(minSize, h);
  }

  const centre = frameCentre(start);
  if (options.fromCentre) return { x: centre.x - w / 2, y: centre.y - h / 2, w, h, rot: start.rot };

  // The point that must not move: opposite the handle, in the frame's own axes.
  // For a side handle with proportions kept, the middle of the opposite side.
  const anchorLocal = {
    x: horizontal === 1 ? -0.5 : horizontal === -1 ? 0.5 : 0,
    y: vertical === 1 ? -0.5 : vertical === -1 ? 0.5 : 0,
  };
  const anchorBefore = rotatePoint(
    { x: centre.x + anchorLocal.x * start.w, y: centre.y + anchorLocal.y * start.h },
    centre,
    start.rot,
  );
  // Where the centre must go so the anchor of the new size lands on the same spot.
  const offset = rotatePoint({ x: -anchorLocal.x * w, y: -anchorLocal.y * h }, { x: 0, y: 0 }, start.rot);
  const newCentre = { x: anchorBefore.x + offset.x, y: anchorBefore.y + offset.y };
  return { x: newCentre.x - w / 2, y: newCentre.y - h / 2, w, h, rot: start.rot };
}

/** The angle, in degrees clockwise from straight up, of a pointer around a centre. */
export function angleFromCentre(centre: Point, pointer: Point): number {
  return Math.atan2(pointer.x - centre.x, centre.y - pointer.y) / RADIANS;
}

export function normaliseAngle(degrees: number): number {
  const turned = ((degrees % 360) + 360) % 360;
  return Math.round(turned * 10) / 10 === 360 ? 0 : Math.round(turned * 10) / 10;
}

/** Rounds to a multiple of `step`, or to a quarter turn when within `pull` degrees of one. */
export function snapAngle(degrees: number, step: number | null, pull = 3): number {
  const angle = normaliseAngle(degrees);
  if (step) return normaliseAngle(Math.round(angle / step) * step);
  const quarter = Math.round(angle / 90) * 90;
  return Math.abs(angle - quarter) <= pull ? normaliseAngle(quarter) : angle;
}

/** The end of a line from `start`, turned to the nearest 15° when the angle is being constrained. */
export function constrainLineEnd(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return end;
  const step = 15 * RADIANS;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

interface SnapLines {
  x: Array<{ pos: number; from: number; to: number }>;
  y: Array<{ pos: number; from: number; to: number }>;
}

/** The lines things can snap to: the slide's edges and middle, and the edges and middles of the other boxes. */
export function snapLines(others: Box[], slideWidth: number, slideHeight: number): SnapLines {
  const lines: SnapLines = {
    x: [0, slideWidth / 2, slideWidth].map(pos => ({ pos, from: 0, to: slideHeight })),
    y: [0, slideHeight / 2, slideHeight].map(pos => ({ pos, from: 0, to: slideWidth })),
  };
  for (const box of others) {
    for (const pos of [box.left, (box.left + box.right) / 2, box.right]) lines.x.push({ pos, from: box.top, to: box.bottom });
    for (const pos of [box.top, (box.top + box.bottom) / 2, box.bottom]) lines.y.push({ pos, from: box.left, to: box.right });
  }
  return lines;
}

function nearest(
  candidates: number[],
  lines: Array<{ pos: number; from: number; to: number }>,
  threshold: number,
): { delta: number; lines: Array<{ pos: number; from: number; to: number }> } | null {
  let best: number | null = null;
  for (const candidate of candidates) {
    for (const line of lines) {
      const delta = line.pos - candidate;
      if (Math.abs(delta) <= threshold && (best === null || Math.abs(delta) < Math.abs(best))) best = delta;
    }
  }
  if (best === null) return null;
  const delta = best;
  const matched = lines.filter(line => candidates.some(candidate => Math.abs(line.pos - (candidate + delta)) < 0.01));
  return { delta, lines: matched };
}

/**
 * How far to nudge a moving box so its edges or middle line up with the
 * nearest snap lines, and the guides to draw for the lines it met.
 */
export function snapMove(moving: Box, lines: SnapLines, threshold: number): SnapResult {
  const result: SnapResult = { dx: 0, dy: 0, guides: [] };
  const x = nearest([moving.left, (moving.left + moving.right) / 2, moving.right], lines.x, threshold);
  const y = nearest([moving.top, (moving.top + moving.bottom) / 2, moving.bottom], lines.y, threshold);
  if (x) result.dx = x.delta;
  if (y) result.dy = y.delta;
  const top = moving.top + result.dy;
  const bottom = moving.bottom + result.dy;
  const left = moving.left + result.dx;
  const right = moving.right + result.dx;
  for (const line of x?.lines ?? []) {
    result.guides.push({ axis: 'x', pos: line.pos, from: Math.min(line.from, top), to: Math.max(line.to, bottom) });
  }
  for (const line of y?.lines ?? []) {
    result.guides.push({ axis: 'y', pos: line.pos, from: Math.min(line.from, left), to: Math.max(line.to, right) });
  }
  return result;
}

/** Snaps single coordinates (the sides a resize is moving, or the end of a line) to the lines. */
export function snapPoint(point: { x?: number; y?: number }, lines: SnapLines, threshold: number): SnapResult {
  const result: SnapResult = { dx: 0, dy: 0, guides: [] };
  const x = point.x === undefined ? null : nearest([point.x], lines.x, threshold);
  const y = point.y === undefined ? null : nearest([point.y], lines.y, threshold);
  if (x) result.dx = x.delta;
  if (y) result.dy = y.delta;
  for (const line of x?.lines ?? []) {
    const at = point.y ?? line.from;
    result.guides.push({ axis: 'x', pos: line.pos, from: Math.min(line.from, at), to: Math.max(line.to, at) });
  }
  for (const line of y?.lines ?? []) {
    const at = point.x ?? line.from;
    result.guides.push({ axis: 'y', pos: line.pos, from: Math.min(line.from, at), to: Math.max(line.to, at) });
  }
  return result;
}

/** Whole slide units, so stored frames stay short and tidy. */
export function roundFrame<T extends Partial<Frame>>(frame: T): T {
  const rounded = { ...frame };
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    const value = rounded[key];
    if (typeof value === 'number') rounded[key] = Math.round(value * 10) / 10;
  }
  return rounded;
}
