import init, { HwpDocument } from '@rhwp/core';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';
import { mountLazyPages } from '../lazy-pages.js';

// rhwp는 조판할 때 글자 폭을 호스트에 물어본다. WebView의 canvas로 잰다.
let measureCtx = null;
let lastFont = '';
globalThis.measureTextWidth = (font, text) => {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (font !== lastFont) {
    measureCtx.font = font;
    lastFont = font;
  }
  return measureCtx.measureText(text).width;
};

const wasm = await init({ module_or_path: wasmUrl });

const A4 = { width: 794, height: 1123 };

function pageSize(doc, index) {
  try {
    const info = JSON.parse(doc.getPageInfo(index));
    const width = info.width ?? info.pageWidth;
    const height = info.height ?? info.pageHeight;
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // 쪽 정보가 없으면 A4로 자리를 잡고, 그린 뒤 SVG 크기를 따른다.
  }
  return A4;
}

export async function render(bytes, container, ctx) {
  const doc = new HwpDocument(bytes);
  const pages = doc.pageCount();
  const sizes = Array.from({ length: pages }, (_, i) => pageSize(doc, i));
  mountLazyPages(container, sizes, (i) => doc.renderPageSvg(i));
  ctx.markFirstPage();
  addEventListener('pagehide', () => doc.free(), { once: true });
  return { pages, extra: { wasmMemoryBytes: wasm.memory.buffer.byteLength } };
}
