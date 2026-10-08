// 빌드에 실제로 들어간 외부 패키지의 라이선스 고지를 모아 third-party-licenses.txt로 내보낸다.
// 앱의 '앱 정보' 화면이 이 파일을 그대로 보여준다.
// 워커 번들은 Vite가 따로 빌드하므로, 두 빌드가 같은 목록(collected)을 채우고 본 빌드가 마지막에 파일을 쓴다.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const collected = new Map(); // 패키지 디렉터리 → { name, version, license, text }
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;
// 자기 dist 안에 다른 패키지를 합쳐 넣은 경우. 빌드 모듈 목록에는 안 나오므로 따로 고지한다.
const INLINED = { jszip: ['pako'], '@web-ppt/core': ['fflate'] };

function packageDirOf(id) {
  const path = id.replace(/^\0/, '').split('?')[0];
  const marker = '/node_modules/';
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = path.slice(at + marker.length).split('/');
  const nameParts = rest[0].startsWith('@') ? 2 : 1;
  return path.slice(0, at + marker.length) + rest.slice(0, nameParts).join('/');
}

function collect(id) {
  const dir = packageDirOf(id);
  if (!dir || collected.has(dir)) return;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  const text = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n');
  collected.set(dir, { name: pkg.name, version: pkg.version, license: pkg.license ?? '(no license information)', text });
  for (const inner of INLINED[pkg.name] ?? []) collect(installedDir(dir, inner) + '/');
}

/** parentDir 패키지 기준으로 inner 패키지가 설치된 디렉터리를 찾는다(exports가 package.json을 막아도 동작). */
function installedDir(parentDir, inner) {
  let dir = dirname(createRequire(join(parentDir, 'package.json')).resolve(inner));
  while (!dir.endsWith(`/node_modules/${inner}`)) dir = dirname(dir);
  return dir;
}

function render() {
  const entries = [...collected.values()].sort((a, b) => a.name.localeCompare(b.name));
  const line = '='.repeat(60);
  // 앱 정보 화면에 그대로 보이는 파일이다. 라이선스 원문이 영어라 머리말도 영어로 둔다.
  const header = 'Open source software included in this app, and its licenses.\n';
  return (
    header +
    entries.map((e) => `\n${line}\n${e.name} ${e.version} (${e.license})\n${line}\n${e.text || '(no license file)'}`).join('\n') +
    '\n'
  );
}

function collectBundle(bundle) {
  for (const output of Object.values(bundle)) {
    if (output.type === 'chunk') for (const id of output.moduleIds ?? Object.keys(output.modules)) collect(id);
  }
}

/** 워커 빌드에 넣는 플러그인: 모듈만 모은다. */
export function collectLicenses() {
  return { name: 'third-party-licenses:collect', generateBundle: (_, bundle) => collectBundle(bundle) };
}

/** 본 빌드에 넣는 플러그인: 모은 뒤 파일을 쓴다(워커 번들은 본 빌드의 generateBundle 전에 끝난다). */
export function emitLicenses(fileName = 'third-party-licenses.txt') {
  return {
    name: 'third-party-licenses:emit',
    generateBundle(_, bundle) {
      collectBundle(bundle);
      this.emitFile({ type: 'asset', fileName, source: render() });
    },
  };
}
