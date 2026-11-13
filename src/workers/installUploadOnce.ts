// Imported before the worker itself so its file-server uploads go through this.
import { browserConfirmedUploadStorage, ConfirmedUploads, uploadOnceFetch } from './uploadOnce';

const storage = typeof indexedDB === 'undefined' ? null : browserConfirmedUploadStorage;
globalThis.fetch = uploadOnceFetch(globalThis.fetch.bind(globalThis), new ConfirmedUploads(storage));
