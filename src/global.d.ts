/**
 * Global type declarations for window properties
 * Used for HMR singleton patterns and test helpers
 */

import type { NostrStore } from './nostr';
import type { LocalStore } from './store';
import type { TreeEntry } from '@hashtree/core';

declare global {
  interface Window {
    // HMR singleton patterns
    __nostrStore?: NostrStore;

    // Test helpers
    __testHelpers?: {
      uploadSingleFile: unknown;
      followPubkey: unknown;
    };
    __testHelpersReady?: boolean;
    __localStore?: LocalStore;
    __settingsStore?: unknown;
    __thumbnailCaptureReset?: () => void;
    __testSetDirectoryEntries?: (entries: TreeEntry[]) => void;
    __reloadYjsEditors?: () => Promise<void>;

    // File System Access API (not in standard TS types)
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{
        description?: string;
        accept?: Record<string, string[]>;
      }>;
    }) => Promise<FileSystemFileHandle>;
  }
}

export {};
