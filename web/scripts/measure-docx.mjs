// DOCX를 데스크톱 Chromium에서 열어 첫 쪽 시간과 렌더러 메모리를 잰다. 빌드한 web/dist를 그대로 띄운다.
// 문서 묶음(corpus)은 저장소에 없으므로 spike/renderer-eval/scripts의 안내대로 만든 폴더를 가리킨다.
//
// 사용: pnpm build && node scripts/measure-docx.mjs [--corpus <폴더>] [--repeat 3] [--cpu 1] [--mode scroll] <문서 id 또는 경로>...
//   예: node scripts/measure-docx.mjs --repeat 5 docx-poi-075
//   --cpu 4  CPU를 4배 느리게 해서 느린 기기를 흉내 낸다(실기기는 데스크톱의 1.8~4배 느리다).
//   메모리는 렌더러 프로세스의 PSS를 읽는다(Linux 전용). '열린 직후'는 첫 쪽이 보인 순간 GC 없이 읽은 값(실기기에서 본 값과
//   같은 성격이고 정리 안 된 쓰레기를 포함한다), 'GC 뒤'는 강제로 GC를 돌린 뒤 값(실제로 쥐고 있는 양)이다.
import { readFileSync, createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return fallback;
  return args.splice(at, 2)[1];
};
const corpus = resolve(option('corpus', '../spike/renderer-eval/corpus'));
const repeat = Number(option('repeat', 3));
const cpuRate = Number(option('cpu', 1));
const mode = option('mode', 'scroll');
const targets = args;
if (targets.length === 0) {
  console.error('문서 id(예: docx-poi-075)나 경로를 하나 이상 주세요.');
  process.exit(1);
}

const dist = resolve(import.meta.dirname, '../dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  const file = url.pathname === '/doc' ? url.searchParams.get('path') : join(dist, decodeURIComponent(url.pathname));
  try {
    statSync(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
const browserCdp = await browser.newBrowserCDPSession();

/** 렌더러 프로세스 가운데 가장 큰 것(문서를 연 쪽)의 PSS(MB). */
async function rendererPssMb() {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
  let best = 0;
  for (const proc of processInfo.filter((p) => p.type === 'renderer')) {
    try {
      best = Math.max(best, Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${proc.id}/smaps_rollup`, 'utf8'))?.[1] ?? 0) / 1024);
    } catch {}
  }
  return Math.round(best);
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

for (const target of targets) {
  const file = target.includes('/') ? resolve(target) : join(corpus, 'docx', `${target}.docx`);
  const rows = [];
  for (let run = 0; run < repeat; run++) {
    const context = await browser.newContext({ viewport: { width: 800, height: 1280 } });
    const page = await context.newPage();
    // 앱이 WebView에 주입하는 AndroidViewer 통로를 흉내 내 측정 이벤트를 받는다.
    await page.addInitScript(() => {
      window.__events = [];
      window.AndroidViewer = { report: (payload) => window.__events.push({ t: performance.now(), ...JSON.parse(payload) }) };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    if (cpuRate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    await page.goto(`${base}/viewer.html?fmt=docx&src=${encodeURIComponent(`/doc?path=${file}`)}&mode=${mode}`);
    await page.waitForFunction(() => window.__events.some((e) => e.event === 'done' || e.event === 'error'), null, { timeout: 300_000, polling: 50 });
    const pssAtDone = await rendererPssMb();
    await page.waitForTimeout(1500); // 이어서 그리는 쪽과 이미지가 자리 잡을 시간
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(300);
    const events = await page.evaluate(() => window.__events);
    const done = events.find((e) => e.event === 'done');
    const error = events.find((e) => e.event === 'error');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    rows.push({
      error: error?.message,
      firstPageMs: done?.firstPageMs,
      totalMs: done?.totalMs,
      pages: done?.pages,
      byPage: done?.docxByPage,
      jsHeapMb: Math.round(m.JSHeapUsedSize / 1e6),
      domNodes: m.Nodes,
      pssAtDoneMb: pssAtDone,
      rendererPssMb: await rendererPssMb(),
    });
    await context.close();
  }
  const ok = rows.filter((r) => !r.error);
  if (ok.length === 0) {
    console.log(`${target}: 열지 못했다 — ${rows[0].error}`);
    continue;
  }
  console.log(
    `${target}: ${ok[0].pages}쪽, 쪽 단위 ${ok[0].byPage ? '예' : '아니오'} | 첫 쪽 ${median(ok.map((r) => r.firstPageMs))}ms (${ok.map((r) => r.firstPageMs).join('/')}) | ` +
      `완료 보고 ${median(ok.map((r) => r.totalMs))}ms | JS 힙 ${median(ok.map((r) => r.jsHeapMb))}MB | DOM 노드 ${median(ok.map((r) => r.domNodes))} | 렌더러 PSS 열린 직후 ${median(ok.map((r) => r.pssAtDoneMb))}MB, GC 뒤 ${median(ok.map((r) => r.rendererPssMb))}MB`,
  );
}
await browser.close();
server.close();
