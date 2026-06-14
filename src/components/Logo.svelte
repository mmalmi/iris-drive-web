<script lang="ts">
  import { getAppBrand, getAppBrandAssetUrl, type IrisFilesAppId } from '../lib/appBrand';

  const baseUrl = import.meta.env.BASE_URL;

  let { class: className = '', app = 'files' }: { class?: string; app?: IrisFilesAppId } = $props();
  let brand = $derived(getAppBrand(app));
  let iconUrl = $derived(getAppBrandAssetUrl(app, 'iconSvg', baseUrl));
</script>

<span class="flex items-center gap-2 {className}">
  <img src={iconUrl} alt="" class="w-8 h-8" draggable="false" />
  <span class="font-semibold text-xl text-text-1">iris <span class="text-accent">{brand.label}</span></span>
</span>
