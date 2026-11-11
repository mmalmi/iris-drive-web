// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import * as Y from 'yjs';
import { createYjsTiptapEditor } from '../src/lib/yjs/tiptapEditor';

test('rich text survives a saved Yjs document reopening with collaboration enabled', () => {
  const original = new Y.Doc();
  const restored = new Y.Doc();
  const elements = [document.createElement('div'), document.createElement('div')];
  elements.forEach(element => document.body.append(element));
  let localUpdates = 0;
  original.on('update', () => { localUpdates += 1; });
  const setup = (ydoc: Y.Doc, element: HTMLElement) => createYjsTiptapEditor({
    element, ydoc, canEdit: true,
    handleImageUpload: () => {},
    resolveImageSrc: () => {},
    onCommentsState: () => {},
  });
  const first = setup(original, elements[0]!);
  let second: ReturnType<typeof setup> | undefined;
  try {
    first.editor.commands.setContent('<h2>Trip notes</h2><p>Bring <strong>sandwiches</strong>.</p>');
    expect(localUpdates).toBeGreaterThan(0);
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(original));
    second = setup(restored, elements[1]!);
    expect(second.editor.getHTML()).toBe(first.editor.getHTML());
    expect(second.editor.getHTML()).toContain('<strong>sandwiches</strong>');
    expect(second.editor.extensionManager.extensions.filter(extension => extension.name === 'undoRedo')).toHaveLength(0);
    expect(second.editor.extensionManager.extensions.some(extension => extension.name === 'collaboration')).toBe(true);
  } finally {
    second?.editor.destroy();
    first.editor.destroy();
    original.destroy();
    restored.destroy();
    elements.forEach(element => element.remove());
  }
});
