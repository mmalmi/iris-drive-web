import { afterEach, expect, test } from 'vitest';
import {
  connectPresentation,
  formatElapsed,
  isPresenterWindow,
  presentationKey,
  presenterUrl,
  type PresentationLink,
  type Showing,
} from '../src/lib/slides/presentSync';

const links: PresentationLink[] = [];
afterEach(() => {
  while (links.length) links.pop()!.close();
});

/** A window of the presentation, as far as keeping in step goes. */
function windowOn(key: string, start: Showing | null) {
  const state = { showing: start, ended: false };
  const link = connectPresentation(key, {
    onShow: (showing) => { state.showing = showing; },
    current: () => state.showing,
    onEnd: () => { state.ended = true; },
  });
  links.push(link);
  return { state, link };
}

const delivered = () => new Promise(resolve => setTimeout(resolve, 20));

test('a window that opens later is told where the presentation is, and both follow each other', async () => {
  const key = `test-${Math.random()}`;
  const audience = windowOn(key, { slideId: 'two', ended: false });
  const presenter = windowOn(key, null);
  await delivered();
  expect(presenter.state.showing).toEqual({ slideId: 'two', ended: false });

  presenter.state.showing = { slideId: 'three', ended: false };
  presenter.link.show(presenter.state.showing);
  await delivered();
  expect(audience.state.showing).toEqual({ slideId: 'three', ended: false });

  audience.state.showing = { slideId: 'three', ended: true };
  audience.link.show(audience.state.showing);
  await delivered();
  expect(presenter.state.showing).toEqual({ slideId: 'three', ended: true });

  audience.link.end();
  await delivered();
  expect(presenter.state.ended).toBe(true);
  expect(audience.state.ended).toBe(false);
});

test('windows of different presentations do not hear each other', async () => {
  const one = windowOn(`test-${Math.random()}`, { slideId: 'a', ended: false });
  const other = windowOn(`test-${Math.random()}`, null);
  one.link.show({ slideId: 'b', ended: false });
  await delivered();
  expect(other.state.showing).toBeNull();
});

test('the presenter\'s window is the same address with a mark, and both share one name', () => {
  const plain = 'https://drive.example/#/npub1abc/main/Talk.irisslides';
  const shared = 'https://drive.example/#/nhash1xyz?doc=Talk&kind=slides';
  expect(presenterUrl(plain)).toBe(`${plain}?presenter=1`);
  expect(presenterUrl(shared)).toBe(`${shared}&presenter=1`);
  expect(presenterUrl(presenterUrl(shared))).toBe(`${shared}&presenter=1`);
  expect(isPresenterWindow(new URL(presenterUrl(plain)).hash)).toBe(true);
  expect(isPresenterWindow(new URL(plain).hash)).toBe(false);
  const key = (href: string) => presentationKey(new URL(href));
  expect(key(presenterUrl(shared))).toBe(key(shared));
  expect(key(plain)).not.toBe(key(shared));
});

test('elapsed time reads as a clock', () => {
  expect(formatElapsed(0)).toBe('0:00');
  expect(formatElapsed(247_900)).toBe('4:07');
  expect(formatElapsed(3_750_000)).toBe('1:02:30');
  expect(formatElapsed(-5)).toBe('0:00');
});
