<script lang="ts">
  /**
   * Router component that handles route matching and rendering
   * Receives currentPath as a prop to ensure proper reactivity
   */
  import { matchRoute } from '../lib/router.svelte';
  import { matchDirectContentRoute } from '../lib/directContentRoute';

  // Only the Drive itself is part of the first download; every other page
  // loads when it is first opened.
  import HomeRoute from '../routes/HomeRoute.svelte';
  import TreeRoute from '../routes/TreeRoute.svelte';

  // Route definitions with patterns
  // Note: More specific routes must come before less specific ones
  type RouteId =
    | 'home'
    | 'deviceApproval'
    | 'shareDialog'
    | 'shareJoin'
    | 'shareInvite'
    | 'trash'
    | 'recent'
    | 'photos'
    | 'sharedWithMe'
    | 'settings'
    | 'users'
    | 'tree'
    | 'user';
  type ResolvedRouteParams = Partial<Record<
    'payload' | 'usersMode' | 'npub' | 'treeName' | 'wild' | 'id',
    string
  >>;

  const routePatterns: Array<{
    pattern: string;
    id: RouteId;
    staticParams?: ResolvedRouteParams;
  }> = [
    { pattern: '/', id: 'home' },
    { pattern: '/approve-device/:payload', id: 'deviceApproval' },
    { pattern: '/share', id: 'shareDialog' },
    { pattern: '/share-invite/:payload', id: 'shareInvite' },
    { pattern: '/share-join/:payload', id: 'shareJoin' },
    { pattern: '/trash', id: 'trash' },
    { pattern: '/recent', id: 'recent' },
    // The timeline, the albums and each album.
    { pattern: '/photos/*', id: 'photos' },
    { pattern: '/shared-with-me', id: 'sharedWithMe' },
    { pattern: '/settings', id: 'settings' },
    { pattern: '/settings/*', id: 'settings' },
    { pattern: '/users/no_existing', id: 'users', staticParams: { usersMode: 'no_existing' } },
    { pattern: '/users/create', id: 'users', staticParams: { usersMode: 'create' } },
    { pattern: '/users/existing', id: 'users', staticParams: { usersMode: 'existing' } },
    { pattern: '/users', id: 'users', staticParams: { usersMode: 'list' } },
    // A person's page; addresses of pages Drive no longer has open it too.
    { pattern: '/:npub/profile', id: 'user' },
    { pattern: '/:npub/follows', id: 'user' },
    { pattern: '/:npub/followers', id: 'user' },
    { pattern: '/:npub/edit', id: 'user' },
    // Generic tree routes
    { pattern: '/:npub/:treeName/*', id: 'tree' },
    { pattern: '/:npub/:treeName', id: 'tree' },
    { pattern: '/:id/*', id: 'user' },
    { pattern: '/:id', id: 'user' },
  ];

  interface Props {
    currentPath: string;
    onShortcuts: () => void;
  }

  let { currentPath, onShortcuts }: Props = $props();

  // Find matching route
  function findRoute(path: string): { id: RouteId; params: ResolvedRouteParams } {
    const directContentRoute = matchDirectContentRoute(path);
    if (directContentRoute) {
      return { id: 'user', params: directContentRoute };
    }

    for (const route of routePatterns) {
      const match = matchRoute(route.pattern, path);
      if (match.matched) {
        return { id: route.id, params: { ...match.params, ...(route.staticParams ?? {}) } };
      }
    }
    return { id: 'home', params: {} };
  }

  // Derive route from path prop
  let route = $derived.by(() => findRoute(currentPath));
</script>

<div class="flex-1 flex flex-col lg:flex-row min-h-0">
  {#if route.id === 'home'}
    <HomeRoute />
  {:else if route.id === 'deviceApproval'}
    {#await import('../routes/DeviceApprovalRoute.svelte') then { default: DeviceApprovalRoute }}
      {#key route.params.payload}
        <DeviceApprovalRoute payload={route.params.payload || ''} />
      {/key}
    {/await}
  {:else if route.id === 'shareDialog'}
    {#await import('../routes/ShareDialogRoute.svelte') then { default: ShareDialogRoute }}
      <ShareDialogRoute />
    {/await}
  {:else if route.id === 'shareInvite'}
    {#await import('../routes/ShareInviteRoute.svelte') then { default: ShareInviteRoute }}
      <ShareInviteRoute payload={route.params.payload || ''} />
    {/await}
  {:else if route.id === 'shareJoin'}
    {#await import('../routes/ShareJoinRoute.svelte') then { default: ShareJoinRoute }}
      <ShareJoinRoute payload={route.params.payload || ''} />
    {/await}
  {:else if route.id === 'trash'}
    {#await import('../routes/TrashRoute.svelte') then { default: TrashRoute }}
      <TrashRoute />
    {/await}
  {:else if route.id === 'recent'}
    {#await import('../routes/RecentRoute.svelte') then { default: RecentRoute }}
      <RecentRoute />
    {/await}
  {:else if route.id === 'photos'}
    {#await import('../routes/PhotosRoute.svelte') then { default: PhotosRoute }}
      <PhotosRoute />
    {/await}
  {:else if route.id === 'sharedWithMe'}
    {#await import('../routes/SharedWithMeRoute.svelte') then { default: SharedWithMeRoute }}
      <SharedWithMeRoute />
    {/await}
  {:else if route.id === 'settings'}
    {#await import('./settings/SettingsLayout.svelte') then { default: SettingsLayout }}
      <SettingsLayout {onShortcuts} />
    {/await}
  {:else if route.id === 'users'}
    {#await import('./UsersPage.svelte') then { default: UsersPage }}
      <UsersPage mode={route.params.usersMode === 'no_existing' ? 'no_existing' : route.params.usersMode === 'create' ? 'create' : route.params.usersMode === 'existing' ? 'existing' : 'list'} />
    {/await}
  {:else if route.id === 'tree'}
    <TreeRoute npub={route.params.npub} treeName={route.params.treeName} wild={route.params.wild} />
  {:else if route.id === 'user'}
    {#await import('../routes/UserRoute.svelte') then { default: UserRoute }}
      <UserRoute id={route.params.id || route.params.npub} wild={route.params.wild} />
    {/await}
  {:else}
    <HomeRoute />
  {/if}
</div>
