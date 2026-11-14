/**
 * Printing an open document or spreadsheet, from its own button or from the
 * browser's menu, prints that alone: for the time of the print, what `build`
 * makes goes directly under the body, and everything else there is left out.
 * The rules for it are added only then, so they cannot shape anything else
 * printed from the app.
 */
const BASE_STYLES = `
  @media screen { .print-alone { display: none; } }
  @media print {
    body > :not(.print-alone) { display: none !important; }
    html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
    .print-alone { color: #1a1a1a; }
  }
`;

/** Starts printing alone; the function returned stops it. */
export function printAlone(build: () => HTMLElement | null, styles = ''): () => void {
  let page: HTMLElement | null = null;
  let rules: HTMLStyleElement | null = null;
  const after = () => {
    page?.remove();
    rules?.remove();
    page = null;
    rules = null;
  };
  const before = () => {
    after();
    page = build();
    if (!page) return;
    page.classList.add('print-alone');
    rules = document.createElement('style');
    rules.textContent = BASE_STYLES + styles;
    document.head.appendChild(rules);
    document.body.appendChild(page);
  };
  window.addEventListener('beforeprint', before);
  window.addEventListener('afterprint', after);
  return () => {
    after();
    window.removeEventListener('beforeprint', before);
    window.removeEventListener('afterprint', after);
  };
}
