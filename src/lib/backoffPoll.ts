/**
 * A safety-net check that runs less and less often while nothing needs it:
 * after `minMs` first, then twice as long each time up to `maxMs`. It does not
 * run while the page is hidden; showing the page or coming back online runs it
 * at once and starts the waits over. `kick()` asks for it again soon.
 */
export interface BackoffPoll {
  /** Run again after the shortest wait, and back off from there. */
  kick(): void;
  /** Run now (when the page is shown) and back off from there. */
  now(): void;
  stop(): void;
}

export function startBackoffPoll(
  task: () => void,
  { minMs, maxMs }: { minMs: number; maxMs: number },
): BackoffPoll {
  let delay = minMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (!stopped && !hidden()) timer = setTimeout(run, delay);
  };
  function run(): void {
    timer = null;
    if (stopped || hidden()) return;
    task();
    delay = Math.min(delay * 2, maxMs);
    schedule();
  }
  const now = () => {
    if (stopped) return;
    delay = minMs;
    clear();
    run();
  };
  const onShown = () => {
    if (!hidden()) now();
  };

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onShown);
  if (typeof window !== 'undefined') window.addEventListener('online', onShown);
  schedule();

  return {
    kick: () => {
      if (stopped) return;
      delay = minMs;
      schedule();
    },
    now,
    stop: () => {
      stopped = true;
      clear();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onShown);
      if (typeof window !== 'undefined') window.removeEventListener('online', onShown);
    },
  };
}
