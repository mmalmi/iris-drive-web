/**
 * A small PowerPoint file written by hand, the way PowerPoint lays one out:
 * a 4:3 slide whose title and body say almost nothing themselves and take
 * their place, size, colour and bullets from their layout and master; a band
 * on the master; a group holding a shape styled by the theme. Used by the
 * unit tests of the import and by the end-to-end ones.
 */
import { strToU8, zipSync } from 'fflate';

export function inheritedPptx(): Uint8Array {
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const rels = (items: Array<[string, string, string]>) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, to]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${to}"/>`).join('')}</Relationships>`;
  const ph = (type: string, idx?: string) => `<p:nvSpPr><p:cNvPr id="2" name="${type}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"${idx ? ` idx="${idx}"` : ''}/></p:nvPr></p:nvSpPr>`;
  const xfrm = (x: number, y: number, w: number, h: number) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
  // A 4:3 deck, so its slides sit in the middle of ours.
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId2', 'slide', 'slides/slide1.xml']]),
    'ppt/theme/theme1.xml': `<a:theme ${ns} name="Old"><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FAF6EE"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="B4532A"/></a:accent1></a:clrScheme><a:fontScheme name="x"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Garamond"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${ns}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg><p:spTree>`
      + `<p:sp>${ph('title')}<p:spPr>${xfrm(457200, 274638, 8229600, 1143000)}</p:spPr><p:txBody><a:bodyPr anchor="b"/><a:p/></p:txBody></p:sp>`
      + `<p:sp>${ph('body', '1')}<p:spPr>${xfrm(457200, 1600200, 8229600, 4525963)}</p:spPr><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`
      + `<p:sp><p:nvSpPr><p:cNvPr id="9" name="Band"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 6400800, 9144000, 457200)}<a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
      + '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/>'
      + '<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>'
      + '<p:bodyStyle><a:lvl1pPr><a:buChar char="•"/><a:defRPr sz="3200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr><a:lvl2pPr><a:buChar char="–"/><a:defRPr sz="2800"/></a:lvl2pPr></p:bodyStyle></p:txStyles></p:sldMaster>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'theme', '../theme/theme1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${ns}><p:cSld><p:spTree>`
      + `<p:sp>${ph('title')}<p:spPr>${xfrm(457200, 457200, 8229600, 914400)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr algn="l"/></a:lstStyle><a:p/></p:txBody></p:sp>`
      + `<p:sp>${ph('body', '1')}<p:spPr/><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`
      + '</p:spTree></p:cSld></p:sldLayout>',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slides/slide1.xml': `<p:sld ${ns}><p:cSld><p:spTree>`
      + `<p:sp>${ph('title')}<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-GB"/><a:t>Old house</a:t></a:r></a:p></p:txBody></p:sp>`
      + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Rooms</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Kitchen</a:t></a:r></a:p><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr sz="2000" i="1"/><a:t>Note</a:t></a:r></a:p></p:txBody></p:sp>`
      + `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="6000000" y="2000000"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm></p:grpSpPr>`
      + `<p:sp><p:nvSpPr><p:cNvPr id="6" name="Dot"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 0, 2000000, 2000000)}<a:prstGeom prst="ellipse"/></p:spPr><p:style><a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:r><a:t>Here</a:t></a:r></a:p></p:txBody></p:sp>`
      + '</p:grpSp>'
      + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));
}
