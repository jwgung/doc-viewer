// 윈도우 셸: 상단바, 왼쪽 폴더 탐색기, 문서 탭. 탭마다 iframe으로 viewer.html(웹 렌더러)을 띄우고 window.viewer API로만 부른다.
// 문서 파일은 Rust가 탭 번호를 붙여 doc 스킴으로 내준다(src-tauri/src/main.rs).
import { EXTENSIONS, defaultSettings, formatOf, isPaged, settingsGroup } from './formats.js';
import { fileIcon, folderIcon, lineIcon } from './icons.js';

const STRINGS = {
  ko: {
    openFolder: '폴더 열기',
    changeFolder: '다른 폴더 열기',
    toggleExplorer: '폴더 탐색기 보이기·숨기기',
    folderHint: '폴더를 열면 그 안의 문서를 여기서 골라 볼 수 있습니다.',
    viewMode: '보기 방식',
    viewModeScroll: '연속 스크롤',
    viewModePage: '한 쪽씩',
    viewModeSpread: '두 쪽씩',
    opening: '여는 중…',
    fit: '맞춤',
    fitWidth: '화면 가득',
    fitPage: '용지 맞춤',
    search: '찾기 (Ctrl+F)',
    outline: '목차',
    notes: '발표자 노트',
    print: '인쇄 (Ctrl+P)',
    zoom: '확대·축소',
    zoomIn: '확대 (Ctrl++)',
    zoomOut: '축소 (Ctrl+-)',
    zoomReset: '원래 크기 (Ctrl+0)',
    closeTab: '닫기 (Ctrl+W)',
    closeOthers: '다른 탭 닫기',
    splitRight: '오른쪽으로 나누기',
    moveToOtherPane: '다른 칸으로 옮기기',
    emptyHint: '왼쪽에서 폴더를 열어 문서를 고르거나, 문서를 여기에 끌어다 놓으세요.',
    unsupported: '지원하지 않는 형식의 파일입니다.',
    folderFailed: '폴더를 읽지 못했습니다.',
    refresh: '새로 고침',
    open: '열기',
    rename: '이름 바꾸기',
    reveal: '탐색기에서 보기',
    copyPath: '경로 복사',
    trash: '삭제',
    trashMessage: (name) => `'${name}'을(를) 휴지통으로 보낼까요?`,
    renameExists: '같은 이름이 이미 있습니다.',
    renameInvalid: '파일 이름으로 쓸 수 없는 이름입니다.',
    actionFailed: '작업을 하지 못했습니다.',
    pathCopied: '경로를 복사했습니다.',
    printFailed: '인쇄할 쪽을 준비하지 못했습니다.',
    printTooMany: (n) => `${n}쪽이 넘는 문서는 아직 인쇄할 수 없습니다.`,
  },
  en: {
    openFolder: 'Open folder',
    changeFolder: 'Open another folder',
    toggleExplorer: 'Show or hide the folder explorer',
    folderHint: 'Open a folder to pick its documents here.',
    viewMode: 'View mode',
    viewModeScroll: 'Continuous scroll',
    viewModePage: 'Single page',
    viewModeSpread: 'Two pages',
    opening: 'Opening…',
    fit: 'Fit',
    fitWidth: 'Fit width',
    fitPage: 'Fit page',
    search: 'Find (Ctrl+F)',
    outline: 'Contents',
    notes: 'Speaker notes',
    print: 'Print (Ctrl+P)',
    zoom: 'Zoom',
    zoomIn: 'Zoom in (Ctrl++)',
    zoomOut: 'Zoom out (Ctrl+-)',
    zoomReset: 'Actual size (Ctrl+0)',
    closeTab: 'Close (Ctrl+W)',
    closeOthers: 'Close other tabs',
    splitRight: 'Split right',
    moveToOtherPane: 'Move to other pane',
    emptyHint: 'Open a folder on the left and pick a document, or drop documents here.',
    unsupported: 'This file type is not supported.',
    folderFailed: "Couldn't read the folder.",
    refresh: 'Refresh',
    open: 'Open',
    rename: 'Rename',
    reveal: 'Show in File Explorer',
    copyPath: 'Copy path',
    trash: 'Delete',
    trashMessage: (name) => `Move '${name}' to the Recycle Bin?`,
    renameExists: 'An item with that name already exists.',
    renameInvalid: "That name can't be used for a file.",
    actionFailed: "Couldn't complete the action.",
    pathCopied: 'Path copied.',
    printFailed: "Couldn't prepare the document for printing.",
    printTooMany: (n) => `Documents over ${n} pages can't be printed yet.`,
  },
};
const t = STRINGS[navigator.language?.slice(0, 2)] ?? STRINGS.en;

// 보기 방식·맞춤의 아이콘과 이름(상단바 단추와 메뉴)
const VIEW_ICONS = { scroll: 'viewScroll', page: 'viewPage', spread: 'viewSpread' };
const FIT_ICONS = { width: 'fitWidth', page: 'fitPage' };
const MODE_LABELS = { scroll: t.viewModeScroll, page: t.viewModePage, spread: t.viewModeSpread };
const FIT_LABELS = { width: t.fitWidth, page: t.fitPage };
/** 줄 단위 휠(마우스 설정 '한 번에 여러 줄')을 픽셀로 바꾸는 값. web/src/paged-viewer.js의 WHEEL_LINE_PX와 같다. */
const WHEEL_LINE_PX = 40;

const { invoke } = window.__TAURI__.core;
const { getCurrentWebviewWindow } = window.__TAURI__.webviewWindow;
const appWindow = getCurrentWebviewWindow();

const $ = (id) => document.getElementById(id);
const viewButton = $('view-menu');
const notesButton = $('notes');
const outlineButton = $('outline');
const zoomLabel = $('zoom-reset');

document.documentElement.lang = t === STRINGS.ko ? 'ko' : 'en';
document.querySelectorAll('[data-label]').forEach((el) => (el.textContent = t[el.dataset.label]));
document.querySelectorAll('[data-label-attr]').forEach((el) => {
  el.setAttribute('aria-label', t[el.dataset.labelAttr]);
  if (el.tagName === 'BUTTON') el.title = t[el.dataset.labelAttr];
});
document.querySelectorAll('[data-icon]').forEach((el) => el.prepend(lineIcon(el.dataset.icon)));

// ---- 저장해 두는 작은 설정(보기 설정 묶음, 탐색기 보임). 저장소를 못 써도 동작한다.

function loadPref(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 기억하지 못해도 화면은 바뀐다.
  }
}

/** 같은 묶음(발표 자료·나머지)에서 마지막으로 고른 보기 설정을 다음 문서에 쓴다(Android ViewSettings.lastUsed). */
function loadSettings(fmt) {
  const saved = loadPref(`view:${settingsGroup(fmt)}`);
  return saved?.mode && saved?.fit ? saved : defaultSettings(fmt);
}

// ---- 탭: { id, name, fmt, pane, frame, button, mode, fit, zoom, page, scroll, lastUsed, loading, hasOutline, hasNotes, notesShown, printing }
// 문서는 탭을 처음 볼 때 불러온다(지난번 탭을 여러 개 되살려도 보는 탭만 그린다).
// 탭을 많이 열어도 메모리가 쌓이지 않게, 최근에 본 MAX_AWAKE개 밖이거나 오래 안 본 탭은 재운다:
// 렌더러(iframe)를 버리고 보던 상태(쪽·스크롤·확대·보기 방식)만 남겼다가, 다시 보면 그 상태로 새로 불러온다.

const MAX_AWAKE = 4;
const IDLE_SLEEP_MS = 15 * 60 * 1000;

/** @type {Array<object>} */
const tabs = [];
/** 초점 칸에서 보이는 탭. 상단바·단축키가 다룬다(syncActive가 맞춘다). */
let active = null;

const viewerOf = (tab) => tab?.frame.contentWindow?.viewer;
const viewer = () => viewerOf(active);
const tabOfWindow = (win) => tabs.find((tab) => tab.frame.contentWindow === win);

// ---- 칸(pane): 좌우 두 칸까지. 칸마다 탭 줄·문서 자리·로딩 화면이 있고 보이는 탭(active)이 하나다.
// 상단바·단축키는 마지막으로 누른 칸(focused)에 적용한다. 두 칸 사이 경계선을 끌어 폭을 바꾼다.

const docs = $('docs');
/** @type {Array<{ el: HTMLElement, bar: HTMLElement, frames: HTMLElement, loading: HTMLElement, active: object | null }>} */
const panes = [];
let focused = null;
let splitResizer = null;

function createPane() {
  const pane = { el: document.createElement('section'), bar: document.createElement('nav'), frames: document.createElement('main'), active: null };
  pane.el.className = 'pane';
  pane.bar.className = 'tabs';
  pane.bar.setAttribute('role', 'tablist');
  pane.frames.className = 'frames';
  pane.loading = document.createElement('div');
  pane.loading.className = 'loading';
  pane.loading.setAttribute('role', 'status');
  pane.loading.hidden = true;
  pane.loading.append(
    Object.assign(document.createElement('span'), { className: 'spinner' }),
    Object.assign(document.createElement('span'), { className: 'loading-name' }),
    Object.assign(document.createElement('span'), { textContent: t.opening }),
  );
  pane.frames.appendChild(pane.loading);
  pane.el.append(pane.bar, pane.frames);
  // 칸 안(탭 줄·빈 자리)을 누르면 그 칸이 초점 칸이 된다. 문서(iframe) 안을 누른 것은 createFrame이 알린다.
  pane.el.addEventListener('pointerdown', () => focusPane(pane), true);
  if (panes.length) {
    splitResizer = createSplitResizer();
    docs.append(splitResizer, pane.el);
  } else docs.appendChild(pane.el);
  panes.push(pane);
  applySplitRatio();
  return pane;
}

/** 빈 칸을 없앤다(칸이 하나면 그대로 둔다). */
function removePane(pane) {
  if (panes.length < 2) return;
  panes.splice(panes.indexOf(pane), 1);
  pane.el.remove();
  splitResizer?.remove();
  splitResizer = null;
  docs.classList.remove('split');
  if (focused === pane) focusPane(panes[0]);
  applySplitRatio();
}

const otherPane = (pane) => panes.find((candidate) => candidate !== pane);
const tabsOf = (pane) => tabs.filter((tab) => tab.pane === pane);

function focusPane(pane) {
  if (!pane || focused === pane) return;
  focused = pane;
  for (const candidate of panes) candidate.el.classList.toggle('focused', candidate === pane);
  syncActive();
}

/** 상단바가 다룰 탭을 초점 칸의 보이는 탭으로 맞춘다. */
function syncActive() {
  active = focused?.active ?? null;
  showToolbar();
}

function showPaneLoading(pane) {
  const tab = pane.active;
  pane.loading.hidden = !tab?.loading;
  if (tab) pane.loading.querySelector('.loading-name').textContent = tab.name;
}

// 두 칸의 폭 비율(왼쪽 칸 몫). 경계선을 끌어 바꾸고 다음에도 쓴다.
const MIN_PANE_RATIO = 0.2;
let splitRatio = loadPref('splitRatio') ?? 0.5;

function applySplitRatio() {
  docs.classList.toggle('split', panes.length > 1);
  if (panes.length < 2) {
    panes[0].el.style.flex = '';
    return;
  }
  panes[0].el.style.flex = `${splitRatio} 1 0`;
  panes[1].el.style.flex = `${1 - splitRatio} 1 0`;
}

function createSplitResizer() {
  const resizer = document.createElement('div');
  resizer.className = 'resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.addEventListener('pointerdown', (e) => {
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    const rect = docs.getBoundingClientRect();
    splitRatio = Math.min(1 - MIN_PANE_RATIO, Math.max(MIN_PANE_RATIO, (e.clientX - rect.left) / rect.width));
    applySplitRatio();
  });
  const end = (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    resizer.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing');
    savePref('splitRatio', splitRatio);
  };
  resizer.addEventListener('pointerup', end);
  resizer.addEventListener('pointercancel', end);
  resizer.addEventListener('dblclick', () => {
    splitRatio = 0.5;
    applySplitRatio();
    savePref('splitRatio', splitRatio);
  });
  return resizer;
}

/**
 * 문서를 탭으로 연다. view는 지난번에 보던 상태(되살릴 때)다: { mode, fit, zoom, page, scroll }.
 * select가 false면 탭만 만들고 보지 않는다(되살리기). 이미 연 파일이면 그 탭(어느 칸이든)으로 간다.
 */
function openTab(opened, view = null, select = true, pane = focused) {
  const existing = tabs.find((tab) => tab.id === opened.id);
  if (existing) return select && activate(existing);
  // 내용으로 가린 형식이 확장자보다 앞서고, 확장자로도 모르는 글자 파일은 첫 글자로 가린 형식을 쓴다.
  const fmt = opened.contentFmt ?? formatOf(opened.name) ?? opened.textFmt;
  if (!fmt) {
    invoke('close_document', { id: opened.id });
    toast(t.unsupported);
    return;
  }
  const settings = isPaged(fmt) ? loadSettings(fmt) : defaultSettings('txt');
  const tab = {
    ...opened,
    fmt,
    pane,
    mode: view?.mode ?? settings.mode,
    fit: view?.fit ?? settings.fit,
    zoom: 1,
    /** 그린 뒤 되돌릴 확대 비율 */
    savedZoom: view?.zoom ?? 1,
    page: view?.page ?? 0,
    scroll: view?.scroll ?? 0,
    lastUsed: 0,
    hasOutline: false,
    hasNotes: false,
    notesShown: false,
    printing: false,
  };

  tab.frame = createFrame(tab);

  tab.button = document.createElement('div');
  tab.button.className = 'tab';
  tab.button.setAttribute('role', 'tab');
  tab.button.tabIndex = 0;
  tab.button.title = opened.name;
  const label = document.createElement('span');
  label.className = 'tab-name';
  label.textContent = opened.name;
  tab.label = label;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.appendChild(lineIcon('close'));
  close.setAttribute('aria-label', t.closeTab);
  close.title = t.closeTab;
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  tab.button.append(fileIcon(fmt), label, close);
  tab.button.addEventListener('click', () => !dragJustEnded && activate(tab));
  tab.button.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && activate(tab));
  // 가운데 단추로 누르면 닫는다(브라우저 탭과 같이).
  tab.button.addEventListener('auxclick', (e) => e.button === 1 && closeTab(tab));
  tab.button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, tabActions(tab));
  });
  tab.button.addEventListener('pointerdown', (e) => startTabDrag(tab, e));
  pane.bar.appendChild(tab.button);

  tabs.push(tab);
  if (select) activate(tab);
  else saveSession();
}

function createFrame(tab) {
  const frame = document.createElement('iframe');
  frame.title = tab.name;
  frame.hidden = tab.pane.active !== tab;
  // 문서가 창 전체를 다른 곳으로 옮기거나 새 창을 띄우지 못하게 한다(인쇄 대화상자는 허용).
  frame.sandbox = 'allow-scripts allow-same-origin allow-modals';
  frame.addEventListener('load', () => {
    const win = frame.contentWindow;
    win?.addEventListener('keydown', onKey);
    win?.addEventListener('wheel', onWheel, { passive: false });
    win?.addEventListener('click', blockExternalLink, true);
    // 문서 안을 누르면 그 칸이 초점 칸이 된다(iframe 안 포인터는 셸 칸까지 올라오지 않는다).
    win?.addEventListener('pointerdown', () => focusPane(tab.pane), true);
  });
  tab.pane.frames.appendChild(frame);
  return frame;
}

/**
 * 문서 속 링크(docx·pptx 하이퍼링크 등)가 탭을 바깥 웹 페이지로 바꾸지 않게 막는다. 문서 안 이동(#)과 렌더러가 직접 처리하는
 * 링크(PDF 쪽 이동 등)는 그대로 둔다. 바깥 링크를 브라우저로 여는 기능은 아직 없다.
 * SVG 안 링크(<a>)는 href가 문자열이 아니므로(SVGAnimatedString) 속성 값으로 비교한다.
 */
function blockExternalLink(e) {
  const link = e.target instanceof Element ? e.target.closest('a[href], a[*|href]') : null;
  const href = link?.getAttribute('href') ?? link?.getAttribute('xlink:href');
  if (!href || href.startsWith('#')) return;
  if (new URL(href, link.baseURI).origin !== location.origin) e.preventDefault();
}

/** 렌더러를 버리고 다시 볼 때 쓸 상태만 남긴다(잠들기·칸 옮기기). */
function dropRenderer(tab) {
  viewerOf(tab)?.closeOverlay(); // 모아 두던 읽던 위치를 바로 알리게 한다(검색 막대도 닫힌다).
  // 되살린 확대를 아직 적용하기 전(그리는 중)이면 그 값을 그대로 둔다.
  if (tab.frame.src && tab.savedZoom === 1) tab.savedZoom = tab.zoom;
  Object.assign(tab, { zoom: 1, loading: false, hasOutline: false, hasNotes: false, notesShown: false });
  const old = tab.frame;
  tab.frame = createFrame(tab);
  old.remove();
}

/** 탭을 재운다(보이는 탭·인쇄 중인 탭은 두고). */
function sleepTab(tab) {
  if (tab.pane.active === tab || !tab.frame.src || tab.printing) return;
  dropRenderer(tab);
  tab.button.classList.add('asleep');
  saveSession();
}

/** 최근에 본 MAX_AWAKE개 밖의 깨어 있는 탭과 오래 안 본 탭을 재운다. */
function sleepIdleTabs() {
  const awake = tabs.filter((tab) => tab.frame.src).sort((a, b) => b.lastUsed - a.lastUsed);
  const now = Date.now();
  awake.forEach((tab, index) => (index >= MAX_AWAKE || now - tab.lastUsed > IDLE_SLEEP_MS) && sleepTab(tab));
}
setInterval(sleepIdleTabs, 60 * 1000);

/** 탭 문서를 불러온다(처음 볼 때·잠에서 깰 때). 보이는 상태에서 불러야 렌더러가 화면 폭을 잰다. */
function loadTab(tab) {
  tab.button.classList.remove('asleep');
  if (tab.frame.src) return;
  tab.loading = true; // 첫 쪽이 그려질 때까지 로딩 화면(firstPage·error 알림에서 끈다)
  const { fmt, src, name, mode, fit, page, scroll } = tab;
  const params = new URLSearchParams({ fmt, src, name, mode, fit, page, scroll });
  tab.frame.src = `viewer/viewer.html?${params}`;
}

/** 탭을 그 칸에서 보이게 하고 그 칸을 초점 칸으로 한다. */
function activate(tab) {
  const pane = tab.pane;
  pane.active = tab;
  for (const other of tabsOf(pane)) {
    other.frame.hidden = other !== tab;
    other.button.classList.toggle('active', other === tab);
    other.button.setAttribute('aria-selected', String(other === tab));
  }
  tab.lastUsed = Date.now();
  loadTab(tab);
  showPaneLoading(pane);
  tab.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  focused = null; // 같은 칸이어도 상단바를 다시 맞춘다
  focusPane(pane);
  sleepIdleTabs();
  saveSession();
}

/** 칸에서 탭 하나가 빠진 뒤: 그 칸에 남은 탭을 보이거나, 빈 칸이면 없앤다. */
function afterLeave(pane, index) {
  if (pane.active && tabs.includes(pane.active) && pane.active.pane === pane) return;
  const rest = tabsOf(pane);
  pane.active = null;
  if (rest.length) return activate(rest[Math.min(index, rest.length - 1)]);
  if (panes.length > 1) removePane(pane);
  else {
    pane.loading.hidden = true;
    syncActive();
  }
}

function closeTab(tab) {
  const pane = tab.pane;
  const index = tabsOf(pane).indexOf(tab);
  if (index < 0) return;
  tabs.splice(tabs.indexOf(tab), 1);
  tab.frame.remove();
  tab.button.remove();
  invoke('close_document', { id: tab.id });
  afterLeave(pane, index);
  saveSession();
}

/**
 * 탭을 다른 칸(또는 같은 칸의 다른 자리)으로 옮긴다. index는 대상 칸 탭 줄에서의 자리(없으면 끝).
 * 다른 칸으로 옮기면 iframe을 새로 만들어 보던 상태로 다시 불러온다(iframe은 옮기면 처음부터 다시 읽힌다).
 */
function moveTab(tab, target, index = Infinity) {
  const from = tab.pane;
  const fromIndex = tabsOf(from).indexOf(tab);
  const siblings = tabsOf(target).filter((other) => other !== tab);
  const before = siblings[index] ?? null;
  // tabs 배열 순서도 탭 줄 순서와 같게 둔다(Ctrl+Tab·저장 순서).
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.splice(before ? tabs.indexOf(before) : tabs.length, 0, tab);
  target.bar.insertBefore(tab.button, before?.button ?? null);
  if (from !== target) {
    dropRenderer(tab); // 예전 칸에 새 자리를 만들었다가
    tab.frame.remove();
    tab.pane = target; // 대상 칸에 다시 만든다
    tab.frame = createFrame(tab);
    if (from.active === tab) from.active = null;
    afterLeave(from, fromIndex);
  }
  activate(tab);
}

/** 탭을 옆 칸으로 보낸다. 칸이 하나면 오른쪽에 새 칸을 만든다(탭이 하나뿐이면 나눌 것이 없다). */
function splitTab(tab) {
  if (panes.length < 2 && tabsOf(tab.pane).length < 2) return;
  moveTab(tab, otherPane(tab.pane) ?? createPane());
}

function tabActions(tab) {
  const split = panes.length > 1;
  return [
    { label: split ? t.moveToOtherPane : t.splitRight, hint: 'Ctrl+\\', run: () => splitTab(tab) },
    'separator',
    { label: t.closeTab.replace(/ \(.*\)$/, ''), hint: 'Ctrl+W', run: () => closeTab(tab) },
    { label: t.closeOthers, run: () => tabsOf(tab.pane).filter((other) => other !== tab).forEach(closeTab) },
  ];
}

// ---- 탭 끌기: 포인터 이벤트로 직접 한다. Windows에서 Tauri가 파일 끌어다 놓기를 받으면 웹 안의 HTML 끌어다 놓기가 막힌다.
// 탭 줄에 놓으면 그 자리로(다른 칸이면 그 칸으로), 칸이 하나일 때 문서 오른쪽 가장자리에 놓으면 오른쪽에 새 칸을 만든다.

const DRAG_START_PX = 6;
/** 칸이 하나일 때 이 비율보다 오른쪽에 놓으면 나눈다 */
const SPLIT_EDGE = 0.75;
let drag = null;
/** 끌기가 끝난 직후의 click(탭 고르기)을 한 번 무시한다 */
let dragJustEnded = false;
const dropMark = Object.assign(document.createElement('div'), { className: 'drop-mark', hidden: true });
document.body.appendChild(dropMark);

function startTabDrag(tab, e) {
  if (e.button !== 0 || e.target.closest('.tab-close')) return;
  drag = { tab, x: e.clientX, y: e.clientY, started: false, target: null };
  tab.button.setPointerCapture(e.pointerId);
  tab.button.addEventListener('pointermove', moveTabDrag);
  tab.button.addEventListener('pointerup', endTabDrag, { once: true });
  tab.button.addEventListener('pointercancel', endTabDrag, { once: true });
}

function moveTabDrag(e) {
  if (!drag) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_START_PX) return;
    drag.started = true;
    document.body.classList.add('dragging-tab'); // 문서 iframe이 포인터를 가로채지 않게
    drag.tab.button.classList.add('dragging');
  }
  drag.target = dropTarget(e.clientX, e.clientY);
  showDropMark(drag.target);
}

/** 포인터 아래의 놓을 곳: { pane, index }(탭 줄) 또는 { split: true }(오른쪽 가장자리) */
function dropTarget(x, y) {
  for (const pane of panes) {
    const bar = pane.bar.getBoundingClientRect();
    const rect = pane.el.getBoundingClientRect();
    if (x < rect.left || x > rect.right) continue;
    // 탭 줄(비어 있으면 높이가 0이라 위쪽 34px을 탭 줄로 본다)
    if (y >= rect.top && y <= rect.top + Math.max(bar.height, 34)) {
      const others = tabsOf(pane).filter((tab) => tab !== drag.tab);
      const index = others.filter((tab) => {
        const r = tab.button.getBoundingClientRect();
        return x > r.left + r.width / 2;
      }).length;
      return { pane, index };
    }
    if (y > rect.top && y < rect.bottom) {
      if (panes.length === 1 && x > rect.left + rect.width * SPLIT_EDGE && tabsOf(pane).length > 1) return { split: true };
      if (pane !== drag.tab.pane) return { pane, index: Infinity };
    }
  }
  return null;
}

function showDropMark(target) {
  dropMark.hidden = !target;
  if (!target) return;
  let rect;
  if (target.split) {
    const r = panes[0].frames.getBoundingClientRect();
    rect = { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height };
    dropMark.className = 'drop-mark area';
  } else if (target.index === Infinity && target.pane !== drag.tab.pane) {
    const r = target.pane.frames.getBoundingClientRect();
    rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    dropMark.className = 'drop-mark area';
  } else {
    // 탭 줄의 끼울 자리에 세로 막대
    const others = tabsOf(target.pane).filter((tab) => tab !== drag.tab);
    const bar = target.pane.bar.getBoundingClientRect();
    const ref = others[target.index]?.button.getBoundingClientRect();
    const last = others.at(-1)?.button.getBoundingClientRect();
    const x = ref ? ref.left : last ? last.right : bar.left;
    rect = { left: x - 1, top: target.pane.el.getBoundingClientRect().top, width: 2, height: Math.max(bar.height, 34) };
    dropMark.className = 'drop-mark line';
  }
  Object.assign(dropMark.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

function endTabDrag(e) {
  const current = drag;
  drag = null;
  current.tab.button.removeEventListener('pointermove', moveTabDrag);
  if (current.tab.button.hasPointerCapture(e.pointerId)) current.tab.button.releasePointerCapture(e.pointerId);
  document.body.classList.remove('dragging-tab');
  current.tab.button.classList.remove('dragging');
  dropMark.hidden = true;
  if (!current.started) return;
  dragJustEnded = true;
  setTimeout(() => (dragJustEnded = false), 0);
  const target = e.type === 'pointerup' ? current.target : null;
  if (target?.split) splitTab(current.tab);
  else if (target) moveTab(current.tab, target.pane, target.index);
}

// ---- 지난번 상태: 열린 탭과 탭마다 보던 상태를 Rust가 앱 설정 폴더에 적어 둔다(경로는 Rust만 안다).
// 칸 번호(pane)와 그 칸에서 보이던 탭(shown)도 함께 적어 나눈 화면을 되살린다.

let sessionTimer = null;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const state = tabs.map((tab) => ({
      id: tab.id,
      view: {
        mode: tab.mode,
        fit: tab.fit,
        // 아직 불러오지 않은 탭은 되살린 상태를 그대로 둔다.
        zoom: tab.frame.src ? tab.zoom : tab.savedZoom,
        page: tab.page,
        scroll: tab.scroll,
        pane: panes.indexOf(tab.pane),
        shown: tab.pane.active === tab,
      },
    }));
    invoke('save_session', { tabs: state, active: active?.id ?? null });
  }, 300);
}

async function restoreSession() {
  const { tabs: saved, active: activeId } = await invoke('restore_session');
  if (saved.some(({ view }) => view?.pane === 1) && saved.some(({ view }) => (view?.pane ?? 0) === 0)) createPane();
  for (const { opened, view } of saved) openTab(opened, view, false, panes[view?.pane ?? 0] ?? panes[0]);
  // 칸마다 보이던 탭을 보이고, 마지막에 초점 칸의 탭을 고른다.
  for (const pane of panes) {
    const own = tabsOf(pane);
    const shown = own.find((tab) => saved.find((entry) => entry.opened.id === tab.id)?.view?.shown) ?? own[0];
    if (shown) activate(shown);
  }
  const tab = tabs.find((candidate) => candidate.id === activeId);
  if (tab) activate(tab);
}

function cycleTab(step) {
  const own = tabsOf(focused);
  if (own.length < 2) return;
  activate(own[(own.indexOf(active) + step + own.length) % own.length]);
}

/** 상단바를 초점 칸의 탭에 맞춘다. 창 제목은 늘 앱 이름이다(작업 표시줄에 파일 이름을 붙이지 않는다). */
function showToolbar() {
  const tab = active;
  document.body.classList.toggle('has-doc', !!tab);
  document.body.classList.toggle('paged', !!tab && isPaged(tab.fmt));
  $('empty').hidden = tabs.length > 0;
  if (!tab) return;
  viewButton.replaceChildren(
    lineIcon(VIEW_ICONS[tab.mode]),
    Object.assign(document.createElement('span'), { textContent: `${MODE_LABELS[tab.mode]} · ${FIT_LABELS[tab.fit]}` }),
    lineIcon('chevronDown'),
  );
  outlineButton.hidden = !tab.hasOutline;
  notesButton.hidden = !tab.hasNotes;
  notesButton.setAttribute('aria-pressed', String(tab.notesShown));
  zoomLabel.textContent = `${Math.round(tab.zoom * 100)}%`;
}

/** 실행 인자·끌어다 놓기·두 번째 실행으로 들어온 문서를 탭으로 연다. */
async function takeDocuments() {
  for (const opened of await invoke('take_documents')) openTab(opened);
}

// ---- 렌더러 알림(web/src/main.js의 report). 같은 출처 iframe이 parent.viewerHost.report(json, 그 창)을 부른다.

window.viewerHost = {
  report(json, source) {
    const tab = tabs.find((candidate) => candidate.frame.contentWindow === source);
    if (!tab) return;
    const { event, ...data } = JSON.parse(json);
    switch (event) {
      case 'outline':
        tab.hasOutline = true;
        break;
      case 'notes':
        tab.hasNotes = true;
        break;
      case 'shrink':
        tab.zoom = data.value;
        saveSession();
        break;
      case 'position':
        if (data.page !== undefined) tab.page = data.page;
        if (data.scroll !== undefined) tab.scroll = data.scroll;
        saveSession();
        return;
      case 'firstPage':
      case 'error':
        tab.loading = false;
        showPaneLoading(tab.pane);
        break;
      case 'done':
        tab.loading = false;
        showPaneLoading(tab.pane);
        if (tab === active) showToolbar();
        // 지난번 확대 비율로 되돌린다(렌더러는 처음 크기로 연다).
        if (tab.savedZoom !== 1) viewerOf(tab)?.setZoom(tab.savedZoom);
        tab.savedZoom = 1;
        return;
      case 'printReady':
        startPrint(tab, data);
        return;
      case 'printFailed':
        tab.printing = false;
        toast(data.tooManyPages ? t.printTooMany(data.limit) : t.printFailed);
        return;
      default:
        return;
    }
    if (tab === active) showToolbar();
  },
};

// ---- 인쇄: 모든 쪽을 인쇄용 층에 그린 뒤(preparePrint → printReady) iframe을 인쇄하고, 끝나면 층을 걷는다.

function requestPrint() {
  if (!active || active.printing || !viewer()) return;
  active.printing = true;
  viewer().preparePrint();
}

function startPrint(tab, size) {
  const win = tab.frame.contentWindow;
  // 첫 쪽이 가로로 길면 용지도 가로로(Android는 인쇄 속성으로 정한다).
  const orientation = win.document.createElement('style');
  if (size.width > size.height) orientation.textContent = '@page { size: landscape; }';
  win.document.head.appendChild(orientation);
  win.addEventListener(
    'afterprint',
    () => {
      orientation.remove();
      win.viewer?.finishPrint();
      tab.printing = false;
    },
    { once: true },
  );
  win.print();
}

// ---- 확대·축소: WebView 전체 확대(상단바까지 커짐) 대신 렌더러가 문서만 키운다(window.viewer.setZoom).

/** 단추·단축키 한 번에 바꾸는 배수 */
const ZOOM_STEP = 1.25;
/** 휠(터치패드 오므리기 포함) 1px당 확대 정도 */
const WHEEL_ZOOM_RATE = 0.0015;

function setZoom(value, focusX, focusY) {
  const applied = viewer()?.setZoom(value, focusX, focusY);
  if (!applied) return;
  active.zoom = applied;
  showToolbar();
}

/** Ctrl+휠: 마우스 아래 자리를 기준으로 키운다. 터치패드 오므리기도 Ctrl+휠로 온다. */
function onWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault(); // 문서가 없어도 WebView 전체 확대는 막는다.
  // 문서 위에서 굴렸으면 그 칸을 다룬다(나눈 화면에서 초점이 없는 칸 위).
  const tab = tabOfWindow(e.view);
  if (tab) focusPane(tab.pane);
  if (!active) return;
  const dy = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * WHEEL_LINE_PX : e.deltaY;
  setZoom(active.zoom * Math.exp(-dy * WHEEL_ZOOM_RATE), e.clientX, e.clientY);
}

$('zoom-in').addEventListener('click', () => active && setZoom(active.zoom * ZOOM_STEP));
$('zoom-out').addEventListener('click', () => active && setZoom(active.zoom / ZOOM_STEP));
zoomLabel.addEventListener('click', () => setZoom(1));
addEventListener('wheel', onWheel, { passive: false });

// ---- 상단바·단축키

$('search').addEventListener('click', () => viewer()?.openSearch());
outlineButton.addEventListener('click', () => viewer()?.openOutline());
$('print').addEventListener('click', requestPrint);
notesButton.addEventListener('click', () => {
  active.notesShown = !active.notesShown;
  viewer()?.setNotes(active.notesShown);
  showToolbar();
});
// 보기 방식·맞춤: 단추 하나를 누르면 메뉴로 고른다(기본 select는 Windows 목록 상자로 떠서 셸과 어울리지 않는다).
function setView(change) {
  Object.assign(active, change);
  if (change.mode) viewer()?.setMode(active.mode);
  if (change.fit) viewer()?.applyFit(active.fit);
  savePref(`view:${settingsGroup(active.fmt)}`, { mode: active.mode, fit: active.fit });
  saveSession();
  showToolbar();
}

viewButton.addEventListener('click', () => {
  const rect = viewButton.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, [
    { heading: t.viewMode },
    ...Object.entries(MODE_LABELS).map(([mode, label]) => ({
      label,
      icon: VIEW_ICONS[mode],
      checked: active.mode === mode,
      run: () => setView({ mode }),
    })),
    'separator',
    { heading: t.fit },
    ...Object.entries(FIT_LABELS).map(([fit, label]) => ({
      label,
      icon: FIT_ICONS[fit],
      checked: active.fit === fit,
      run: () => setView({ fit }),
    })),
  ]);
});

/** 셸과 iframe 어디에 초점이 있어도 같은 단축키를 쓴다. 브라우저 기본 동작(셸 인쇄·페이지 찾기)은 막는다. */
function onKey(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && key === 'o') pickFolder();
  else if (ctrl && key === 'tab') cycleTab(e.shiftKey ? -1 : 1);
  else if (ctrl && key === 'w' && active) closeTab(active);
  else if (ctrl && key === '\\' && active) splitTab(active);
  else if (ctrl && key === 'f' && active) viewer()?.openSearch();
  else if (ctrl && key === 'p' && active) requestPrint();
  else if (e.key === 'Escape' && active) viewer()?.closeOverlay();
  else if (ctrl && (key === '=' || key === '+') && active) setZoom(active.zoom * ZOOM_STEP);
  else if (ctrl && key === '-' && active) setZoom(active.zoom / ZOOM_STEP);
  else if (ctrl && key === '0' && active) setZoom(1);
  else return;
  e.preventDefault();
}
addEventListener('keydown', onKey);

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('shown'), 4000);
}

// ---- 폴더 탐색기: 고른 폴더 아래를 펼칠 때마다 읽는다(Rust가 그 폴더 밖은 막는다).

const explorer = $('explorer');
const tree = $('tree');
/** 펼쳐 둔 폴더(다음에 열 때도 펼친다) */
const expanded = new Set(loadPref('expanded') ?? []);

function showExplorer(visible) {
  explorer.classList.toggle('collapsed', !visible);
  $('explorer-resizer').hidden = !visible;
  $('toggle-explorer').setAttribute('aria-pressed', String(visible));
  savePref('explorer', visible);
}

/** 폴더 하나를 읽어 list 아래에 항목을 단다. */
async function fill(list, path) {
  list.dataset.path = path;
  let entries;
  try {
    entries = await invoke('list_folder', { path, extensions: EXTENSIONS });
  } catch {
    toast(t.folderFailed);
    return;
  }
  list.replaceChildren(...entries.map(entryItem));
}

/** 항목이 든 목록을 다시 읽는다(이름 바꾸기·지우기 뒤). 펼쳐 둔 폴더는 다시 펼친다. */
function refreshList(list) {
  return fill(list, list.dataset.path);
}

function entryItem(entry) {
  const item = document.createElement('li');
  item.setAttribute('role', 'treeitem');
  item.entry = entry;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'tree-row';
  row.title = entry.name;
  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = entry.name;
  const twisty = entry.dir ? lineIcon('chevron') : document.createElement('span');
  twisty.classList.add('twisty');
  row.append(twisty, entry.dir ? folderIcon() : fileIcon(formatOf(entry.name)), name);
  item.appendChild(row);
  if (entry.dir) {
    item.setAttribute('aria-expanded', 'false');
    let children = null;
    const toggle = async (open) => {
      item.setAttribute('aria-expanded', String(open));
      if (open) expanded.add(entry.path);
      else expanded.delete(entry.path);
      savePref('expanded', [...expanded]);
      if (open && !children) {
        children = document.createElement('ul');
        children.setAttribute('role', 'group');
        item.appendChild(children);
        await fill(children, entry.path);
      }
      if (children) children.hidden = !open;
    };
    row.addEventListener('click', () => toggle(item.getAttribute('aria-expanded') !== 'true'));
    if (expanded.has(entry.path)) toggle(true);
  } else {
    row.addEventListener('click', () => openEntry(entry));
  }
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    row.focus();
    showMenu(e.clientX, e.clientY, entryActions(item));
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'F2') startRename(item);
    else if (e.key === 'Delete') trashEntry(item);
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const rect = row.getBoundingClientRect();
      showMenu(rect.left + 24, rect.bottom, entryActions(item));
    } else return;
    e.preventDefault();
  });
  return item;
}

async function openEntry(entry) {
  try {
    openTab(await invoke('open_file', { path: entry.path }));
  } catch {
    toast(t.folderFailed);
  }
}

// ---- 파일 관리: 우클릭 메뉴(F2 이름 바꾸기, Del 휴지통). Rust가 고른 폴더 밖은 막는다.

function entryActions(item) {
  const { entry } = item;
  return [
    !entry.dir && { label: t.open, run: () => openEntry(entry) },
    { label: t.rename, hint: 'F2', run: () => startRename(item) },
    { label: t.reveal, run: () => invoke('reveal_entry', { path: entry.path }).catch(() => toast(t.actionFailed)) },
    { label: t.copyPath, run: () => navigator.clipboard.writeText(entry.path).then(() => toast(t.pathCopied), () => toast(t.actionFailed)) },
    'separator',
    { label: t.trash, hint: 'Del', danger: true, run: () => trashEntry(item) },
  ].filter(Boolean);
}

/** 이름을 바꾼 항목(폴더면 그 아래까지)의 '펼쳐 둔 폴더' 기억을 새 경로로 옮긴다. */
function moveExpanded(from, to) {
  for (const path of [...expanded]) {
    if (path === from || path.startsWith(`${from}\\`) || path.startsWith(`${from}/`)) {
      expanded.delete(path);
      expanded.add(to + path.slice(from.length));
    }
  }
  savePref('expanded', [...expanded]);
}

/** 이름 칸을 입력칸으로 바꾼다. Enter·초점 잃음이면 바꾸고 Esc면 그만둔다. 파일은 확장자 앞까지만 고른다. */
function startRename(item) {
  const { entry } = item;
  const row = item.querySelector(':scope > .tree-row');
  const name = row.querySelector('.tree-name');
  const input = document.createElement('input');
  input.className = 'tree-rename';
  input.value = entry.name;
  input.setAttribute('aria-label', t.rename);
  name.replaceWith(input);
  input.focus();
  const dot = entry.dir ? -1 : entry.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  let done = false;
  const finish = async (apply) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    input.replaceWith(name);
    row.focus();
    if (!apply || !next || next === entry.name) return;
    try {
      const changed = await invoke('rename_entry', { path: entry.path, name: next });
      moveExpanded(entry.path, changed.path);
      if (!entry.dir) {
        for (const tab of tabs.filter((candidate) => changed.ids.includes(candidate.id))) {
          tab.name = next;
          tab.label.textContent = next;
          tab.button.title = next;
          tab.frame.title = next;
        }
      }
      await refreshList(item.parentElement);
    } catch (error) {
      toast(error === 'exists' ? t.renameExists : error === 'invalid' ? t.renameInvalid : t.actionFailed);
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 이름 칸의 F2·Del·Enter가 행 단축키로 가지 않게
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    // 막지 않으면 Enter가 초점이 돌아간 행 단추를 눌러 옛 경로로 파일을 연다.
    e.preventDefault();
    finish(e.key === 'Enter');
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
}

async function trashEntry(item) {
  const { entry } = item;
  try {
    const changed = await invoke('trash_entry', { path: entry.path, title: t.trash, message: t.trashMessage(entry.name) });
    if (!changed) return;
    for (const tab of tabs.filter((candidate) => changed.ids.includes(candidate.id))) closeTab(tab);
    await refreshList(item.parentElement);
  } catch {
    toast(t.actionFailed);
  }
}

// ---- 우클릭 메뉴

const menu = document.createElement('div');
menu.className = 'menu';
menu.setAttribute('role', 'menu');
menu.hidden = true;
document.body.appendChild(menu);

function hideMenu() {
  menu.hidden = true;
}

/** items: { label, icon?, checked?, hint?, danger?, run }, { heading } 또는 'separator' */
function showMenu(x, y, items) {
  const checkable = items.some((item) => item.checked !== undefined);
  menu.replaceChildren(
    ...items.map((item) => {
      if (item === 'separator') {
        const line = document.createElement('div');
        line.className = 'menu-separator';
        return line;
      }
      if (item.heading) {
        const heading = document.createElement('div');
        heading.className = 'menu-heading';
        heading.textContent = item.heading;
        return heading;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', checkable ? 'menuitemradio' : 'menuitem');
      button.classList.toggle('danger', !!item.danger);
      if (checkable) {
        button.setAttribute('aria-checked', String(!!item.checked));
        const check = item.checked ? lineIcon('check') : document.createElement('span');
        check.classList.add('menu-check');
        button.append(check);
      }
      if (item.icon) button.append(lineIcon(item.icon));
      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = item.label;
      button.append(label);
      if (item.hint) {
        const hint = document.createElement('kbd');
        hint.textContent = item.hint;
        button.append(hint);
      }
      button.addEventListener('click', () => {
        hideMenu();
        item.run();
      });
      return button;
    }),
  );
  menu.hidden = false;
  // 화면 밖으로 나가지 않게 놓는다.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - height - 4)}px`;
  (menu.querySelector('[aria-checked="true"]') ?? menu.querySelector('button'))?.focus();
}

menu.addEventListener('keydown', (e) => {
  const buttons = [...menu.querySelectorAll('button')];
  const index = buttons.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') buttons[(index + 1) % buttons.length].focus();
  else if (e.key === 'ArrowUp') buttons[(index - 1 + buttons.length) % buttons.length].focus();
  else if (e.key === 'Escape') hideMenu();
  else return;
  e.preventDefault();
});
addEventListener('pointerdown', (e) => !menu.contains(e.target) && hideMenu(), true);
addEventListener('blur', hideMenu);

async function showFolder(folder) {
  $('folder-name').textContent = folder?.name ?? '';
  $('folder-name').title = folder?.path ?? '';
  $('explorer-head').hidden = !folder;
  $('no-folder').hidden = !!folder;
  tree.replaceChildren();
  if (folder) await fill(tree, folder.path);
}

async function pickFolder() {
  const folder = await invoke('pick_folder');
  if (folder) {
    expanded.clear();
    savePref('expanded', []);
    showExplorer(true);
    showFolder(folder);
  }
}
$('pick-folder').addEventListener('click', pickFolder);
$('refresh-folder').addEventListener('click', () => refreshList(tree));
$('pick-folder-empty').addEventListener('click', pickFolder);
$('toggle-explorer').addEventListener('click', () => showExplorer(explorer.classList.contains('collapsed')));

// 사이드바 폭: 경계선 어디든 끌어서 바꾼다. 끄는 동안 문서 iframe이 마우스를 가로채지 않게 막는다.
const MIN_EXPLORER = 180;
function setExplorerWidth(width) {
  explorer.style.setProperty('--explorer-width', `${Math.round(Math.min(Math.max(width, MIN_EXPLORER), innerWidth * 0.6))}px`);
}
setExplorerWidth(loadPref('explorerWidth') ?? 260);
const resizer = $('explorer-resizer');
resizer.addEventListener('pointerdown', (e) => {
  resizer.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
});
resizer.addEventListener('pointermove', (e) => {
  if (resizer.hasPointerCapture(e.pointerId)) setExplorerWidth(e.clientX - explorer.getBoundingClientRect().left);
});
const endResize = (e) => {
  if (!resizer.hasPointerCapture(e.pointerId)) return;
  resizer.releasePointerCapture(e.pointerId);
  document.body.classList.remove('resizing');
  savePref('explorerWidth', explorer.offsetWidth);
};
resizer.addEventListener('pointerup', endResize);
resizer.addEventListener('pointercancel', endResize);
resizer.addEventListener('dblclick', () => {
  setExplorerWidth(260);
  savePref('explorerWidth', 260);
});

// ---- 시작

createPane();
focusPane(panes[0]);
showExplorer(loadPref('explorer') ?? true);
showToolbar();
appWindow.listen('documents', takeDocuments);
showFolder(await invoke('current_folder'));
await restoreSession();
await takeDocuments();
