/**
 * Calls `task` every `ms` while the page is shown. Nothing runs while it is
 * hidden; showing it again runs the task at once and resumes the rhythm.
 * Returns a function that stops it.
 */
export function setVisibleInterval(task: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const pause = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const resume = () => {
    if (timer) return;
    timer = setInterval(() => {
      if (hidden()) pause();
      else task();
    }, ms);
  };
  const onVisibility = () => {
    if (hidden()) {
      pause();
      return;
    }
    if (!timer) {
      task();
      resume();
    }
  };
  if (!hidden()) resume();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  return () => {
    pause();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
}
