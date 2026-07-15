<script lang="ts">
  import { onDestroy } from 'svelte';
  import FileBrowser from '../components/FileBrowser.svelte';
  import Viewer from '../components/Viewer/Viewer.svelte';
  import StreamView from '../components/stream/StreamView.svelte';
  import { nostrStore } from '../nostr';
  import { routeStore, addRecent, isViewingFileStore, currentHash, directoryEntriesStore } from '../stores';
  import { LinkType } from '@hashtree/core';
  import { updateRecentVisibility } from '../stores/recents';
  import { nip19 } from 'nostr-tools';
  import { getQueryParamsFromHash } from '../lib/router.svelte';
  import { buildSelectedTreeForOwnRoute, syncSelectedTreeForOwnRoute } from '../lib/selectedTree';
  import { supportsDocumentFeatures } from '../appType';
  import { treeRootRegistry } from '../TreeRootRegistry';

  interface Props {
    npub?: string;
    treeName?: string;
    wild?: string;
  }

  let { npub, treeName }: Props = $props();

  // Use derived from routeStore for reactivity
  let route = $derived($routeStore);
  let hash = $derived($currentHash);
  // Check if fullscreen mode from URL
  let isFullscreen = $derived.by(() => {
    return getQueryParamsFromHash(hash).get('fullscreen') === '1';
  });
  // Check if viewing own tree (streaming only allowed on own trees)
  let userNpub = $derived($nostrStore.npub);
  let viewedNpub = $derived(route.npub);
  let isOwnTree = $derived(!viewedNpub || viewedNpub === userNpub);
  let connectedRelays = $derived($nostrStore.connectedRelays);
  let lastConnectedRelays = $state(0);

  // Only enable streaming mode on user's own trees
  let isStreaming = $derived(route.params.get('stream') === '1' && isOwnTree);
  // Check if a file is selected (actual check from hashtree, not heuristic)
  let isViewingFile = $derived($isViewingFileStore);
  let dirEntries = $derived($directoryEntriesStore);

  // Check if current directory is a Yjs document (contains .yjs file)
  let isYjsDocument = $derived(supportsDocumentFeatures() && dirEntries.entries.some(e => e.name === '.yjs' && e.type !== LinkType.Dir));

  // On mobile, show viewer for Yjs docs or when file/stream selected
  let hasFileSelected = $derived(isViewingFile || isStreaming || isYjsDocument);
  let showViewerPane = $derived(
    hasFileSelected || isFullscreen
  );

  // Show stream view if streaming and logged in
  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let showStreamView = $derived(isStreaming && isLoggedIn);

  // Use $effect to run when npub or treeName props change (not just on mount)
  // This is needed because the Router uses conditionals, not {#key}, so the component
  // doesn't remount when navigating between trees
  $effect(() => {
    // Load tree when route params change
    if (npub && treeName) {
      // Set selectedTree immediately (synchronously) if viewing own tree
      // This ensures autosaveIfOwn works before async loadTree completes
      syncSelectedTreeForOwnRoute(nostrStore, {
        npub,
        treeName,
        visibility: treeRootRegistry.getVisibility(npub, treeName),
        labels: treeRootRegistry.getLabels(npub, treeName),
      });

      loadTree(npub, treeName);

      // Track as recent - include linkKey if present
      // Parse linkKey from current URL directly (routeStore may not have updated yet)
      const hash = window.location.hash;
      let linkKey: string | undefined;
      linkKey = getQueryParamsFromHash(hash).get('k') ?? undefined;

      addRecent({
        type: 'tree',
        label: treeName,
        path: `/${npub}/${treeName}`,
        npub,
        treeName,
        linkKey,
      });
    }
  });

  let resolverUnsub: (() => void) | null = null;

  async function loadTree(npubStr: string, treeNameVal: string) {
    try {
      const { getRefResolver, getResolverKey } = await import('../refResolver');
      const { toHex } = await import('@hashtree/core');
      const resolver = getRefResolver();
      const key = getResolverKey(npubStr, treeNameVal);

      if (key) {
        resolverUnsub?.();
        let pubkey: string | null = null;
        try {
          const decoded = nip19.decode(npubStr);
          if (decoded.type === 'npub') {
            pubkey = decoded.data as string;
          }
        } catch {}
        resolverUnsub = resolver.subscribe(key, async (cidObj, visibilityInfo) => {
          if (cidObj) {
            const hashHex = toHex(cidObj.hash);
            const keyHex = cidObj.key ? toHex(cidObj.key) : undefined;

            // Update recent item's visibility when resolved
            if (visibilityInfo?.visibility) {
              updateRecentVisibility(`/${npubStr}/${treeNameVal}`, visibilityInfo.visibility);
            }

            // If owner viewing link-visible without k= param, recover linkKey and update URL
            if (visibilityInfo?.visibility === 'link-visible') {
              const state = nostrStore.getState();
              const currentHash = window.location.hash;
              const hasKParam = currentHash.includes('?k=') || currentHash.includes('&k=');

              if (state.pubkey === pubkey && !hasKParam) {
                const { decrypt } = await import('../nostr');

                if (visibilityInfo.selfEncryptedLinkKey) {
                  // New format: directly decrypt linkKey
                  try {
                    const linkKey = await decrypt(state.pubkey, visibilityInfo.selfEncryptedLinkKey);
                    if (linkKey && linkKey.length === 64) {
                      const separator = currentHash.includes('?') ? '&' : '?';
                      window.history.replaceState(null, '', currentHash + separator + 'k=' + linkKey);
                    }
                  } catch (e) {
                    console.debug('Could not recover linkKey for URL:', e);
                  }
                } else if (visibilityInfo.selfEncryptedKey && visibilityInfo.encryptedKey) {
                  // Migration: derive linkKey from contentKey and encryptedKey
                  try {
                    const { visibilityHex } = await import('@hashtree/core');
                    const contentKeyHex = await decrypt(state.pubkey, visibilityInfo.selfEncryptedKey);
                    if (contentKeyHex && contentKeyHex.length === 64) {
                      // linkKey = XOR(encryptedKey, contentKey)
                      const linkKeyHex = visibilityHex.encryptKeyForLink(contentKeyHex, visibilityInfo.encryptedKey);
                      const separator = currentHash.includes('?') ? '&' : '?';
                      window.history.replaceState(null, '', currentHash + separator + 'k=' + linkKeyHex);
                    }
                  } catch (e) {
                    console.debug('Could not derive linkKey from selfEncryptedKey:', e);
                  }
                }
              }
            }

            if (pubkey) {
              const state = nostrStore.getState();
              const baseSelectedTree = buildSelectedTreeForOwnRoute(state, {
                npub: npubStr,
                treeName: treeNameVal,
                visibility: visibilityInfo?.visibility ?? treeRootRegistry.getVisibility(npubStr, treeNameVal),
                labels: treeRootRegistry.getLabels(npubStr, treeNameVal),
              });
              if (baseSelectedTree) {
                nostrStore.setSelectedTree({
                  ...baseSelectedTree,
                  rootHash: hashHex,
                  rootKey: keyHex,
                  visibility: visibilityInfo?.visibility ?? baseSelectedTree.visibility,
                  encryptedKey: visibilityInfo?.encryptedKey,
                  keyId: visibilityInfo?.keyId,
                  selfEncryptedKey: visibilityInfo?.selfEncryptedKey,
                  selfEncryptedLinkKey: visibilityInfo?.selfEncryptedLinkKey,
                });
              }
            }
          }
        });
      }
    } catch (e) {
      console.error('Failed to load from nostr:', e);
    }
  }

  $effect(() => {
    if (connectedRelays > 0 && lastConnectedRelays === 0 && npub && treeName) {
      loadTree(npub, treeName);
    }
    lastConnectedRelays = connectedRelays;
  });

  onDestroy(() => {
    resolverUnsub?.();
  });
</script>

<!-- Desktop file sidebar. -->
{#if !isFullscreen}
  <div class={hasFileSelected
      ? 'hidden lg:flex lg:w-80 shrink-0 flex-col min-h-0'
      : 'flex flex-1 shrink-0 flex-col min-h-0'}>
    <FileBrowser compact={showViewerPane} />
  </div>
{/if}
<!-- Right panel (Viewer or StreamView) - shown on mobile when file/stream selected -->
<div class={showViewerPane
  ? 'flex flex-1 flex-col min-w-0 min-h-0'
  : 'hidden'}>
  {#if showStreamView}
    <StreamView />
  {:else}
    <Viewer />
  {/if}
</div>
