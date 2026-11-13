/**
 * Where a presentation is: the slide on screen and how far its points have
 * come in, moving on and back, and staying in step with the other windows
 * showing the same presentation. The audience's window and the presenter's
 * window each have one.
 */
import type { Slide } from './model';
import { buildPlan } from './motion';
import { connectPresentation, type PresentationLink, type Showing } from './presentSync';

export interface PresentationOptions {
  slides: () => Slide[];
  /** The slide to start on; the first one when null. */
  startId: string | null;
  /** The name shared by the windows of this presentation; see `presentationKey`. */
  key: string;
  /**
   * Whether this window knows where the presentation is from the start, as
   * the window that began it does. One that joins asks the others first.
   */
  leads: boolean;
  /** Another window ended the presentation. */
  onEnd?: () => void;
}

export class Presentation {
  // Set when it is made; given a value here because the fields below are worked out from it.
  #slides: () => Slide[] = () => [];
  readonly #link: PresentationLink;
  #settled: boolean;
  #lastIndex = 0;

  /** Followed by id, so the place is kept when someone adds or removes slides meanwhile. */
  showingId = $state<string | null>(null);
  /** How many points of the slide on screen have come in, for a slide that builds. */
  step = $state(0);
  /** On the closing screen after the last slide. */
  ended = $state(false);
  /** Which way the last move went: 1 on, -1 back. A slide coming in slides from that side. */
  direction = $state<1 | -1>(1);

  readonly index: number = $derived.by(() => {
    const slides = this.#slides();
    const found = slides.findIndex(slide => slide.id === this.showingId);
    return found >= 0 ? found : Math.min(this.#lastIndex, slides.length - 1);
  });
  readonly slide: Slide | null = $derived(this.#slides()[this.index] ?? null);
  readonly following: Slide | null = $derived(this.ended ? null : this.#slides()[this.index + 1] ?? null);
  readonly count: number = $derived(this.#slides().length);
  /** How many points the slide on screen brings in one by one. */
  readonly steps: number = $derived(this.slide ? buildPlan(this.slide).steps : 0);

  constructor(options: PresentationOptions) {
    this.#slides = options.slides;
    this.#settled = options.leads;
    const slides = options.slides();
    this.showingId = options.startId ?? slides[0]?.id ?? null;
    this.#lastIndex = Math.max(0, slides.findIndex(slide => slide.id === this.showingId));
    this.#link = connectPresentation(options.key, {
      onShow: (showing) => {
        this.#settled = true;
        this.#apply(showing);
      },
      current: () => (this.#settled ? this.#showing() : null),
      onEnd: options.onEnd,
    });
  }

  #showing(): Showing {
    return { slideId: this.slide?.id ?? null, ended: this.ended, step: this.step };
  }

  #apply(showing: Showing): void {
    const before = this.index;
    this.ended = showing.ended;
    if (showing.slideId) this.showingId = showing.slideId;
    this.step = typeof showing.step === 'number' && showing.step >= 0 ? showing.step : 0;
    const index = this.#slides().findIndex(slide => slide.id === this.showingId);
    if (index >= 0) {
      if (index !== before) this.direction = index > before ? 1 : -1;
      this.#lastIndex = index;
    }
  }

  /** Shows the slide at `target` with `step` of its points in; past the last one, the closing screen. */
  go(target: number, step = 0): void {
    const slides = this.#slides();
    this.direction = target >= this.index ? 1 : -1;
    if (target >= slides.length) {
      this.ended = true;
    } else {
      this.ended = false;
      const index = Math.max(0, target);
      this.showingId = slides[index]?.id ?? null;
      this.#lastIndex = index;
    }
    this.step = step;
    this.#settled = true;
    this.#link.show(this.#showing());
  }

  /** Brings in the next point, or moves on. Returns false when there was nowhere further to go. */
  next(): boolean {
    if (this.ended) return false;
    if (this.step < this.steps) {
      this.step += 1;
      this.#settled = true;
      this.#link.show(this.#showing());
      return true;
    }
    this.go(this.index + 1);
    return true;
  }

  /** Takes the last point away again, or goes back to the slide before, with all its points in. */
  previous(): void {
    if (this.ended) {
      this.go(this.index, this.steps);
    } else if (this.step > 0) {
      this.step -= 1;
      this.#link.show(this.#showing());
    } else if (this.index > 0) {
      const before = this.#slides()[this.index - 1];
      this.go(this.index - 1, before ? buildPlan(before).steps : 0);
    }
  }

  first(): void {
    this.go(0);
  }

  last(): void {
    const slides = this.#slides();
    const final = slides[slides.length - 1];
    this.go(slides.length - 1, final ? buildPlan(final).steps : 0);
  }

  /** Tells the other windows the presentation is over. */
  end(): void {
    this.#link.end();
  }

  close(): void {
    this.#link.close();
  }
}
