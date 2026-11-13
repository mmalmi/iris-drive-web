<script lang="ts">
  /**
   * The deck laid out for the printer: one slide to a page, the page the
   * shape of a slide, colours as they are. It opens the browser's own print
   * window, where the deck can be printed or saved as a PDF, and is gone
   * again when that closes.
   */
  import { onMount, tick } from 'svelte';
  import { SLIDE_HEIGHT, SLIDE_WIDTH, type Slide } from '../../lib/slides/model';
  import type { Theme } from '../../lib/slides/themes';
  import SlideView from './SlideView.svelte';

  interface Props {
    slides: Slide[];
    theme: Theme;
    urls: Map<string, string>;
    onDone: () => void;
  }
  let { slides, theme, urls, onDone }: Props = $props();

  let holder: HTMLElement | undefined = $state();

  // Kept out of the page's own styles: these rules must not outlive the print, or they would shape whatever else is printed from the app.
  const PRINT_STYLES = `
    .slides-print { position: fixed; left: -200000px; top: 0; width: ${SLIDE_WIDTH}px; visibility: hidden; pointer-events: none; }
    @media print {
      @page { size: ${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px; margin: 0; }
      html, body { margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; background: #fff !important; }
      body > *:not(.slides-print) { display: none !important; }
      .slides-print { position: static !important; visibility: visible !important; }
      .slides-print-page { width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; overflow: hidden; break-after: page; page-break-after: always; break-inside: avoid; }
      .slides-print-page:last-child { break-after: auto; page-break-after: auto; }
      .slides-print, .slides-print * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    }
  `;

  /** Pictures that are still arriving would print as empty frames; give them a moment. */
  async function picturesReady(root: HTMLElement, patience: number): Promise<void> {
    const waiting = [...root.querySelectorAll('img')].filter(image => !image.complete);
    if (waiting.length === 0) return;
    await Promise.race([
      Promise.all(waiting.map(image => new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      }))),
      new Promise(resolve => setTimeout(resolve, patience)),
    ]);
  }

  onMount(() => {
    if (!holder) return;
    const pages = holder;
    // Directly under the body, so that printing can leave out everything else there.
    document.body.appendChild(pages);
    const styles = document.createElement('style');
    styles.textContent = PRINT_STYLES;
    document.head.appendChild(styles);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onDone();
    };
    window.addEventListener('afterprint', finish);
    void (async () => {
      await tick();
      await picturesReady(pages, 4000);
      if (!finished) window.print();
    })();
    return () => {
      finished = true;
      window.removeEventListener('afterprint', finish);
      styles.remove();
      pages.remove();
    };
  });
</script>

<div class="slides-print" bind:this={holder} data-testid="slides-print" aria-hidden="true">
  {#each slides as slide (slide.id)}
    <div class="slides-print-page">
      <SlideView {slide} {theme} {urls} width={SLIDE_WIDTH} />
    </div>
  {/each}
</div>
