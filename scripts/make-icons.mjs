// Renders the SVG icon to PNGs for the PWA manifest / apple-touch-icon.
import { chromium } from 'playwright';
import fs from 'node:fs';
const svg = fs.readFileSync('packages/web/public/icons/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') && fs.statSync('/opt/pw-browsers/chromium').isFile() ? '/opt/pw-browsers/chromium' : undefined });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:#0f172a">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `packages/web/public/icons/${name}`, omitBackground: false });
  await page.close();
}
await browser.close();
console.log('icons written');
