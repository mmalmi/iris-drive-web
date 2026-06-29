<script lang="ts">
  /**
   * Router component that handles route matching and rendering
   * Receives currentPath as a prop to ensure proper reactivity
   */
  import { matchRoute } from '../lib/router.svelte';

  // Page components
  import SettingsLayout from './settings/SettingsLayout.svelte';
  import WalletPage from './WalletPage.svelte';
  import UsersPage from './UsersPage.svelte';
  import ProfileView from './ProfileView.svelte';
  import FollowsPage from './FollowsPage.svelte';
  import FollowersPage from './FollowersPage.svelte';
  import EditProfilePage from './EditProfilePage.svelte';

  // Route handlers
  import DeviceInviteRoute from '../routes/DeviceInviteRoute.svelte';
  import HomeRoute from '../routes/HomeRoute.svelte';
  import ShareDialogRoute from '../routes/ShareDialogRoute.svelte';
  import ShareInviteRoute from '../routes/ShareInviteRoute.svelte';
  import TreeRoute from '../routes/TreeRoute.svelte';
  import UserRoute from '../routes/UserRoute.svelte';

  // Route definitions with patterns
  // Note: More specific routes must come before less specific ones
  const routePatterns = [
    { pattern: '/', component: HomeRoute },
    { pattern: '/invite/:payload', component: DeviceInviteRoute },
    { pattern: '/share', component: ShareDialogRoute },
    { pattern: '/share-invite/:payload', component: ShareInviteRoute },
    { pattern: '/settings', component: SettingsLayout },
    { pattern: '/settings/*', component: SettingsLayout },
    { pattern: '/wallet', component: WalletPage },
    { pattern: '/users/no_existing', component: UsersPage, staticParams: { usersMode: 'no_existing' } },
    { pattern: '/users/create', component: UsersPage, staticParams: { usersMode: 'create' } },
    { pattern: '/users/existing', component: UsersPage, staticParams: { usersMode: 'existing' } },
    { pattern: '/users', component: UsersPage, staticParams: { usersMode: 'list' } },
    { pattern: '/:npub/follows', component: FollowsPage },
    { pattern: '/:npub/followers', component: FollowersPage },
    { pattern: '/:npub/edit', component: EditProfilePage },
    { pattern: '/:npub/profile', component: UserRoute },
    // Generic tree routes
    { pattern: '/:npub/:treeName/*', component: TreeRoute },
    { pattern: '/:npub/:treeName', component: TreeRoute },
    { pattern: '/:id/*', component: UserRoute },
    { pattern: '/:id', component: UserRoute },
  ];

  interface Props {
    currentPath: string;
  }

  let { currentPath }: Props = $props();

  // Find matching route
  function findRoute(path: string) {
    for (const route of routePatterns) {
      const match = matchRoute(route.pattern, path);
      if (match.matched) {
        return { component: route.component, params: { ...match.params, ...(route.staticParams ?? {}) } };
      }
    }
    return { component: HomeRoute, params: {} };
  }

  // Derive route from path prop
  let route = $derived.by(() => findRoute(currentPath));
</script>

<div class="flex-1 flex flex-col lg:flex-row min-h-0">
  {#if route.component === HomeRoute}
    <HomeRoute />
  {:else if route.component === DeviceInviteRoute}
    <DeviceInviteRoute payload={route.params.payload || ''} />
  {:else if route.component === ShareDialogRoute}
    <ShareDialogRoute />
  {:else if route.component === ShareInviteRoute}
    <ShareInviteRoute payload={route.params.payload || ''} />
  {:else if route.component === SettingsLayout}
    <SettingsLayout />
  {:else if route.component === WalletPage}
    <WalletPage />
  {:else if route.component === UsersPage}
    <UsersPage mode={route.params.usersMode === 'no_existing' ? 'no_existing' : route.params.usersMode === 'create' ? 'create' : route.params.usersMode === 'existing' ? 'existing' : 'list'} />
  {:else if route.component === FollowsPage}
    <FollowsPage npub={route.params.npub} />
  {:else if route.component === FollowersPage}
    <FollowersPage npub={route.params.npub} />
  {:else if route.component === EditProfilePage}
    <EditProfilePage npub={route.params.npub} />
  {:else if route.component === ProfileView}
    <ProfileView npub={route.params.npub || ''} />
  {:else if route.component === TreeRoute}
    <TreeRoute npub={route.params.npub} treeName={route.params.treeName} wild={route.params.wild} />
  {:else if route.component === UserRoute}
    <UserRoute id={route.params.id || route.params.npub} wild={route.params.wild} />
  {:else}
    <HomeRoute />
  {/if}
</div>
