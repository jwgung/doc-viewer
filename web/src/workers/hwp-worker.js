// HWP 조판은 큰 문서에서 수십 초가 걸릴 수 있어 워커에서 돌린다. 화면 스레드는 스피너와 스크롤을 계속 처리한다.
// 메시지: open(bytes) → opened{pages, sizes}, page(index) → page{index, svg}
import init, { HwpDocument } from '@rhwp/core';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';

// rhwp는 조판할 때 글자 폭을 호스트에 묻는다. 워커에는 DOM이 없으므로 OffscreenCanvas로 잰다.
const measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
let lastFont = '';
globalThis.measureTextWidth = (font, text) => {
  if (font !== lastFont) {
    measureCtx.font = font;
    lastFont = font;
  }
  return measureCtx.measureText(text).width;
};

const A4 = { width: 794, height: 1123 };
const ready = init({ module_or_path: wasmUrl });
let doc = null;

function pageSize(index) {
  try {
    const info = JSON.parse(doc.getPageInfo(index));
    if (info.width > 0 && info.height > 0) return { width: info.width, height: info.height };
  } catch {
    // 쪽 정보가 없으면 A4로 자리를 잡는다.
  }
  return A4;
}

self.onmessage = async ({ data }) => {
  try {
    const wasm = await ready;
    if (data.type === 'open') {
      doc = new HwpDocument(new Uint8Array(data.bytes));
      const pages = doc.pageCount();
      const sizes = Array.from({ length: pages }, (_, i) => pageSize(i));
      self.postMessage({ type: 'opened', pages, sizes, wasmMemoryBytes: wasm.memory.buffer.byteLength });
    } else if (data.type === 'page') {
      self.postMessage({ type: 'page', index: data.index, svg: doc.renderPageSvg(data.index) });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) });
  }
};
