export type IrisFilesAppId = 'files';

export interface AppBrand {
  id: IrisFilesAppId;
  label: string;
  displayName: string;
  iconSvg: string;
  appleTouchPng: string;
  pwa192Png: string;
  pwa512Png: string;
}

export const IRIS_FILES_APPS = ['files'] as const satisfies readonly IrisFilesAppId[];

const APP_BRANDS: Record<IrisFilesAppId, AppBrand> = {
  files: {
    id: 'files',
    label: 'drive',
    displayName: 'iris drive',
    iconSvg: 'iris-drive-icon.svg',
    appleTouchPng: 'iris-drive-icon-180.png',
    pwa192Png: 'iris-drive-icon-192.png',
    pwa512Png: 'iris-drive-icon-512.png',
  },
};

export function getAppBrand(app: IrisFilesAppId = 'files'): AppBrand {
  return APP_BRANDS[app];
}

export function getAppBrandAssetUrl(
  app: IrisFilesAppId,
  asset: keyof Pick<AppBrand, 'iconSvg' | 'appleTouchPng' | 'pwa192Png' | 'pwa512Png'>,
  baseUrl: string,
): string {
  return `${baseUrl}${getAppBrand(app)[asset]}`;
}

export function getAppPwaIcons(app: IrisFilesAppId) {
  const brand = getAppBrand(app);

  return [
    {
      src: brand.pwa192Png,
      sizes: '192x192',
      type: 'image/png',
    },
    {
      src: brand.pwa512Png,
      sizes: '512x512',
      type: 'image/png',
    },
    {
      src: brand.pwa512Png,
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any maskable',
    },
  ];
}
