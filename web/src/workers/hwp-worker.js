// HWP 조판은 큰 문서에서 수십 초가 걸릴 수 있어 워커에서 돌린다. 화면 스레드는 스피너와 스크롤을 계속 처리한다.
// 메시지
//   open(bytes)          → opened{pages, sizes} 또는 opened{needsPassword}(암호 문서: 바이트를 들고 기다린다)
//   unlock(password)     → opened{pages, sizes} 또는 opened{wrongPassword}
//   page(index)          → page{index, svg}
//   text(index)          → text{index, text}  쪽 SVG의 글자(검색용, 화면에 그린 글자와 같게)
//   layout(index)        → layout{index, runs} 글자 조각의 위치(선택·복사용 글자 층)
//   outline()            → outline{items}     개요 번호가 붙은 문단(목차용)
// rhwp wasm은 보기 전용으로 줄여 두었다(web/scripts/slim-rhwp.py). 여기서 새 HwpDocument 메서드를 쓰려면
// 그 스크립트의 KEEP에 더하고 wasm을 다시 만든다(목록 밖 메서드는 wasm에서 지워져 있다).
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
// 측정: 워커 시작부터 wasm 준비·문서 열기까지 걸린 시간('done' 측정값에 함께 실린다).
const startedAt = performance.now();
let initMs = 0;
const ready = init({ module_or_path: wasmUrl }).then((wasm) => {
  initMs = Math.round(performance.now() - startedAt);
  return wasm;
});
let doc = null;
let locked = null; // 암호를 기다리는 문서 바이트

function pageSize(index) {
  try {
    const info = JSON.parse(doc.getPageInfo(index));
    if (info.width > 0 && info.height > 0) return { width: info.width, height: info.height };
  } catch {
    // 쪽 정보가 없으면 A4로 자리를 잡는다.
  }
  return A4;
}

function opened(wasm) {
  const pages = doc.pageCount();
  const sizes = Array.from({ length: pages }, (_, i) => pageSize(i));
  self.postMessage({
    type: 'opened',
    pages,
    sizes,
    wasmMemoryBytes: wasm.memory.buffer.byteLength,
    timing: { initMs, openMs: Math.round(performance.now() - startedAt) },
  });
}

// rhwp 오류 문구로 암호 문서·틀린 암호를 가린다(전용 오류 형식이 없다).
const needsPassword = (error) => String(error?.message ?? error).includes('비밀번호가 필요한');
const wrongPassword = (error) => String(error?.message ?? error).includes('비밀번호가 일치하지 않');

/** SVG 문자열에서 글자만: 태그를 걷고 엔티티를 푼다(DOM에 그렸을 때의 textContent와 같다). */
function svgText(svg) {
  return svg
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (match, name) => {
      if (name[0] === '#') return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[name.toLowerCase()] ?? match;
    });
}

self.onmessage = async ({ data }) => {
  try {
    const wasm = await ready;
    if (data.type === 'open') {
      const bytes = new Uint8Array(data.bytes);
      try {
        doc = new HwpDocument(bytes);
      } catch (error) {
        if (!needsPassword(error)) throw error;
        locked = bytes;
        self.postMessage({ type: 'opened', needsPassword: true });
        return;
      }
      opened(wasm);
    } else if (data.type === 'unlock') {
      try {
        doc = HwpDocument.openWithPassword(locked, data.password);
      } catch (error) {
        if (!wrongPassword(error)) throw error;
        self.postMessage({ type: 'opened', wrongPassword: true });
        return;
      }
      locked = null;
      opened(wasm);
    } else if (data.type === 'page') {
      const t0 = performance.now();
      const svg = doc.renderPageSvg(data.index);
      self.postMessage({ type: 'page', index: data.index, svg, renderMs: Math.round(performance.now() - t0) });
    } else if (data.type === 'text') {
      self.postMessage({ type: 'text', index: data.index, text: svgText(doc.renderPageSvg(data.index)) });
    } else if (data.type === 'layout') {
      let runs = [];
      try {
        runs = (JSON.parse(doc.getPageTextLayout(data.index)).runs ?? [])
          .filter((run) => run.text)
          .map((run) => ({
            text: run.text,
            x: run.x,
            y: run.y,
            w: run.w,
            size: run.fontSize,
            // 같은 문단(표 칸 안 문단 포함)인지 가리는 열쇠: 복사할 때 줄을 이을지 끊을지 정한다.
            p: `${run.secIdx}:${run.paraIdx}:${run.controlIdx ?? ''}:${(run.cellPath ?? []).map((c) => `${c.controlIndex}.${c.cellIndex}.${c.cellParaIndex}`).join('/')}`,
          }));
      } catch {
        // 글자 위치를 못 얻으면 선택 층 없이 그림만 보인다.
      }
      self.postMessage({ type: 'layout', index: data.index, runs });
    } else if (data.type === 'outline') {
      let items = [];
      try {
        items = JSON.parse(doc.getOutlineNavigation()).outline ?? [];
      } catch {
        // 개요 정보가 없거나 읽지 못하면 빈 목차
      }
      self.postMessage({ type: 'outline', items });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) });
  }
};
