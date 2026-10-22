#!/usr/bin/env node
// Real-browser development-mode check. Install Playwright separately or pass
// --playwright /absolute/path/to/playwright/index.mjs. An existing Chromium can
// be selected with --browser /absolute/path/to/chromium. Synthetic data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert(args[index + 1], `${name} requires a value`);
  return args[index + 1];
}
const binary = path.resolve(option('--binary', path.join(root, 'bin/pocketcontext')));
const playwrightPath = option('--playwright');
const uiRequire = createRequire(path.join(root, 'ui/package.json'));
const { chromium } = playwrightPath ? await import(pathToFileURL(path.resolve(playwrightPath)).href) : uiRequire('playwright');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'pocketcontext-ui-dev-'));
const home = path.join(temporary, 'home');
const ui = path.join(temporary, 'ui');
const db = path.join(temporary, 'project', 'pocketcontext.db');
await Promise.all([mkdir(home), mkdir(ui), mkdir(path.dirname(db))]);
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
  child.stderr.on('data', () => {}); // No URLs, tokens or server request logs in test output.
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
  for (const name of ['src', 'index.html', 'package.json', 'vite.config.ts']) {
    await cp(path.join(root, 'ui', name), path.join(ui, name), { recursive: true });
  }
  await symlink(path.join(root, 'ui/node_modules'), path.join(ui, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await cli(['init', '--email', 'browser@example.localhost', '--name', 'Browser Test', '--port', String(port), '--password-stdin'], 'synthetic browser password\n');
  await cli(['stop']);
  const startVite = () => start(process.execPath, [path.join(root, 'ui/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort)], {
    cwd: ui, env: { ...process.env, POCKETCONTEXT_DEV_PORT: String(port) },
  });
  let vite = startVite();
  await until(async () => (await fetch(upstream)).ok, 'Vite readiness');
  let server = start(binary, ['serve', '--db', db, '--ui-dev', upstream], { env, cwd: temporary });
  await until(async () => (await fetch(`${origin}/api/bundle/instance`)).ok, 'PocketContext readiness');

  const original = '# Synthetic browser source\n\nThe observatory opened in October.\n';
  const note = path.join(temporary, 'observatory.md');
  await writeFile(note, original);
  const ingested = await cli(['ingest', note]);
  const identity = await cli(['create', 'pages', JSON.stringify({ slug: 'observatory', kind: 'concept' })]);
  let revision = '';
  async function publish(edition) {
    const run = await cli(['create', 'ingestion_runs', JSON.stringify({ key: `browser-${edition}`, status: 'staging', description: 'Synthetic browser check' })]);
    const next = await cli(['create', 'page_revisions', '-'], JSON.stringify({ run: run.id, page: identity.id, base_revision: revision, title: 'Observatory', summary: 'Synthetic browser fixture.', body: `Edition ${edition} [needs verification]` }));
    await cli(['publish', run.id, '--expected-revision', String(run.revision)]);
    revision = next.id;
  }
  await publish(1);
  browser = await chromium.launch({ headless: true, executablePath: option('--browser') });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const sockets = [];
  const requests = [];
  const errors = [];
  page.on('websocket', socket => sockets.push(socket.url()));
  page.on('request', request => requests.push(new URL(request.url())));
  page.on('pageerror', error => errors.push(error.message));
  const signIn = await cli(['open', '--no-browser']);
  await page.goto(signIn.signInLink);
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  await page.evaluate(() => { location.hash = '#/page/observatory'; });
  await page.getByText('Edition 1 [needs verification]', { exact: true }).waitFor();
  ok('one-time open link signs into the reader on the backend origin');
  await until(async () => sockets.some(url => new URL(url).pathname === '/__ui_hmr'), 'same-origin hot-reload connection');
  assert(sockets.every(url => new URL(url).port === String(port)), 'HMR must not bypass the backend');
  assert(requests.every(url => url.origin === origin), 'all UI and API requests must use the backend origin');
  ok('Vite modules and hot-reload WebSocket use the backend origin');

  const documentMarker = await page.evaluate(() => (window.__uiTestDocument = crypto.randomUUID()));
  const initialPID = server.pid;
  const css = path.join(ui, 'src/styles.css');
  await writeFile(css, `${await readFile(css, 'utf8')}\nbody { --pocketcontext-hmr-check: updated; }\n`);
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--pocketcontext-hmr-check').trim() === 'updated');
  const component = path.join(ui, 'src/App.tsx');
  const source = await readFile(component, 'utf8');
  assert(source.includes('YOUR CONNECTED KNOWLEDGE'));
  await writeFile(component, source.replace('YOUR CONNECTED KNOWLEDGE', 'SYNTHETIC HOT UPDATE'));
  await page.getByText('SYNTHETIC HOT UPDATE', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiTestDocument), documentMarker, 'CSS and component edits must preserve the document');
  assert.equal(server.pid, initialPID);
  assert.equal(server.exitCode, null, 'the same Go process must stay running');
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  assert.equal(errors.length, 0, 'reader must have no browser runtime errors');
  ok('CSS and React edits update without navigation, sign-in loss or Go restart');

  await until(async () => requests.some(url => url.pathname === '/api/realtime'), 'reader realtime connection');
  await publish(2);
  await page.getByText('Edition 2 [needs verification]', { exact: true }).waitFor();
  ok('publication realtime updates still reach the reader');

  const viteStopped = once(vite, 'exit');
  vite.kill('SIGTERM');
  await viteStopped;
  await until(async () => (await fetch(origin)).status === 502, 'clear unavailable Vite response');
  assert((await fetch(`${origin}/api/bundle/instance`)).ok, 'Go API stays available if Vite stops');
  ok('Vite failure returns 502 while the backend remains healthy');
  vite = startVite();
  await until(async () => (await fetch(`${origin}/@vite/client`)).ok, 'Vite restart');
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  await writeFile(css, `${await readFile(css, 'utf8')}\nbody { --pocketcontext-hmr-check: reconnected; }\n`);
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--pocketcontext-hmr-check').trim() === 'reconnected');
  assert.equal(server.pid, initialPID);
  assert.equal(server.exitCode, null);
  assert(sockets.every(url => new URL(url).port === String(port)));
  assert.equal(errors.length, 0, 'Vite restart must have no browser runtime errors');
  ok('hot reload recovers after restarting Vite with the same Go process');
  await page.evaluate(sourceID => { location.hash = `#/sources/${sourceID}`; }, ingested.source);
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original' }).click();
  const download = await downloadReady;
  assert.equal(await readFile(await download.path(), 'utf8'), original);
  const sourceRecord = await cli(['get', 'sources', ingested.source]);
  const denied = await fetch(`${origin}/api/files/sources/${sourceRecord.id}/${sourceRecord.original}`);
  assert.equal(denied.status, 404, 'originals must still require file authorization');
  ok('authenticated original download is byte-exact and anonymous access is denied');

  await cli(['stop']);
  await until(async () => server.exitCode !== null, 'development server shutdown');
  server = start(binary, ['serve', '--db', db], { env, cwd: temporary });
  await until(async () => (await fetch(`${origin}/api/bundle/instance`)).ok, 'embedded server readiness');
  const embedded = await fetch(origin);
  assert.equal(embedded.status, 200);
  assert(!(await embedded.text()).includes('/@vite/client'));
  const embeddedContext = await browser.newContext();
  const embeddedPage = await embeddedContext.newPage();
  const embeddedSignIn = await cli(['open', '--no-browser']);
  await embeddedPage.goto(embeddedSignIn.signInLink);
  await embeddedPage.getByRole('button', { name: 'Sign out' }).waitFor();
  ok('the same binary still serves the signed-in embedded reader by default');
  console.log('all UI development browser checks passed');
} finally {
  await browser?.close();
  await cli(['stop']).catch(() => {});
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit').catch(() => {}) : undefined));
  await rm(temporary, { recursive: true, force: true });
}
