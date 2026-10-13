// 앱의 WebView가 viewer.html을 먼저 띄워 두고, 문서가 준비되면 window.viewer.open({...})으로 연다.
// (WebView 준비와 파일 준비를 겹쳐 여는 시간을 줄인다. 검증 도구는 viewer.html?fmt=&src=로 바로 연다.)
// 형식에 맞는 렌더러만 불러와 그리고, 측정값·읽던 위치·화면 탭은 앱이 주입한 AndroidViewer 통로로 넘긴다.
// 앱은 window.viewer.setMode('scroll' | 'page' | 'spread'), applyFit('width' | 'page'), setChrome(보임 여부),
// setNotes(발표자 노트 보임 여부), resetShrink()를 부른다.
import { PagedViewer } from './paged-viewer.js';
import { openSheet } from './sheet.js';
import { t } from './strings.js';
import { connect } from './worker-client.js';

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
  txt: () => import('./renderers/txt.js'),
};

const PASSWORD_CANCELLED = 'password cancelled';
// 압축을 풀면 이보다 커지는 ZIP 문서(docx·xlsx·pptx·hwpx)는 열지 않는다. 풀다가 기기 메모리를 넘겨 렌더러가 죽거나
// 기기 전체가 느려지기 전에 거른다(압축 폭탄 등). 시험 문서 1,007개 중 가장 큰 것은 87MB다.
const MAX_EXPANDED_BYTES = 1024 ** 3;
/** 압축을 풀면 너무 커서 열지 않는 문서. 최후 대안(본문 글자 뽑기)도 압축을 풀어야 하므로 건너뛴다. */
class TooLargeError extends Error {}
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const container = document.getElementById('doc');
const status = document.getElementById('status');
let fmt = null;
let viewer = null;
let printer = null;
let opened = false;
/** 쪽 있는 문서의 쪽별 글자(검색용). 렌더러가 ctx.setTextSource로 준다. */
let textSource = null;
/** 렌더러가 직접 찾고 보여 주는 검색(가상 스크롤 표). ctx.setSearchProvider로 준다. */
let searchProvider = null;
let search = null;
/** 목차 항목을 돌려주는 함수. 렌더러가 ctx.setOutline으로 주거나, 쪽 없는 문서는 그려진 제목으로 만든다. */
let outlineLoader = null;
/** 쪽 번호 → 그 쪽의 발표자 노트 글자. 노트가 있는 발표 자료만 ctx.setNotes로 준다. */
let notesOf = null;
/** 발표자 노트 칸(켰을 때만 있다) */
let notesPanel = null;

window.viewer = {
  open: (options) => open(options),
  setMode: (next) => viewer?.setMode(next),
  applyFit: (next) => viewer?.applyFit(next),
  /** 오므려 줄인 쪽을 처음 크기로(앱의 '원래 크기' 버튼). WebView 확대는 앱이 되돌린다. */
  resetShrink: () => viewer?.resetShrink?.(),
  /** 읽기 모드: 앱이 상단바를 숨기면 쪽 번호·빠른 이동 손잡이도 숨긴다. */
  setChrome: (visible) => document.body.classList.toggle('reading', !visible),
  /** 발표자 노트 칸을 켜고 끈다(앱의 '더 보기' → 발표자 노트). 노트가 없는 문서면 아무것도 하지 않는다. */
  setNotes: (visible) => setNotes(visible),
  /** 문서 안 검색 막대를 연다(앱 상단바의 검색 버튼). */
  openSearch: async () => {
    if (!search) {
      const { createSearch } = await import('./search.js');
      search ??= createSearch({ container, viewer: () => viewer, textOf: () => textSource, provider: () => searchProvider });
    }
    search.open();
  },
  /** 인쇄 준비: 모든 쪽을 인쇄용 층에 그린 뒤 'printReady'(첫 쪽 크기)를 알린다. */
  preparePrint: async () => {
    const { preparePrint, TooManyPagesError, MAX_PRINT_PAGES } = await import('./print.js');
    try {
      const size = await preparePrint(viewer, printer);
      report('printReady', size ?? {});
    } catch (error) {
      report('printFailed', { tooManyPages: error instanceof TooManyPagesError, limit: error?.limit ?? MAX_PRINT_PAGES, message: String(error?.message ?? error) });
    }
  },
  finishPrint: async () => (await import('./print.js')).finishPrint(viewer),
  /** 목차 시트를 연다(앱의 '더 보기' → 목차). */
  openOutline: async () => {
    const { openOutline } = await import('./outline.js');
    openOutline((await outlineLoader?.().catch(() => [])) ?? []);
  },
  /** 앱의 뒤로 가기: 열린 시트(입력·목차)나 검색 막대가 있으면 그것만 닫고 true를 돌려준다. */
  closeOverlay: () => {
    const backdrop = document.querySelector('.sheet-backdrop');
    if (backdrop) {
      const cancel = backdrop.querySelector('.sheet-cancel');
      if (cancel) cancel.click();
      else backdrop.remove();
      return true;
    }
    if (search?.isOpen()) {
      search.close();
      return true;
    }
    flushPosition(); // 곧 닫힌다: 묶어 두었던 읽던 위치를 바로 알린다.
    return false;
  },
};

/**
 * 발표자 노트 칸: 화면 아래에 높이를 정해 두고 붙인다. 쪽 뷰어는 그만큼 위에서 쪽을 맞추고(setBottomInset),
 * 쪽 번호·빠른 이동 손잡이는 칸 위로 올린다(CSS --notes-height).
 */
function setNotes(visible) {
  if (!notesOf || !viewer || visible === Boolean(notesPanel)) return;
  if (visible) {
    notesPanel = document.createElement('aside');
    notesPanel.className = 'notes-panel';
    document.body.appendChild(notesPanel);
    showNotes();
  } else {
    notesPanel.remove();
    notesPanel = null;
  }
  measureNotes();
}

/** 노트 칸 높이(화면 높이의 30%, 최대 240px)를 다시 재어 쪽 배치에 알린다. 화면을 돌리면 높이가 바뀐다. */
function measureNotes() {
  const height = notesPanel?.offsetHeight ?? 0;
  document.documentElement.style.setProperty('--notes-height', `${height}px`);
  viewer?.setBottomInset(height);
}
addEventListener('resize', () => notesPanel && measureNotes());

/** 지금 보는 쪽(두 쪽씩이면 두 쪽)의 노트를 칸에 채운다. */
function showNotes() {
  if (!notesPanel || !viewer) return;
  const first = viewer.current;
  const indexes = viewer.mode === 'spread' ? [first, first + 1].filter((i) => i < viewer.doc.count) : [first];
  notesPanel.replaceChildren(
    ...indexes.flatMap((index) => {
      const label = document.createElement('h2');
      label.textContent = t.notesTitle(index + 1);
      const body = document.createElement('p');
      const text = notesOf(index)?.trim();
      body.textContent = text || t.notesEmpty;
      body.classList.toggle('empty', !text);
      return [label, body];
    }),
  );
  notesPanel.scrollTop = 0;
}

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

/** 읽던 위치를 앱에 알린다. 스크롤 중 너무 자주 쓰지 않게 묶어서 보낸다. */
let positionTimer = null;
let pendingPosition = null;
function reportPosition(position) {
  clearTimeout(positionTimer);
  pendingPosition = position;
  positionTimer = setTimeout(flushPosition, 500);
}

/** 기다리던 위치 알림을 바로 보낸다(문서를 닫기 직전). */
function flushPosition() {
  clearTimeout(positionTimer);
  if (pendingPosition) report('position', pendingPosition);
  pendingPosition = null;
}

async function open({ fmt: format, src, name = '', mode = 'scroll', fit, page = 0, scroll = 0, notes = false }) {
  if (opened) return;
  opened = true;
  fmt = format;
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
    fit,
    /** 이어보기로 열 쪽. 뒤에서 쪽을 나누는 렌더러는 이 쪽까지 먼저 나눈 뒤 보여 준다. */
    startPage: page,
    setViewer(paged) {
      viewer = paged;
      // 이어보기: 렌더러가 첫 화면을 그리기 전에 시작 쪽을 정한다.
      paged.current = Math.max(0, Math.min(page, paged.doc.count - 1));
      paged.onPageChange = (index) => {
        reportPosition({ page: index });
        showNotes();
      };
    },
    askPassword(incorrect) {
      report('needsPassword', { incorrect });
      return promptPassword(incorrect);
    },
    /** 쪽 있는 렌더러가 쪽별 글자를 주면, 아직 그리지 않은 쪽까지 검색할 수 있다. */
    setTextSource(source) {
      textSource = source;
    },
    setSearchProvider(provider) {
      searchProvider = provider;
    },
    /** 쪽 뷰어 없이 인쇄용 쪽을 직접 만드는 렌더러(엑셀): printer(root, { limit, makeError }) → 첫 쪽 크기 */
    setPrinter(fn) {
      printer = fn;
    },
    /** 문서 이름(머리글·바닥글의 &F 등) */
    name,
    /** 목차가 있는 렌더러가 항목을 돌려주는 함수를 준다. 앱은 이 알림을 받으면 '목차' 메뉴를 보인다. */
    setOutline(loader) {
      outlineLoader = loader;
      report('outline');
    },
    /** 발표자 노트가 있는 발표 자료가 쪽별 노트를 주는 함수를 준다. 앱은 이 알림을 받으면 '발표자 노트' 메뉴를 보인다. */
    setNotes(source) {
      notesOf = source;
      report('notes');
      if (notes) setNotes(true);
    },
  };
  try {
    const load = RENDERERS[fmt];
    if (!load) throw new Error(`지원하지 않는 형식입니다: ${fmt}`);
    let [renderer, bytes] = await Promise.all([load(), fetchDocument(src)]);
    if (await isEncryptedOoxml(bytes)) {
      bytes = await unlockOoxml(bytes, ctx);
      // 확장자와 실제 형식이 다를 수 있어(암호 문서는 앱이 확장자로 형식을 정한다) 풀린 ZIP의 경로로 다시 정한다.
      const actual = await ooxmlFormat(bytes);
      if (actual && actual !== fmt) {
        fmt = ctx.fmt = actual;
        renderer = await RENDERERS[fmt]();
      }
    }
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const { zipExpandedSize } = await import('./containers.js');
      const expanded = zipExpandedSize(bytes);
      if (expanded > MAX_EXPANDED_BYTES) throw new TooLargeError(`압축을 풀면 ${expanded}바이트`);
    }
    const loadMs = Math.round(performance.now() - t0);
    const size = bytes.length; // 워커로 넘기면 bytes가 비워지므로 미리 잰다.
    const result = (await renderer.render(bytes, container, ctx)) ?? {};
    ctx.markFirstPage();
    if (!viewer) restoreScroll(scroll);
    // 쪽 없는 문서는 그려진 제목으로 목차를 만든다(제목이 있을 때만).
    if (!outlineLoader && container.querySelector('h1, h2, h3, h4')) {
      ctx.setOutline(async () => (await import('./outline.js')).headingOutline(container));
    }
    report('done', {
      loadMs,
      firstPageMs,
      totalMs: Math.round(performance.now() - t0),
      pages: result.pages ?? null,
      bytes: size,
      ...heap(),
      ...(result.extra ?? {}),
    });
    // 뒤에서 쪽을 나누는 문서(doc·docx): 다 나눈 시각과 쪽 수(측정용)
    viewer?.doc.paginated?.then(() => report('paginated', { pages: viewer?.doc.count ?? null, ms: Math.round(performance.now() - t0), ...heap() }));
  } catch (error) {
    // 암호 입력을 취소했거나 너무 큰 문서면 대안 없이 안내만 한다. 그 밖의 실패는 본문 글자라도 보여 준다(최후 대안).
    const cancelled = error?.message === PASSWORD_CANCELLED;
    const tooLarge = error instanceof TooLargeError;
    const fallback = cancelled ? 'cancelled' : tooLarge ? 'tooLarge' : await showFallback(src).catch(() => 'failed');
    report('error', { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 1000), fallback });
    if (fallback === 'text') return;
    status.dataset.kind = 'error';
    status.textContent = { cancelled: t.passwordRequired, encrypted: t.encryptedUnsupported, tooLarge: t.tooLargeExpanded }[fallback] ?? t.renderFailed;
  }
}

/**
 * 렌더러가 실패한 문서의 본문 글자를 뽑아 보여 준다. 렌더러가 워커로 넘긴 바이트는 비어 있으므로 다시 받는다.
 * @returns {'text' | 'encrypted' | 'empty'}
 */
async function showFallback(src) {
  // 실패한 렌더러가 남긴 쪽 뷰어 부품(쪽 번호·빠른 이동 손잡이·임시 그리기 영역)을 걷어 낸다.
  viewer = null;
  printer = null;
  document.querySelectorAll('.page-indicator, .scrubber, .offscreen').forEach((el) => el.remove());
  const [{ extractFallback, renderFallback }, bytes] = await Promise.all([import('./fallback.js'), fetchDocument(src)]);
  const extracted = await extractFallback(bytes);
  if (extracted?.encrypted) return 'encrypted';
  return extracted && renderFallback(extracted, container) ? 'text' : 'empty';
}

/** CFB 안에 EncryptedPackage가 있으면 암호 걸린 docx·xlsx·pptx다. */
async function isEncryptedOoxml(bytes) {
  if (bytes.length < 512 || !CFB_MAGIC.every((b, i) => bytes[i] === b)) return false;
  const { readCompound } = await import('./containers.js');
  try {
    return readCompound(bytes).has('EncryptedPackage');
  } catch {
    return false; // CFB가 깨졌으면 렌더러와 최후 대안이 처리한다.
  }
}

/** 암호를 물어 워커에서 푼다. 틀리면 다시 묻고, 취소하면 PASSWORD_CANCELLED로 끝난다. */
async function unlockOoxml(bytes, ctx) {
  const worker = new Worker(new URL('./workers/decrypt-worker.js', import.meta.url), { type: 'module' });
  try {
    const request = connect(worker);
    await request({ type: 'open', bytes: bytes.slice().buffer }, 'opened');
    for (let incorrect = false; ; incorrect = true) {
      const password = await ctx.askPassword(incorrect);
      status.textContent = t.unlocking;
      const reply = await request({ type: 'decrypt', password }, 'decrypted');
      status.textContent = '';
      if (reply.zip) return new Uint8Array(reply.zip);
    }
  } finally {
    status.textContent = '';
    worker.terminate();
  }
}

async function ooxmlFormat(bytes) {
  const { readZip } = await import('./containers.js');
  const zip = readZip(bytes);
  if (zip.has('word/document.xml')) return 'docx';
  if (zip.has('xl/workbook.xml')) return 'xlsx';
  if (zip.has('ppt/presentation.xml')) return 'pptx';
  return null;
}

/** 쪽 구분이 없는 문서(doc·마크다운·엑셀)는 스크롤 비율로 이어본다. */
function restoreScroll(ratio) {
  const max = () => document.documentElement.scrollHeight - innerHeight;
  if (ratio > 0) scrollTo(0, ratio * max());
  addEventListener('scroll', () => max() > 0 && reportPosition({ scroll: Math.min(1, scrollY / max()) }), { passive: true });
}

/**
 * 문서를 한 번 탭하면 앱이 상단바를 숨기거나 다시 보인다(읽기 모드).
 * 쪽 넘기기(가장자리 탭), 화면 위 버튼·시트, 글자 선택 중인 경우는 제외한다.
 */
function bindChromeToggle() {
  let start = null;
  addEventListener(
    'touchstart',
    (e) => {
      const touch = e.touches.length === 1 ? e.touches[0] : null;
      // 화면 위 부품(검색 막대·시트·입력칸·버튼)을 누른 것은 문서 탭이 아니다.
      const onUi =
        e.target instanceof Element && e.target.closest('.scrubber, .page-indicator, .notes-panel, .sheet-backdrop, .sheet-tabs, .search-bar, a, button, input, textarea, select');
      start = touch && !onUi ? { x: touch.clientX, y: touch.clientY, t: performance.now() } : null;
    },
    { passive: true },
  );
  addEventListener(
    'touchend',
    (e) => {
      const touch = e.changedTouches[0];
      if (!start || !touch || e.touches.length > 0) return;
      const tap = performance.now() - start.t < 400 && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) < 10;
      start = null;
      if (!tap) return;
      // 같은 탭을 쪽 뷰어가 쪽 넘기기로 썼는지는 모든 처리기가 끝난 뒤에 확인한다.
      setTimeout(() => {
        if (getSelection()?.toString()) return;
        if (PagedViewer.flippedBy === e) return;
        report('toggleChrome');
      }, 0);
    },
    { passive: true },
  );
}

/** 암호 입력 시트. 확인하면 암호를, 취소하면 reject한다. */
async function promptPassword(incorrect) {
  const value = await openSheet({
    title: t.passwordTitle,
    message: incorrect ? t.passwordWrong : t.passwordPrompt,
    inputType: 'password',
    confirmLabel: t.ok,
    cancelLabel: t.cancel,
  });
  if (value === null) throw new Error(PASSWORD_CANCELLED);
  return value;
}

bindChromeToggle();
// 시트·검색 막대가 입력칸을 열면 앱에 알려 키보드를 띄운다. 웹에서 초점을 줘도 사용자 탭이 아니면
// Android가 키보드를 띄우지 않고, 웹뷰가 아직 초점이 없으면 focus 이벤트조차 오지 않아 직접 알린다.
addEventListener('viewerinputopen', () => report('inputFocused'));
addEventListener('viewershrink', (e) => report('shrink', { value: e.detail }));
const params = new URLSearchParams(location.search);
if (params.get('fmt')) {
  open({
    fmt: params.get('fmt'),
    src: params.get('src'),
    name: params.get('name') ?? '',
    mode: params.get('mode') ?? 'scroll',
    fit: params.get('fit') ?? undefined,
    page: Number(params.get('page') ?? 0),
    scroll: Number(params.get('scroll') ?? 0),
  });
}
