<script lang="ts">
  /** Help while a formula is typed: functions that match the name so far, or what the current function takes. */
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { argumentList } from '../../lib/sheets/formula/docs';

  interface Props {
    ctl: SheetController;
    /** CSS that places the box, relative to the nearest positioned parent. */
    place: string;
  }
  let { ctl, place }: Props = $props();

  let completion = $derived(ctl.completion);
  let hint = $derived(completion ? null : ctl.callHint);
  let hintArgs = $derived(hint ? argumentList(hint.doc) : []);
  // Past the listed values, a function that takes "more of the same" is still on its last one.
  let currentArg = $derived(hint ? Math.min(hint.argument, hintArgs.length - 1) : -1);
</script>

{#if completion}
  <!-- Choosing with the mouse must not take the cursor out of the formula. -->
  <div class="help list" style={place} role="listbox" tabindex="-1" aria-label="Functions" data-testid="sheet-function-list" onmousedown={event => event.preventDefault()}>
    {#each completion.matches as doc, index (doc.name)}
      <button
        type="button"
        role="option"
        class="choice"
        class:active={index === ctl.completionIndex}
        aria-selected={index === ctl.completionIndex}
        onclick={() => ctl.acceptCompletion(index)}
      >
        <span class="fn">{doc.name}</span>
        <span class="about">{doc.about}</span>
      </button>
    {/each}
  </div>
{:else if hint}
  <div class="help hint" style={place} data-testid="sheet-function-hint">
    <div class="signature">
      <span class="fn">{hint.doc.name}</span>({#each hintArgs as arg, index (index)}<span class:current={index === currentArg}>{arg}</span>{index < hintArgs.length - 1 ? ', ' : ''}{/each})
    </div>
    <div class="about">{hint.doc.about}</div>
  </div>
{/if}

<style>
  .help {
    position: absolute;
    z-index: 5;
    width: max-content;
    max-width: min(420px, calc(100vw - 16px));
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: rgb(var(--surface-1));
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
    font-size: 0.8rem;
    color: rgb(var(--text-1));
  }

  .list {
    padding: 3px;
  }

  .choice {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 4px 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font-size: inherit;
    text-align: left;
    cursor: pointer;
  }

  .choice.active,
  .choice:hover {
    background: rgb(145 109 254 / 0.16);
  }

  .fn {
    flex: none;
    font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.76rem;
  }

  .about {
    color: rgb(var(--text-2));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint {
    padding: 6px 10px;
    pointer-events: none;
  }

  .hint .about {
    white-space: normal;
    margin-top: 2px;
  }

  .signature {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.76rem;
    overflow-wrap: anywhere;
  }

  .current {
    color: #916dfe;
    font-weight: 700;
  }
</style>
