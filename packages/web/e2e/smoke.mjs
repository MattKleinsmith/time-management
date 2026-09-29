import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const base = process.env.BASE ?? 'http://localhost:8787';
const shots = process.env.SHOTS ?? 'scratch/shots';
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const errors = [];
const log = (...a) => console.log('[smoke]', ...a);

async function newPage(ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { errors.push(`pageerror: ${e.message}`); console.log('PAGEERROR', e.message, e.stack?.split('\n').slice(0,4).join(' / ')); });
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(`console: ${m.text()}`); console.log('CONSOLE', m.text().slice(0, 600)); } });
  return { ctx, page };
}

// ---------- desktop ----------
{
  const { ctx, page } = await newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${base}/?mock=1`);
  await page.waitForSelector('.week', { timeout: 15000 });
  await page.waitForSelector('.event', { timeout: 15000 });
  await page.waitForTimeout(800);
  const count = await page.locator('.event:not(.ghost)').count();
  log('desktop events rendered:', count);
  if (count < 5) throw new Error('too few events');
  await page.screenshot({ path: `${shots}/desktop-week.png` });

  // active alert overlay present (mock seeds "Take medication" started 7 min ago)
  await page.waitForSelector('.alert-card', { timeout: 10000 });
  log('alert card visible:', await page.locator('.alert-card strong').first().innerText());

  // open editor via double click on an event
  const ev = page.locator('.event:not(.ghost)', { hasText: 'Pick up groceries' }).first();
  await ev.dblclick();
  await page.waitForSelector('.editor');
  log('editor title:', await page.locator('.editor .title-input').inputValue());
  await page.screenshot({ path: `${shots}/desktop-editor.png` });

  // change TM interval and save
  await page.locator('.editor .tm-form input[type=number]').nth(1).fill('3');
  await page.locator('.editor .editor-actions .btn.primary').click();
  await page.waitForSelector('.toast.success', { timeout: 10000 });
  log('saved edit');
  await page.waitForSelector('.editor', { state: 'detached' });

  // drag-move an event by 60px down (≈ 1h at 56px/h → snapped)
  await ev.scrollIntoViewIfNeeded();
  const box = await ev.boundingBox();
  const beforeTitle = await ev.getAttribute('title');
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 30, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 56, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const afterTitle = await page.locator('.event:not(.ghost)', { hasText: 'Pick up groceries' }).first().getAttribute('title');
  log('drag move:', beforeTitle.split('\n')[1], '->', afterTitle.split('\n')[1]);
  if (beforeTitle === afterTitle) throw new Error('drag did not move the event');

  // drag a recurring event → scope prompt appears; choose "This event only"
  const rec = page.locator('.event:not(.ghost)', { hasText: 'Exercise' }).first();
  await rec.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const rbox = await rec.boundingBox();
  if (rbox) {
    await page.mouse.move(rbox.x + rbox.width / 2, rbox.y + 8);
    await page.mouse.down();
    await page.mouse.move(rbox.x + rbox.width / 2, rbox.y + 40, { steps: 8 });
    await page.mouse.move(rbox.x + rbox.width / 2, rbox.y + 8 + 56, { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector('.modal', { timeout: 5000 });
    await page.screenshot({ path: `${shots}/desktop-scope-prompt.png` });
    await page.locator('.modal button', { hasText: 'This event only' }).click();
    await page.waitForTimeout(600);
    log('recurring instance moved (exception created)');
  }

  // keyboard: n opens create editor; type title; Enter creates
  await page.keyboard.press('Escape');
  await page.keyboard.press('n');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/debug-after-n.png` });
  log('active element:', await page.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className));
  log('toasts:', await page.locator('.toast').allInnerTexts());
  await page.waitForSelector('.editor .title-input');
  await page.keyboard.type('Keyboard-created event');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast.success', { timeout: 10000 });
  log('keyboard create ok');

  // acknowledge the active alert with "a"
  await page.keyboard.press('Escape');
  await page.keyboard.press('a');
  await page.waitForTimeout(600);
  const remaining = await page.locator('.alert-card').count();
  log('alerts after ack:', remaining);

  // read-only event: double-click → notice shown
  await page.locator('.event:not(.ghost)', { hasText: 'Yoga' }).first().dblclick();
  await page.waitForSelector('.editor .notice');
  log('read-only notice:', (await page.locator('.editor .notice').first().innerText()).slice(0, 80));
  await page.screenshot({ path: `${shots}/desktop-readonly.png` });
  await page.keyboard.press('Escape');

  // day view + agenda + settings
  await page.keyboard.press('d');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/desktop-day.png` });
  await page.keyboard.press('g');
  await page.waitForSelector('.agenda');
  await page.screenshot({ path: `${shots}/desktop-agenda.png` });
  await page.keyboard.press(',');
  await page.waitForSelector('.settings');
  await page.screenshot({ path: `${shots}/desktop-settings.png` });
  await page.keyboard.press('?');
  await page.waitForSelector('.shortcuts');
  await page.screenshot({ path: `${shots}/desktop-help.png` });
  await ctx.close();
}

// ---------- mobile ----------
{
  const { ctx, page } = await newPage({ ...devices['iPhone 13'] });
  await page.goto(`${base}/?mock=1`);
  await page.waitForSelector('.now', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/mobile-now.png`, fullPage: false });
  log('mobile now current:', await page.locator('.now-current .big-title').innerText());
  const ackBtn = page.locator('.now-alerts .btn.primary').first();
  if (await ackBtn.count()) {
    await ackBtn.tap();
    await page.waitForTimeout(500);
    log('mobile ack done, alerts left:', await page.locator('.now-alerts .alert-card').count());
  }
  await page.locator('.mobile-nav button', { hasText: 'Day' }).tap();
  await page.waitForSelector('.agenda');
  await page.screenshot({ path: `${shots}/mobile-agenda.png` });
  await page.locator('.mobile-nav button', { hasText: 'Grid' }).tap();
  await page.waitForSelector('.week');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/mobile-grid.png` });
  await page.locator('.mobile-nav .fab').tap();
  await page.waitForSelector('.editor');
  await page.screenshot({ path: `${shots}/mobile-editor.png` });
  await ctx.close();
}

await browser.close();
if (errors.length) {
  console.log('ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
log('OK');
