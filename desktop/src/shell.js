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
    reopenClosed: '닫은 탭 다시 열기',
    duplicateTab: '탭 복제',
    duplicateFailed: '탭을 복제하지 못했습니다',
    reopenFailed: '닫은 탭을 다시 열지 못했습니다(파일이 옮겨졌거나 지워졌습니다)',
    splitRight: '오른쪽으로 나누기',
    splitDown: '아래로 나누기',
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
    reopenClosed: 'Reopen closed tab',
    duplicateTab: 'Duplicate tab',
    duplicateFailed: 'Could not duplicate the tab',
    reopenFailed: 'Could not reopen the closed tab (the file was moved or deleted)',
    splitRight: 'Split right',
    splitDown: 'Split down',
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

// ---- 칸(pane): 최대 MAX_PANES칸. 칸마다 탭 줄·문서 자리·로딩 화면이 있고 보이는 탭(active)이 하나다.
// 상단바·단축키는 마지막으로 누른 칸(focused)에 적용한다.
// 배치는 나눔 나무(layout)로 둔다: 잎은 칸, 가지는 같은 방향(row: 좌우, column: 위아래)으로 나란한 자식들과 그 몫(sizes).
// 칸 요소는 늘 #docs 바로 아래에 두고 나무에서 계산한 자리에 절대 위치로 놓는다. 나누거나 합칠 때 칸 요소를 다른 부모로
// 옮기면 그 안의 iframe이 처음부터 다시 읽히기 때문이다. 칸 사이 경계선을 끌어 몫을 바꾸고, 두 번 누르면 고르게 나눈다.

const MAX_PANES = 4;
/** 경계선을 끌어 줄일 수 있는 칸의 가장 작은 폭·높이(px). 같은 방향으로 여러 번 나눈 좁은 칸끼리도 경계선이 움직이도록 몫이 아니라 픽셀로 둔다 */
const MIN_PANE_PX = 80;

const docs = $('docs');
/** @type {Array<{ el: HTMLElement, bar: HTMLElement, frames: HTMLElement, loading: HTMLElement, active: object | null }>} */
const panes = [];
let focused = null;
/** @type {{ pane: object } | { dir: 'row' | 'column', children: Array<object>, sizes: number[] } | null} */
let layout = null;
const splitResizers = [];

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
  docs.appendChild(pane.el);
  panes.push(pane);
  return pane;
}

/** 나무에서 칸의 잎과 그 부모 가지를 찾는다. */
function findLeaf(pane, node = layout, parent = null) {
  if (node.pane) return node.pane === pane ? { node, parent } : null;
  for (const child of node.children) {
    const found = findLeaf(pane, child, node);
    if (found) return found;
  }
  return null;
}

/**
 * target 칸의 side(left·right·top·bottom) 쪽에 새 칸을 만든다. 같은 방향 가지 안이면 형제로 끼우고(세 칸 나란히),
 * 아니면 그 칸 자리를 새 가지로 바꾼다(한쪽을 위아래로 나누기). target이 가졌던 몫을 반씩 나눈다.
 */
function splitPane(target, side) {
  return splitNode(findLeaf(target).node, side);
}

/** 나무의 node(칸 또는 가지) 자리를 side 쪽으로 나눠 새 칸을 만든다(splitPane, 닫은 칸 되살리기). */
function splitNode(node, side) {
  const dir = side === 'left' || side === 'right' ? 'row' : 'column';
  const after = side === 'right' || side === 'bottom';
  const pane = createPane();
  const leaf = { pane };
  const parent = findParent(node);
  if (parent?.dir === dir) {
    const index = parent.children.indexOf(node);
    const half = parent.sizes[index] / 2;
    parent.sizes[index] = half;
    parent.children.splice(index + (after ? 1 : 0), 0, leaf);
    parent.sizes.splice(index + (after ? 1 : 0), 0, half);
  } else {
    const branch = { dir, children: after ? [node, leaf] : [leaf, node], sizes: [0.5, 0.5] };
    if (parent) parent.children[parent.children.indexOf(node)] = branch;
    else layout = branch;
  }
  applyLayout();
  return pane;
}

/** node가 아직 나무 안에 있는지(닫은 칸을 되살릴 기준 자리가 그 뒤 합쳐져 사라졌을 수 있다) */
const inLayout = (node) => node === layout || findParent(node) !== null;

/**
 * 닫은 칸을 되살릴 기준 자리를 나무에 다시 둔다. 같은 방향 바깥 가지에 펼쳐져 사라진 가지면, 그 자식들이 아직 그대로
 * 이어 있을 때 다시 하나로 묶는다(예: 위 칸을 닫아 row[C, D]가 바깥 row에 펼쳐진 뒤 위 칸을 되살릴 때). 못 두면 false.
 */
function reviveAnchor(anchor) {
  if (inLayout(anchor)) return true;
  const spread = anchor.spread;
  if (!spread || !inLayout(spread.into)) return false;
  const { into, children } = spread;
  const start = into.children.indexOf(children[0]);
  if (start < 0 || children.some((child, i) => into.children[start + i] !== child)) return false;
  const sizes = into.sizes.slice(start, start + children.length);
  const share = sizes.reduce((sum, size) => sum + size, 0);
  Object.assign(anchor, { children, sizes: sizes.map((size) => size / share) });
  delete anchor.spread;
  into.children.splice(start, children.length, anchor);
  into.sizes.splice(start, children.length, share);
  return true;
}

/**
 * 빈 칸을 없앤다(칸이 하나면 그대로 둔다). 그 몫은 앞 형제(왼쪽·위, 맨 앞이면 뒤 형제)가 받고, 초점도 그 자리로 옮긴다.
 * 자식이 하나 남은 가지는 풀어 준다.
 */
function removePane(pane) {
  if (panes.length < 2) return;
  panes.splice(panes.indexOf(pane), 1);
  pane.el.remove();
  const { node, parent } = findLeaf(pane);
  const index = parent.children.indexOf(node);
  const share = parent.sizes[index];
  parent.children.splice(index, 1);
  parent.sizes.splice(index, 1);
  const heir = Math.max(0, index - 1);
  parent.sizes[heir] += share;
  // 닫은 탭을 다시 열 때(Ctrl+Shift+T) 이 칸을 같은 자리에 되살리도록, 몫을 받은 형제와 그 형제에서 본 방향을 남긴다.
  const before = index > heir;
  pane.gone = { anchor: parent.children[heir], side: parent.dir === 'row' ? (before ? 'right' : 'left') : before ? 'bottom' : 'top' };
  const firstPane = (tree) => (tree.pane ? tree.pane : firstPane(tree.children[0]));
  const next = firstPane(parent.children[heir]);
  if (parent.children.length === 1) replaceNode(parent, parent.children[0]);
  if (focused === pane) focusPane(next);
  applyLayout();
}

/** 나무에서 old 자리를 replacement로 바꾼다. 같은 방향 가지 안에 같은 방향 가지가 들어가면 하나로 펼친다. */
function replaceNode(old, replacement) {
  const grand = findParent(old);
  if (!grand) {
    layout = replacement;
    return;
  }
  const index = grand.children.indexOf(old);
  if (replacement.dir && replacement.dir === grand.dir) {
    const share = grand.sizes[index];
    // 펼쳐진 가지가 닫은 칸을 되살릴 기준 자리일 수 있어, 어디로 펼쳐졌는지 남긴다(reviveAnchor가 다시 묶는다).
    replacement.spread = { into: grand, children: [...replacement.children] };
    grand.children.splice(index, 1, ...replacement.children);
    grand.sizes.splice(index, 1, ...replacement.sizes.map((size) => size * share));
  } else grand.children[index] = replacement;
}

function findParent(target, node = layout) {
  if (node.pane) return null;
  if (node.children.includes(target)) return node;
  for (const child of node.children) {
    const found = findParent(target, child);
    if (found) return found;
  }
  return null;
}

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

/**
 * 나무대로 칸을 놓고 경계선을 다시 단다(#docs 안의 비율로 두므로 창 크기가 바뀌어도 따라간다).
 * save가 false면 배치를 적지 않는다(시작할 때: 지난번 배치를 되살리기 전에 덮어쓰지 않게).
 */
function applyLayout(save = true) {
  docs.classList.toggle('split', panes.length > 1);
  // 끌던 경계선이 지워지면(끄는 중 Ctrl+W로 칸이 사라짐) pointerup이 오지 않으므로 끄는 상태를 여기서 푼다.
  document.body.classList.remove('resizing', 'rows');
  for (const resizer of splitResizers.splice(0)) resizer.remove();
  place(layout, ROOT_BOX);
  if (save) savePref('layout', serializeLayout(layout));
}

const ROOT_BOX = { left: 0, top: 0, width: 1, height: 1 };
const percent = (value) => `${(value * 100).toFixed(4)}%`;

/** node를 box(#docs에 대한 비율)에 놓는다. move면 경계선을 새로 만들지 않고 있던 것만 옮긴다(끄는 중: 포인터를 붙든 경계선이 남아야 한다). */
function place(node, box, move = false) {
  if (node.pane) {
    Object.assign(node.pane.el.style, { left: percent(box.left), top: percent(box.top), width: percent(box.width), height: percent(box.height) });
    return;
  }
  const row = node.dir === 'row';
  if (!move) node.resizers = [];
  let offset = 0;
  node.children.forEach((child, index) => {
    const share = node.sizes[index];
    const childBox = row
      ? { left: box.left + offset * box.width, top: box.top, width: share * box.width, height: box.height }
      : { left: box.left, top: box.top + offset * box.height, width: box.width, height: share * box.height };
    place(child, childBox, move);
    offset += share;
    if (index === node.children.length - 1) return;
    if (!move) node.resizers.push(createSplitResizer(node, index));
    Object.assign(
      node.resizers[index].style,
      row
        ? { left: percent(box.left + offset * box.width), top: percent(box.top), height: percent(box.height) }
        : { top: percent(box.top + offset * box.height), left: percent(box.left), width: percent(box.width) },
    );
  });
  node.box = box;
}

/** node 가지의 index번째와 그다음 자식 사이 경계선 */
function createSplitResizer(node, index) {
  const row = node.dir === 'row';
  const resizer = document.createElement('div');
  resizer.className = `resizer split-resizer ${row ? 'vertical' : 'horizontal'}`;
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', row ? 'vertical' : 'horizontal');
  resizer.addEventListener('pointerdown', (e) => {
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('held');
    document.body.classList.add('resizing');
    document.body.classList.toggle('rows', !row);
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    const rect = docs.getBoundingClientRect();
    const { box } = node;
    const position = row ? ((e.clientX - rect.left) / rect.width - box.left) / box.width : ((e.clientY - rect.top) / rect.height - box.top) / box.height;
    // 두 이웃 칸의 몫 합은 그대로 두고 경계만 옮긴다.
    const before = node.sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
    const pair = node.sizes[index] + node.sizes[index + 1];
    // 가장 작은 칸 크기를 이 가지 안의 몫으로 바꾼다(두 칸 합보다 크면 반씩).
    const min = Math.min(pair / 2, MIN_PANE_PX / (row ? rect.width * box.width : rect.height * box.height));
    const first = Math.min(pair - min, Math.max(min, position - before));
    node.sizes[index] = first;
    node.sizes[index + 1] = pair - first;
    place(layout, ROOT_BOX, true);
  });
  const end = (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    resizer.releasePointerCapture(e.pointerId);
    resizer.classList.remove('held');
    document.body.classList.remove('resizing', 'rows');
    savePref('layout', serializeLayout(layout));
  };
  resizer.addEventListener('pointerup', end);
  resizer.addEventListener('pointercancel', end);
  resizer.addEventListener('dblclick', () => {
    node.sizes = node.children.map(() => 1 / node.children.length);
    applyLayout();
  });
  docs.appendChild(resizer);
  splitResizers.push(resizer);
  return resizer;
}

/** 저장용: 칸은 panes 안의 번호로 적는다(탭도 칸 번호를 적는다). */
function serializeLayout(node) {
  return node.pane ? { pane: panes.indexOf(node.pane) } : { dir: node.dir, sizes: node.sizes, children: node.children.map(serializeLayout) };
}

/** 저장해 둔 나무를 칸을 만들며 되살린다. 모양이 이상하면 null(한 칸으로 시작). */
function restoreLayout(saved, made = new Map(), depth = 0) {
  // 칸이 MAX_PANES개면 가지는 그보다 깊을 수 없다(손상된 값이 아주 깊으면 재귀가 넘친다).
  if (!saved || typeof saved !== 'object' || depth > MAX_PANES) return null;
  if (Number.isInteger(saved.pane)) {
    if (made.has(saved.pane) || made.size >= MAX_PANES) return null;
    made.set(saved.pane, true);
    return { saved: saved.pane };
  }
  const { dir, sizes, children } = saved;
  if (!['row', 'column'].includes(dir) || !Array.isArray(children) || children.length < 2 || !Array.isArray(sizes) || sizes.length !== children.length) return null;
  const restored = children.map((child) => restoreLayout(child, made, depth + 1));
  if (restored.some((child) => !child)) return null;
  const shares = sizes.map((size) => (Number.isFinite(Number(size)) ? Math.max(0, Number(size)) : 0));
  const total = shares.reduce((sum, size) => sum + size, 0);
  return { dir, children: restored, sizes: shares.map((size) => (total > 0 ? size / total : 1 / shares.length)) };
}

/**
 * 문서를 탭으로 연다. view는 지난번에 보던 상태(되살릴 때)다: { mode, fit, zoom, page, scroll }.
 * select가 false면 탭만 만들고 보지 않는다(되살리기). 이미 연 파일이면 그 탭(어느 칸이든)으로 간다.
 */
function openTab(opened, view = null, select = true, pane = focused) {
  const existing = tabs.find((tab) => tab.id === opened.id);
  if (existing) {
    if (select) activate(existing);
    return existing;
  }
  // 내용으로 가린 형식이 확장자보다 앞서고, 확장자로도 모르는 글자 파일은 첫 글자로 가린 형식을 쓴다.
  const fmt = opened.contentFmt ?? formatOf(opened.name) ?? opened.textFmt;
  if (!fmt) {
    invoke('close_document', { id: opened.id, remember: false }); // 열지 못한 문서는 다시 열기 목록에 두지 않는다
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
  return tab;
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
  // 끌던 탭을 닫으면(Ctrl+W) 탭 단추가 사라져 pointerup이 오지 않으므로 끌기를 여기서 끝낸다.
  if (drag?.tab === tab) {
    drag = null;
    document.body.classList.remove('dragging-tab', 'copying-tab');
    dropMark.hidden = true;
  }
  rememberClosed(tab, index);
  tabs.splice(tabs.indexOf(tab), 1);
  tab.frame.remove();
  tab.button.remove();
  invoke('close_document', { id: tab.id });
  afterLeave(pane, index);
  saveSession();
}

// ---- 닫은 탭 다시 열기(Ctrl+Shift+T): 브라우저처럼 가장 최근에 닫은 탭부터, 닫을 때의 칸·탭 줄 자리·보던 상태로 연다.
// 그 칸이 마지막 탭과 함께 사라졌으면 몫을 받았던 옆자리를 같은 방향으로 다시 나눈다(최대 4칸, 못 나누면 초점 칸).
// 파일은 Rust가 닫은 탭 번호로 기억한다(CLOSED_KEEP과 같은 개수). 같은 파일이 다른 탭에 열려 있어도 닫았던 탭을 따로 되살린다.

const CLOSED_KEEP = 20;
const closedTabs = [];

function rememberClosed(tab, index) {
  viewerOf(tab)?.flushPosition?.(); // 모아 두던 읽던 위치를 바로 받는다
  closedTabs.push({ id: tab.id, pane: tab.pane, index, view: viewState(tab) });
  if (closedTabs.length > CLOSED_KEEP) closedTabs.shift();
}

/** 닫힌 칸이 다시 만들어졌으면 그 칸으로 이어 간다(같은 칸에서 닫은 탭 여럿을 한 칸에 되살리게). */
function livePane(pane) {
  while (pane.reborn) pane = pane.reborn;
  return pane;
}

async function reopenClosedTab() {
  const entry = closedTabs.pop();
  if (!entry) return;
  let opened;
  try {
    opened = await invoke('reopen_document', { id: entry.id });
  } catch {
    toast(t.reopenFailed);
    return;
  }
  let pane = livePane(entry.pane);
  if (!panes.includes(pane)) {
    const gone = pane.gone;
    if (gone && panes.length < MAX_PANES && reviveAnchor(gone.anchor)) {
      pane.reborn = splitNode(gone.anchor, gone.side);
      pane = pane.reborn;
    } else pane = focused;
  }
  const tab = openTab(opened, entry.view, true, pane);
  if (tab && tab.pane === pane) moveTab(tab, pane, entry.index);
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
    tab.pane = target;
    dropRenderer(tab); // 렌더러를 버리고 대상 칸에 새 자리를 만든다
    if (from.active === tab) from.active = null;
    afterLeave(from, fromIndex);
  }
  activate(tab);
}

/**
 * tab을 pane의 가장자리로 보내 새 칸을 만들 수 있는지. 칸 수가 MAX_PANES를 넘지 않아야 하고(혼자 있던 칸에서 다른 칸으로 가면
 * 그 칸이 없어져 수가 그대로다), 제 칸을 나누려면 남길 탭이 있어야 한다.
 */
function canSplit(tab, pane) {
  if (pane === tab.pane) return tabsOf(pane).length > 1 && panes.length < MAX_PANES;
  return panes.length < MAX_PANES || tabsOf(tab.pane).length === 1;
}

/** 탭을 pane의 side 쪽 새 칸으로 보낸다(Ctrl+\는 제 칸 오른쪽). */
function splitTab(tab, side = 'right', pane = tab.pane) {
  if (!canSplit(tab, pane)) return;
  moveTab(tab, splitPane(pane, side));
}

function tabActions(tab) {
  const split = canSplit(tab, tab.pane);
  return [
    ...(split
      ? [
          { label: t.splitRight, hint: 'Ctrl+\\', run: () => splitTab(tab, 'right') },
          { label: t.splitDown, run: () => splitTab(tab, 'bottom') },
          'separator',
        ]
      : []),
    { label: t.duplicateTab, run: () => duplicateTab(tab, { pane: tab.pane, index: tabsOf(tab.pane).indexOf(tab) + 1 }) },
    'separator',
    { label: t.closeTab.replace(/ \(.*\)$/, ''), hint: 'Ctrl+W', run: () => closeTab(tab) },
    { label: t.closeOthers, run: () => tabsOf(tab.pane).filter((other) => other !== tab).forEach(closeTab) },
    ...(closedTabs.length ? [{ label: t.reopenClosed, hint: 'Ctrl+Shift+T', run: reopenClosedTab }] : []),
  ];
}

// ---- 탭 끌기: 포인터 이벤트로 직접 한다. Windows에서 Tauri가 파일 끌어다 놓기를 받으면 웹 안의 HTML 끌어다 놓기가 막힌다.
// 탭 줄에 놓으면 그 자리로(다른 칸이면 그 칸으로), 문서 자리의 가장자리(위·아래·왼쪽·오른쪽)에 놓으면 그쪽에 새 칸을 만들고,
// 다른 칸 문서 자리의 가운데에 놓으면 그 칸으로 옮긴다.

const DRAG_START_PX = 6;
/** 탭 줄 높이(shell.css .tab). 탭이 없는 칸도 이만큼 위쪽을 탭 줄로 본다 */
const TAB_BAR_PX = 34;
/** 문서 자리에서 이 비율 안쪽의 가장자리에 놓으면 나눈다 */
const SPLIT_EDGE = 0.25;
let drag = null;
/** 끌기가 끝난 직후의 click(탭 고르기)을 한 번 무시한다 */
let dragJustEnded = false;
const dropMark = Object.assign(document.createElement('div'), { className: 'drop-mark', hidden: true });
document.body.appendChild(dropMark);

function startTabDrag(tab, e) {
  if (e.button !== 0 || e.target.closest('.tab-close')) return;
  drag = { tab, x: e.clientX, y: e.clientY, started: false, target: null, copy: false };
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
  // Ctrl을 누른 채 놓으면 옮기지 않고 복제한다: 새로 여는 문서처럼 제 칸 가운데·가장자리에도 놓을 수 있다.
  drag.copy = e.ctrlKey;
  document.body.classList.toggle('copying-tab', drag.copy);
  drag.target = dropTarget(e.clientX, e.clientY, drag.copy ? null : drag.tab);
  showDropMark(drag.target);
}

/**
 * 포인터 아래의 놓을 곳: { pane, index }(탭 줄·다른 칸 가운데) 또는 { pane, side }(가장자리에 새 칸).
 * tab은 끄는 탭이고, 새로 여는 파일(사이드바·Windows 탐색기에서 끌어옴)이나 복제(Ctrl+끌기)면 null이다:
 * 그때는 어느 칸 가운데든(제 칸 포함) 그 칸에 연다.
 */
function dropTarget(x, y, tab = drag?.tab ?? null) {
  for (const pane of panes) {
    const bar = pane.bar.getBoundingClientRect();
    const rect = pane.el.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    // 탭 줄(비어 있으면 높이가 0이라 위쪽 TAB_BAR_PX를 탭 줄로 본다)
    if (y <= rect.top + Math.max(bar.height, TAB_BAR_PX)) {
      const others = tabsOf(pane).filter((other) => other !== tab);
      const index = others.filter((other) => {
        const r = other.button.getBoundingClientRect();
        return x > r.left + r.width / 2;
      }).length;
      return { pane, index };
    }
    const area = pane.frames.getBoundingClientRect();
    const rx = (x - area.left) / area.width;
    const ry = (y - area.top) / area.height;
    const [side, distance] = [
      ['left', rx],
      ['right', 1 - rx],
      ['top', ry],
      ['bottom', 1 - ry],
    ].reduce((nearest, candidate) => (candidate[1] < nearest[1] ? candidate : nearest));
    if (distance < SPLIT_EDGE && (tab ? canSplit(tab, pane) : panes.length < MAX_PANES)) return { pane, side };
    return !tab || pane !== tab.pane ? { pane, index: Infinity } : null;
  }
  return null;
}

function showDropMark(target) {
  dropMark.hidden = !target;
  if (!target) return;
  let rect;
  if (target.side || target.index === Infinity) {
    // 새 칸이 들어갈 반쪽, 또는 옮겨 갈 칸 전체
    const r = target.pane.frames.getBoundingClientRect();
    const half = { left: { width: r.width / 2 }, right: { left: r.left + r.width / 2, width: r.width / 2 }, top: { height: r.height / 2 }, bottom: { top: r.top + r.height / 2, height: r.height / 2 } };
    rect = { left: r.left, top: r.top, width: r.width, height: r.height, ...half[target.side] };
    dropMark.className = 'drop-mark area';
  } else {
    // 탭 줄의 끼울 자리에 세로 막대
    const others = tabsOf(target.pane).filter((tab) => drag?.copy || tab !== drag?.tab); // 복제면 끄는 탭도 자리를 차지한다
    const bar = target.pane.bar.getBoundingClientRect();
    const ref = others[target.index]?.button.getBoundingClientRect();
    const last = others.at(-1)?.button.getBoundingClientRect();
    const x = ref ? ref.left : last ? last.right : target.pane.el.getBoundingClientRect().left;
    rect = { left: x - 1, top: target.pane.el.getBoundingClientRect().top, width: 2, height: Math.max(bar.height, TAB_BAR_PX) };
    dropMark.className = 'drop-mark line';
  }
  Object.assign(dropMark.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

function endTabDrag(e) {
  const current = drag;
  if (!current) return;
  drag = null;
  current.tab.button.removeEventListener('pointermove', moveTabDrag);
  if (current.tab.button.hasPointerCapture(e.pointerId)) current.tab.button.releasePointerCapture(e.pointerId);
  document.body.classList.remove('dragging-tab');
  current.tab.button.classList.remove('dragging');
  dropMark.hidden = true;
  if (!current.started) return;
  dragJustEnded = true;
  setTimeout(() => (dragJustEnded = false), 0);
  document.body.classList.remove('copying-tab');
  // 끄는 사이 놓을 칸이 사라졌으면(Ctrl+W) 아무것도 하지 않는다.
  const target = e.type === 'pointerup' && panes.includes(current.target?.pane) ? current.target : null;
  // 미리 보인 놓을 곳과 같은 판단(끄는 동안의 Ctrl)으로 복제할지 정한다.
  if (target && current.copy) duplicateTab(current.tab, target);
  else if (target?.side) splitTab(current.tab, target.side, target.pane);
  else if (target) moveTab(current.tab, target.pane, target.index);
}

/**
 * 새로 연 문서들을 놓을 곳에 둔다. 가장자리면 그쪽에 새 칸을 하나 만들어 모두 그 칸에 열고, 칸이면 그 칸(탭 줄이면 그 자리)에 연다.
 * 이미 연 문서면 그 탭을 옮긴다. 놓을 곳이 없으면 초점 칸에 연다.
 */
function placeOpened(list, target) {
  if (target && !panes.includes(target.pane)) target = null;
  const made = target?.side && panes.length < MAX_PANES ? splitPane(target.pane, target.side) : null;
  const pane = made ?? target?.pane ?? focused;
  let index = target?.index ?? Infinity;
  for (const opened of list) {
    const existing = tabs.find((tab) => tab.id === opened.id);
    // 이미 연 문서: 다른 칸이나 탭 줄의 자리로 옮긴다(같은 칸 가운데면 그 탭을 보이기만 한다).
    if (existing) existing.pane === pane && index === Infinity ? activate(existing) : moveTab(existing, pane, index);
    else {
      const tab = openTab(opened, null, true, pane);
      if (tab && index !== Infinity) moveTab(tab, pane, index);
    }
    if (index !== Infinity) index++;
  }
  // 열 수 있는 문서가 없어 새 칸이 비었으면 거둔다.
  if (made && !tabsOf(made).length) removePane(made);
}

/**
 * 탭을 복제한다: 같은 파일을 새 탭(새 문서 번호)으로, 보던 쪽·확대·보기 방식 그대로 연다. 복제본은 따로 넘기고 확대한다.
 * target은 놓을 곳({ pane, index } 또는 { pane, side }: 가장자리면 그쪽에 새 칸, 4칸이면 그 칸).
 */
async function duplicateTab(tab, target) {
  let opened;
  try {
    opened = await invoke('duplicate_document', { id: tab.id });
  } catch {
    toast(t.duplicateFailed);
    return;
  }
  viewerOf(tab)?.flushPosition?.(); // 원본이 모아 두던 읽던 위치까지 넘긴다
  if (!panes.includes(target.pane)) target = { pane: focused, index: Infinity };
  const pane = target.side && panes.length < MAX_PANES ? splitPane(target.pane, target.side) : target.pane;
  const copy = openTab(opened, viewState(tab), true, pane);
  if (copy && target.index !== undefined && target.index !== Infinity) moveTab(copy, pane, target.index);
}

// 사이드바의 파일을 문서 자리로 끌어 놓기: 탭 끌기와 같은 놓을 곳(가장자리면 나누기)을 쓴다. 누르기만 하면 지금처럼 초점 칸에 연다.
let fileDrag = null;

function startFileDrag(entry, row, e) {
  if (e.button !== 0) return;
  fileDrag = { entry, row, x: e.clientX, y: e.clientY, started: false, target: null };
  row.setPointerCapture(e.pointerId);
}

function moveFileDrag(e) {
  if (!fileDrag) return;
  if (!fileDrag.started) {
    if (Math.hypot(e.clientX - fileDrag.x, e.clientY - fileDrag.y) < DRAG_START_PX) return;
    fileDrag.started = true;
    document.body.classList.add('dragging-tab');
    fileDrag.row.classList.add('dragging');
  }
  fileDrag.target = dropTarget(e.clientX, e.clientY, null);
  showDropMark(fileDrag.target);
}

async function endFileDrag(e) {
  const current = fileDrag;
  if (!current) return;
  fileDrag = null;
  if (current.row.hasPointerCapture(e.pointerId)) current.row.releasePointerCapture(e.pointerId);
  document.body.classList.remove('dragging-tab');
  current.row.classList.remove('dragging');
  dropMark.hidden = true;
  if (!current.started) return;
  dragJustEnded = true;
  setTimeout(() => (dragJustEnded = false), 0);
  const target = e.type === 'pointerup' ? current.target : null;
  if (!target) return;
  try {
    placeOpened([await invoke('open_file', { path: current.entry.path })], target);
  } catch {
    toast(t.folderFailed);
  }
}

// Windows 탐색기에서 끌어오는 파일: Rust가 끄는 자리(drop-over)와 놓은 자리(documents의 값)를 알려 준다.
appWindow.listen('drop-over', ({ payload }) => showDropMark(dropTarget(payload.x, payload.y, null)));
appWindow.listen('drop-leave', () => (dropMark.hidden = true));

// ---- 지난번 상태: 열린 탭과 탭마다 보던 상태를 Rust가 앱 설정 폴더에 적어 둔다(경로는 Rust만 안다).
// 칸 번호(pane)와 그 칸에서 보이던 탭(shown)도 함께 적고, 칸 배치(나눔 나무)는 설정(layout)에 둔다.

/** 탭을 다시 열 때 쓸 보던 상태. 되살린 확대를 아직 적용하지 않은 탭(불러오지 않았거나 그리는 중)은 그 값을 그대로 둔다. */
function viewState(tab) {
  const { mode, fit, zoom, savedZoom, page, scroll } = tab;
  return { mode, fit, zoom: savedZoom !== 1 ? savedZoom : zoom, page, scroll };
}

let sessionTimer = null;
/** 탭 상태를 적는다. 자주 바뀌므로 묶어서 적고, now면 바로 적는다(창을 닫을 때). */
function saveSession(now = false) {
  clearTimeout(sessionTimer);
  const write = () => {
    const state = tabs.map((tab) => ({
      id: tab.id,
      view: { ...viewState(tab), pane: panes.indexOf(tab.pane), shown: tab.pane.active === tab },
    }));
    return invoke('save_session', { tabs: state, active: active?.id ?? null });
  };
  if (now) return write();
  sessionTimer = setTimeout(write, 300);
}

async function restoreSession() {
  const { tabs: saved, active: activeId } = await invoke('restore_session');
  // 나눈 배치: 저장해 둔 나무를 따르고, 없으면(좌우 두 칸만 되던 때) 칸 번호로 좌우로 놓는다.
  const used = new Set(saved.map(({ view }) => view?.pane ?? 0));
  let tree = restoreLayout(loadPref('layout'));
  if (!tree && used.has(1) && used.has(0)) {
    const ratio = loadPref('splitRatio') ?? 0.5;
    tree = restoreLayout({ dir: 'row', children: [{ pane: 0 }, { pane: 1 }], sizes: [ratio, 1 - ratio] });
  }
  const byIndex = new Map();
  if (tree) {
    // 처음 만든 칸(0번)을 나무의 첫 잎으로 쓰고 나머지 잎마다 칸을 만든다.
    const toPanes = (node) => {
      if (node.saved !== undefined) {
        const pane = byIndex.size === 0 ? panes[0] : createPane();
        byIndex.set(node.saved, pane);
        return { pane };
      }
      return { dir: node.dir, sizes: node.sizes, children: node.children.map(toPanes) };
    };
    layout = toPanes(tree);
    applyLayout();
  }
  for (const { opened, view } of saved) openTab(opened, view, false, byIndex.get(view?.pane ?? 0) ?? panes[0]);
  // 탭이 하나도 없는 칸은 없앤다.
  for (const pane of [...panes]) if (!tabsOf(pane).length) removePane(pane);
  // 칸마다 보이던 탭을 보이고, 마지막에 초점 칸의 탭을 고른다.
  for (const pane of panes) {
    const own = tabsOf(pane);
    const shown = own.find((tab) => saved.find((entry) => entry.opened.id === tab.id)?.view?.shown) ?? own[0];
    if (shown) activate(shown);
  }
  const tab = tabs.find((candidate) => candidate.id === activeId);
  if (tab) activate(tab);
  // 칸 번호를 나무 순서로 새로 매겼으므로(배치는 이미 적었다) 탭의 칸 번호도 바로 적어 둘이 어긋나지 않게 한다.
  if (tree) await saveSession(true);
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

/** 실행 인자·끌어다 놓기·두 번째 실행으로 들어온 문서를 탭으로 연다. 창에 끌어다 놓았으면 놓은 자리(at)에 맞춰 칸을 고르거나 나눈다. */
async function takeDocuments(event) {
  const at = event?.payload;
  dropMark.hidden = true;
  const list = await invoke('take_documents');
  if (at) placeOpened(list, dropTarget(at.x, at.y, null));
  else for (const opened of list) openTab(opened);
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
  // 첫 쪽을 그리기 전에는 렌더러가 쪽 있는 문서인지 아직 모른다(쪽 없는 문서처럼 CSS 확대가 걸려 풀리지 않는다).
  if (!active || active.loading) return;
  const applied = viewer()?.setZoom(value, focusX, focusY);
  if (!applied) return;
  active.zoom = applied;
  showToolbar();
}

/** Ctrl+휠: 문서 안에서는 마우스 아래 자리, 셸(상단바·탐색기) 위에서는 문서 가운데를 기준으로 키운다. 터치패드 오므리기도 Ctrl+휠로 온다. */
function onWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault(); // 문서가 없어도 WebView 전체 확대는 막는다.
  // 문서 위에서 굴렸으면 그 칸을 다룬다(나눈 화면에서 초점이 없는 칸 위).
  const tab = tabOfWindow(e.view);
  if (tab) focusPane(tab.pane);
  if (!active) return;
  const dy = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * WHEEL_LINE_PX : e.deltaY;
  // 문서 안에서 온 휠이면 마우스 자리를 기준으로, 셸(상단바·탐색기)에서 온 휠이면 문서 가운데를 기준으로 키운다.
  const inDoc = e.view !== window;
  setZoom(active.zoom * Math.exp(-dy * WHEEL_ZOOM_RATE), inDoc ? e.clientX : undefined, inDoc ? e.clientY : undefined);
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
  else if (ctrl && e.shiftKey && key === 't') reopenClosedTab();
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
    row.addEventListener('click', () => !dragJustEnded && openEntry(entry));
    row.addEventListener('pointerdown', (e) => startFileDrag(entry, row, e));
    row.addEventListener('pointermove', moveFileDrag);
    row.addEventListener('pointerup', endFileDrag);
    row.addEventListener('pointercancel', endFileDrag);
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
  resizer.classList.add('held');
  document.body.classList.add('resizing');
});
resizer.addEventListener('pointermove', (e) => {
  if (resizer.hasPointerCapture(e.pointerId)) setExplorerWidth(e.clientX - explorer.getBoundingClientRect().left);
});
const endResize = (e) => {
  if (!resizer.hasPointerCapture(e.pointerId)) return;
  resizer.releasePointerCapture(e.pointerId);
  resizer.classList.remove('held');
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

layout = { pane: createPane() };
applyLayout(false);
focusPane(panes[0]);
showExplorer(loadPref('explorer') ?? true);
showToolbar();
appWindow.listen('documents', takeDocuments);
// 창을 닫을 때: 탭마다 묶어 두던 읽던 위치를 바로 받고, 탭 상태를 미루지 않고 적는다. 이 처리가 끝나면 Tauri가 창을
// 없앤다(destroy, 그래서 core:window:allow-destroy 권한을 둔다). 적다가 실패해도 창은 닫히게 오류를 삼킨다.
appWindow.onCloseRequested(async () => {
  try {
    for (const tab of tabs) viewerOf(tab)?.flushPosition?.();
    await saveSession(true);
  } catch (error) {
    console.warn('닫기 전에 상태를 적지 못함', error);
  }
});
showFolder(await invoke('current_folder'));
await restoreSession();
await takeDocuments();
