/**
 * The first slide a new deck gives itself. Two devices that open a new deck
 * at the same moment each give it one. Each then takes its own away again if
 * it is still untouched and the other's is the one to keep: the one with
 * something on it, or of two untouched ones the one whose id sorts first. A
 * browser only ever removes a slide it made itself, also after a reload, so
 * nothing anyone typed on another device can be lost this way.
 */
import { newId, richTextIsEmpty, type Deck, type Slide } from './model';
import { layoutById } from './layouts';
import { DEFAULT_THEME } from './themes';

/** Transaction origin of the housekeeping around a deck's first slide; not something to undo. */
export const SEED_ORIGIN = 'slides-seed';

const DEVICE_KEY = 'irisslides-device';

/**
 * A name for this browser that outlasts a reload, kept in its local storage.
 * Without storage every editor gets a name of its own.
 */
export function browserId(): string {
  try {
    const known = localStorage.getItem(DEVICE_KEY);
    if (known) return known;
    const made = newId();
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    return newId();
  }
}

/** A slide a new deck was given by itself that nobody has done anything with yet. */
export function untouched(slide: Slide): boolean {
  return !!slide.seed && !slide.background && !slide.notes?.length
    && slide.elements.every(element => element.type === 'text' && !!element.role && richTextIsEmpty(element.content));
}

/** Gives an empty deck its first slide, marked as this device's. */
export function seedDeck(deck: Deck, deviceId: string): void {
  deck.start(DEFAULT_THEME);
  if (deck.slides.size === 0) {
    deck.ydoc.transact(() => deck.addSlide('title', layoutById('title').elements, null, undefined, deviceId), SEED_ORIGIN);
  }
}

/** Removes this device's first slides that the deck has no use for any more. */
export function settleSeeds(deck: Deck, slides: Slide[], deviceId: string): void {
  const seeds = slides.filter(slide => slide.seed);
  // A deck that a file was brought into in place of its first slide has no use for one that arrives late.
  if (deck.meta.get('seedless') === true) {
    const late = seeds.filter(slide => untouched(slide) && slide.seedBy === deviceId && slides.length > 1);
    if (late.length) deck.ydoc.transact(() => late.forEach(slide => deck.slides.delete(slide.id)), SEED_ORIGIN);
    return;
  }
  if (seeds.length < 2) return;
  const blank = seeds.filter(untouched);
  // Something written on is kept; otherwise the first by id.
  const keep = blank.length < seeds.length ? null : blank.reduce((first, slide) => (slide.id < first.id ? slide : first));
  const losers = blank.filter(slide => slide !== keep && slide.seedBy === deviceId);
  if (losers.length === 0) return;
  deck.ydoc.transact(() => {
    for (const slide of losers) deck.slides.delete(slide.id);
  }, SEED_ORIGIN);
}
