import DOMPurify from 'dompurify';
import { marked, type Renderer, type Token, type Tokens } from 'marked';

import { getNpubFileUrl } from './mediaUrl';
import { generateProxyUrlAsync, type ImgProxyConfig } from '../utils/imgproxy';

export interface MarkdownRouteContext {
  npub: string;
  treeName: string;
  basePath: string[];
}

export interface RenderMarkdownOptions {
  routeContext?: MarkdownRouteContext;
  renderer?: Renderer;
  resolveLinkHref?: (href: string) => string | null | undefined;
  addSanitizeAttrs?: string[];
  proxyRemoteImages?: boolean;
  imgproxyConfig?: ImgProxyConfig;
}

function hasUriScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function isRepoRelativeReference(value: string): boolean {
  if (!value || value.startsWith('#') || value.startsWith('//')) return false;
  return !hasUriScheme(value);
}

function splitPathAndSuffix(value: string): { path: string; suffix: string } {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  const suffixIndex = [queryIndex, hashIndex].filter(index => index >= 0).sort((a, b) => a - b)[0];

  if (suffixIndex === undefined) {
    return { path: value, suffix: '' };
  }

  return {
    path: value.slice(0, suffixIndex),
    suffix: value.slice(suffixIndex),
  };
}

function encodePathSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function appendReferenceSuffix(url: string, suffix: string): string {
  if (!suffix) return url;
  if (suffix.startsWith('?') && url.includes('?')) {
    return `${url}&${suffix.slice(1)}`;
  }
  return `${url}${suffix}`;
}

function resolveRepoPath(basePath: string[], reference: string): string[] {
  const { path } = splitPathAndSuffix(reference);
  const inputSegments = path.startsWith('/')
    ? path.split('/')
    : [...basePath, ...path.split('/')];
  const resolved: string[] = [];

  for (const segment of inputSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return resolved;
}

function rewriteRelativeReferences(
  tokens: Token[],
  routeContext?: MarkdownRouteContext,
  resolveLinkHref?: (href: string) => string | null | undefined,
): void {
  if (!routeContext && !resolveLinkHref) return;

  const repoBasePath = routeContext?.basePath ?? [];
  marked.walkTokens(tokens, (token: Token) => {
    if (token.type === 'link') {
      const link = token as Tokens.Link;
      const href = link.href?.trim();
      if (!href) return;

      const resolvedHref = resolveLinkHref?.(href);
      if (resolvedHref) {
        link.href = resolvedHref;
        return;
      }

      if (!routeContext || !isRepoRelativeReference(href)) return;

      const { suffix } = splitPathAndSuffix(href);
      const resolved = [
        routeContext.npub,
        routeContext.treeName,
        ...resolveRepoPath(repoBasePath, href),
      ];
      link.href = '#/' + resolved.map(encodePathSegment).join('/') + suffix;
      return;
    }

    if (token.type !== 'image') return;

    const image = token as Tokens.Image;
    const href = image.href?.trim();
    if (!href || !routeContext || !isRepoRelativeReference(href)) return;

    const { suffix } = splitPathAndSuffix(href);
    const resolved = resolveRepoPath(repoBasePath, href);
    const mediaPath = resolved.map(decodePathSegment).join('/');
    image.href = appendReferenceSuffix(
      getNpubFileUrl(routeContext.npub, routeContext.treeName, mediaPath),
      suffix,
    );
  });
}

function isRemoteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isHtreeMediaUrl(value: string): boolean {
  if (value.startsWith('/htree/')) return true;

  try {
    return new URL(value).pathname.startsWith('/htree/');
  } catch {
    return false;
  }
}

function blockRemoteImage(image: HTMLImageElement): void {
  const placeholder = document.createElement('span');
  placeholder.className = 'markdown-remote-image-blocked';
  const alt = image.getAttribute('alt')?.trim();
  placeholder.textContent = alt ? `[remote image blocked: ${alt}]` : '[remote image blocked]';
  image.replaceWith(placeholder);
}

async function rewriteRemoteImagesInHtml(
  html: string,
  proxyRemoteImages: boolean,
  imgproxyConfig?: ImgProxyConfig,
): Promise<string> {
  if (typeof document === 'undefined') {
    return html;
  }

  const template = document.createElement('template');
  template.innerHTML = html;

  const images = Array.from(template.content.querySelectorAll<HTMLImageElement>('img[src]'));
  await Promise.all(images.map(async (image) => {
    const src = image.getAttribute('src')?.trim();
    if (!src || isHtreeMediaUrl(src) || !isRemoteHttpUrl(src)) return;

    if (!proxyRemoteImages) {
      blockRemoteImage(image);
      return;
    }

    try {
      const proxied = await generateProxyUrlAsync(src, {}, imgproxyConfig);
      if (!proxied || proxied === src) {
        blockRemoteImage(image);
        return;
      }

      image.setAttribute('src', proxied);
      image.removeAttribute('srcset');
    } catch (error) {
      console.error('Failed to rewrite markdown image through imgproxy:', error);
      blockRemoteImage(image);
    }
  }));

  return template.innerHTML;
}

export async function renderMarkdownHtml(
  content: string,
  {
    routeContext,
    renderer,
    resolveLinkHref,
    addSanitizeAttrs = [],
    proxyRemoteImages = false,
    imgproxyConfig,
  }: RenderMarkdownOptions = {},
): Promise<string> {
  const tokens = marked.lexer(content);
  rewriteRelativeReferences(tokens, routeContext, resolveLinkHref);

  const rawHtml = marked.parser(tokens, renderer ? { renderer } : undefined);
  const sanitizedHtml = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: addSanitizeAttrs,
  });

  return rewriteRemoteImagesInHtml(sanitizedHtml, proxyRemoteImages, imgproxyConfig);
}
