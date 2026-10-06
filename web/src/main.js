// 앱의 WebView가 viewer.html?fmt=<형식>&src=<문서 URL> 로 연다.
// 형식에 맞는 렌더러만 불러와 그리고, 측정값과 오류는 앱이 주입한 AndroidViewer 통로로 넘긴다.
const RENDERERS = {
  hwp: () => import('./renderers/hwp.js'),
  hwpx: () => import('./renderers/hwp.js'),
  docx: () => import('./renderers/docx.js'),
  doc: () => import('./renderers/doc.js'),
  ppt: () => import('./renderers/slides.js'),
  pptx: () => import('./renderers/slides.js'),
  xls: () => import('./renderers/sheet.js'),
  xlsx: () => import('./renderers/sheet.js'),
  csv: () => import('./renderers/sheet.js'),
};

const params = new URLSearchParams(location.search);
const fmt = params.get('fmt');
const src = params.get('src');
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
    fmt,
    markFirstPage() {
      if (firstPageMs !== null) return;
      firstPageMs = Math.round(performance.now() - t0);
      report('firstPage', { ms: firstPageMs });
    },
    setStatus(text) {
      status.textContent = text;
    },
  };
  try {
    const load = RENDERERS[fmt];
    if (!load) throw new Error(`지원하지 않는 형식입니다: ${fmt}`);
    const [renderer, bytes] = await Promise.all([load(), fetchDocument(src)]);
    const loadMs = Math.round(performance.now() - t0);
    const result = (await renderer.render(bytes, container, ctx)) ?? {};
    ctx.markFirstPage();
    report('done', {
      loadMs,
      firstPageMs,
      totalMs: Math.round(performance.now() - t0),
      pages: result.pages ?? null,
      bytes: bytes.length,
      ...heap(),
      ...(result.extra ?? {}),
    });
  } catch (error) {
    report('error', { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 1000) });
    status.dataset.kind = 'error';
    status.textContent = '이 문서를 표시하지 못했습니다.';
  }
}

main();
