/**
 * The order of one sheet's rows or columns: the living ids in order, and
 * where each deleted id was, so ranges and references that named it can
 * shrink to a neighbour (see model.ts).
 */
export class Axis {
  /** Ids in order, without the deleted ones. */
  ids: string[] = [];
  private positions = new Map<string, number>();
  /** For a deleted id: how many living ids come before it. */
  private slots = new Map<string, number>();

  /**
   * `placeOf` names, for an id listed more than once, the index in `listed`
   * of the place that counts; otherwise the first one does.
   */
  rebuild(listed: string[], isGone: (id: string) => boolean, placeOf?: (id: string) => number | undefined): void {
    const ids: string[] = [];
    const positions = new Map<string, number>();
    const slots = new Map<string, number>();
    let chosen: Map<string, number> | null = null;
    if (placeOf) {
      const seen = new Set<string>();
      for (const id of listed) {
        if (!seen.has(id)) seen.add(id);
        else if (!chosen?.has(id)) {
          const index = placeOf(id);
          if (index !== undefined && listed[index] === id) (chosen ??= new Map()).set(id, index);
        }
      }
    }
    for (let index = 0; index < listed.length; index += 1) {
      const id = listed[index];
      if (positions.has(id) || slots.has(id)) continue;
      const wanted = chosen?.get(id);
      if (wanted !== undefined && wanted !== index) continue;
      if (isGone(id)) {
        slots.set(id, ids.length);
      } else {
        positions.set(id, ids.length);
        ids.push(id);
      }
    }
    this.ids = ids;
    this.positions = positions;
    this.slots = slots;
  }

  get length(): number {
    return this.ids.length;
  }

  /** Position of a living id, or -1. */
  indexOf(id: string): number {
    return this.positions.get(id) ?? -1;
  }

  /**
   * The positions a range between two ids covers now. An end that was
   * deleted gives way to its nearest living neighbour inside the range.
   * Null when nothing of the range is left or an id is unknown.
   */
  span(first: string, second: string): [number, number] | null {
    const a = this.place(first);
    const b = this.place(second);
    if (!a || !b) return null;
    const [low, high] = a.order <= b.order ? [a, b] : [b, a];
    // A deleted end sits just before the living id at its slot.
    const from = low.at;
    const to = high.alive ? high.at : high.at - 1;
    return from <= to && to < this.ids.length ? [from, to] : null;
  }

  /**
   * Where an id is now: its position, or for a deleted one the position of
   * the living id that took its place (the last one at the end). -1 when unknown.
   */
  near(id: string): number {
    const position = this.positions.get(id);
    if (position !== undefined) return position;
    const slot = this.slots.get(id);
    return slot === undefined || this.ids.length === 0 ? -1 : Math.min(slot, this.ids.length - 1);
  }

  private place(id: string): { at: number; alive: boolean; order: number } | null {
    const position = this.positions.get(id);
    if (position !== undefined) return { at: position, alive: true, order: position };
    const slot = this.slots.get(id);
    return slot === undefined ? null : { at: slot, alive: false, order: slot - 0.5 };
  }
}
