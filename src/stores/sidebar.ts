import { writable } from 'svelte/store';

/**
 * The sidebar as last chosen on this device: in full, or as a rail of icons.
 * Null until someone chooses; then the window's width decides.
 */
export type SidebarChoice = 'full' | 'rail';

const KEY = 'iris-drive.sidebar';

function stored(): SidebarChoice | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'full' || value === 'rail' ? value : null;
  } catch {
    return null;
  }
}

export const sidebarChoice = writable<SidebarChoice | null>(stored());

export function chooseSidebar(choice: SidebarChoice): void {
  sidebarChoice.set(choice);
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Without storage the choice lasts until the page closes.
  }
}
