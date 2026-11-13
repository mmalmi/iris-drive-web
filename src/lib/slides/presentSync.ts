/**
 * Keeps the windows of one presentation on the same slide: the one the
 * audience sees and the presenter's own, with the notes. They are windows
 * of one browser and talk over a BroadcastChannel; nothing leaves the device.
 */

export interface Showing {
  /** The slide on screen, or null when there is none. */
  slideId: string | null;
  /** True on the closing screen after the last slide. */
  ended: boolean;
  /** How many points of a slide that builds are in; missing from windows of older versions. */
  step?: number;
}

type Message =
  | { type: 'show'; showing: Showing }
  /** A window that just opened asks where the presentation is. */
  | { type: 'hello' }
  /** The audience's window stopped presenting. */
  | { type: 'end' };

export interface PresentationLink {
  /** Tells the other windows that this one moved. */
  show(showing: Showing): void;
  /** Tells the other windows that the presentation is over. */
  end(): void;
  close(): void;
}

export interface PresentationHandlers {
  /** Another window moved; follow it. */
  onShow: (showing: Showing) => void;
  /** Where this window is, for a window that just joined. Null when this window is not showing anything yet. */
  current: () => Showing | null;
  onEnd?: () => void;
}

/** The name windows showing the same presentation share: where it lives, without what follows the question mark. */
export function presentationKey(location: { origin: string; pathname: string; hash: string }): string {
  return `irisslides-present:${location.origin}${location.pathname}${location.hash.split('?')[0]}`;
}

export function connectPresentation(key: string, handlers: PresentationHandlers): PresentationLink {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(key);
  if (channel) {
    channel.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (message?.type === 'show') {
        handlers.onShow(message.showing);
      } else if (message?.type === 'hello') {
        const showing = handlers.current();
        if (showing) channel.postMessage({ type: 'show', showing } satisfies Message);
      } else if (message?.type === 'end') {
        handlers.onEnd?.();
      }
    };
    channel.postMessage({ type: 'hello' } satisfies Message);
  }
  return {
    show: showing => channel?.postMessage({ type: 'show', showing } satisfies Message),
    end: () => channel?.postMessage({ type: 'end' } satisfies Message),
    close: () => channel?.close(),
  };
}

/** The address of the presenter's window for the presentation at `href`. */
export function presenterUrl(href: string): string {
  const [base, query = ''] = href.split('?');
  const params = new URLSearchParams(query);
  params.set('presenter', '1');
  return `${base}?${params.toString()}`;
}

/** Whether this window was opened as the presenter's window. */
export function isPresenterWindow(hash: string): boolean {
  return new URLSearchParams(hash.split('?')[1] ?? '').get('presenter') === '1';
}

/** Minutes and seconds, or hours too once there are any: 4:07, 1:02:30. */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
