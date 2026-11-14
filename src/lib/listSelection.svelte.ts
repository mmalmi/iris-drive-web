/**
 * The items of a folder's list chosen to act on together, by name, as in
 * Google Drive: the one model that the mouse, the keyboard and a finger all
 * change. It is a set of names and an anchor, the row that a range (Shift)
 * starts from: the row last chosen on its own.
 */
import { SvelteSet } from 'svelte/reactivity';

export class ListSelection {
  readonly names = new SvelteSet<string>();
  #anchor: string | null = null;
  /** What was chosen before a rectangle started, that it adds to. */
  #bandBase: string[] = [];
  #folder: string | null = null;

  /** Lets go of everything when the list shows another folder than before. */
  showFolder(folder: string): void {
    if (folder === this.#folder) return;
    this.#folder = folder;
    this.clear();
  }

  has(name: string): boolean {
    return this.names.has(name);
  }

  /** Chooses exactly `names`, changing only what differs. */
  #setTo(names: Iterable<string>): void {
    const next = new Set(names);
    for (const name of [...this.names]) if (!next.has(name)) this.names.delete(name);
    for (const name of next) this.names.add(name);
  }

  add(name: string): void {
    this.names.add(name);
    this.#anchor = name;
  }

  toggle(name: string): void {
    if (this.names.has(name)) this.names.delete(name);
    else this.names.add(name);
    this.#anchor = name;
  }

  /** Just this row, or none. */
  only(name: string | null | undefined): void {
    this.#setTo(name ? [name] : []);
    this.#anchor = name ?? null;
  }

  /**
   * The rows of `order` from the anchor to `name`, and nothing else. Without
   * an anchor the range starts at `from`, the row it is extended from.
   */
  extendTo(order: string[], name: string, from = name): void {
    if (this.#anchor === null || !order.includes(this.#anchor)) this.#anchor = from;
    const start = order.indexOf(this.#anchor);
    const end = order.indexOf(name);
    this.#setTo(order.slice(Math.min(start, end), Math.max(start, end) + 1));
  }

  selectAll(order: string[]): void {
    for (const name of order) this.names.add(name);
  }

  /** A rectangle starts: it adds to what is chosen with Ctrl/⌘, else it replaces it. */
  startBand(additive: boolean): void {
    this.#bandBase = additive ? [...this.names] : [];
    this.#setTo(this.#bandBase);
  }

  /** The rows the rectangle touches now, with what it adds to. */
  band(touched: string[]): void {
    this.#setTo([...this.#bandBase, ...touched]);
    if (touched.length > 0) this.#anchor = touched[0];
  }

  /** Lets go of names no longer in `present`. */
  keepOnly(present: ReadonlySet<string>): void {
    for (const name of [...this.names]) if (!present.has(name)) this.names.delete(name);
  }

  clear(): void {
    this.names.clear();
    this.#anchor = null;
  }
}
