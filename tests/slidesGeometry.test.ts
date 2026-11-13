import { describe, expect, test } from 'vitest';
import {
  angleFromCentre,
  boxesOverlap,
  constrainLineEnd,
  fitScale,
  frameBox,
  frameCorners,
  resizeFrame,
  rotatePoint,
  snapAngle,
  snapLines,
  snapMove,
  snapPoint,
  unionBox,
  type Handle,
} from '../src/lib/slides/geometry';
import type { Frame } from '../src/lib/slides/model';

const frame = (x: number, y: number, w: number, h: number, rot = 0): Frame => ({ x, y, w, h, rot });

function close(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
}

describe('frames', () => {
  test('rotating a point about a centre', () => {
    const turned = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
    close(turned.x, 0);
    close(turned.y, 10);
  });

  test('the box of a rotated frame', () => {
    const box = frameBox(frame(0, 0, 200, 100, 90));
    close(box.left, 50);
    close(box.right, 150);
    close(box.top, -50);
    close(box.bottom, 150);
  });

  test('the box of a line drawn right to left, bottom to top', () => {
    expect(frameBox(frame(300, 200, -100, -50))).toEqual({ left: 200, top: 150, right: 300, bottom: 200 });
  });

  test('union and overlap', () => {
    const a = frameBox(frame(0, 0, 10, 10));
    const b = frameBox(frame(20, 5, 10, 10));
    expect(unionBox([a, b])).toEqual({ left: 0, top: 0, right: 30, bottom: 15 });
    expect(unionBox([])).toBeNull();
    expect(boxesOverlap(a, b)).toBe(false);
    expect(boxesOverlap(a, frameBox(frame(5, 5, 10, 10)))).toBe(true);
  });

  test('a slide is scaled to fit the space it is given', () => {
    expect(fitScale(1280, 720, 1280, 720)).toBe(1);
    expect(fitScale(640, 720, 1280, 720)).toBe(0.5);
    expect(fitScale(1280, 360, 1280, 720)).toBe(0.5);
    expect(fitScale(680, 800, 1280, 720, 20)).toBe(0.5);
  });
});

describe('resizing', () => {
  test('dragging the bottom-right corner grows the frame and leaves the top-left where it is', () => {
    expect(resizeFrame(frame(100, 100, 200, 100), 'se', 50, 20)).toEqual(frame(100, 100, 250, 120));
  });

  test('dragging the top-left corner leaves the bottom-right where it is', () => {
    expect(resizeFrame(frame(100, 100, 200, 100), 'nw', 50, 20)).toEqual(frame(150, 120, 150, 80));
  });

  test('a side handle changes one dimension', () => {
    expect(resizeFrame(frame(100, 100, 200, 100), 'e', 30, 99)).toEqual(frame(100, 100, 230, 100));
    expect(resizeFrame(frame(100, 100, 200, 100), 'n', 99, -30)).toEqual(frame(100, 70, 200, 130));
  });

  test('a frame never gets smaller than the minimum', () => {
    const result = resizeFrame(frame(100, 100, 200, 100), 'se', -500, -500, { minSize: 10 });
    expect(result).toEqual(frame(100, 100, 10, 10));
  });

  test('keeping proportions', () => {
    const result = resizeFrame(frame(0, 0, 200, 100), 'se', 100, 0, { keepRatio: true });
    expect(result).toEqual(frame(0, 0, 300, 150));
    const small = resizeFrame(frame(0, 0, 200, 100), 'se', -1000, -1000, { keepRatio: true, minSize: 10 });
    expect(small.w / small.h).toBe(2);
    expect(small.h).toBe(10);
  });

  test('resizing about the centre', () => {
    expect(resizeFrame(frame(100, 100, 200, 100), 'e', 10, 0, { fromCentre: true })).toEqual(frame(90, 100, 220, 100));
  });

  test('on a rotated frame the opposite corner stays put on the slide', () => {
    for (const rot of [30, 90, 145, 270]) {
      for (const handle of ['se', 'nw', 'ne', 'sw'] as Handle[]) {
        const start = frame(100, 100, 200, 100, rot);
        const result = resizeFrame(start, handle, 37, -21);
        const opposite = { se: 0, sw: 1, nw: 2, ne: 3 }[handle as 'se' | 'sw' | 'nw' | 'ne'];
        const before = frameCorners(start)[opposite]!;
        const after = frameCorners(result)[opposite]!;
        close(after.x, before.x);
        close(after.y, before.y);
        expect(result.rot).toBe(rot);
      }
    }
  });

  test('on a frame turned a quarter, dragging right pulls its bottom side', () => {
    // Turned 90° clockwise, the frame's own "down" points left on the slide and its "right" points down.
    const result = resizeFrame(frame(0, 0, 200, 100, 90), 'e', 0, 40);
    close(result.w, 240);
    close(result.h, 100);
  });
});

describe('rotating', () => {
  test('the angle of the pointer around the centre', () => {
    close(angleFromCentre({ x: 0, y: 0 }, { x: 0, y: -10 }), 0);
    close(angleFromCentre({ x: 0, y: 0 }, { x: 10, y: 0 }), 90);
    close(angleFromCentre({ x: 0, y: 0 }, { x: 0, y: 10 }), 180);
    close(angleFromCentre({ x: 0, y: 0 }, { x: -10, y: 0 }), -90);
  });

  test('angles settle on quarter turns and on steps', () => {
    expect(snapAngle(-90, null)).toBe(270);
    expect(snapAngle(88, null)).toBe(90);
    expect(snapAngle(358.5, null)).toBe(0);
    expect(snapAngle(80, null)).toBe(80);
    expect(snapAngle(80, 15)).toBe(75);
    expect(snapAngle(353, 15)).toBe(0);
  });

  test('a line end is turned to the nearest 15 degrees and keeps its length', () => {
    const end = constrainLineEnd({ x: 0, y: 0 }, { x: 100, y: 4 });
    close(end.y, 0);
    close(end.x, Math.hypot(100, 4));
  });
});

describe('snapping', () => {
  const lines = snapLines([frameBox(frame(400, 300, 200, 100))], 1280, 720);

  test('a moving box lines its edge up with another box', () => {
    const moving = frameBox(frame(103, 500, 100, 50));
    const far = snapMove(moving, lines, 5);
    expect(far).toEqual({ dx: 0, dy: 0, guides: [] });
    const near = snapMove(frameBox(frame(397, 500, 90, 50)), lines, 5);
    expect(near.dx).toBe(3);
    expect(near.dy).toBe(0);
    // The guide runs from the other box down to the moving one.
    expect(near.guides).toEqual([{ axis: 'x', pos: 400, from: 300, to: 550 }]);
  });

  test('the middle of the slide attracts the middle of a box', () => {
    const result = snapMove(frameBox(frame(588, 20, 100, 50)), lines, 5);
    expect(result.dx).toBe(2);
    expect(result.guides.some(guide => guide.axis === 'x' && guide.pos === 640)).toBe(true);
  });

  test('both directions snap independently, to the nearest line', () => {
    const result = snapMove(frameBox(frame(602, 398, 100, 50)), lines, 5);
    expect(result.dx).toBe(-2);
    expect(result.dy).toBe(2);
  });

  test('a single point snaps too', () => {
    const result = snapPoint({ x: 598, y: 100 }, lines, 5);
    expect(result.dx).toBe(2);
    expect(result.dy).toBe(0);
    expect(snapPoint({ y: 357 }, lines, 5).dy).toBe(3);
  });
});
