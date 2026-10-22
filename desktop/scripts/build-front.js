// 셸 파일과 웹 렌더러 빌드(web/dist)를 desktop/dist로 모은다. 렌더러는 dist/viewer/ 아래에 그대로 둔다.
// viewer.html의 CSP는 문서를 같은 출처에서만 받게 막혀 있어(connect-src 'self'), 데스크톱 빌드에서만 doc 스킴 출처를 더한다.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const web = resolve(root, '../web/dist');
const out = resolve(root, 'dist');

if (!existsSync(resolve(web, 'viewer.html'))) throw new Error('web/dist가 없습니다. 먼저 web에서 pnpm build를 실행하세요.');

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync(resolve(root, 'index.html'), resolve(out, 'index.html'));
cpSync(resolve(root, 'src'), resolve(out, 'src'), { recursive: true });
cpSync(web, resolve(out, 'viewer'), { recursive: true });

// Windows(WebView2)는 사용자 스킴을 http://doc.localhost로, 그 밖에는 doc://localhost로 부른다(src-tauri/src/main.rs의 DOC_ORIGIN).
const viewer = resolve(out, 'viewer/viewer.html');
const html = readFileSync(viewer, 'utf8');
const patched = html.replace("connect-src 'self'", "connect-src 'self' doc: http://doc.localhost");
if (patched === html) throw new Error("viewer.html CSP에서 connect-src 'self'를 찾지 못했습니다.");
writeFileSync(viewer, patched);
