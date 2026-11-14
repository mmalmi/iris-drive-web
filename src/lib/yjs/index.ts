// The tiptap editor setup is imported from './tiptapEditor' directly: exported
// here, it would pull the whole text editor into spreadsheets too.
export {
  ATTACHMENTS_DIRECTORY,
  ATTACHMENT_SCHEME,
  attachmentFilename,
  generateImageFilename,
} from './imageAttachments';
export { documentWriteScope } from './routeScope';
export {
  DocumentSession,
  STORED_ORIGIN,
  LIVE_ORIGIN,
  type DocumentChange,
} from './documentStore';
export { connectDocumentTabs } from './tabSync';
export { DriveDocument, type SaveStatus } from './driveDocument.svelte';
export { TAB_ORIGIN } from './tabSync';
