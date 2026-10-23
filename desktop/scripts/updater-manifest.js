// 앱 업데이트 정보(latest.json)를 만든다. release.yml이 Release를 만들 때 부른다. 앱은 이 파일을
// https://github.com/<저장소>/releases/latest/download/latest.json 에서 읽는다(tauri.conf.json plugins.updater).
//   node desktop/scripts/updater-manifest.js <설치 파일 폴더> <태그> <저장소>   → <설치 파일 폴더>/latest.json
// 폴더에는 release.yml이 붙인 이름의 설치 파일과 서명(.sig)이 있다. 서명이 있는 것만 넣는다.
// 설치 형식마다 따로 적어(os-arch-형식) 같은 Windows라도 exe로 설치한 앱은 exe를, msi로 설치한 앱은 msi를 받는다.
// deb로 설치한 Linux 앱은 받을 것이 없어(형식 없는 키를 두지 않는다) 새 deb를 직접 받는다.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, tag, repo] = process.argv.slice(2);
if (!dir || !tag || !repo) throw new Error('사용: updater-manifest.js <폴더> <태그> <저장소>');

/** 파일 이름 끝 → 업데이트 대상(latest.json의 platforms 키) */
const TARGETS = [
  ['-windows-setup.exe', ['windows-x86_64-nsis']],
  ['-windows.msi', ['windows-x86_64-msi']],
  // macOS는 Apple 실리콘·Intel 공용(universal) 묶음 하나를 둘 다에 준다.
  ['-macos.app.tar.gz', ['darwin-aarch64-app', 'darwin-x86_64-app']],
  ['-linux-amd64.AppImage', ['linux-x86_64-appimage']],
];

const files = readdirSync(dir);
const platforms = {};
for (const [suffix, keys] of TARGETS) {
  const file = files.find((name) => name.endsWith(suffix));
  if (!file || !files.includes(`${file}.sig`)) continue;
  const entry = {
    url: `https://github.com/${repo}/releases/download/${tag}/${file}`,
    signature: readFileSync(join(dir, `${file}.sig`), 'utf8').trim(),
  };
  for (const key of keys) platforms[key] = entry;
}
if (!Object.keys(platforms).length) throw new Error('서명된 업데이트 파일이 없습니다');

const manifest = {
  version: tag.replace(/^v/, ''),
  notes: `https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json: ${Object.keys(platforms).join(', ')}`);
