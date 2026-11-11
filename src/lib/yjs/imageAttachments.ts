/** Images of a document are files in its `attachments` folder, each written once. */
export const ATTACHMENTS_DIRECTORY = 'attachments';
/** Image sources in the document name the attachment, not where the Drive serves it. */
export const ATTACHMENT_SCHEME = 'attachments:';

/** A name no other device or tab will pick for a different image. */
export function generateImageFilename(file: File): string {
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'png';
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}.${extension.replace(/[^a-z0-9]/g, '') || 'png'}`;
}

/** The attachment a stored image source names, without any folder parts. */
export function attachmentFilename(source: string | null): string | null {
  if (!source?.startsWith(ATTACHMENT_SCHEME)) return null;
  const filename = source.slice(ATTACHMENT_SCHEME.length).split('/').pop() ?? '';
  return filename && filename !== '.' && filename !== '..' ? filename : null;
}
