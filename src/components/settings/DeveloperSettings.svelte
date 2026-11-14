<script lang="ts">
  /** For people who build on Drive: what it is made with, and where its code is. */
  import { shouldOpenSourceCodeLinkInNewTab } from '../../appType';
  import { getCanonicalGitRepositoryUrl } from '../../lib/shareUrls';
  import { buildTime } from './buildTime';

  const openSourceCodeInNewTab = shouldOpenSourceCodeLinkInNewTab();
  const sourceCodeLinkTarget = openSourceCodeInNewTab ? '_blank' : '_self';
  const sourceCodeLinkRel = openSourceCodeInNewTab ? 'noopener noreferrer' : undefined;
  const hashtreeDevUrl = 'https://hashtree.cc/#/dev';
  const sourceCodeUrl = getCanonicalGitRepositoryUrl('hashtree');
</script>

<div class="space-y-6" data-testid="developer-settings">
  <section>
    <p class="text-sm text-text-2 mb-3">
      Built on
      <a
        href={hashtreeDevUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="ml-1 no-underline text-text-1 hover:text-text-0"
      >
        hashtree
      </a>
    </p>
    <div class="bg-surface-2 rounded p-3 text-sm space-y-3">
      <div class="flex justify-between items-center gap-3">
        <span class="text-muted">Build</span>
        <span class="text-text-1 font-mono text-xs">{buildTime() ?? 'development'}</span>
      </div>
      <a
        href={sourceCodeUrl}
        target={sourceCodeLinkTarget}
        rel={sourceCodeLinkRel}
        class="btn-ghost w-full flex items-center justify-center gap-2 no-underline"
      >
        <span class="i-lucide-code text-sm"></span>
        <span>hashtree</span>
        <span class="text-text-3 text-xs no-underline">(source code)</span>
      </a>
    </div>
  </section>
</div>
