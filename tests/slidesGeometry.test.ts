import { describe, expect, test } from 'vitest';
import {
  angleFromCentre,
  boxesOverlap,
  constrainLineEnd,
  fitScale,
  frameBox,
  frameCorners,
  frameFromDrag,
  needsEvenScale,
  rotateFrames,
  scaleFrames,
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

describe('several frames as one', () => {
  const frames = {
    a: frame(100, 100, 100, 50),
    b: frame(300, 200, 100, 100),
    line: { ...frame(100, 300, 300, -100), line: true },
  };
  const box = { left: 100, top: 100, right: 400, bottom: 300 };

  test('dragging a corner of the group scales every frame within it', () => {
    const scaled = scaleFrames(frames, box, 'se', 300, 100);
    expect(scaled.a).toEqual(frame(100, 100, 200, 75));
    expect(scaled.b).toEqual(frame(500, 250, 200, 150));
    expect(scaled.line).toEqual(frame(100, 400, 600, -150));
  });

  test('dragging the left side keeps the right side where it is', () => {
    const scaled = scaleFrames(frames, box, 'w', 150, 0);
    expect(scaled.a).toEqual(frame(250, 100, 50, 50));
    expect(scaled.b).toEqual(frame(350, 200, 50, 100));
  });

  test('a frame turned a quarter is stretched along its own other side', () => {
    const turned = { a: frame(100, 100, 200, 100, 90) };
    // On the slide it stands 100 wide and 200 tall.
    const around = frameBox(turned.a);
    const scaled = scaleFrames(turned, around, 'e', 100, 0);
    expect(scaled.a!.w).toBeCloseTo(200);
    expect(scaled.a!.h).toBeCloseTo(200);
    const after = frameBox(scaled.a!);
    expect(after.left).toBeCloseTo(around.left);
    expect(after.right).toBeCloseTo(around.right + 100);
  });

  test('with a frame at an odd angle the group only scales evenly', () => {
    const tilted = { a: frame(0, 0, 100, 50, 30), b: frame(200, 0, 100, 100) };
    expect(needsEvenScale(Object.values(tilted))).toBe(true);
    expect(needsEvenScale(Object.values(frames))).toBe(false);
    const scaled = scaleFrames(tilted, { left: 0, top: 0, right: 300, bottom: 100 }, 'e', 300, 0);
    expect(scaled.a!.w / scaled.a!.h).toBeCloseTo(2);
    expect(scaled.b!.w).toBeCloseTo(200);
    expect(scaled.b!.h).toBeCloseTo(200);
    expect(scaled.a!.rot).toBe(30);
  });

  test('turning the group turns each frame about the middle of the group', () => {
    const turned = rotateFrames(frames, { x: 250, y: 200 }, 90);
    // a's centre (150, 125) goes to (325, 100).
    expect(turned.a!.rot).toBe(90);
    expect(turned.a!.x + turned.a!.w / 2).toBeCloseTo(325);
    expect(turned.a!.y + turned.a!.h / 2).toBeCloseTo(100);
    expect(turned.a!.w).toBe(100);
    // The line's ends turn with it.
    expect(turned.line!.x).toBeCloseTo(150);
    expect(turned.line!.y).toBeCloseTo(50);
    expect(turned.line!.w).toBeCloseTo(100);
    expect(turned.line!.h).toBeCloseTo(300);
    expect(rotateFrames({ a: frame(0, 0, 10, 10, 350) }, { x: 5, y: 5 }, 20).a!.rot).toBe(10);
  });

  test('a frame drawn by dragging, in any direction', () => {
    expect(frameFromDrag({ x: 10, y: 20 }, { x: 110, y: 70 })).toEqual(frame(10, 20, 100, 50));
    expect(frameFromDrag({ x: 110, y: 70 }, { x: 10, y: 20 })).toEqual(frame(10, 20, 100, 50));
    expect(frameFromDrag({ x: 100, y: 100 }, { x: 40, y: 130 }, true)).toEqual(frame(40, 100, 60, 60));
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
