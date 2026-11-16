/**
 * What is dropped onto a Drive folder from outside the page: files, folders
 * with all that is in them, or a picture dragged from a web page. Added the
 * same way as with the Add buttons, and said in a short message.
 */
import { findGitignoreFile } from '@iris/hashtree-app/directory';
import { uploadDirectory, uploadFiles } from '../stores/upload';
import { markFilesChanged } from '../stores/recentlyChanged';
import { toast } from '../stores/toast';
import { draggedPictureUrl, droppedItems, freeName, pasteStamp } from './driveClipboard';

interface DropPlace {
  /** The open folder's path. */
  currentPath: string[];
  /** The names already in the open folder. */
  taken: ReadonlySet<string>;
  /** A folder of the open one that things were dropped onto, or null for the open one. */
  dirName: string | null;
}

/** Must be called during the drop: what it holds is taken before the first wait. */
export async function addDropped(data: DataTransfer, { currentPath, taken, dirName }: DropPlace): Promise<void> {
  const dropped = droppedItems(data);
  const files = Array.from(data.files ?? []);
  const pictureUrl = files.length === 0 && dropped.entries.length === 0 ? draggedPictureUrl(data) : null;
  const target = dirName ? { dirPath: [...currentPath, dirName] } : {};
  const where = dirName ? ` to ${dirName}` : '';

  if (dropped.hasFolder) {
    const { filesOfEntries } = await import('./driveClipboardData');
    const found = await filesOfEntries(dropped.entries);
    if (found.length === 0) {
      toast.info('Nothing to add: the folder is empty.');
      return;
    }
    const rootDirName = dropped.entries.find(entry => entry.isDirectory)?.name ?? null;
    await uploadDirectory({ files: found, hasGitignore: findGitignoreFile(found, rootDirName) !== null, gitignorePatterns: null, rootDirName }, { ...target, quiet: true });
    const folders = dropped.entries.filter(entry => entry.isDirectory).map(entry => entry.name);
    if (!dirName) markFilesChanged(new Set(folders));
    toast.success(`Added ${folders.length === 1 ? `the folder ${folders[0]}` : `${folders.length} folders`}${where}`);
  } else if (files.length > 0 || dropped.files.length > 0) {
    const added = files.length > 0 ? files : dropped.files;
    await uploadFiles(added, { ...target, quiet: !!dirName || added.length > 1 });
    // One file in the open folder is said by the upload itself.
    if (dirName || added.length > 1) toast.success(`Added ${added.length === 1 ? added[0]!.name : `${added.length} files`}${where}`);
  } else if (pictureUrl) {
    const { fetchPicture } = await import('./driveClipboardData');
    const picture = await fetchPicture(pictureUrl, (type, fromUrl) => {
      const ext = type.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
      const stem = fromUrl.replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 80);
      return freeName(`${stem || `Picture ${pasteStamp()}`}.${ext}`, taken);
    });
    if (!picture) {
      toast.error('That picture could not be saved. Save it to your computer first, then drop the file here.');
      return;
    }
    await uploadFiles([picture], target);
    if (dirName) toast.success(`Added ${picture.name}${where}`);
  } else {
    toast.info('Only files, folders and pictures can be dropped here.');
    return;
  }
  if (dirName) markFilesChanged(new Set([dirName]));
}
