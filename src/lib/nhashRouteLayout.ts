export function shouldShowNhashFileBrowser(options: {
  isFullscreen: boolean;
  isViewingFile: boolean;
}): boolean {
  return !options.isFullscreen && !options.isViewingFile;
}
