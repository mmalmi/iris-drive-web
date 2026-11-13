/**
 * A picture of a slide, or of some of the things on it, as PNG: what goes
 * on the clipboard for other apps when slides or elements are copied. The
 * slide is drawn as it already is on the page, copied into an SVG image with
 * the styles it needs and its pictures read in, so it looks the same.
 * Loaded only when something is copied.
 */
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './model';
import { dataUrlAt } from './clipboardMedia';

export interface SnapshotOptions {
  /** The ids of the elements to draw; the whole slide when absent. */
  keep?: string[];
  /** The part of the slide to draw, in slide units; the whole slide when absent. */
  box?: { x: number; y: number; w: number; h: number };
  /** Pixels per slide unit. */
  scale?: number;
}

/** The rules of the page's stylesheets that slides are drawn with. */
function slideStyles(): string {
  const rules: string[] = [];
  for (const sheet of [...document.styleSheets]) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of [...list]) {
      const text = rule.cssText;
      if (/slide-surface|slide-text|\.el-|point-in/.test(text)) rules.push(text);
    }
  }
  return rules.join('\n');
}

function waitForImage(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The picture could not be drawn'));
  });
}

/** Draws a slide that is on the page (its `.slide-surface`) into a PNG. */
export async function snapshotPng(surface: HTMLElement, options: SnapshotOptions = {}): Promise<Blob> {
  const scale = options.scale ?? 1.5;
  const box = options.box ?? { x: 0, y: 0, w: SLIDE_WIDTH, h: SLIDE_HEIGHT };
  const clone = surface.cloneNode(true) as HTMLElement;
  clone.style.transform = 'none';
  clone.style.left = `${-box.x}px`;
  clone.style.top = `${-box.y}px`;
  if (options.keep) {
    clone.style.background = 'transparent';
    for (const element of [...clone.querySelectorAll<HTMLElement>('[data-el]')]) {
      if (!options.keep.includes(element.dataset.el ?? '')) element.remove();
    }
  }
  // Hints in empty boxes are for the person editing, not part of the slide.
  for (const hint of [...clone.querySelectorAll('.el-hint')]) hint.remove();
  await Promise.all([...clone.querySelectorAll('img')].map(async (image) => {
    const data = await dataUrlAt(image.src);
    if (data) image.setAttribute('src', data);
    else image.remove();
  }));
  const holder = document.createElement('div');
  holder.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  holder.style.cssText = `position:relative;width:${box.w}px;height:${box.h}px;overflow:hidden;`;
  const style = document.createElement('style');
  style.textContent = slideStyles();
  holder.append(style, clone);
  const markup = new XMLSerializer().serializeToString(holder);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w * scale}" height="${box.h * scale}" viewBox="0 0 ${box.w} ${box.h}"><foreignObject x="0" y="0" width="${box.w}" height="${box.h}">${markup}</foreignObject></svg>`;
  const image = new Image();
  const loaded = waitForImage(image);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(box.w * scale);
  canvas.height = Math.round(box.h * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas to draw on');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return await new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The picture could not be made'))), 'image/png');
  });
}
