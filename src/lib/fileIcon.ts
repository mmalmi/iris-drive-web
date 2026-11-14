// @unocss-include: the library names these icons, and UnoCSS does not read it:
// i-lucide-image i-lucide-video i-lucide-music i-lucide-file-code i-lucide-file-json
// i-lucide-file-text i-lucide-file-spreadsheet i-lucide-presentation i-lucide-file-archive i-lucide-file
import { getFileIcon } from '@iris/hashtree-app/fileIcon';

/**
 * A file's icon class from its name. The library names one icon that Lucide
 * does not have, so presentations showed none.
 */
export function fileIcon(name: string): string {
  const icon = getFileIcon(name);
  return icon === 'i-lucide-file-presentation' ? 'i-lucide-presentation' : icon;
}
