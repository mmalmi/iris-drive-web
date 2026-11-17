import { all, kid, kids } from './pptxRead';

/** Only immediate effects on the main click sequence can be played faithfully. */
function startsWithClick(effect: Element, group: Element): boolean {
  for (let node: Element | null = effect; node && node !== group; node = node.parentElement) {
    if (node.localName !== 'cTn') continue;
    for (const start of kids(kid(node, 'stCondLst'), 'cond')) {
      const delay = start.getAttribute('delay') ?? '0';
      if (start.hasAttribute('evt') || (delay !== '0' && !(node.parentElement === group && delay === 'indefinite'))) return false;
    }
  }
  return true;
}

/** The main sequence's on-click Appear effects, keyed by the source shape or group id. */
export function readAppearances(timing: Element | null): { targets: Map<string, number>; incomplete: boolean } {
  const targets = new Map<string, number>();
  if (!timing) return { targets, incomplete: false };
  const main = all(timing, 'cTn').find(node => node.getAttribute('nodeType') === 'mainSeq');
  const handled = new Set<Element>();
  for (const [index, group] of kids(kid(main, 'childTnLst')).entries()) {
    const start = kid(group, 'cTn', 'stCondLst', 'cond');
    if (start?.getAttribute('delay') !== 'indefinite') continue;
    for (const effect of all(group, 'cTn')) {
      if (effect.getAttribute('presetClass') !== 'entr' || effect.getAttribute('presetID') !== '1') continue;
      if (!['clickEffect', 'withEffect'].includes(effect.getAttribute('nodeType') ?? '')) continue;
      if (!startsWithClick(effect, group)) continue;
      for (const set of kids(kid(effect, 'childTnLst'), 'set')) {
        const target = kid(set, 'cBhvr', 'tgtEl', 'spTgt');
        const id = target?.getAttribute('spid');
        if (!target || !id || target.children.length || targets.has(id)) continue;
        if (kid(set, 'cBhvr', 'attrNameLst', 'attrName')?.textContent !== 'style.visibility') continue;
        if (kid(set, 'to', 'strVal')?.getAttribute('val') !== 'visible') continue;
        targets.set(id, index + 1);
        handled.add(target);
      }
    }
  }
  const incomplete = all(timing, 'spTgt').some(target => !handled.has(target))
    || all(timing, 'audio').length > 0 || all(timing, 'video').length > 0;
  return { targets, incomplete };
}

/** Standard on-click visibility changes. Each inner list appears together on one click. */
export function appearanceTiming(groups: Map<number, number[]>): string {
  if (!groups.size) return '';
  let id = 2;
  const start = (delay: string) => `<p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>`;
  const par = (attrs: string, delay: string, children: string) =>
    `<p:par><p:cTn id="${++id}" fill="hold"${attrs}>${start(delay)}<p:childTnLst>${children}</p:childTnLst></p:cTn></p:par>`;
  const groupsXml = [...groups.entries()].sort(([a], [b]) => a - b).map(([, shapes]) => {
    const effects = shapes.map((shape, index) => {
      const behavior = `<p:cBhvr><p:cTn id="${++id}" dur="1" fill="hold">${start('0')}</p:cTn>`
        + `<p:tgtEl><p:spTgt spid="${shape}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>`;
      return par(` presetID="1" presetClass="entr" presetSubtype="0" nodeType="${index ? 'withEffect' : 'clickEffect'}"`,
        '0', `<p:set>${behavior}<p:to><p:strVal val="visible"/></p:to></p:set>`);
    }).join('');
    return par('', 'indefinite', par('', '0', effects));
  }).join('');
  const nav = (name: 'prev' | 'next', event: string) =>
    `<p:${name}CondLst><p:cond evt="${event}" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:${name}CondLst>`;
  return '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
    + `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${groupsXml}</p:childTnLst></p:cTn>`
    + nav('prev', 'onPrev') + nav('next', 'onNext') + '</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>';
}
