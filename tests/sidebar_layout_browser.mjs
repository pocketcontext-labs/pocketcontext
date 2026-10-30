#!/usr/bin/env node
// Synthetic real-browser reader regression. Run after pnpm --dir ui install and
// pnpm --dir ui exec playwright install chromium. No real project is opened.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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
const temporary = await mkdtemp(path.join(os.tmpdir(), 'pocketcontext-sidebar-layout-test-'));
const screenshotOption = option('--screenshots');
const screenshots = screenshotOption ? path.resolve(screenshotOption) : await mkdtemp(path.join(os.tmpdir(), 'pocketcontext-sidebar-layout-shots-'));
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
function ok(message) { console.log(`ok - ${message}`); }

try {
  const port = await freePort();
  const vitePort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const upstream = `http://127.0.0.1:${vitePort}`;
  for (const name of ['src', 'index.html', 'package.json', 'vite.config.ts'])
    await cp(path.join(root, 'ui', name), path.join(ui, name), { recursive: true });
  await symlink(path.join(root, 'ui/node_modules'), path.join(ui, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await cli(['init', '--port', String(port), '--password-stdin'], 'synthetic layout password\n');
  const original = (await cli(['spaces']))[0];
  const longSpace = await cli(['create-space', 'Long'.repeat(50)]);
  await cli(['stop']);
  start(process.execPath, [path.join(root, 'ui/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort)], { cwd: ui, env: { ...process.env, POCKETCONTEXT_DEV_PORT: String(port) } });
  await until(async () => (await fetch(upstream)).ok, 'Vite readiness');
  start(binary, ['serve', '--db', db, '--ui-dev', upstream], { env, cwd: temporary });
  await until(async () => (await fetch(`${origin}/api/bundle/instance`)).ok, 'reader readiness');
  browser = await chromium.launch({ headless: true, executablePath: option('--browser') });
  const page = await browser.newPage({ viewport: { width: 1408, height: 900 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const signIn = await cli(['open', '--no-browser']);
  await page.goto(signIn.signInLink);
  const select = page.getByRole('combobox', { name: 'Space', exact: true });
  await select.waitFor();
  assert.equal(await select.inputValue(), original.id, 'short name is selected while long option controls intrinsic size');
  for (const width of [1408, 1280, 1101, 1100, 700, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await page.locator('.sidebar select[aria-label="Space"]').waitFor({ state: 'attached' });
    if (!(await select.isVisible())) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await select.waitFor();
    await select.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const bounds = await select.evaluate(element => {
      const row = element.parentElement;
      const sidebar = element.closest('.sidebar');
      const rect = element.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const sideRect = sidebar.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { left: rect.left, right: rect.right, rowLeft: rowRect.left, rowRight: rowRect.right,
        sideLeft: sideRect.left, sideRight: sideRect.right, scroll: sidebar.scrollWidth, client: sidebar.clientWidth,
        focus: document.activeElement === element, outline: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset) };
    });
    assert(bounds.left >= bounds.rowLeft - 1 && bounds.right <= bounds.rowRight + 1, `selector escapes row at ${width}px: ${JSON.stringify(bounds)}`);
    assert(bounds.scroll <= bounds.client + 1, `sidebar scrolls horizontally at ${width}px`);
    assert(bounds.focus, `keyboard focus returns to selector at ${width}px`);
    assert(bounds.left - bounds.outline >= bounds.sideLeft && bounds.right + bounds.outline <= bounds.sideRight, `focus outline is clipped at ${width}px: ${JSON.stringify(bounds)}`);
    if (screenshotOption) await page.screenshot({ path: path.join(screenshots, `sidebar-${width}.png`) });
  }
  await page.setViewportSize({ width: 1408, height: 900 });
  await page.reload();
  await select.waitFor();
  await select.selectOption(longSpace.id);
  await until(async () => (await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('space'))) === longSpace.id && await select.inputValue() === longSpace.id, 'space selection');
  await select.selectOption(original.id);
  await until(async () => await select.inputValue() === original.id, 'return to original space');
  assert.deepEqual(errors, []);
  ok('long space options stay within desktop/mobile sidebar; keyboard focus and space switching work');
} finally {
  await browser?.close();
  await cli(['stop']).catch(() => {});
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit').catch(() => {}) : undefined));
  await rm(temporary, { recursive: true, force: true });
  if (!screenshotOption) await rm(screenshots, { recursive: true, force: true });
}
