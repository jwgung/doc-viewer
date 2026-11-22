import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = new URL('../src/renderers/sheet-grid.js', import.meta.url);
const css = new URL('../src/renderers/sheet.css', import.meta.url);
// 앱과 같은 전역 규칙(overscroll-behavior 등)에서 표 안쪽 휠이 막히지 않는지 보려고 viewer.css도 함께 싣는다.
const viewerCss = new URL('../src/viewer.css', import.meta.url);
const server = createServer(async (req, res) => {
  const files = { '/grid.js': [source, 'text/javascript'], '/grid.css': [css, 'text/css'], '/viewer.css': [viewerCss, 'text/css'] };
  const file = files[req.url];
  res.setHeader('Content-Type', file ? file[1] : 'text/html');
  res.end(file ? await readFile(file[0]) : `<!doctype html><link rel="stylesheet" href="/viewer.css"><link rel="stylesheet" href="/grid.css"><style>
    body { margin: 0 } .sheet-body { width: 500px; height: 300px }
  </style><div class="sheet-body"></div><script type="module">
    import { SheetGrid } from '/grid.js';
    const scroller = document.querySelector('.sheet-body');
    const grid = new SheetGrid(scroller, { fetchBlock: async () => ({ error: 'unused' }) });
    const sparse = () => ({ index: [], value: [] });
    await grid.show(0, { meta: {
      rowCount: 1, colCount: 1, defaultRowHeight: 20, defaultColWidth: 64,
      rowHeights: sparse(), colWidths: sparse(), rowStyles: sparse(), colStyles: sparse(),
      customRows: [], merges: [], freezeRows: 0, freezeCols: 0, showGrid: true,
      pictures: [], blockRows: 64,
    }, blocks: [{ start: 0, count: 1, offsets: [0, 1], cols: [0], kinds: [2], texts: ['a fairly long cell text for autofit'], xfs: [0] }], styles: {}, media: [] });
    window.grid = grid;
  </script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.grid);
  await page.mouse.move(250, 150);
  await page.mouse.wheel(200, 200);
  await page.waitForFunction(() => document.querySelector('.sheet-body').scrollTop >= 180);
  const scroll = await page.evaluate(() => ({ x: document.querySelector('.sheet-body').scrollLeft, y: document.querySelector('.sheet-body').scrollTop }));
  assert.ok(scroll.x >= 180 && scroll.y >= 180, `빈 셀 방향으로 계속 스크롤할 수 없음: ${JSON.stringify(scroll)}`);
  await page.evaluate(() => document.querySelector('.sheet-body').scrollTo(0, 0));
  const col = page.locator('.sg-hc').first();
  const beforeCol = await col.boundingBox();
  await page.mouse.move(beforeCol.x + beforeCol.width - 2, beforeCol.y + beforeCol.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeCol.x + beforeCol.width + 40, beforeCol.y + beforeCol.height / 2, { steps: 4 });
  await page.mouse.up();
  const afterCol = await page.locator('.sg-hc').first().boundingBox();
  assert.ok(afterCol.width > beforeCol.width + 20, `열 너비가 바뀌지 않음: ${beforeCol.width} → ${afterCol.width}`);
  const row = page.locator('.sg-hr').first();
  const beforeRow = await row.boundingBox();
  await page.mouse.move(beforeRow.x + beforeRow.width / 2, beforeRow.y + beforeRow.height - 2);
  await page.mouse.down();
  await page.mouse.move(beforeRow.x + beforeRow.width / 2, beforeRow.y + beforeRow.height + 30, { steps: 4 });
  await page.mouse.up();
  const afterRow = await page.locator('.sg-hr').first().boundingBox();
  assert.ok(afterRow.height > beforeRow.height + 15, `행 높이가 바뀌지 않음: ${beforeRow.height} → ${afterRow.height}`);
  // 머리글 경계 더블클릭: 열 너비는 내용에 맞춰 늘고, 다시 더블클릭해도 같은 값이다.
  const fitCol = await page.locator('.sg-hc').first().boundingBox();
  const fitX = fitCol.x + fitCol.width - 2;
  const fitY = fitCol.y + fitCol.height / 2;
  await page.mouse.dblclick(fitX, fitY);
  const fitted = await page.locator('.sg-hc').first().evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(fitted > 150 && fitted < 400, `열 더블클릭이 내용에 맞추지 않음: ${afterCol.width} → ${fitted}`);
  const fitRow = await page.locator('.sg-hr').first().boundingBox();
  await page.mouse.dblclick(fitRow.x + fitRow.width / 2, fitRow.y + fitRow.height - 2);
  const fittedRow = await page.locator('.sg-hr').first().evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(fittedRow < beforeRow.height + 15 && fittedRow >= 12, `행 더블클릭이 내용에 맞추지 않음: ${afterRow.height} → ${fittedRow}`);
  await page.evaluate(() => document.querySelector('.sheet-body').scrollTo(0, 0));
  const initialRows = await page.evaluate(() => window.grid.geo.nRows);
  await page.evaluate(() => {
    const el = document.querySelector('.sheet-body');
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForFunction((count) => window.grid.geo.nRows > count, initialRows);
  assert.equal(await page.locator('.sg-hc').first().evaluate((el) => el.getBoundingClientRect().width), fitted);
  console.log('sheet scroll and row/column resize: ok');
} finally {
  await browser.close();
  server.close();
}
