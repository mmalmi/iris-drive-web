export type AppType = 'files';

let currentAppType: AppType = 'files';

export function setAppType(type: AppType) {
  currentAppType = type;
}

export function getAppType(): AppType {
  return currentAppType;
}

export function isFilesApp(): boolean {
  return currentAppType === 'files';
}

export function supportsDocumentFeatures(): boolean {
  return false;
}

export function shouldOpenSourceCodeLinkInNewTab(): boolean {
  return true;
}
