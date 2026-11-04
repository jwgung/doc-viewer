// 운영체제 파일 아이콘과 파일 연결을 만든다. 사이드바 문서 아이콘(src/icons.js fileIconMarkup)에 오른쪽 아래 앱 배지를 얹어
// 형식마다 .ico(Windows)·.icns(macOS)를 그리고, 같은 표(ASSOCIATIONS)로 파일 연결 설정을 함께 쓴다:
//   src-tauri/icons/files/<형식>.ico·.icns, tauri.conf.json의 bundle.fileAssociations(macOS·Linux),
//   src-tauri/windows/file-icons.nsh(설치 프로그램 exe), src-tauri/windows/file-icons.wxs(msi): Windows 연결을 직접 등록한다.
//     Tauri 기본 연결은 확장자 기본값을 덮어 Office 등의 "새로 만들기"를 없애므로 tauri.windows.conf.json에서 끈다(src-tauri/src/assoc.rs).
//   src-tauri/Info.plist(macOS 문서 형식과 아이콘; Tauri가 만드는 목록에는 아이콘 칸이 없어 이것으로 통째로 바꾼다),
//   src-tauri/tauri.macos.conf.json(.icns를 앱의 Contents/Resources에 넣는다). Windows 쪽 설정은 tauri.windows.conf.json에 손으로 둔다.
// 아이콘 색·글자나 연결할 확장자를 바꾸면 다시 실행해 결과를 함께 커밋한다(web의 playwright 크로미움으로 그린다).
//   node scripts/make-file-icons.js
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { formatOf } from '../src/formats.js';
import { fileIconMarkup } from '../src/icons.js';

const root = resolve(import.meta.dirname, '..');
const tauri = resolve(root, 'src-tauri');
const { chromium } = createRequire(resolve(root, '../web/package.json'))('playwright');

/**
 * 형식 → 연결할 확장자. 형식마다 아이콘이 다르므로 연결도 형식마다 하나다(이름이 Windows ProgID가 되므로 한 번 내보낸 뒤에는
 * 바꾸지 않는다). 스크립트·소스 코드(bat·ps1·js·py 등)와 프로그램 설정 파일(ini·cfg·conf 등)은 넣지 않는다: macOS·Linux에서는
 * 연결한 확장자의 기본 앱 후보가 되므로, 넣으면 더블클릭이 실행·편집 대신 보기가 될 수 있다. json·xml·toml·yaml은 보는 일이 많은
 * 데이터 파일이라 넣는다. 그림도 사진 앱을 빼앗지 않게 넣지 않는다. Windows에서는 "연결 프로그램" 후보로만 더한다.
 */
const ASSOCIATIONS = {
  pdf: ['pdf'],
  hwp: ['hwp', 'hwt'],
  hwpx: ['hwpx'],
  doc: ['doc', 'dot'],
  docx: ['docx', 'docm', 'dotx', 'dotm'],
  xls: ['xls', 'xlt'],
  xlsx: ['xlsx', 'xlsm', 'xltx', 'xltm'],
  csv: ['csv', 'tsv'],
  ppt: ['ppt', 'pps', 'pot'],
  pptx: ['pptx', 'pptm', 'ppsx', 'potx'],
  md: ['md', 'markdown'],
  txt: ['txt', 'text'],
  log: ['log'],
  json: ['json', 'jsonc'],
  xml: ['xml'],
  toml: ['toml'],
  yaml: ['yaml', 'yml'],
};
const PRODUCT = JSON.parse(readFileSync(resolve(tauri, 'tauri.conf.json'), 'utf8')).productName;
/** 설치되는 실행 파일 이름(Cargo 패키지 이름. Tauri 설치 프로그램이 그대로 쓴다) */
const BINARY = readFileSync(resolve(tauri, 'Cargo.toml'), 'utf8').match(/^name = "([^"]+)"/m)[1];
/** exe 설치 프로그램의 ProgID(연결 이름). msi는 예전 Tauri 연결과 같은 "제품 이름.확장자"를 그대로 쓴다(사용자가 고른 기본 앱이 유지된다). */
const progId = (fmt) => `DocViewer.${fmt}`;
const msiProgId = (ext) => `${PRODUCT}.${ext}`;
/** 형식 이름(ProgID 설명). macOS 문서 형식 이름과 같다. */
const typeName = (fmt) => `${fmt.toUpperCase()} document`;
const allExts = Object.values(ASSOCIATIONS).flat();
/** 설치 뒤 앱을 이 인자로 불러 예전 설치 프로그램이 덮은 확장자 기본값을 되돌린다(src-tauri/src/assoc.rs REPAIR_FLAG). */
const repairArgs = `--repair-file-associations ${allExts.join(' ')}`;

for (const [fmt, exts] of Object.entries(ASSOCIATIONS)) {
  for (const ext of exts) if (formatOf(`a.${ext}`) !== fmt) throw new Error(`${ext}는 ${fmt}로 열리지 않는다(formats.js와 맞춘다)`);
}

// ---- 그림

/** 앱 아이콘(네 색 타일)을 흰 원에 담은 배지. 중심 (23, 26.5), 반지름 6.3. */
const TILES = [
  ['#508FEA', 0, -2.45],
  ['#FD9646', -2.45, 0],
  ['#F2605C', 2.45, 0],
  ['#4EBF6B', 0, 2.45],
];
const BADGE =
  '<g transform="translate(23 26.5)"><circle r="6.3" fill="#fff" stroke="#CDD3DA" stroke-width="0.5"/>' +
  TILES.map(([fill, x, y]) => `<rect x="-1.55" y="-1.55" width="3.1" height="3.1" rx="0.7" fill="${fill}" transform="translate(${x} ${y}) rotate(45)"/>`).join('') +
  '</g>';

/** 정사각형 아이콘 SVG: 문서(24×30)와 배지를 33×33 칸 가운데에 둔다. 글자는 배지와 겹치지 않게 위로 올린다. */
const iconSvg = (fmt, size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-1.8 0 33 33">` +
  fileIconMarkup(fmt, { labelY: 19, font: 'Noto Sans, Segoe UI, sans-serif' }) +
  BADGE +
  '</svg>';

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
/** icns 칸 종류 → 그림 크기(PNG). icp4·icp5·icp6은 16·32·64, ic11~ic14는 레티나(2배). */
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

/** PNG 여러 장을 담은 .ico(Windows Vista 이후는 모든 크기에 PNG를 받는다) */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(([size, png], i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map(([, png]) => png)]);
}

function icns(chunks) {
  const parts = chunks.map(([type, png]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const pngCache = new Map();
async function png(fmt, size) {
  const key = `${fmt}@${size}`;
  if (!pngCache.has(key)) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0">${iconSvg(fmt, size)}</body></html>`);
    pngCache.set(key, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  }
  return pngCache.get(key);
}

const out = resolve(tauri, 'icons/files');
mkdirSync(out, { recursive: true });
for (const fmt of Object.keys(ASSOCIATIONS)) {
  const icoPngs = [];
  for (const size of ICO_SIZES) icoPngs.push([size, await png(fmt, size)]);
  writeFileSync(resolve(out, `${fmt}.ico`), ico(icoPngs));
  const icnsPngs = [];
  for (const [type, size] of ICNS_TYPES) icnsPngs.push([type, await png(fmt, size)]);
  writeFileSync(resolve(out, `${fmt}.icns`), icns(icnsPngs));
}
await browser.close();

// ---- 연결 설정

const confPath = resolve(tauri, 'tauri.conf.json');
const conf = readFileSync(confPath, 'utf8');
const lines = Object.entries(ASSOCIATIONS).map(
  ([fmt, exts]) => `      { "ext": [${exts.map((ext) => `"${ext}"`).join(', ')}], "name": "${progId(fmt)}", "role": "Viewer" }`,
);
const replaced = conf.replace(/("fileAssociations": \[\n)[\s\S]*?(\n {4}\])/, `$1${lines.join(',\n')}$2`);
if (replaced === conf && !conf.includes(lines[0])) throw new Error('tauri.conf.json에서 fileAssociations를 찾지 못했다');
writeFileSync(confPath, replaced);

const generated = '이 파일은 desktop/scripts/make-file-icons.js가 만든다. 손으로 고치지 말고 스크립트를 고쳐 다시 실행한다.';
mkdirSync(resolve(tauri, 'windows'), { recursive: true });

// Windows 연결: 이 앱의 ProgID(설명·아이콘·여는 명령)를 만들고 확장자의 OpenWithProgids에 더한다. 확장자 기본값은 건드리지 않는다:
// 탐색기 "새로 만들기"가 기본값이 가리키는 ProgID 아래 ShellNew를 찾으므로, 바꾸면 Office 등의 새로 만들기 항목이 사라진다.
// 설치 뒤 앱을 불러 예전 설치 프로그램이 덮은 기본값을 되돌린다.
const pairs = Object.entries(ASSOCIATIONS).flatMap(([fmt, exts]) => exts.map((ext) => [fmt, ext]));
const notify = "  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'";

// exe(NSIS): SHCTX는 설치 범위(기본은 사용자 키)다. 업데이트(/UPDATE)는 제거 없이 다시 설치하므로 같은 값을 다시 쓴다.
const nsisClass = (fmt) => `Software\\Classes\\${progId(fmt)}`;
writeFileSync(
  resolve(tauri, 'windows/file-icons.nsh'),
  [
    `; ${generated}`,
    '!macro NSIS_HOOK_POSTINSTALL',
    ...Object.keys(ASSOCIATIONS).flatMap((fmt) => [
      `  WriteRegStr SHCTX "${nsisClass(fmt)}" "" "${typeName(fmt)}"`,
      `  WriteRegStr SHCTX "${nsisClass(fmt)}\\DefaultIcon" "" "$INSTDIR\\icons\\files\\${fmt}.ico"`,
      `  WriteRegStr SHCTX "${nsisClass(fmt)}\\shell\\open\\command" "" \`"$INSTDIR\\\${MAINBINARYNAME}.exe" "%1"\``,
    ]),
    ...pairs.map(([fmt, ext]) => `  WriteRegStr SHCTX "Software\\Classes\\.${ext}\\OpenWithProgids" "${progId(fmt)}" ""`),
    `  ExecWait \`"$INSTDIR\\\${MAINBINARYNAME}.exe" ${repairArgs}\``,
    notify,
    '!macroend',
    '!macro NSIS_HOOK_POSTUNINSTALL',
    ...pairs.flatMap(([fmt, ext]) => [
      `  DeleteRegValue SHCTX "Software\\Classes\\.${ext}\\OpenWithProgids" "${progId(fmt)}"`,
      `  DeleteRegKey /ifempty SHCTX "Software\\Classes\\.${ext}\\OpenWithProgids"`,
    ]),
    ...Object.keys(ASSOCIATIONS).map((fmt) => `  DeleteRegKey SHCTX "${nsisClass(fmt)}"`),
    notify,
    '!macroend',
    '',
  ].join('\n'),
);

// msi(WiX): 컴퓨터 전체 설치(HKLM). 지우면 msi가 이 값들을 함께 지운다. OpenWithProgids 값의 내용은 Windows가 읽지 않는다(WiX는 빈 값을 받지 않는다).
// 구성 요소의 KeyPath(설치 여부를 판단하는 값)는 첫 값 하나에만 둔다. 여는 명령은 [#Path](Tauri main.wxs의 실행 파일)로 쓰면
// 실행 파일이 다른 기능(feature)에 있어 light가 ICE69로 멈추므로 설치 폴더 경로로 쓴다. 복구 동작(FileKey)은 그대로 [#Path]를 쓴다.
// 복구는 파일과 레지스트리를 쓴 뒤 시스템 권한(Impersonate="no")으로 돌리고, 실패해도 설치는 마친다.
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const wixClass = (ext) => `Software\\Classes\\${msiProgId(ext)}`;
const wixValues = pairs.flatMap(([fmt, ext]) => [
  [wixClass(ext), '', typeName(fmt)],
  [`${wixClass(ext)}\\DefaultIcon`, '', `[INSTALLDIR]icons\\files\\${fmt}.ico`],
  [`${wixClass(ext)}\\shell\\open\\command`, '', `"[INSTALLDIR]${BINARY}.exe" "%1"`],
  [`Software\\Classes\\.${ext}\\OpenWithProgids`, msiProgId(ext), PRODUCT],
]);
writeFileSync(
  resolve(tauri, 'windows/file-icons.wxs'),
  [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<!-- ${generated} -->`,
    '<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">',
    '  <Fragment>',
    '    <DirectoryRef Id="INSTALLDIR">',
    '      <Component Id="FileAssociations" Guid="3FD19C82-04BA-4F58-8575-5355205BB175">',
    ...wixValues.map(
      ([key, name, value], i) =>
        `        <RegistryValue Root="HKLM" Key="${attr(key)}"${name ? ` Name="${attr(name)}"` : ''} Type="string" Value="${attr(value)}"${i === 0 ? ' KeyPath="yes"' : ''} />`,
    ),
    '      </Component>',
    '    </DirectoryRef>',
    `    <CustomAction Id="RepairFileAssociations" FileKey="Path" ExeCommand="${repairArgs}" Execute="deferred" Impersonate="no" Return="ignore" />`,
    '    <InstallExecuteSequence>',
    '      <Custom Action="RepairFileAssociations" After="WriteRegistryValues">NOT (REMOVE~="ALL")</Custom>',
    '    </InstallExecuteSequence>',
    '  </Fragment>',
    '</Wix>',
    '',
  ].join('\n'),
);

// macOS: 문서 형식마다 아이콘(Contents/Resources/<형식>.icns, tauri.macos.conf.json이 넣는다)
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const types = Object.entries(ASSOCIATIONS).map(
  ([fmt, exts]) =>
    '    <dict>\n' +
    `      <key>CFBundleTypeName</key>\n      <string>${xml(typeName(fmt))}</string>\n` +
    `      <key>CFBundleTypeExtensions</key>\n      <array>\n${exts.map((ext) => `        <string>${ext}</string>`).join('\n')}\n      </array>\n` +
    `      <key>CFBundleTypeIconFile</key>\n      <string>${fmt}.icns</string>\n` +
    '      <key>CFBundleTypeRole</key>\n      <string>Viewer</string>\n' +
    '      <key>LSHandlerRank</key>\n      <string>Default</string>\n' +
    '    </dict>',
);
writeFileSync(
  resolve(tauri, 'Info.plist'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<!-- ${generated} -->\n<plist version="1.0">\n<dict>\n  <key>CFBundleDocumentTypes</key>\n  <array>\n${types.join('\n')}\n  </array>\n</dict>\n</plist>\n`,
);

writeFileSync(
  resolve(tauri, 'tauri.macos.conf.json'),
  `${JSON.stringify(
    { bundle: { macOS: { files: Object.fromEntries(Object.keys(ASSOCIATIONS).map((fmt) => [`Resources/${fmt}.icns`, `icons/files/${fmt}.icns`])) } } },
    null,
    2,
  )}\n`,
);

console.log(`형식 ${Object.keys(ASSOCIATIONS).length}개: 아이콘·연결 설정을 만들었다.`);
