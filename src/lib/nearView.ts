/** One observer per scrolling area. Tiles release their previews when they leave it. */
const observers = new Map<Element | null, { observer: IntersectionObserver; count: number }>();
const callbacks = new WeakMap<Element, (near: boolean) => void>();

export function nearView(node: HTMLElement, onChange: (near: boolean) => void) {
  const root = node.closest('[data-scroll-root]');
  let group = observers.get(root);
  if (!group) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin: '100% 0px' });
    group = { observer, count: 0 };
    observers.set(root, group);
  }
  const subscribed = group;
  subscribed.count++;
  callbacks.set(node, onChange);
  subscribed.observer.observe(node);
  return {
    destroy() {
      callbacks.delete(node);
      subscribed.observer.unobserve(node);
      if (--subscribed.count === 0) {
        subscribed.observer.disconnect();
        observers.delete(root);
      }
    },
  };
}
