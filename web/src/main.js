// 앱의 WebView가 viewer.html?fmt=<형식>&src=<문서 URL>&mode=<보기 방식> 으로 연다.
// 형식에 맞는 렌더러만 불러와 그리고, 측정값과 오류는 앱이 주입한 AndroidViewer 통로로 넘긴다.
// 앱은 window.viewer.setMode('scroll' | 'page' | 'spread')로 보기 방식을 바꾼다.
import { t } from './strings.js';

const RENDERERS = {
  pdf: () => import('./renderers/pdf.js'),
  hwp: () => import('./renderers/hwp.js'),
  hwpx: () => import('./renderers/hwp.js'),
  docx: () => import('./renderers/docx.js'),
  doc: () => import('./renderers/doc.js'),
  ppt: () => import('./renderers/slides.js'),
  pptx: () => import('./renderers/slides.js'),
  xls: () => import('./renderers/sheet.js'),
  xlsx: () => import('./renderers/sheet.js'),
  csv: () => import('./renderers/sheet.js'),
  md: () => import('./renderers/md.js'),
};

const params = new URLSearchParams(location.search);
const fmt = params.get('fmt');
const src = params.get('src');
const mode = params.get('mode') ?? 'scroll';
let viewer = null;
window.viewer = { setMode: (next) => viewer?.setMode(next) };
const container = document.getElementById('doc');
const status = document.getElementById('status');

function report(event, data = {}) {
  const payload = JSON.stringify({ event, fmt, ...data });
  if (window.AndroidViewer) window.AndroidViewer.report(payload);
  else console.log('[viewer]', payload);
}

const heap = () => (performance.memory ? { jsHeapUsedBytes: performance.memory.usedJSHeapSize } : {});

async function fetchDocument(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`문서를 읽지 못했습니다 (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function main() {
  const t0 = performance.now();
  let firstPageMs = null;
  const ctx = {
    markFirstPage() {
      if (firstPageMs !== null) return;
      firstPageMs = Math.round(performance.now() - t0);
      report('firstPage', { ms: firstPageMs });
    },
    fmt,
    mode,
    setViewer(paged) {
      viewer = paged;
    },
    askPassword(incorrect) {
      report('needsPassword', { incorrect });
      return promptPassword(incorrect);
    },
  };
  try {
    const load = RENDERERS[fmt];
    if (!load) throw new Error(`지원하지 않는 형식입니다: ${fmt}`);
    const [renderer, bytes] = await Promise.all([load(), fetchDocument(src)]);
    const loadMs = Math.round(performance.now() - t0);
    const size = bytes.length; // 워커로 넘기면 bytes가 비워지므로 미리 잰다.
    const result = (await renderer.render(bytes, container, ctx)) ?? {};
    ctx.markFirstPage();
    report('done', {
      loadMs,
      firstPageMs,
      totalMs: Math.round(performance.now() - t0),
      pages: result.pages ?? null,
      bytes: size,
      ...heap(),
      ...(result.extra ?? {}),
    });
  } catch (error) {
    report('error', { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 1000) });
    status.dataset.kind = 'error';
    status.textContent = t.renderFailed;
  }
}

/** 암호 입력 창. 확인하면 암호를, 취소하면 reject한다. */
function promptPassword(incorrect) {
  return new Promise((resolve, reject) => {
    const form = document.createElement('form');
    form.className = 'password-dialog';
    form.innerHTML = '<p></p><input type="password" autocomplete="off"><div><button type="button"></button><button type="submit"></button></div>';
    form.querySelector('p').textContent = incorrect ? t.passwordWrong : t.passwordPrompt;
    const [cancel, ok] = form.querySelectorAll('button');
    cancel.textContent = t.cancel;
    ok.textContent = t.ok;
    cancel.addEventListener('click', () => {
      form.remove();
      reject(new Error('password cancelled'));
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      form.remove();
      resolve(form.querySelector('input').value);
    });
    document.body.appendChild(form);
    form.querySelector('input').focus();
  });
}

main();
