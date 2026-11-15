<script lang="ts">
  import { isTreeLinkKey } from '../lib/treeLinkKey';
  import { onDestroy } from 'svelte';
  import FileBrowser from '../components/FileBrowser.svelte';
  import Viewer from '../components/Viewer/Viewer.svelte';
  import NoAccessNotice from '../components/NoAccessNotice.svelte';
  import { nostrStore, sessionRestored } from '../nostr';
  import { isNostrIdentityId } from '../utils/route';
  import { routeStore, addRecent, isViewingFileStore, currentHash } from '../stores';
  import { updateRecentVisibility } from '../stores/recents';
  import { nip19 } from 'nostr-tools';
  import { getQueryParamsFromHash } from '../lib/router.svelte';
  import { buildSelectedTreeForOwnRoute, syncSelectedTreeForOwnRoute } from '../lib/selectedTree';
  import { routeDocumentFolderName } from '../lib/documentNames';
  import { treeRootRegistry } from '../TreeRootRegistry';
  import { acceptedShares } from '../drive/shareLibrary';
  import { sharedRouteForOwnPath } from '../drive/sharePeople';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';

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
  let connectedRelays = $derived($nostrStore.connectedRelays);
  let lastConnectedRelays = $state(0);

  // Check if a file is selected (actual check from hashtree, not heuristic)
  let isViewingFile = $derived($isViewingFileStore);

  // A document folder shows the editor, also on a narrow screen.
  let isYjsDocument = $derived(!!routeDocumentFolderName(route));

  let showViewerPane = $derived(isViewingFile || isYjsDocument || isFullscreen);

  // A Drive or shared folder is only reached through this account's own
  // profile or a share record it holds. Without either, no relay answer could
  // open it, so say so instead of loading.
  let noAccess = $derived.by(() => {
    if (!npub || !isNostrIdentityId(npub) || !$sessionRestored) return false;
    const profileId = activeNostrIdentityRootScope($nostrStore);
    if (!profileId) return true;
    return profileId !== npub
      && !$acceptedShares.some((record) => record.share_id === npub && record.local_profile_id === profileId);
  });

  // A folder or document of this Drive that has been shared lives in the shared
  // folder from then on: open it there, so the owner edits what everyone sees.
  $effect(() => {
    const profileId = activeNostrIdentityRootScope($nostrStore);
    if (!profileId || route.npub !== profileId || route.treeName !== 'main' || route.isPermalink) return;
    const shared = sharedRouteForOwnPath(route.path, profileId, $acceptedShares);
    if (shared) window.location.replace(`#${shared}`);
  });

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
                    if (isTreeLinkKey(linkKey)) {
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
                    if (contentKeyHex) {
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

{#if noAccess}
  <NoAccessNotice />
{:else}
<!-- An open file takes the folder's place, as in Google Drive. The list stays as it was
     underneath, so closing the file returns to the same rows. -->
{#if !isYjsDocument}
  <div class={showViewerPane ? 'hidden' : 'flex flex-1 flex-col min-h-0'}>
    <FileBrowser />
  </div>
{/if}
<div class={showViewerPane
  ? 'flex flex-1 flex-col min-w-0 min-h-0'
  : 'hidden'}>
  <Viewer />
</div>
{/if}
