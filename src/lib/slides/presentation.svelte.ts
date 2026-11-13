/**
 * Where a presentation is: the slide on screen, moving on and back, and
 * staying in step with the other windows showing the same presentation.
 * The audience's window and the presenter's window each have one.
 */
import type { Slide } from './model';
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
  /** On the closing screen after the last slide. */
  ended = $state(false);

  readonly index: number = $derived.by(() => {
    const slides = this.#slides();
    const found = slides.findIndex(slide => slide.id === this.showingId);
    return found >= 0 ? found : Math.min(this.#lastIndex, slides.length - 1);
  });
  readonly slide: Slide | null = $derived(this.#slides()[this.index] ?? null);
  readonly following: Slide | null = $derived(this.ended ? null : this.#slides()[this.index + 1] ?? null);
  readonly count: number = $derived(this.#slides().length);

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
    return { slideId: this.slide?.id ?? null, ended: this.ended };
  }

  #apply(showing: Showing): void {
    this.ended = showing.ended;
    if (showing.slideId) this.showingId = showing.slideId;
    const index = this.#slides().findIndex(slide => slide.id === this.showingId);
    if (index >= 0) this.#lastIndex = index;
  }

  /** Shows the slide at `target`; past the last one, the closing screen. */
  go(target: number): void {
    const slides = this.#slides();
    if (target >= slides.length) {
      this.ended = true;
    } else {
      this.ended = false;
      const index = Math.max(0, target);
      this.showingId = slides[index]?.id ?? null;
      this.#lastIndex = index;
    }
    this.#settled = true;
    this.#link.show(this.#showing());
  }

  /** Moves on. Returns false when there was nowhere further to go. */
  next(): boolean {
    if (this.ended) return false;
    this.go(this.index + 1);
    return true;
  }

  previous(): void {
    if (this.ended) this.go(this.index);
    else this.go(this.index - 1);
  }

  first(): void {
    this.go(0);
  }

  last(): void {
    this.go(this.#slides().length - 1);
  }

  /** Tells the other windows the presentation is over. */
  end(): void {
    this.#link.end();
  }

  close(): void {
    this.#link.close();
  }
}
