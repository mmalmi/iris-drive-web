/**
 * A deck as a PowerPoint file (.pptx): Office Open XML, zipped with fflate.
 * Loaded only when someone asks for the file.
 *
 * What comes across: every slide with its background (a colour or a simple
 * gradient), text boxes with their paragraphs, lists, alignment, bold,
 * italic, underline, strikethrough, colours and sizes; shapes (rectangle,
 * rounded rectangle, ellipse) with fill, border and text; lines and arrows;
 * pictures, cropped as on the slide; tables with fills, borders and the
 * heading row; rotation; speaker notes; fade and slide-in transitions.
 * Colours and fonts of the theme are written out as they look, so the file
 * looks the same without our themes. Not carried over: points shown one at
 * a time, and text shrunk to fit (PowerPoint shrinks it again itself).
 */
import { strToU8, zipSync } from 'fflate';
import * as Y from 'yjs';
import { SLIDE_HEIGHT, SLIDE_WIDTH, type Slide, type SlideElement } from './model';
import { cellKey, cellPlace, edgeBorder, type CellBorder, type Side } from './table';
import { paletteFor, readableOn, resolveColour, textStyle, type Palette, type Theme } from './themes';
import { cssColour, validFontSize } from './richText';
import { escapeXml } from '../markup';

/** One slide unit in EMU: a 1280-unit slide is PowerPoint's 13.333-inch widescreen. */
const EMU = 9525;
const SLIDE_CX = SLIDE_WIDTH * EMU;
const SLIDE_CY = SLIDE_HEIGHT * EMU;
/** One slide unit in points (960 points across). */
const POINT = 0.75;

export interface PptxImage {
  bytes: Uint8Array;
  /** 'png', 'jpeg', 'gif', 'svg' or 'webp'. */
  ext: string;
  width?: number;
  height?: number;
}

export interface PptxOptions {
  slides: Slide[];
  theme: Theme;
  title: string;
  /** The bytes of an image attachment, or null when it cannot be had. */
  loadImage: (src: string) => Promise<PptxImage | null>;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function emu(value: number): number {
  return Math.round(value * EMU);
}

/** A hex colour without its #, for OOXML; null for anything else. */
function hex(colour: string | null | undefined): string | null {
  if (!colour) return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(colour.trim());
  if (!match) return null;
  const value = match[1]!;
  const full = value.length === 3 ? value.split('').map(c => c + c).join('') : value.slice(0, 6);
  return full.toUpperCase();
}

function solid(colour: string | null | undefined): string {
  const value = hex(colour);
  return value ? `<a:solidFill><a:srgbClr val="${value}"/></a:solidFill>` : '<a:noFill/>';
}

/** A CSS background as an OOXML fill: a colour, or a two-stop linear gradient. */
function backgroundFill(background: string): string {
  const gradient = /linear-gradient\(\s*(-?[\d.]+)deg\s*,\s*(#[0-9a-f]{3,8})[^,]*,\s*(#[0-9a-f]{3,8})/i.exec(background);
  if (gradient) {
    // CSS measures from the top, clockwise; DrawingML from the right, clockwise.
    const angle = ((Number(gradient[1]) - 90) % 360 + 360) % 360;
    return `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="${hex(gradient[2])}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${hex(gradient[3])}"/></a:gs></a:gsLst><a:lin ang="${Math.round(angle * 60000)}" scaled="0"/></a:gradFill>`;
  }
  return solid(background);
}

/** A font PowerPoint is likely to have, from one of our CSS font stacks. */
export function fontFor(stack: string): string {
  const names = stack.split(',').map(name => name.trim().replace(/^"|"$/g, ''));
  for (const known of ['Georgia', 'Palatino Linotype', 'Arial', 'Segoe UI', 'Helvetica Neue']) {
    if (names.includes(known)) return known;
  }
  return names.find(name => !/^(system-ui|-apple-system|ui-|sans-serif|serif)/.test(name)) ?? 'Arial';
}

interface TextLook {
  size: number;
  colour: string;
  bold: boolean;
  font: string;
  align: 'left' | 'center' | 'right';
}

const ALIGN = { left: 'l', center: 'ctr', right: 'r' } as const;

function runXml(text: string, attributes: Record<string, unknown>, look: TextLook): string {
  const size = validFontSize((attributes.fontSize as { size?: unknown } | undefined)?.size) ?? look.size;
  const colour = cssColour((attributes.color as { color?: unknown } | undefined)?.color);
  const fill = hex(colour?.startsWith('#') ? colour : null) ?? hex(look.colour);
  const on = (mark: string) => mark in attributes && attributes[mark] !== null && attributes[mark] !== false;
  const props = [
    'lang="en-US"',
    `sz="${Math.round(size * POINT * 100)}"`,
    on('bold') || look.bold ? 'b="1"' : '',
    on('italic') ? 'i="1"' : '',
    on('underline') ? 'u="sng"' : '',
    on('strike') ? 'strike="sngStrike"' : '',
    'dirty="0"',
  ].filter(Boolean).join(' ');
  return `<a:r><a:rPr ${props}>${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : ''}<a:latin typeface="${escapeXml(look.font)}"/></a:rPr><a:t>${escapeXml(text)}</a:t></a:r>`;
}

function themeColour(value: string | null, palette: Palette): string | null {
  // Theme colour names written inside text marks become the colours they stand for here.
  if (!value) return null;
  const named: Record<string, string> = { 'var(--slide-text)': palette.text, 'var(--slide-muted)': palette.muted, 'var(--slide-accent)': palette.accent, 'var(--slide-on-accent)': palette.onAccent };
  return named[value] ?? value;
}

function runsOf(paragraph: Y.XmlElement, look: TextLook, palette: Palette): string {
  let runs = '';
  for (const child of paragraph.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const part of child.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
        if (typeof part.insert !== 'string' || !part.insert) continue;
        const attributes = { ...(part.attributes ?? {}) };
        const colour = themeColour(cssColour((attributes.color as { color?: unknown } | undefined)?.color), palette);
        if (colour) attributes.color = { color: colour };
        runs += runXml(part.insert, attributes, look);
      }
    } else if (child instanceof Y.XmlElement && child.nodeName === 'hardBreak') {
      runs += '<a:br/>';
    }
  }
  return runs;
}

function paragraphXml(node: Y.XmlElement, look: TextLook, palette: Palette, list: { kind: 'bullet' | 'number'; level: number } | null): string {
  const own = node.getAttribute('textAlign');
  const align = own === 'left' || own === 'center' || own === 'right' ? own : look.align;
  const indent = list ? Math.round(look.size * 1.25 * EMU) : 0;
  const bullet = !list
    ? '<a:buNone/>'
    : list.kind === 'number'
      ? '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>'
      : `<a:buFont typeface="Arial"/><a:buChar char="${list.level % 2 ? '◦' : '•'}"/>`;
  const level = list ? ` lvl="${Math.min(8, list.level)}" marL="${indent * (list.level + 1)}" indent="-${indent}"` : ' marL="0" indent="0"';
  const runs = runsOf(node, look, palette);
  const end = `<a:endParaRPr lang="en-US" sz="${Math.round(look.size * POINT * 100)}" dirty="0"/>`;
  return `<a:p><a:pPr algn="${ALIGN[align]}"${level}>${bullet}</a:pPr>${runs}${end}</a:p>`;
}

/** The paragraphs of a text, lists flattened to paragraphs with bullets and levels. */
function paragraphsXml(fragment: Y.XmlFragment | null | undefined, look: TextLook, palette: Palette): string {
  let out = '';
  const visit = (node: Y.XmlFragment | Y.XmlElement, list: { kind: 'bullet' | 'number'; level: number } | null): void => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'paragraph') {
        out += paragraphXml(child, look, palette, list);
      } else if (child.nodeName === 'bulletList' || child.nodeName === 'orderedList') {
        visit(child, { kind: child.nodeName === 'orderedList' ? 'number' : 'bullet', level: list ? list.level + 1 : 0 });
      } else if (child.nodeName === 'listItem') {
        visit(child, list);
      }
    }
  };
  if (fragment) visit(fragment, null);
  return out || `<a:p><a:endParaRPr lang="en-US" sz="${Math.round(look.size * POINT * 100)}" dirty="0"/></a:p>`;
}

function bodyXml(fragment: Y.XmlFragment | null | undefined, look: TextLook, palette: Palette, options: { valign: 'top' | 'middle' | 'bottom'; inset: [number, number]; fit: 'shrink' | 'grow' }): string {
  const anchor = options.valign === 'middle' ? 'ctr' : options.valign === 'bottom' ? 'b' : 't';
  const [x, y] = options.inset;
  const fit = options.fit === 'shrink' ? '<a:normAutofit/>' : '<a:spAutoFit/>';
  return `<p:txBody><a:bodyPr wrap="square" lIns="${emu(x)}" tIns="${emu(y)}" rIns="${emu(x)}" bIns="${emu(y)}" anchor="${anchor}" rtlCol="0">${fit}</a:bodyPr><a:lstStyle/>${paragraphsXml(fragment, look, palette)}</p:txBody>`;
}

function xfrm(element: SlideElement, flip = ''): string {
  const rot = element.rot ? ` rot="${Math.round((((element.rot % 360) + 360) % 360) * 60000)}"` : '';
  return `<a:xfrm${rot}${flip}><a:off x="${emu(element.x)}" y="${emu(element.y)}"/><a:ext cx="${emu(Math.max(1, element.w))}" cy="${emu(Math.max(1, element.h))}"/></a:xfrm>`;
}

function lookOf(element: SlideElement, theme: Theme, layout: string): TextLook {
  const style = textStyle(element, theme, layout);
  return { size: style.fontSize, colour: style.color, bold: style.fontWeight >= 600, font: fontFor(style.fontFamily), align: style.align };
}

interface Writer {
  id: number;
  /** Adds a relationship from the slide and returns its id. */
  rel: (type: string, target: string) => string;
}

function textShape(element: SlideElement, theme: Theme, layout: string, palette: Palette, writer: Writer): string {
  const style = textStyle(element, theme, layout);
  const look = lookOf(element, theme, layout);
  const id = writer.id++;
  const name = element.role ? `${element.role[0]!.toUpperCase()}${element.role.slice(1)} ${id}` : `Text ${id}`;
  const body = bodyXml(element.content, look, palette, { valign: style.valign, inset: [12, 8], fit: element.role ? 'shrink' : 'grow' });
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>${body}</p:sp>`;
}

function shapeXml(element: SlideElement, theme: Theme, layout: string, palette: Palette, writer: Writer): string {
  const style = textStyle(element, theme, layout);
  const look = lookOf(element, theme, layout);
  const id = writer.id++;
  const fill = resolveColour(element.fill, palette, palette.accent);
  const stroke = resolveColour(element.stroke, palette, null);
  const geometry = element.shape === 'ellipse' ? 'ellipse' : element.shape === 'round' ? 'roundRect' : 'rect';
  const adjust = element.shape === 'round'
    ? `<a:avLst><a:gd name="adj" fmla="val ${Math.round(Math.min(28, Math.min(element.w, element.h) / 4) / Math.min(element.w, element.h) * 100000)}"/></a:avLst>`
    : '<a:avLst/>';
  const line = stroke ? `<a:ln w="${emu(element.strokeWidth ?? 3)}">${solid(stroke)}</a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const inset: [number, number] = element.shape === 'ellipse' ? [element.w * 0.146, element.h * 0.146] : [12, 8];
  const body = bodyXml(element.content, look, palette, { valign: style.valign, inset, fit: 'shrink' });
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(element)}<a:prstGeom prst="${geometry}">${adjust}</a:prstGeom>${solid(fill)}${line}</p:spPr>${body}</p:sp>`;
}

function lineXml(element: SlideElement, palette: Palette, writer: Writer): string {
  const id = writer.id++;
  const stroke = hex(resolveColour(element.stroke, palette, palette.text)) ?? '000000';
  // A line's frame is a vector; OOXML keeps a box and flips it.
  const box = { ...element, x: Math.min(element.x, element.x + element.w), y: Math.min(element.y, element.y + element.h), w: Math.abs(element.w), h: Math.abs(element.h) };
  const flip = `${element.w < 0 ? ' flipH="1"' : ''}${element.h < 0 ? ' flipV="1"' : ''}`;
  const arrow = element.arrow ? '<a:tailEnd type="triangle" w="med" len="med"/>' : '';
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Line ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(box, flip)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${emu(element.strokeWidth ?? 4)}" cap="rnd"><a:solidFill><a:srgbClr val="${stroke}"/></a:solidFill>${arrow}</a:ln></p:spPr></p:cxnSp>`;
}

function pictureXml(element: SlideElement, image: PptxImage, target: string, writer: Writer): string {
  const id = writer.id++;
  const rel = writer.rel(`${REL}/image`, target);
  // Pictures fill their frame and are cropped to it, as on the slide: as they were cropped, or else to fill it.
  let crop = '';
  if (element.crop) {
    const [l, t, r, b] = element.crop.map(share => Math.round(share * 100000));
    crop = `<a:srcRect l="${l}" t="${t}" r="${r}" b="${b}"/>`;
  } else if (image.width && image.height && element.w > 0 && element.h > 0) {
    const frame = element.w / element.h;
    const picture = image.width / image.height;
    if (picture > frame) {
      const cut = Math.round((1 - frame / picture) / 2 * 100000);
      crop = `<a:srcRect l="${cut}" r="${cut}"/>`;
    } else if (picture < frame) {
      const cut = Math.round((1 - picture / frame) / 2 * 100000);
      crop = `<a:srcRect t="${cut}" b="${cut}"/>`;
    }
  }
  const alt = element.alt ? ` descr="${escapeXml(element.alt)}"` : '';
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"${alt}/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rel}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function tableXml(element: SlideElement, theme: Theme, layout: string, palette: Palette, writer: Writer): string {
  const table = element.table!;
  const id = writer.id++;
  const look = lookOf(element, theme, layout);
  const style = textStyle(element, theme, layout);
  const line = resolveColour(element.stroke, palette, palette.muted);
  const fallback: CellBorder | null = line ? { width: element.strokeWidth ?? 1.5, colour: line } : null;
  const lineXmlFor = (tag: string, border: CellBorder | null) => border
    ? `<a:${tag} w="${emu(border.width)}"><a:solidFill><a:srgbClr val="${hex(resolveColour(border.colour, palette, line)) ?? '888888'}"/></a:solidFill></a:${tag}>`
    : `<a:${tag}><a:noFill/></a:${tag}>`;
  const keyAt = (r: number, c: number) => (table.rows[r] && table.cols[c] ? cellKey(table.rows[r]!.id, table.cols[c]!.id) : null);
  /** The line along one side of a cell, as the slide draws it. */
  const sideOf = (r: number, c: number, side: Side) => {
    const [other, otherSide]: [string | null, Side] = side === 't' ? [keyAt(r - 1, c), 'b'] : side === 'b' ? [keyAt(r + 1, c), 't'] : side === 'l' ? [keyAt(r, c - 1), 'r'] : [keyAt(r, c + 1), 'l'];
    return edgeBorder(table, keyAt(r, c), side, other, otherSide, fallback);
  };
  const colTotal = table.cols.reduce((sum, col) => sum + col.size, 0);
  const rowTotal = table.rows.reduce((sum, row) => sum + row.size, 0);
  const grid = table.cols.map(col => `<a:gridCol w="${emu(element.w * col.size / colTotal)}"/>`).join('');
  const anchor = style.valign === 'middle' ? 'ctr' : style.valign === 'bottom' ? 'b' : 't';
  const rows = table.rows.map((row, index) => {
    const header = index === 0 && !!element.header;
    const cells = table.cols.map((col, colIndex) => {
      const key = cellKey(row.id, col.id);
      const cell = table.cells.get(key);
      // A merged block is written PowerPoint's way: its first cell spans, the rest say they are merged into it.
      const block = table.merges.get(key);
      const owner = table.covered.get(key);
      const ownerPlace = owner ? cellPlace(table, owner) : null;
      const merge = block
        ? `${block.cols > 1 ? ` gridSpan="${block.cols}"` : ''}${block.rows > 1 ? ` rowSpan="${block.rows}"` : ''}`
        : ownerPlace
          ? `${ownerPlace.col !== colIndex ? ' hMerge="1"' : ''}${ownerPlace.row !== index ? ' vMerge="1"' : ''}`
          : '';
      const own = resolveColour(cell?.fill, palette);
      const fill = own ?? (header ? palette.accent : null);
      const colour = fill ? (!own && header ? palette.onAccent : element.color ? style.color : readableOn(fill, palette)) : style.color;
      const cellLook = { ...look, colour, bold: header || look.bold };
      const body = `<a:txBody><a:bodyPr/><a:lstStyle/>${paragraphsXml(cell?.content, cellLook, palette)}</a:txBody>`;
      const props = `<a:tcPr marL="${emu(12)}" marR="${emu(12)}" marT="${emu(6)}" marB="${emu(6)}" anchor="${anchor}">${lineXmlFor('lnL', sideOf(index, colIndex, 'l'))}${lineXmlFor('lnR', sideOf(index, colIndex, 'r'))}${lineXmlFor('lnT', sideOf(index, colIndex, 't'))}${lineXmlFor('lnB', sideOf(index, colIndex, 'b'))}${fill ? solid(fill) : '<a:noFill/>'}</a:tcPr>`;
      return `<a:tc${merge}>${body}${props}</a:tc>`;
    }).join('');
    return `<a:tr h="${emu(element.h * row.size / rowTotal)}">${cells}</a:tr>`;
  }).join('');
  const rot = element.rot ? ` rot="${Math.round(element.rot * 60000)}"` : '';
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm${rot}><a:off x="${emu(element.x)}" y="${emu(element.y)}"/><a:ext cx="${emu(element.w)}" cy="${emu(element.h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="${element.header ? 1 : 0}" bandRow="0"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function transitionXml(slide: Slide): string {
  if (slide.transition === 'fade') return '<p:transition spd="med"><p:fade/></p:transition>';
  if (slide.transition === 'slide') return '<p:transition spd="med"><p:push dir="l"/></p:transition>';
  return '';
}

function relsXml(rels: Array<{ id: string; type: string; target: string }>): string {
  return `${XML_HEAD}<Relationships xmlns="${PKG_REL}">${rels.map(rel => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${escapeXml(rel.target)}"/>`).join('')}</Relationships>`;
}

function notesXml(slideIndex: number, text: string): string {
  const paragraphs = text.split('\n').map(line => (line ? `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>` : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>')).join('');
  return `${XML_HEAD}<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`
    + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image ${slideIndex}"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes ${slideIndex}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
}

const CLR_MAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

function themeXml(theme: Theme, name: string): string {
  const base = theme.base;
  const scheme = (tag: string, colour: string) => `<a:${tag}><a:srgbClr val="${hex(colour) ?? '000000'}"/></a:${tag}>`;
  const font = escapeXml(fontFor(theme.bodyFont));
  const titleFont = escapeXml(fontFor(theme.titleFont));
  const fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return `${XML_HEAD}<a:theme xmlns:a="${NS_A}" name="${escapeXml(name)}"><a:themeElements><a:clrScheme name="${escapeXml(theme.name)}">`
    + scheme('dk1', base.text) + scheme('lt1', hex(base.background) ? base.background : '#ffffff') + scheme('dk2', base.muted) + scheme('lt2', '#eeeeee')
    + scheme('accent1', base.accent) + scheme('accent2', '#2f9e44') + scheme('accent3', '#f08c00') + scheme('accent4', '#1c7ed6') + scheme('accent5', '#c2255c') + scheme('accent6', '#0ca678')
    + scheme('hlink', base.accent) + scheme('folHlink', base.muted)
    + `</a:clrScheme><a:fontScheme name="${escapeXml(theme.name)}"><a:majorFont><a:latin typeface="${titleFont}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="${escapeXml(theme.name)}"><a:fillStyleLst>${fills}${fills}${fills}</a:fillStyleLst>`
    + '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
    + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    + `<a:bgFillStyleLst>${fills}${fills}${fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

function emptyTree(): string {
  return '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';
}

const MASTER = `${XML_HEAD}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${emptyTree()}</p:cSld><p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
const LAYOUT = `${XML_HEAD}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank">${emptyTree()}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const NOTES_MASTER = `${XML_HEAD}<p:notesMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${emptyTree()}</p:cSld><p:clrMap ${CLR_MAP}/></p:notesMaster>`;

/** Builds the file. Images that cannot be loaded are left out. */
export async function deckToPptx(options: PptxOptions): Promise<Uint8Array> {
  const { slides, theme } = options;
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string) => (files[path] = strToU8(text));
  const media = new Map<string, { path: string; image: PptxImage } | null>();
  const types = new Set<string>();

  // Every picture once, however often it is used.
  for (const slide of slides) {
    for (const element of slide.elements) {
      if (element.type !== 'image' || !element.src || media.has(element.src)) continue;
      const image = await options.loadImage(element.src).catch(() => null);
      if (!image) {
        media.set(element.src, null);
        continue;
      }
      const ext = image.ext === 'jpg' ? 'jpeg' : image.ext;
      const path = `ppt/media/image${media.size + 1}.${ext}`;
      files[path] = image.bytes;
      types.add(ext);
      media.set(element.src, { path, image });
    }
  }

  const slideRefs: string[] = [];
  slides.forEach((slide, index) => {
    const number = index + 1;
    const palette = paletteFor(theme, slide.layout);
    const background = resolveColour(slide.background, palette) ?? palette.background;
    const rels: Array<{ id: string; type: string; target: string }> = [{ id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' }];
    const writer: Writer = {
      id: 2,
      rel: (type, target) => {
        const id = `rId${rels.length + 1}`;
        rels.push({ id, type, target });
        return id;
      },
    };
    let shapes = '';
    for (const element of slide.elements) {
      if (element.type === 'text') shapes += textShape(element, theme, slide.layout, palette, writer);
      else if (element.type === 'shape') shapes += shapeXml(element, theme, slide.layout, palette, writer);
      else if (element.type === 'line') shapes += lineXml(element, palette, writer);
      else if (element.type === 'table' && element.table) shapes += tableXml(element, theme, slide.layout, palette, writer);
      else if (element.type === 'image' && element.src) {
        const found = media.get(element.src);
        if (found) shapes += pictureXml(element, found.image, `../media/${found.path.split('/').pop()}`, writer);
      }
    }
    const notes = slide.notes?.toString() ?? '';
    if (notes.trim()) {
      writer.rel(`${REL}/notesSlide`, `../notesSlides/notesSlide${number}.xml`);
      put(`ppt/notesSlides/notesSlide${number}.xml`, notesXml(number, notes));
      put(`ppt/notesSlides/_rels/notesSlide${number}.xml.rels`, relsXml([
        { id: 'rId1', type: `${REL}/notesMaster`, target: '../notesMasters/notesMaster1.xml' },
        { id: 'rId2', type: `${REL}/slide`, target: `../slides/slide${number}.xml` },
      ]));
    }
    const tree = emptyTree().replace('</p:spTree>', `${shapes}</p:spTree>`);
    put(`ppt/slides/slide${number}.xml`, `${XML_HEAD}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgPr>${backgroundFill(background)}<a:effectLst/></p:bgPr></p:bg>${tree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(slide)}</p:sld>`);
    put(`ppt/slides/_rels/slide${number}.xml.rels`, relsXml(rels));
    slideRefs.push(`ppt/slides/slide${number}.xml`);
  });

  const hasNotes = Object.keys(files).some(path => path.startsWith('ppt/notesSlides/'));
  const presentationRels = [
    { id: 'rId1', type: `${REL}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: `${REL}/theme`, target: 'theme/theme1.xml' },
    { id: 'rId3', type: `${REL}/presProps`, target: 'presProps.xml' },
    { id: 'rId4', type: `${REL}/viewProps`, target: 'viewProps.xml' },
    { id: 'rId5', type: `${REL}/tableStyles`, target: 'tableStyles.xml' },
    ...(hasNotes ? [{ id: 'rId6', type: `${REL}/notesMaster`, target: 'notesMasters/notesMaster1.xml' }] : []),
    ...slides.map((_slide, index) => ({ id: `rId${index + 10}`, type: `${REL}/slide`, target: `slides/slide${index + 1}.xml` })),
  ];
  const slideIds = slides.map((_slide, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 10}"/>`).join('');
  put('ppt/presentation.xml', `${XML_HEAD}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst>' : ''}<p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr lang="en-US"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`);
  put('ppt/_rels/presentation.xml.rels', relsXml(presentationRels));
  put('ppt/presProps.xml', `${XML_HEAD}<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>`);
  put('ppt/viewProps.xml', `${XML_HEAD}<p:viewPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  put('ppt/tableStyles.xml', `${XML_HEAD}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  put('ppt/slideMasters/slideMaster1.xml', MASTER);
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml([
    { id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: `${REL}/theme`, target: '../theme/theme1.xml' },
  ]));
  put('ppt/slideLayouts/slideLayout1.xml', LAYOUT);
  put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([{ id: 'rId1', type: `${REL}/slideMaster`, target: '../slideMasters/slideMaster1.xml' }]));
  put('ppt/theme/theme1.xml', themeXml(theme, 'Deck'));
  if (hasNotes) {
    put('ppt/notesMasters/notesMaster1.xml', NOTES_MASTER);
    put('ppt/notesMasters/_rels/notesMaster1.xml.rels', relsXml([{ id: 'rId1', type: `${REL}/theme`, target: '../theme/theme2.xml' }]));
    put('ppt/theme/theme2.xml', themeXml(theme, 'Notes'));
  }
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  put('docProps/core.xml', `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(options.title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  put('docProps/app.xml', `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Iris Drive</Application><Slides>${slides.length}</Slides></Properties>`);
  put('_rels/.rels', relsXml([
    { id: 'rId1', type: `${REL}/officeDocument`, target: 'ppt/presentation.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: `${REL}/extended-properties`, target: 'docProps/app.xml' },
  ]));

  const overrides = [
    ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
    ['/ppt/presProps.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml'],
    ['/ppt/viewProps.xml', 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml'],
    ['/ppt/tableStyles.xml', 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml'],
    ['/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],
    ['/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],
    ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
    ...slideRefs.map(path => [`/${path}`, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml']),
    ...Object.keys(files).filter(path => path.startsWith('ppt/notesSlides/notesSlide')).map(path => [`/${path}`, 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml']),
    ...(hasNotes ? [
      ['/ppt/notesMasters/notesMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml'],
      ['/ppt/theme/theme2.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ] : []),
  ];
  const mediaTypes: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
  put('[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...types].map(ext => `<Default Extension="${ext}" ContentType="${mediaTypes[ext] ?? 'application/octet-stream'}"/>`).join('')}${overrides.map(([path, type]) => `<Override PartName="${path}" ContentType="${type}"/>`).join('')}</Types>`);

  // [Content_Types].xml goes first, as some readers expect.
  const ordered: Record<string, Uint8Array> = { '[Content_Types].xml': files['[Content_Types].xml']! };
  for (const [path, bytes] of Object.entries(files)) if (path !== '[Content_Types].xml') ordered[path] = bytes;
  return zipSync(ordered, { level: 6 });
}

/** What kind of picture some bytes are, from their first bytes. */
export function imageKind(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'webp';
  const head = new TextDecoder().decode(bytes.slice(0, 256));
  return /<svg[\s>]/i.test(head) ? 'svg' : null;
}

async function pictureSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** Makes the file of a deck and hands it to the browser to save. */
export async function downloadPptx(options: { slides: Slide[]; theme: Theme; title: string; urls: Map<string, string> }): Promise<void> {
  const bytes = await deckToPptx({
    slides: options.slides,
    theme: options.theme,
    title: options.title,
    loadImage: async (src) => {
      const url = options.urls.get(src);
      if (!url) return null;
      const blob = await (await fetch(url)).blob();
      const data = new Uint8Array(await blob.arrayBuffer());
      const ext = imageKind(data);
      if (!ext) return null;
      return { bytes: data, ext, ...(await pictureSize(blob)) };
    },
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
  link.download = `${options.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Presentation'}.pptx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}
