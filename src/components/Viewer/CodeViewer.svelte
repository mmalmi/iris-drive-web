<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import Prism from 'prismjs';
  // Import popular languages
  import 'prismjs/components/prism-markup';
  import 'prismjs/components/prism-css';
  import 'prismjs/components/prism-clike';
  import 'prismjs/components/prism-javascript';
  import 'prismjs/components/prism-typescript';
  import 'prismjs/components/prism-jsx';
  import 'prismjs/components/prism-tsx';
  import 'prismjs/components/prism-json';
  import 'prismjs/components/prism-markdown';
  import 'prismjs/components/prism-python';
  import 'prismjs/components/prism-rust';
  import 'prismjs/components/prism-go';
  import 'prismjs/components/prism-c';
  import 'prismjs/components/prism-cpp';
  import 'prismjs/components/prism-java';
  import 'prismjs/components/prism-bash';
  import 'prismjs/components/prism-sql';
  import 'prismjs/components/prism-yaml';
  import 'prismjs/components/prism-toml';
  import 'prismjs/components/prism-ini';
  import 'prismjs/components/prism-diff';
  import 'prismjs/components/prism-ruby';
  import 'prismjs/components/prism-markup-templating';
  import 'prismjs/components/prism-php';
  import 'prismjs/components/prism-swift';
  import 'prismjs/components/prism-kotlin';
  import 'prismjs/components/prism-scala';
  import 'prismjs/components/prism-docker';
  import 'prismjs/components/prism-nginx';

  interface Props {
    content: string;
    filename: string;
  }

  let { content, filename }: Props = $props();

  // Map file extensions to Prism language names
  const extToLang: Record<string, string> = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    jsx: 'jsx',
    tsx: 'tsx',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hxx: 'cpp',
    java: 'java',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    diff: 'diff',
    patch: 'diff',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',
    scala: 'scala',
    html: 'markup',
    htm: 'markup',
    xml: 'markup',
    svg: 'markup',
    css: 'css',
    scss: 'css',
    sass: 'css',
    dockerfile: 'docker',
    svelte: 'markup',
    vue: 'markup',
  };

  function getLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const base = filename.toLowerCase();

    // Handle special filenames
    if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'docker';
    if (base === 'nginx.conf' || base.endsWith('.nginx')) return 'nginx';
    if (base === 'makefile' || base === 'gnumakefile') return 'clike';

    return extToLang[ext] || 'clike'; // fallback to clike for basic highlighting
  }

  let language = $derived(getLanguage(filename));

  // Parse line range from URL query param (e.g., ?L=10 or ?L=10-15)
  function parseLineRange(search: string): { start: number; end: number } | null {
    const params = new URLSearchParams(search);
    const lineParam = params.get('L');
    if (!lineParam) return null;
    const match = lineParam.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) return null;
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }

  // Extract query string from hash URL (e.g., #/path?L=3 -> L=3)
  function getQueryFromHash(): string {
    const hash = window.location.hash;
    const qIndex = hash.indexOf('?');
    return qIndex >= 0 ? hash.slice(qIndex + 1) : '';
  }

  let highlightedRange = $state<{ start: number; end: number } | null>(null);
  let selectedLine = $state<number | null>(null);

  // Track hash/query changes
  $effect(() => {
    function updateFromHash() {
      highlightedRange = parseLineRange(getQueryFromHash());
    }
    updateFromHash();
    window.addEventListener('hashchange', updateFromHash);
    return () => window.removeEventListener('hashchange', updateFromHash);
  });

  // Scroll to highlighted line after DOM updates
  $effect(() => {
    const range = highlightedRange;
    if (!range) return;
    tick().then(() => {
      const el = document.querySelector(`[data-line="${range.start}"]`);
      el?.scrollIntoView({ block: 'center' });
    });
  });

  // Split highlighted HTML into lines while preserving tags
  let lines = $derived.by(() => {
    const grammar = Prism.languages[language];
    let highlighted: string;
    if (!grammar) {
      highlighted = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    } else {
      highlighted = Prism.highlight(content, grammar, language);
    }
    // Split by newlines - each becomes a line
    return highlighted.split('\n');
  });

  function isLineHighlighted(lineNum: number): boolean {
    if (!highlightedRange) return false;
    return lineNum >= highlightedRange.start && lineNum <= highlightedRange.end;
  }

  function handleLineClick(lineNum: number, event: MouseEvent) {
    const hash = window.location.hash;
    const qIndex = hash.indexOf('?');
    const basePath = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
    const currentParams = new SvelteURLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');

    if (event.shiftKey && selectedLine !== null) {
      // Shift-click: select range
      const start = Math.min(selectedLine, lineNum);
      const end = Math.max(selectedLine, lineNum);
      currentParams.set('L', `${start}-${end}`);
    } else {
      // Regular click: select single line
      selectedLine = lineNum;
      currentParams.set('L', String(lineNum));
    }

    window.location.hash = `${basePath}?${currentParams.toString()}`;
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -->
<pre class="code-viewer"><code class="language-{language}">{#each lines as line, i (i)}{@const lineNum = i + 1}<span
  class="code-line"
  class:line-highlighted={isLineHighlighted(lineNum)}
  data-line={lineNum}
><span
  class="line-number"
  role="button"
  tabindex="0"
  onclick={(e) => handleLineClick(lineNum, e)}
  onkeydown={(e) => e.key === 'Enter' && handleLineClick(lineNum, e as unknown as MouseEvent)}
>{lineNum}</span><span class="line-content"><!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html line || '&nbsp;'}</span></span>{/each}</code></pre>
<!-- eslint-enable svelte/no-at-html-tags -->

<style>
  .code-viewer {
    margin: 0;
    padding: 0;
    font-size: 0.875rem;
    line-height: 1.5;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    color: var(--text-1, #f1f1f1);
    background: transparent;
    counter-reset: line;
  }

  .code-viewer code {
    font-family: inherit;
    display: block;
    white-space: normal;
  }

  .code-line {
    display: flex;
    align-items: flex-start;
  }

  .code-line.line-highlighted {
    background: rgba(118, 71, 254, 0.15);
  }

  .line-number {
    flex: 0 0 3.5em;
    padding-right: 1em;
    text-align: right;
    color: var(--text-3, #666);
    user-select: none;
    cursor: pointer;
  }

  .line-number:hover {
    color: var(--text-1, #f1f1f1);
  }

  .line-content {
    flex: 1 1 auto;
    min-width: 0;
    display: block;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Dark theme - matches app colors */
  :global(.code-viewer .token.comment),
  :global(.code-viewer .token.prolog),
  :global(.code-viewer .token.doctype),
  :global(.code-viewer .token.cdata) {
    color: #6a737d;
  }

  :global(.code-viewer .token) {
    display: inline;
  }

  :global(.code-viewer .token.punctuation) {
    color: #aab1bb;
  }

  :global(.code-viewer .token.property),
  :global(.code-viewer .token.tag),
  :global(.code-viewer .token.boolean),
  :global(.code-viewer .token.number),
  :global(.code-viewer .token.constant),
  :global(.code-viewer .token.symbol),
  :global(.code-viewer .token.deleted) {
    color: #f97583;
  }

  :global(.code-viewer .token.selector),
  :global(.code-viewer .token.attr-name),
  :global(.code-viewer .token.string),
  :global(.code-viewer .token.char),
  :global(.code-viewer .token.builtin),
  :global(.code-viewer .token.inserted) {
    color: #9ecbff;
  }

  :global(.code-viewer .token.operator),
  :global(.code-viewer .token.entity),
  :global(.code-viewer .token.url),
  :global(.code-viewer .language-css .token.string),
  :global(.code-viewer .style .token.string) {
    color: #79b8ff;
  }

  :global(.code-viewer .token.atrule),
  :global(.code-viewer .token.attr-value),
  :global(.code-viewer .token.keyword) {
    color: #b392f0;
  }

  :global(.code-viewer .token.function),
  :global(.code-viewer .token.class-name) {
    color: #ffab70;
  }

  :global(.code-viewer .token.regex),
  :global(.code-viewer .token.important),
  :global(.code-viewer .token.variable) {
    color: #ffab70;
  }
</style>
