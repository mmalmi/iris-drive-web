<script lang="ts">
  /**
   * Router component that handles route matching and rendering
   * Receives currentPath as a prop to ensure proper reactivity
   */
  import { matchRoute } from '../lib/router.svelte';
  import { matchDirectContentRoute } from '../lib/directContentRoute';

  // Pages other than the file views load when first opened.
  import UsersPage from './UsersPage.svelte';

  // Route handlers
  import HomeRoute from '../routes/HomeRoute.svelte';
  import RecentRoute from '../routes/RecentRoute.svelte';
  import SharedWithMeRoute from '../routes/SharedWithMeRoute.svelte';
  import TreeRoute from '../routes/TreeRoute.svelte';
  import UserRoute from '../routes/UserRoute.svelte';

  // Route definitions with patterns
  // Note: More specific routes must come before less specific ones
  type RouteId =
    | 'home'
    | 'deviceApproval'
    | 'shareDialog'
    | 'shareJoin'
    | 'shareInvite'
    | 'recent'
    | 'sharedWithMe'
    | 'settings'
    | 'wallet'
    | 'users'
    | 'follows'
    | 'followers'
    | 'editProfile'
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
    { pattern: '/recent', id: 'recent' },
    { pattern: '/shared-with-me', id: 'sharedWithMe' },
    { pattern: '/settings', id: 'settings' },
    { pattern: '/settings/*', id: 'settings' },
    { pattern: '/wallet', id: 'wallet' },
    { pattern: '/users/no_existing', id: 'users', staticParams: { usersMode: 'no_existing' } },
    { pattern: '/users/create', id: 'users', staticParams: { usersMode: 'create' } },
    { pattern: '/users/existing', id: 'users', staticParams: { usersMode: 'existing' } },
    { pattern: '/users', id: 'users', staticParams: { usersMode: 'list' } },
    { pattern: '/:npub/follows', id: 'follows' },
    { pattern: '/:npub/followers', id: 'followers' },
    { pattern: '/:npub/edit', id: 'editProfile' },
    { pattern: '/:npub/profile', id: 'user' },
    // Generic tree routes
    { pattern: '/:npub/:treeName/*', id: 'tree' },
    { pattern: '/:npub/:treeName', id: 'tree' },
    { pattern: '/:id/*', id: 'user' },
    { pattern: '/:id', id: 'user' },
  ];

  interface Props {
    currentPath: string;
  }

  let { currentPath }: Props = $props();

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
      <DeviceApprovalRoute payload={route.params.payload || ''} />
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
  {:else if route.id === 'recent'}
    <RecentRoute />
  {:else if route.id === 'sharedWithMe'}
    <SharedWithMeRoute />
  {:else if route.id === 'settings'}
    {#await import('./settings/SettingsLayout.svelte') then { default: SettingsLayout }}
      <SettingsLayout />
    {/await}
  {:else if route.id === 'wallet'}
    {#await import('./WalletPage.svelte') then { default: WalletPage }}
      <WalletPage />
    {/await}
  {:else if route.id === 'users'}
    <UsersPage mode={route.params.usersMode === 'no_existing' ? 'no_existing' : route.params.usersMode === 'create' ? 'create' : route.params.usersMode === 'existing' ? 'existing' : 'list'} />
  {:else if route.id === 'follows'}
    {#await import('./FollowsPage.svelte') then { default: FollowsPage }}
      <FollowsPage npub={route.params.npub} />
    {/await}
  {:else if route.id === 'followers'}
    {#await import('./FollowersPage.svelte') then { default: FollowersPage }}
      <FollowersPage npub={route.params.npub} />
    {/await}
  {:else if route.id === 'editProfile'}
    {#await import('./EditProfilePage.svelte') then { default: EditProfilePage }}
      <EditProfilePage npub={route.params.npub} />
    {/await}
  {:else if route.id === 'tree'}
    <TreeRoute npub={route.params.npub} treeName={route.params.treeName} wild={route.params.wild} />
  {:else if route.id === 'user'}
    <UserRoute id={route.params.id || route.params.npub} wild={route.params.wild} />
  {:else}
    <HomeRoute />
  {/if}
</div>
