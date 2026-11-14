// Imported before the worker itself so its file-server uploads go through this.
import { browserConfirmedUploadStorage, ConfirmedUploads, uploadOnceFetch } from './uploadOnce';

const storage = typeof indexedDB === 'undefined' ? null : browserConfirmedUploadStorage;
/** Blocks each file server confirmed lately; backups ask a server only about the others. */
export const confirmedUploads = new ConfirmedUploads(storage);
globalThis.fetch = uploadOnceFetch(globalThis.fetch.bind(globalThis), confirmedUploads);
