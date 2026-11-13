/**
 * The rich text of a text box, shape or table cell as stored: a Y.XmlFragment
 * of paragraphs and lists, as tiptap writes it. Reading it as plain text,
 * and copying it to and from plain data for the clipboard.
 */
import * as Y from 'yjs';

/** Rich text as plain data, for the clipboard. */
export type RichTextJson = Array<
  | { name: string; attrs: Record<string, unknown>; children: RichTextJson }
  | { text: Array<{ insert: string; attributes?: Record<string, unknown> }> }
>;

/** The plain text of a text box, one line per paragraph. */
export function richTextToPlain(fragment: Y.XmlFragment | undefined | null): string {
  if (!fragment) return '';
  const lines: string[] = [];
  const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
    let line = '';
    let hasText = false;
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) {
        hasText = true;
        for (const part of child.toDelta() as Array<{ insert: unknown }>) {
          if (typeof part.insert === 'string') line += part.insert;
        }
      } else if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'hardBreak') {
          hasText = true;
          line += '\n';
        } else {
          visit(child);
        }
      }
    }
    if (hasText || (node instanceof Y.XmlElement && node.nodeName === 'paragraph' && node.length === 0)) lines.push(line);
  };
  visit(fragment);
  return lines.join('\n');
}

export function richTextIsEmpty(fragment: Y.XmlFragment | undefined | null): boolean {
  return richTextToPlain(fragment).trim() === '';
}

/** Paragraph nodes for plain text, one per line. */
export function paragraphsFromText(value: string): Y.XmlElement[] {
  return value.split('\n').map((line) => {
    const paragraph = new Y.XmlElement('paragraph');
    if (line) {
      const node = new Y.XmlText();
      node.insert(0, line);
      paragraph.insert(0, [node]);
    }
    return paragraph;
  });
}

export function richTextToJson(fragment: Y.XmlFragment | Y.XmlElement | undefined | null): RichTextJson {
  if (!fragment) return [];
  const result: RichTextJson = [];
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlText) {
      const delta = (child.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>)
        .filter(part => typeof part.insert === 'string')
        .map(part => part.attributes ? { insert: part.insert as string, attributes: part.attributes } : { insert: part.insert as string });
      result.push({ text: delta });
    } else if (child instanceof Y.XmlElement) {
      result.push({ name: child.nodeName, attrs: child.getAttributes() as Record<string, unknown>, children: richTextToJson(child) });
    }
  }
  return result;
}

/** Nodes for rich text given as plain data; anything that is not rich text is left out. */
export function richTextNodesFromJson(json: unknown, depth = 0): Array<Y.XmlElement | Y.XmlText> {
  if (!Array.isArray(json) || depth > 12) return [];
  const nodes: Array<Y.XmlElement | Y.XmlText> = [];
  for (const item of json as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.text)) {
      const node = new Y.XmlText();
      const delta = (item.text as Array<Record<string, unknown>>)
        .filter(part => part && typeof part.insert === 'string')
        .map(part => part.attributes && typeof part.attributes === 'object'
          ? { insert: part.insert as string, attributes: part.attributes as Record<string, unknown> }
          : { insert: part.insert as string });
      node.applyDelta(delta);
      nodes.push(node);
    } else if (typeof item.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(item.name)) {
      const node = new Y.XmlElement(item.name);
      if (item.attrs && typeof item.attrs === 'object') {
        for (const [key, value] of Object.entries(item.attrs as Record<string, unknown>)) {
          if (value !== undefined && value !== null) node.setAttribute(key, value as string);
        }
      }
      const children = richTextNodesFromJson(item.children, depth + 1);
      if (children.length) node.insert(0, children);
      nodes.push(node);
    }
  }
  return nodes;
}

/** Calls `visit` with every run of text in a fragment. */
export function eachText(fragment: Y.XmlFragment, visit: (text: Y.XmlText) => void): void {
  const walk = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) visit(child);
      else if (child instanceof Y.XmlElement) walk(child);
    }
  };
  walk(fragment);
}
