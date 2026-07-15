import type { Snippet } from 'svelte';

export type MutationResult = string | null | void | Promise<string | null | void>;

export interface AccessSection {
  id: string;
  label: string;
  memberLabel: string;
  npubs: string[];
  emptyText?: string;
  removeTitle?: string;
}

export interface RequestAccessOptions {
  text: string;
  visible?: boolean;
  shareHref?: (userNpub: string) => string | null;
  shareTitle?: string;
  copyText?: string;
  displayText?: string;
}

export interface NpubAccessModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  intro: string;
  sections: AccessSection[];
  canEdit?: boolean;
  onAdd?: (npub: string, sectionId: string) => MutationResult;
  onRemove?: (sectionId: string, npub: string) => MutationResult;
  validateAdd?: (npub: string, sectionId: string) => string | null;
  initialSectionId?: string;
  addPromptLabel?: string;
  sectionSelectLabel?: string;
  addButtonLabel?: string;
  searchPlaceholder?: string;
  requestAccess?: RequestAccessOptions | null;
  beforeSections?: Snippet;
  panelClass?: string;
  sectionsClass?: string;
}
