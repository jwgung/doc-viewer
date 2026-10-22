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
    emptyHint: '왼쪽에서 폴더를 열어 문서를 고르거나, 문서를 여기에 끌어다 놓으세요.',
    unsupported: '지원하지 않는 형식의 파일입니다.',
    folderFailed: '폴더를 읽지 못했습니다.',
    refresh: '새로 고침',
    open: '열기',
    rename: '이름 바꾸기',
    reveal: '탐색기에서 보기',
    copyPath: '경로 복사',
    trash: '삭제',
    trashTitle: '삭제',
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
    emptyHint: 'Open a folder on the left and pick a document, or drop documents here.',
    unsupported: 'This file type is not supported.',
    folderFailed: "Couldn't read the folder.",
    refresh: 'Refresh',
    open: 'Open',
    rename: 'Rename',
    reveal: 'Show in File Explorer',
    copyPath: 'Copy path',
    trash: 'Delete',
    trashTitle: 'Delete',
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

const { invoke } = window.__TAURI__.core;
const { getCurrentWebviewWindow } = window.__TAURI__.webviewWindow;
const appWindow = getCurrentWebviewWindow();

const $ = (id) => document.getElementById(id);
const frames = $('frames');
const tabBar = $('tabs');
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

// ---- 탭: { id, name, fmt, frame, button, mode, fit, zoom, page, scroll, lastUsed, hasOutline, hasNotes, notesShown, printing }
// 문서는 탭을 처음 볼 때 불러온다(지난번 탭을 여러 개 되살려도 보는 탭만 그린다).
// 탭을 많이 열어도 메모리가 쌓이지 않게, 최근에 본 MAX_AWAKE개 밖이거나 오래 안 본 탭은 재운다:
// 렌더러(iframe)를 버리고 보던 상태(쪽·스크롤·확대·보기 방식)만 남겼다가, 다시 보면 그 상태로 새로 불러온다.

const MAX_AWAKE = 4;
const IDLE_SLEEP_MS = 15 * 60 * 1000;

/** @type {Array<object>} */
const tabs = [];
let active = null;

const viewerOf = (tab) => tab?.frame.contentWindow?.viewer;
const viewer = () => viewerOf(active);

/**
 * 문서를 탭으로 연다. view는 지난번에 보던 상태(되살릴 때)다: { mode, fit, zoom, page, scroll }.
 * select가 false면 탭만 만들고 보지 않는다(되살리기).
 */
function openTab(opened, view = null, select = true) {
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
  tab.button.addEventListener('click', () => activate(tab));
  tab.button.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && activate(tab));
  // 가운데 단추로 누르면 닫는다(브라우저 탭과 같이).
  tab.button.addEventListener('auxclick', (e) => e.button === 1 && closeTab(tab));
  tabBar.appendChild(tab.button);

  tabs.push(tab);
  if (select) activate(tab);
  else saveSession();
}

function createFrame(tab) {
  const frame = document.createElement('iframe');
  frame.title = tab.name;
  frame.hidden = tab !== active;
  frame.addEventListener('load', () => {
    frame.contentWindow?.addEventListener('keydown', onKey);
    frame.contentWindow?.addEventListener('wheel', onWheel, { passive: false });
  });
  frames.appendChild(frame);
  return frame;
}

/** 탭을 재운다: 렌더러를 버리고 다시 볼 때 쓸 상태만 남긴다. */
function sleepTab(tab) {
  if (tab === active || !tab.frame.src || tab.printing) return;
  viewerOf(tab)?.closeOverlay(); // 모아 두던 읽던 위치를 바로 알리게 한다(검색 막대도 닫힌다).
  // 되살린 확대를 아직 적용하기 전(그리는 중)이면 그 값을 그대로 둔다.
  if (tab.savedZoom === 1) tab.savedZoom = tab.zoom;
  Object.assign(tab, { zoom: 1, hasOutline: false, hasNotes: false, notesShown: false });
  const old = tab.frame;
  tab.frame = createFrame(tab);
  old.remove();
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

function activate(tab) {
  active = tab;
  for (const other of tabs) {
    other.frame.hidden = other !== tab;
    other.button.classList.toggle('active', other === tab);
    other.button.setAttribute('aria-selected', String(other === tab));
  }
  tab.lastUsed = Date.now();
  loadTab(tab);
  tab.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  showToolbar();
  sleepIdleTabs();
  saveSession();
}

function closeTab(tab) {
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  tabs.splice(index, 1);
  tab.frame.remove();
  tab.button.remove();
  invoke('close_document', { id: tab.id });
  if (active === tab) {
    active = null;
    const next = tabs[Math.min(index, tabs.length - 1)];
    if (next) activate(next);
    else showToolbar();
  }
  saveSession();
}

// ---- 지난번 상태: 열린 탭과 탭마다 보던 상태를 Rust가 앱 설정 폴더에 적어 둔다(경로는 Rust만 안다).

let sessionTimer = null;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const state = tabs.map(({ id, mode, fit, zoom, savedZoom, page, scroll, frame }) => ({
      id,
      // 아직 불러오지 않은 탭은 되살린 상태를 그대로 둔다.
      view: { mode, fit, zoom: frame.src ? zoom : savedZoom, page, scroll },
    }));
    invoke('save_session', { tabs: state, active: active?.id ?? null });
  }, 300);
}

async function restoreSession() {
  const { tabs: saved, active: activeId } = await invoke('restore_session');
  for (const { opened, view } of saved) openTab(opened, view, false);
  const tab = tabs.find((candidate) => candidate.id === activeId) ?? tabs[0];
  if (tab) activate(tab);
}

function cycleTab(step) {
  if (tabs.length < 2) return;
  activate(tabs[(tabs.indexOf(active) + step + tabs.length) % tabs.length]);
}

/** 상단바를 지금 탭에 맞춘다. 창 제목은 늘 앱 이름이다(작업 표시줄에 파일 이름을 붙이지 않는다). */
function showToolbar() {
  const tab = active;
  document.body.classList.toggle('has-doc', !!tab);
  document.body.classList.toggle('paged', !!tab && isPaged(tab.fmt));
  $('empty').hidden = !!tab;
  $('loading').hidden = !tab?.loading;
  if (!tab) return;
  $('loading-name').textContent = tab.name;
  viewButton.replaceChildren(
    lineIcon(VIEW_ICONS[tab.mode]),
    Object.assign(document.createElement('span'), { textContent: `${MODE_LABELS()[tab.mode]} · ${FIT_LABELS()[tab.fit]}` }),
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
        break;
      case 'done':
        tab.loading = false;
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
  if (!active) return;
  const dy = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40 : e.deltaY;
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
const VIEW_ICONS = { scroll: 'viewScroll', page: 'viewPage', spread: 'viewSpread' };
const MODE_LABELS = () => ({ scroll: t.viewModeScroll, page: t.viewModePage, spread: t.viewModeSpread });
const FIT_LABELS = () => ({ width: t.fitWidth, page: t.fitPage });

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
    ...Object.entries(MODE_LABELS()).map(([mode, label]) => ({
      label,
      icon: VIEW_ICONS[mode],
      checked: active.mode === mode,
      run: () => setView({ mode }),
    })),
    'separator',
    { heading: t.fit },
    ...Object.entries(FIT_LABELS()).map(([fit, label]) => ({
      label,
      icon: fit === 'width' ? 'fitWidth' : 'fitPage',
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
  explorer.hidden = !visible;
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
      // 펼쳐 둔 폴더 기억도 새 경로로 옮긴다.
      for (const path of [...expanded]) {
        if (path === entry.path || path.startsWith(entry.path + '\\') || path.startsWith(entry.path + '/')) {
          expanded.delete(path);
          expanded.add(changed.path + path.slice(entry.path.length));
        }
      }
      savePref('expanded', [...expanded]);
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
    const changed = await invoke('trash_entry', { path: entry.path, title: t.trashTitle, message: t.trashMessage(entry.name) });
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
$('toggle-explorer').addEventListener('click', () => showExplorer(explorer.hidden));

// 사이드바 폭: 경계선 어디든 끌어서 바꾼다. 끄는 동안 문서 iframe이 마우스를 가로채지 않게 막는다.
const MIN_EXPLORER = 180;
function setExplorerWidth(width) {
  explorer.style.width = `${Math.round(Math.min(Math.max(width, MIN_EXPLORER), innerWidth * 0.6))}px`;
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

showExplorer(loadPref('explorer') ?? true);
showToolbar();
appWindow.listen('documents', takeDocuments);
showFolder(await invoke('current_folder'));
await restoreSession();
await takeDocuments();
