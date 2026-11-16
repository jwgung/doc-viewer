import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import XLSX from 'xlsx';

const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['first', 1], ['second', 2]]), 'Sheet 1');
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['other']]), 'Sheet 2');
const fixture = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
const server = await createServer({
  server: { port: 0 },
  plugins: [{ name: 'sheet-zoom-fixture', configureServer(vite) {
    vite.middlewares.use('/fixture.xlsx', (_req, res) => {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.end(fixture);
    });
  } }],
});
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/viewer.html`);
  await page.evaluate(() => window.viewer.open({ fmt: 'xlsx', src: '/fixture.xlsx' }));
  await page.locator('.sg-hc').first().waitFor();
  const before = await page.evaluate(() => ({
    tabs: document.querySelector('.sheet-tabs').getBoundingClientRect().height,
    cell: document.querySelector('.sg-hc').getBoundingClientRect().width,
    body: document.querySelector('.sheet-body').getBoundingClientRect().height,
  }));
  await page.evaluate(() => window.viewer.setZoom(2, 400, 250));
  const after = await page.evaluate(() => ({
    tabs: document.querySelector('.sheet-tabs').getBoundingClientRect().height,
    cell: document.querySelector('.sg-hc').getBoundingClientRect().width,
    body: document.querySelector('.sheet-body').getBoundingClientRect().height,
  }));
  assert.equal(after.tabs, before.tabs, `시트 목록까지 확대됨: ${before.tabs} → ${after.tabs}`);
  assert.ok(after.cell >= before.cell * 1.9, `표가 확대되지 않음: ${before.cell} → ${after.cell}`);
  assert.equal(after.body, before.body, '표 영역이 화면 밖으로 넘침');
  await page.getByRole('button', { name: 'Sheet 2' }).click();
  await page.locator('.sg-cells .c span', { hasText: 'other' }).first().waitFor();
  assert.equal(await page.locator('.sheet-tabs').evaluate((el) => el.getBoundingClientRect().height), before.tabs);
  await page.evaluate(() => window.viewer.setZoom(1, 400, 250));
  const restored = await page.evaluate(() => ({
    tabs: document.querySelector('.sheet-tabs').getBoundingClientRect().height,
    cell: document.querySelector('.sg-hc').getBoundingClientRect().width,
  }));
  assert.equal(restored.tabs, before.tabs);
  assert.equal(restored.cell, before.cell);
  console.log('sheet zoom keeps tabs fixed: ok');
} finally {
  await browser.close();
  await server.close();
}
