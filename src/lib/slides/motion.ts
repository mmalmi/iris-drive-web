/**
 * Movement while presenting: how a slide comes on screen (its transition),
 * and its points shown one at a time (its build). Both are set per slide.
 *
 * A slide that builds shows its title and subtitle at once, then each point
 * of its other text boxes with each step forward: every paragraph that has
 * words in it, and every point of a list at its top level (with what is
 * nested under it). Boxes go in stacking order, lowest first.
 */
import * as Y from 'yjs';
import type { Slide, SlideElement } from './model';

export type Transition = 'none' | 'fade' | 'slide';

export const TRANSITIONS: Array<{ id: Transition; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'slide', label: 'Slide in' },
];

export function readTransition(value: unknown): Transition | undefined {
  return value === 'fade' || value === 'slide' ? value : undefined;
}

function hasWords(node: Y.XmlElement): boolean {
  let found = false;
  const visit = (parent: Y.XmlElement): void => {
    for (const child of parent.toArray()) {
      if (found) return;
      if (child instanceof Y.XmlText) found = child.toString().trim().length > 0;
      else if (child instanceof Y.XmlElement) visit(child);
    }
  };
  visit(node);
  return found;
}

/** How many points of a text are shown one by one. */
export function buildPoints(fragment: Y.XmlFragment | undefined): number {
  if (!fragment) return 0;
  let count = 0;
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === 'bulletList' || child.nodeName === 'orderedList') {
      for (const item of child.toArray()) if (item instanceof Y.XmlElement && hasWords(item)) count += 1;
    } else if (hasWords(child)) {
      count += 1;
    }
  }
  return count;
}

/** The points of drawn text in the order they are shown, by the same rule as `buildPoints`. */
export function drawnPoints(container: HTMLElement): HTMLElement[] {
  const points: HTMLElement[] = [];
  for (const child of container.children) {
    const element = child as HTMLElement;
    if (element.tagName === 'UL' || element.tagName === 'OL') {
      for (const item of element.children) if ((item as HTMLElement).textContent?.trim()) points.push(item as HTMLElement);
    } else if (element.textContent?.trim()) {
      points.push(element);
    }
  }
  return points;
}

function builds(element: SlideElement): boolean {
  return element.type === 'text' && element.role !== 'title' && element.role !== 'subtitle';
}

export interface BuildPlan {
  /** Steps forward before the slide is complete. */
  steps: number;
  /** For each element that builds, how many points come before its first. */
  offsets: Map<string, number>;
  /** First visible step for objects revealed as a whole. */
  appearances: Map<string, number>;
}

/** Which points of a slide come in at which step; no steps when the slide does not build. */
export function buildPlan(slide: Slide): BuildPlan {
  const offsets = new Map<string, number>();
  const groups = [...new Set(slide.elements.flatMap(element => element.appearOn ? [element.appearOn] : []))].sort((a, b) => a - b);
  const ranks = new Map(groups.map((group, index) => [group, index + 1]));
  const appearances = new Map<string, number>();
  for (const element of slide.elements) {
    if (element.appearOn) appearances.set(element.id, ranks.get(element.appearOn)!);
  }
  let steps = groups.length;
  if (!slide.build) return { steps, offsets, appearances };
  for (const element of slide.elements) {
    if (element.appearOn || !builds(element)) continue;
    offsets.set(element.id, steps);
    steps += buildPoints(element.content);
  }
  return { steps, offsets, appearances };
}
