/**
 * What Excel and PowerPoint files (.xlsx, .pptx) have in common: a zip of
 * XML parts, tied together by relationships listed in `.rels` parts.
 */
import { escapeXml } from './markup';

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** The namespace of relationships (the `r:` prefix), which also starts each relationship's type. */
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';

export interface Relationship {
  id: string;
  type: string;
  target: string;
  /** Points outside the file, such as a link to a web address. */
  external?: boolean;
}

/** A `.rels` part: what a part points to. */
export function relationshipsXml(rels: Relationship[]): string {
  return `${XML_HEAD}<Relationships xmlns="${NS_PACKAGE_RELS}">${rels.map(rel => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${escapeXml(rel.target)}"${rel.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
}

/** Where a relationship of a part points, as a path in the file. */
export function resolvePath(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}
