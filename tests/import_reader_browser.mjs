#!/usr/bin/env node
// Synthetic real-browser reader regression. Run after pnpm --dir ui install and
// pnpm --dir ui exec playwright install chromium. No real project is opened.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  assert(process.argv[index + 1], `${name} requires a value`);
  return process.argv[index + 1];
}
const binary = path.resolve(option('--binary', path.join(root, 'bin/pocketcontext')));
const { chromium } = createRequire(path.join(root, 'ui/package.json'))('playwright');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'pocketcontext-import-reader-test-'));
const screenshotOption = option('--screenshots');
const screenshots = screenshotOption ? path.resolve(screenshotOption) : await mkdtemp(path.join(os.tmpdir(), 'pocketcontext-import-reader-shots-'));
const home = path.join(temporary, 'home');
const ui = path.join(temporary, 'ui');
const db = path.join(temporary, 'project', 'pocketcontext.db');
await Promise.all([mkdir(home), mkdir(ui), mkdir(path.dirname(db)), mkdir(screenshots, { recursive: true })]);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('POCKETCONTEXT_')));
Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
const children = [];
let browser;

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function start(command, argv, options = {}) {
  const child = spawn(command, argv, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += chunk; });
  child.stderr.on('data', () => {}); // Never print authentication URLs or request logs.
  children.push(child);
  return child;
}
async function cli(argv, input) {
  const child = start(binary, ['--db', db, ...argv], { env, cwd: temporary });
  const ended = once(child, 'exit');
  child.stdin.end(input);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    const [code] = await ended;
    assert.equal(code, 0, `CLI ${argv[0]} failed`);
    return child.output.trim() ? JSON.parse(child.output) : null;
  } finally { clearTimeout(timeout); }
}
async function until(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}
const create = (collection, body) => cli(['create', collection, '-'], JSON.stringify(body));
function ok(message) { console.log(`ok - ${message}`); }

try {
  const port = await freePort();
  const vitePort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const upstream = `http://127.0.0.1:${vitePort}`;
  for (const name of ['src', 'index.html', 'package.json', 'vite.config.ts'])
    await cp(path.join(root, 'ui', name), path.join(ui, name), { recursive: true });
  await symlink(path.join(root, 'ui/node_modules'), path.join(ui, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await cli(['init', '--port', String(port), '--password-stdin'], 'synthetic import password\n');
  const sourceSpace = (await cli(['spaces']))[0];
  const targetSpace = await cli(['create-space', 'Destination collection']);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  const imagePath = path.join(temporary, 'diagram.png');
  await writeFile(imagePath, png);
  const image = await cli(['ingest', imagePath]);
  async function publish(space, key, pages) {
    const staged = await cli(['--space', space, 'stage', '-'], JSON.stringify({ run_key: key, pages: pages.map(page => ({ summary: 'Synthetic import reader fixture.', ...page })) }));
    assert.deepEqual(staged.problems, []);
    await cli(['--space', space, 'publish', staged.run, '--expected-revision', String(staged.revision)]);
  }
  await publish(targetSpace.id, 'destination', [{ slug: 'overview', kind: 'legacy', title: 'Destination overview', body: '## Target heading\n\nIndependent destination. [needs verification]' }]);
  await publish(sourceSpace.id, 'imported', [{ slug: 'imported', kind: 'legacy', title: 'Imported collection page', properties: { import_format: 'obsidian' }, body: `Imported prose[^import-1]. [needs verification]\n\n![Synthetic diagram](source:${image.source} "size=320")\n\n[Other collection](space:${targetSpace.id}/overview#Target%20heading)\n\n[^import-1]: Preserved source reference: [diagram original](source:${image.source}).` }]);
  await cli(['stop']);
  start(process.execPath, [path.join(root, 'ui/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort)], { cwd: ui, env: { ...process.env, POCKETCONTEXT_DEV_PORT: String(port) } });
  await until(async () => (await fetch(upstream)).ok, 'Vite readiness');
  start(binary, ['serve', '--db', db, '--ui-dev', upstream], { env, cwd: temporary });
  await until(async () => (await fetch(`${origin}/api/bundle/instance`)).ok, 'reader readiness');
  browser = await chromium.launch({ headless: true, executablePath: option('--browser') });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(15_000);
  const signIn = await cli(['open', '--no-browser']);
  await page.goto(signIn.signInLink);
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await page.goto(`${origin}/#/page/imported?space=${sourceSpace.id}`);
  await page.getByRole('heading', { name: 'Imported collection page', exact: true }).waitFor();
  const inline = page.locator('.source-image-open img');
  await inline.waitFor();
  await inline.evaluate(async img => { await img.decode(); });
  assert.equal(await inline.evaluate(img => img.naturalWidth), 1);
  assert((await inline.getAttribute('src')).startsWith('blob:'), 'image uses locally verified blob');
  assert.equal(await inline.getAttribute('width'), '320');
  await page.getByRole('button', { name: 'Enlarge Synthetic diagram' }).click();
  const dialog = page.locator('.source-image-dialog');
  assert(await dialog.isVisible());
  assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'modal takes focus');
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download original' }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'diagram.png');
  const stream = await download.createReadStream();
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  assert.deepEqual(Buffer.concat(parts), png, 'download retains original bytes');
  await page.keyboard.press('Escape');
  assert(!(await dialog.isVisible()));
  assert.equal(await page.locator('.citation').count(), 0, 'imported footnote is not a verified citation');
  const footnote = page.locator('a[href="#user-content-fn-import-1"]');
  await footnote.click();
  await page.getByRole('link', { name: 'diagram original' }).click();
  await until(() => Promise.resolve(page.url().includes(`#/sources/${image.source}`)), 'footnote source navigation');
  await page.goto(`${origin}/#/page/imported?space=${sourceSpace.id}`);
  await page.getByRole('link', { name: 'Other collection' }).click();
  await page.getByRole('heading', { name: 'Destination overview', exact: true }).waitFor();
  assert(page.url().includes(`space=${targetSpace.id}`));
  assert(!page.url().includes('publication='));
  assert.equal(await page.getByRole('combobox', { name: 'Space', exact: true }).inputValue(), targetSpace.id);
  await page.screenshot({ path: path.join(screenshots, 'cross-space.png'), fullPage: true });
  await page.goto(`${origin}/#/page/imported?space=${sourceSpace.id}`);
  await page.locator('.source-image-open img').waitFor();
  await page.screenshot({ path: path.join(screenshots, 'imported-image-footnote.png'), fullPage: true });
  assert.deepEqual(errors, []);
  ok('protected image load, modal focus, byte-exact download, imported footnote source link and cross-space navigation');
  if (screenshotOption) console.log(`Import reader screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await cli(['stop']).catch(() => {});
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit').catch(() => {}) : undefined));
  await rm(temporary, { recursive: true, force: true });
  if (!screenshotOption) await rm(screenshots, { recursive: true, force: true });
}
