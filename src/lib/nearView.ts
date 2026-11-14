/**
 * `use:nearView={onNear}`: calls `onNear` once, when the element comes within
 * a screen of being seen in the scrolling element around it marked
 * `data-scroll-root` (or the window). One observer serves every element in it.
 */
const observers = new Map<Element | null, IntersectionObserver>();
const waiting = new WeakMap<Element, () => void>();

function observerFor(root: Element | null): IntersectionObserver {
  let observer = observers.get(root);
  if (!observer) {
    observer = new IntersectionObserver((entries, self) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        self.unobserve(entry.target);
        const onNear = waiting.get(entry.target);
        waiting.delete(entry.target);
        onNear?.();
      }
    }, { root, rootMargin: '100% 0px' });
    observers.set(root, observer);
  }
  return observer;
}

export function nearView(node: HTMLElement, onNear: () => void) {
  const root = node.closest('[data-scroll-root]');
  const observer = observerFor(root);
  waiting.set(node, onNear);
  observer.observe(node);
  return {
    destroy() {
      waiting.delete(node);
      observer.unobserve(node);
      // A scrolling element that is gone needs no observer.
      if (root && !root.isConnected) {
        observer.disconnect();
        observers.delete(root);
      }
    },
  };
}
