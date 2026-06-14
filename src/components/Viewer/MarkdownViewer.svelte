<script lang="ts">
  import { marked, type Tokens } from 'marked';
  import { SvelteMap, SvelteURLSearchParams } from 'svelte/reactivity';
  import { routeStore } from '../../stores';
  import { settingsStore } from '../../stores/settings';
  import { DEFAULT_IMGPROXY_CONFIG } from '../../utils/imgproxy';
  import { renderMarkdownHtml, type RenderMarkdownOptions } from '../../lib/markdown';

  interface Props {
    content: string;
    dirPath?: string[];
    class?: string;
    padded?: boolean;
    contentClass?: string;
    collapsible?: boolean;
    collapsedMaxHeight?: number;
    resolveLinkHref?: RenderMarkdownOptions['resolveLinkHref'];
  }

  let {
    content,
    dirPath,
    class: className = '',
    padded = true,
    contentClass = 'prose prose-sm max-w-none text-text-1',
    collapsible = false,
    collapsedMaxHeight = 960,
    resolveLinkHref,
  }: Props = $props();
  let route = $derived($routeStore);
  let imgproxySettings = $derived($settingsStore.imgproxy);
  let containerEl: HTMLDivElement | undefined;
  let contentEl: HTMLDivElement | undefined;
  let contentHeight = $state(0);
  let expanded = $state(false);
  const copyResetTimers = new SvelteMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

  function slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
  }

  function escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function getCodeLanguage(token: Tokens.Code): string {
    return token.lang?.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? '';
  }

  const renderer = new marked.Renderer();
  const defaultCodeRenderer = renderer.code.bind(renderer);
  renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
    const id = slugify(text);
    const anchor = `<a class="heading-anchor" data-anchor="${id}" href="#" aria-label="Link to this section"></a>`;
    return `<h${depth} id="${id}">${text}${anchor}</h${depth}>`;
  };
  renderer.code = (token: Tokens.Code) => {
    const language = getCodeLanguage(token);
    const languageLabel = language ? escapeHtml(language) : 'Code';
    const languageClass = language ? '' : ' is-plain';
    const renderedCode = defaultCodeRenderer(token).trimEnd();
    return `<div class="markdown-code-block"><div class="markdown-code-toolbar"><span class="markdown-code-language${languageClass}">${languageLabel}</span><button type="button" class="markdown-copy-button" aria-label="Copy code" title="Copy code"><span class="markdown-copy-button-label">Copy</span></button></div>${renderedCode}</div>\n`;
  };

  function setCopyButtonLabel(button: HTMLButtonElement, label: string) {
    const labelEl = button.querySelector('.markdown-copy-button-label');
    if (labelEl) {
      labelEl.textContent = label;
    }
  }

  function resetCopyButton(button: HTMLButtonElement) {
    const timer = copyResetTimers.get(button);
    if (timer) {
      clearTimeout(timer);
      copyResetTimers.delete(button);
    }
    button.classList.remove('is-copied');
    setCopyButtonLabel(button, 'Copy');
  }

  function markCopyButtonCopied(button: HTMLButtonElement) {
    resetCopyButton(button);
    button.classList.add('is-copied');
    setCopyButtonLabel(button, 'Copied');
    const timer = setTimeout(() => {
      button.classList.remove('is-copied');
      setCopyButtonLabel(button, 'Copy');
      copyResetTimers.delete(button);
    }, 2000);
    copyResetTimers.set(button, timer);
  }

  async function handleCopyButtonClick(button: HTMLButtonElement) {
    const code = button.closest('.markdown-code-block')?.querySelector('code');
    const copyText = code?.textContent?.replace(/\n$/, '');
    if (!copyText || !navigator.clipboard?.writeText) return;

    try {
      await navigator.clipboard.writeText(copyText);
      markCopyButtonCopied(button);
    } catch (error) {
      console.error('Failed to copy markdown code block:', error);
    }
  }

  function handleContainerClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const copyButton = target.closest('.markdown-copy-button') as HTMLButtonElement | null;
    if (copyButton) {
      event.preventDefault();
      void handleCopyButtonClick(copyButton);
      return;
    }

    const anchor = target.closest('.heading-anchor') as HTMLAnchorElement | null;
    if (!anchor) return;

    event.preventDefault();
    const anchorId = anchor.dataset.anchor;
    if (!anchorId) return;

    const hash = window.location.hash;
    const qIndex = hash.indexOf('?');
    const basePath = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
    const params = new SvelteURLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');
    params.set('anchor', anchorId);
    history.replaceState(null, '', `${basePath}?${params.toString()}`);

    const el = document.getElementById(anchorId);
    el?.scrollIntoView();
  }

  let htmlContent = $state('');
  let canCollapse = $derived(collapsible && contentHeight > collapsedMaxHeight + 8);
  let isCollapsed = $derived(canCollapse && !expanded);

  $effect(() => {
    const resolvedDir = dirPath ?? route.path.slice(0, -1);
    const routeContext = route.npub && route.treeName
      ? {
          npub: route.npub,
          treeName: route.treeName,
          basePath: resolvedDir,
        }
      : undefined;

    const imgproxyConfig = imgproxySettings.url && imgproxySettings.key && imgproxySettings.salt
      ? {
          url: imgproxySettings.url,
          key: imgproxySettings.key,
          salt: imgproxySettings.salt,
        }
      : DEFAULT_IMGPROXY_CONFIG;

    let cancelled = false;

    void renderMarkdownHtml(content, {
      routeContext,
      renderer,
      resolveLinkHref,
      addSanitizeAttrs: ['id', 'data-anchor'],
      proxyRemoteImages: imgproxySettings.enabled,
      imgproxyConfig,
    }).then((rendered) => {
      if (!cancelled) {
        htmlContent = rendered;
      }
    }).catch((error) => {
      console.error('Failed to render markdown:', error);
      if (!cancelled) {
        htmlContent = '';
      }
    });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    content;
    expanded = false;
  });

  $effect(() => {
    const hash = window.location.hash;
    const qIndex = hash.indexOf('?');
    if (qIndex < 0) return;
    const params = new SvelteURLSearchParams(hash.slice(qIndex + 1));
    const anchorId = params.get('anchor');
    if (!anchorId) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(anchorId);
      el?.scrollIntoView({ block: 'center' });
    });
  });

  $effect(() => {
    const node = containerEl;
    if (!node) return;
    node.addEventListener('click', handleContainerClick);
    return () => {
      node.removeEventListener('click', handleContainerClick);
    };
  });

  function measureContentHeight() {
    contentHeight = contentEl?.scrollHeight ?? 0;
  }

  $effect(() => {
    htmlContent;
    requestAnimationFrame(() => {
      measureContentHeight();
    });
  });

  $effect(() => {
    const node = contentEl;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      measureContentHeight();
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  });

  $effect(() => {
    htmlContent;
    return () => {
      for (const timer of copyResetTimers.values()) {
        clearTimeout(timer);
      }
      copyResetTimers.clear();
    };
  });
</script>

<div class={`markdown-shell ${className}`.trim()}>
  <div
    bind:this={containerEl}
    class={`markdown-frame ${isCollapsed ? 'is-collapsed' : ''}`.trim()}
    style={isCollapsed ? `max-height: ${collapsedMaxHeight}px;` : undefined}
  >
    <div
      bind:this={contentEl}
      class={`markdown-content ${padded ? 'p-4 lg:p-6' : ''} ${contentClass}`.trim()}
    >
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
      {@html htmlContent}
    </div>
    {#if isCollapsed}
      <div class="markdown-fade" aria-hidden="true"></div>
    {/if}
  </div>
  {#if canCollapse}
    <button
      type="button"
      class="markdown-toggle"
      onclick={() => {
        expanded = !expanded;
      }}
    >
      {expanded ? 'Show less' : 'Show more'}
    </button>
  {/if}
</div>

<style>
  .markdown-shell {
    min-width: 0;
    --markdown-link: #7647fe;
    --markdown-link-hover: #9b7dff;
    --markdown-success: #2ba640;
  }

  .markdown-frame {
    position: relative;
  }

  .markdown-frame.is-collapsed {
    overflow: hidden;
  }

  .markdown-content {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .markdown-fade {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    height: 5rem;
    pointer-events: none;
    background: linear-gradient(to bottom, rgb(var(--surface-0) / 0), rgb(var(--surface-0)));
  }

  .markdown-toggle {
    margin-top: 0.75rem;
    border: 0;
    background: transparent;
    color: var(--markdown-link);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    padding: 0;
  }

  .markdown-toggle:hover,
  .markdown-toggle:focus-visible {
    text-decoration: underline;
    outline: none;
  }

  .markdown-content :global(h1),
  .markdown-content :global(h2),
  .markdown-content :global(h3),
  .markdown-content :global(h4),
  .markdown-content :global(h5),
  .markdown-content :global(h6) {
    position: relative;
  }

  .markdown-content :global(.heading-anchor) {
    margin-left: 0.5em;
    opacity: 0;
    text-decoration: none;
    color: rgb(var(--text-2));
    transition: opacity 0.15s;
  }

  .markdown-content :global(.heading-anchor)::before {
    content: '#';
  }

  .markdown-content :global(h1:hover .heading-anchor),
  .markdown-content :global(h2:hover .heading-anchor),
  .markdown-content :global(h3:hover .heading-anchor),
  .markdown-content :global(h4:hover .heading-anchor),
  .markdown-content :global(h5:hover .heading-anchor),
  .markdown-content :global(h6:hover .heading-anchor),
  .markdown-content :global(.heading-anchor:focus) {
    opacity: 1;
  }

  .markdown-content :global(p),
  .markdown-content :global(li),
  .markdown-content :global(blockquote),
  .markdown-content :global(a),
  .markdown-content :global(code) {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .markdown-content :global(a) {
    color: var(--markdown-link);
    text-decoration-line: underline;
    text-decoration-thickness: 0.08em;
    text-underline-offset: 0.18em;
    text-decoration-color: color-mix(in srgb, var(--markdown-link) 42%, transparent);
    transition: color 0.15s, text-decoration-color 0.15s;
  }

  .markdown-content :global(a:hover),
  .markdown-content :global(a:focus-visible) {
    color: var(--markdown-link-hover);
    text-decoration-color: currentColor;
    outline: none;
  }

  .markdown-content :global(img) {
    max-width: min(100%, 60rem);
    max-height: min(70vh, 45rem);
    height: auto;
    object-fit: contain;
    vertical-align: middle;
  }

  .markdown-content :global(code) {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-variant-ligatures: none;
    letter-spacing: -0.01em;
  }

  .markdown-content :global(code::before),
  .markdown-content :global(code::after) {
    content: none !important;
  }

  .markdown-content :global(:not(pre) > code) {
    white-space: break-spaces;
    padding: 0.18em 0.45em;
    border: 1px solid rgb(var(--surface-3) / 0.85);
    border-radius: 0.55rem;
    background: rgb(var(--surface-2) / 0.72);
    color: rgb(var(--text-1));
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  .markdown-content :global(blockquote) {
    margin: 1.15em 0;
    padding: 0.95rem 1.05rem;
    border-inline-start: 0.28rem solid color-mix(in srgb, var(--markdown-link) 36%, rgb(var(--surface-3)));
    border-radius: 0 0.95rem 0.95rem 0;
    background: rgb(var(--surface-1) / 0.78);
    color: rgb(var(--text-2));
    box-shadow: inset 0 0 0 1px rgb(var(--surface-2) / 0.5);
  }

  .markdown-content :global(blockquote > :first-child) {
    margin-top: 0;
  }

  .markdown-content :global(blockquote > :last-child) {
    margin-bottom: 0;
  }

  .markdown-content :global(.markdown-remote-image-blocked) {
    display: inline-block;
    padding: 0.35rem 0.55rem;
    border: 1px dashed rgb(var(--surface-3));
    border-radius: 0.5rem;
    background: rgb(var(--surface-1));
    color: rgb(var(--text-3));
    font-size: 0.875rem;
  }

  .markdown-content :global(pre) {
    white-space: pre;
    overflow-x: auto;
    overscroll-behavior-x: contain;
  }

  .markdown-content :global(.markdown-code-block) {
    margin: 1.25em 0;
    border: 1px solid rgb(var(--surface-3) / 0.95);
    border-radius: 0.95rem;
    overflow: hidden;
    background: rgb(var(--surface-1));
    box-shadow: inset 0 1px 0 rgb(var(--surface-2) / 0.55);
  }

  .markdown-content :global(.markdown-code-toolbar) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.55rem 0.75rem;
    border-bottom: 1px solid rgb(var(--surface-3) / 0.9);
    background: linear-gradient(180deg, rgb(var(--surface-0)), rgb(var(--surface-1)));
  }

  .markdown-content :global(.markdown-code-language) {
    min-width: 0;
    color: rgb(var(--text-2));
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .markdown-content :global(.markdown-code-language.is-plain) {
    letter-spacing: 0.02em;
    text-transform: none;
  }

  .markdown-content :global(.markdown-copy-button) {
    border: 1px solid rgb(var(--surface-3) / 0.95);
    border-radius: 0.65rem;
    background: rgb(var(--surface-1));
    color: rgb(var(--text-2));
    padding: 0.35rem 0.72rem;
    font-size: 0.75rem;
    line-height: 1;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s, color 0.15s;
  }

  .markdown-content :global(.markdown-copy-button:hover),
  .markdown-content :global(.markdown-copy-button:focus-visible) {
    background: rgb(var(--surface-2));
    color: rgb(var(--text-1));
    border-color: color-mix(in srgb, var(--markdown-link) 22%, rgb(var(--surface-3)));
    outline: none;
  }

  .markdown-content :global(.markdown-copy-button.is-copied) {
    color: var(--markdown-success);
    border-color: color-mix(in srgb, var(--markdown-success) 45%, rgb(var(--surface-3)));
    background: color-mix(in srgb, var(--markdown-success) 10%, rgb(var(--surface-1)));
  }

  .markdown-content :global(.markdown-code-block pre) {
    margin: 0;
    border-radius: 0;
    background: transparent;
    padding: 0.95rem 1rem 1.05rem;
    font-size: 0.83rem;
    line-height: 1.6;
  }

  .markdown-content :global(.markdown-code-block pre code) {
    display: block;
    color: rgb(var(--text-1));
    background: transparent;
    border: 0;
    padding: 0;
    white-space: inherit;
  }
</style>
