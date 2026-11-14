/** When this copy of the app was built, as the page says; null while developing. */
export function buildTime(): string | null {
  return document.querySelector('meta[name="build-time"]')?.getAttribute('content') ?? null;
}

/** The build time for people to read, or "Development version" while developing. */
export function buildTimeLabel(): string {
  const time = buildTime();
  if (!time) return 'Development version';
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? time : date.toLocaleString();
}
