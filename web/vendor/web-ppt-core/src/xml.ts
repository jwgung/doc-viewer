import { parseXmlLite } from './xml-lite';

/**
 * 命名空间无关的 XML 访问工具。
 * OOXML 的前缀（p:/a:/r:）在不同生成器里不稳定，一律按 localName 匹配。
 */

// doc-viewer 패치: 브라우저에서도 늘 자체 최소 파서(xml-lite)를 쓴다. Android WebView의 DOMParser는
// 슬라이드가 많은 pptx에서 열 때 대부분의 시간을 썼다(28장 2MB 파일에서 DOMParser 0.78초, xml-lite 전체 해석 0.05초).
// 두 파서의 결과 구조는 같다(아래 멤버만 쓰며 LiteElement가 모두 구현한다).
export function parseXml(text: string): Element {
  // 只用到 localName / firstElementChild / nextElementSibling / children /
  // attributes / getAttribute / textContent / getElementsByTagName 这几个成员，
  // LiteElement 全部实现，因此这里的断言是安全的。
  return parseXmlLite(text) as unknown as Element;
}

export function kids(el: Element | null, name: string): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let n = el.firstElementChild; n; n = n.nextElementSibling) {
    if (n.localName === name) out.push(n);
  }
  return out;
}

export function kid(el: Element | null, name: string): Element | null {
  if (!el) return null;
  for (let n = el.firstElementChild; n; n = n.nextElementSibling) {
    if (n.localName === name) return n;
  }
  return null;
}

export function walk(el: Element | null, ...path: string[]): Element | null {
  let cur = el;
  for (const name of path) {
    cur = kid(cur, name);
    if (!cur) return null;
  }
  return cur;
}

export function attr(el: Element | null, name: string): string | null {
  if (!el) return null;
  if (name.includes(':')) {
    for (const a of Array.from(el.attributes)) if (a.name === name) return a.value;
    const local = name.split(':')[1];
    for (const a of Array.from(el.attributes)) if (a.localName === local) return a.value;
    return null;
  }
  const v = el.getAttribute(name);
  if (v !== null) return v;
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
}

export function numAttr(el: Element | null, name: string): number | null {
  const v = attr(el, name);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function boolAttr(el: Element | null, name: string, dflt = false): boolean {
  const v = attr(el, name);
  if (v === null) return dflt;
  return v === '1' || v === 'true';
}

/** EMU → CSS px */
export const emu = (v: number | null | undefined): number => (v ?? 0) / 9525;

/** 百分之一磅 → px */
export const pt100 = (v: number): number => (v / 100) * (96 / 72);
