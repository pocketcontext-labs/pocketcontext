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
const temporary = await mkdtemp(path.join(os.tmpdir(), 'pocketcontext-reader-test-'));
const screenshotOption = option('--screenshots');
const screenshots = screenshotOption ? path.resolve(screenshotOption) : await mkdtemp(path.join(os.tmpdir(), 'pocketcontext-reader-shots-'));
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
  for (const name of ['src', 'index.html', 'package.json', 'vite.config.ts']) {
    await cp(path.join(root, 'ui', name), path.join(ui, name), { recursive: true });
  }
  await symlink(path.join(root, 'ui/node_modules'), path.join(ui, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await cli(['init', '--email', 'reader@example.localhost', '--name', 'Reader Test', '--port', String(port), '--password-stdin'], 'synthetic reader password\n');
  await cli(['stop']);
  start(process.execPath, [path.join(root, 'ui/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort)], {
    cwd: ui, env: { ...process.env, POCKETCONTEXT_DEV_PORT: String(port) },
  });
  await until(async () => (await fetch(upstream)).ok, 'Vite readiness');
  start(binary, ['serve', '--db', db, '--ui-dev', upstream], { env, cwd: temporary });
  await until(async () => (await fetch(`${origin}/api/bundle/instance`)).ok, 'reader readiness');

  const note = path.join(temporary, 'observatory.md');
  await writeFile(note, '# Observatory evidence\n\nThe synthetic observatory opened in October. The telescope measures starlight every clear night.\n');
  const source = await cli(['ingest', note, '--title', 'Observatory evidence']);
  const passage = (await cli(['sql', `SELECT id FROM passages WHERE rendition='${source.rendition}' ORDER BY ordinal LIMIT 1`])).rows[0][0];
  const pages = [];
  const titles = ['Observatory edition one', 'Telescope catalog', 'Getting started', 'Account setup', 'Engineering handbook', 'Project notes', 'Team directory', 'Research transcript', 'Common answers', 'Historical notes', 'Release process', 'Newly published model'];
  const kinds = ['concept', 'entity', 'concept', 'concept', 'summary', 'summary', 'entity', 'transcript', 'answer', 'legacy', 'concept', 'entity'];
  for (let index = 0; index < 12; index++) {
    pages.push(await create('pages', { slug: index === 0 ? 'observatory' : `reference-${String(index).padStart(2, '0')}`, kind: kinds[index] }));
  }
  const revisions = new Map();
  const publications = [];
  const body = edition => `## Observatory overview\n\nThe **observatory** opened in October, edition ${edition}.[^1] It follows [[reference-01|telescope catalog notes]].\n\n<img src=x onerror="window.__readerInjected=true">\n\n## Reading and evidence\n\n${'The observatory keeps synthetic field notes so colleagues can compare the claim with its source. '.repeat(10)}[^1]\n\n## Next steps\n\nRead the evidence before using these fictional examples.[^1]`;
  for (let edition = 1; edition <= 2; edition++) {
    const run = await create('ingestion_runs', { key: `reader-edition-${edition}`, status: 'staging', description: 'Synthetic reader fixture' });
    const indexes = edition === 1 ? Array.from({ length: 11 }, (_, index) => index) : [0, 11];
    for (const index of indexes) {
      const properties = index === 2 ? { onboarding_order: 1 } : index === 3 ? { onboarding_order: 2 } : index === 1 ? { catalog_type: 'resource' } : index === 6 ? { catalog_type: 'person' } : index === 11 ? { catalog_type: 'model' } : {};
      const revision = await create('page_revisions', {
        run: run.id, page: pages[index].id, base_revision: revisions.get(index) || '',
        title: index === 0 && edition === 2 ? 'Observatory edition two' : titles[index],
        summary: `Synthetic ${titles[index].toLowerCase()} for reader layout checks.`,
        body: index === 0 ? body(edition) : `## Overview\n\nSynthetic ${titles[index].toLowerCase()}. [needs verification]`, properties,
      });
      revisions.set(index, revision.id);
      if (index === 0) {
        await create('citations', { page_revision: revision.id, passage, marker: '1', note: 'Compare this claim with the synthetic source.' });
        await create('page_links', { page_revision: revision.id, target: pages[1].id });
      }
    }
    await cli(['publish', run.id, '--expected-revision', String(run.revision)]);
    publications.push((await cli(['sql', 'SELECT id FROM publications ORDER BY sequence DESC LIMIT 1'])).rows[0][0]);
  }

  browser = await chromium.launch({ headless: true, executablePath: option('--browser') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(() => {
    // A previous reader preference and the operating system must not re-enable dark mode.
    try { localStorage.setItem('pocketcontext-theme', 'dark'); } catch { /* No storage on opaque origins. */ }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  await page.locator('.product-brand img').evaluate(async image => { await image.decode(); });
  assert(await page.locator('.product-brand img').evaluate(image => image.naturalWidth > 0), 'website logo must render under the reader security policy');
  await page.evaluate(() => document.fonts.load('700 20px PocketContextWordmark'));
  assert(await page.evaluate(() => document.fonts.check('700 20px PocketContextWordmark')), 'local wordmark font must load');
  await assertLight('anonymous login');
  await screenshot('login-desktop-light');
  const signIn = await cli(['open', '--no-browser']);
  await page.goto(signIn.signInLink);
  await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
  await assertLight('signed-in reader');
  ok('login and reader remain light with a legacy dark preference and dark operating system');
  async function screenshot(name) {
    if (name.startsWith('home-') || name.startsWith('reader-')) {
      await page.locator('#reader').evaluate(element => element.scrollTo(0, 0));
    }
    await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
  }
  async function route(hash, heading) {
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    await page.locator('.refresh-status').waitFor({ state: 'hidden' });
  }
  async function assertLight(label) {
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light', `${label}: native controls use light mode`);
    assert(await page.evaluate(() => {
      const channels = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
      return channels && channels.slice(0, 3).every(channel => Number(channel) > 200);
    }), `${label}: background remains light`);
    assert.equal(await page.getByRole('button', { name: /theme/i }).count(), 0, `${label}: theme controls are removed`);
  }
  async function noOverflow(label) {
    assert(await page.evaluate(() => {
      if (document.documentElement.scrollWidth > innerWidth + 1) return false;
      return ['#reader', '.topbar', '.evidence-panel'].every(selector => {
        const element = document.querySelector(selector);
        if (!element || element.getClientRects().length === 0) return true;
        const bounds = element.getBoundingClientRect();
        return element.scrollWidth <= element.clientWidth + 1 && bounds.left >= -1 && bounds.right <= innerWidth + 1;
      });
    }), `${label}: reader, toolbar and evidence fit without horizontal overflow`);
  }
  async function assertFocusInside(locator, description) {
    assert(await locator.evaluate(element => element.contains(document.activeElement)), description);
  }
  async function trapCheck(locator) {
    const selector = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex="0"]';
    const last = locator.locator(selector).filter({ visible: true }).last();
    const first = locator.locator(selector).filter({ visible: true }).first();
    await last.focus();
    await page.keyboard.press('Tab');
    assert(await first.evaluate(element => element === document.activeElement), 'Tab wraps to the first drawer/dialog control');
    await page.keyboard.press('Shift+Tab');
    assert(await last.evaluate(element => element === document.activeElement), 'Shift+Tab wraps to the last drawer/dialog control');
  }

  const onboarding = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Getting started' }) });
  assert.equal(await onboarding.getAttribute('open'), null, 'onboarding is initially collapsed');
  await onboarding.locator('summary').click();
  assert.deepEqual(await onboarding.getByRole('link').locator('strong').allTextContents(), ['Getting started', 'Account setup']);
  await onboarding.locator('summary').click();
  const recent = page.getByRole('region', { name: 'Recently published' });
  await recent.getByRole('link', { name: /Observatory edition two/ }).waitFor();
  await recent.getByRole('link', { name: /Newly published model/ }).waitFor();
  assert((await recent.getByRole('link').count()) <= 6);
  await noOverflow('desktop Home');
  await screenshot('home-desktop-light');
  await route(`#/welcome?publication=${publications[0]}`, 'Home');
  assert.equal(await page.getByText('Newly published model', { exact: true }).count(), 0, 'historical Home excludes pages first published later');
  await recent.getByRole('link', { name: /Observatory edition one/ }).waitFor();
  for (const href of await recent.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))) {
    assert(href.includes(`publication=${publications[0]}`), 'historical recent links retain selected publication');
  }
  ok('Home is compact, onboarding explicit and collapsible, recents respect publication history');

  await route('#/page/observatory', 'Observatory edition two');
  assert.equal(await page.locator('.markdown p').first().evaluate(element => getComputedStyle(element).fontSize), '16px');
  await noOverflow('desktop reader');
  await screenshot('reader-desktop-light');
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.locator('.sidebar').waitFor({ state: 'hidden' });
  await noOverflow('desktop collapsed navigation');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.locator('.sidebar').waitFor({ state: 'visible' });
  // The assertions below exercise the accessible controls added by the reader UI.
  await page.locator('.copy-links > summary').click();
  await page.getByRole('button', { name: /^Current page/ }).click();
  await page.getByText(/Copied/).first().waitFor();
  let copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(copied.origin, origin);
  assert(copied.hash.startsWith('#/page/observatory'));
  assert(!copied.hash.includes('publication='), 'current link follows future publications');
  await page.locator('.copy-links > summary').click();
  await page.getByRole('button', { name: /^This version/ }).click();
  copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  assert(copied.hash.includes(`publication=${publications[1]}`), 'version link pins displayed publication');
  const versions = page.getByRole('combobox', { name: 'Version', exact: true });
  assert.equal(await versions.locator('option[value="live"]').innerText(), 'Current version');
  assert(/\d{4}/.test(await versions.locator(`option[value="${publications[0]}"]`).innerText()), 'historical version options include dates');
  await versions.selectOption(publications[0]);
  await page.getByRole('heading', { name: 'Observatory edition one', exact: true }).waitFor();
  await page.locator('.copy-links > summary').click();
  await page.getByRole('button', { name: /^This version/ }).click();
  copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  assert(copied.hash.includes(`publication=${publications[0]}`), 'historical page copies its own selected publication');
  await versions.selectOption('live');
  await page.getByRole('heading', { name: 'Observatory edition two', exact: true }).waitFor();
  ok('dated version history and copy menu distinguish current and pinned links with copy feedback');

  const citation = page.getByRole('button', { name: 'Citation 1', exact: true }).first();
  await citation.click();
  const evidence = page.locator('.evidence-panel');
  await evidence.waitFor();
  await evidence.getByRole('link', { name: /Open original/ }).waitFor();
  assert.notEqual(await evidence.getAttribute('aria-modal'), 'true', 'wide reader docks evidence without a modal');
  await evidence.getByText('Observatory evidence', { exact: true }).waitFor();
  assert(await page.locator('.citation-claim-active').count(), 'cited claim remains identifiable beside evidence');
  await noOverflow('docked evidence');
  await screenshot('evidence-desktop-light');
  const repeatedCitation = page.getByRole('button', { name: 'Citation 1', exact: true }).nth(1);
  await repeatedCitation.click();
  await until(() => repeatedCitation.evaluate(element => element.closest('p')?.classList.contains('citation-claim-active')), 'changing a repeated citation while evidence stays open highlights the clicked claim');
  await evidence.getByRole('button', { name: /Close/ }).click();
  await evidence.waitFor({ state: 'hidden' });
  ok('desktop evidence stays beside the readable claim');

  for (const [label, width, height] of [['split', 960, 900], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await route('#/page/observatory', 'Observatory edition two');
    const navigation = page.getByRole('button', { name: /Open navigation/ });
    await navigation.waitFor();
    await navigation.click();
    const drawer = page.locator('.sidebar');
    await assertFocusInside(drawer, `${label}: opening drawer moves focus inside`);
    await trapCheck(drawer);
    await screenshot(`drawer-${label}-light`);
    await page.keyboard.press('Escape');
    await until(() => navigation.evaluate(element => element === document.activeElement), `${label}: Escape returns focus to navigation trigger`);
    await citation.click();
    await evidence.waitFor();
    await evidence.getByRole('link', { name: /Open original/ }).waitFor();
    assert.equal(await evidence.getAttribute('aria-modal'), 'true', `${label}: evidence uses a modal`);
    await trapCheck(evidence);
    await screenshot(`evidence-${label}-light`);
    await page.keyboard.press('Escape');
    await evidence.waitFor({ state: 'hidden' });
    await until(() => citation.evaluate(element => element === document.activeElement), `${label}: evidence dismissal returns citation focus`);
    await noOverflow(`${label} reader`);
    await route('#/welcome', 'Home');
    await noOverflow(`${label} Home`);
    await screenshot(`home-${label}-light`);
  }
  ok('split/mobile navigation and evidence trap focus, close on Escape, restore focus and fit viewport');

  await route('#/page/observatory', 'Observatory edition two');
  await assertLight('mobile reader');
  await noOverflow('mobile reader');
  await screenshot('reader-mobile-light');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await route('#/welcome', 'Home');
  await page.getByRole('searchbox', { name: 'Search published pages' }).fill('observatory');
  await page.getByRole('searchbox', { name: 'Search published pages' }).press('Enter');
  await page.getByRole('heading', { name: 'Search results', exact: true }).waitFor();
  const snippet = page.locator('.search-excerpt').first();
  await snippet.waitFor();
  assert(await snippet.locator('mark.search-highlight').count() > 0, 'search highlights matched terms');
  assert(!/\[\^\d+\]|\[\[|\]\]|\*\*|<img|onerror=/.test(await snippet.innerText()), 'search snippet removes Markdown and HTML syntax');
  assert.equal(await page.locator('.search-results img, .search-results script').count(), 0);
  assert.equal(await page.evaluate(() => window.__readerInjected), undefined);
  assert.equal(await snippet.evaluate(element => getComputedStyle(element).webkitLineClamp), '3');
  await screenshot('search-desktop-light');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('mobile search');
  await screenshot('search-mobile-light');
  assert(!(await snippet.innerText()).includes('reference-01'), 'internal link aliases hide raw target slugs in snippets');
  await route('#/page/observatory', 'Observatory edition two');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawerSearch = page.locator('.sidebar').getByRole('searchbox', { name: 'Search pages', exact: true });
  await drawerSearch.fill('observatory');
  await drawerSearch.press('Enter');
  await page.getByRole('heading', { name: 'Search results', exact: true }).waitFor();
  await until(() => page.locator('#reader').evaluate(element => element === document.activeElement), 'drawer search Enter focuses the results reader after closing');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: /Pages/ }).click();
  const directoryHeading = page.getByRole('heading', { name: 'The complete page index', exact: true });
  await directoryHeading.waitFor();
  await until(() => directoryHeading.evaluate(element => element === document.activeElement), 'Pages navigation focuses the complete directory');
  await until(() => directoryHeading.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 60 && bounds.bottom <= innerHeight;
  }), 'Pages navigation finishes scrolling the directory into view', 5000);
  await screenshot('pages-mobile-light');

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await route('#/page/observatory', 'Observatory edition two');
  await citation.click();
  await evidence.waitFor();
  await page.setViewportSize({ width: 960, height: 900 });
  await until(() => evidence.getAttribute('aria-modal').then(value => value === 'true'), 'docked evidence becomes modal on resize');
  assert.equal(await page.locator('.navigation-backdrop').count(), 0, 'resizing does not resurrect a previously open drawer beneath evidence');
  await page.keyboard.press('Escape');
  await evidence.waitFor({ state: 'hidden' });
  assert.equal(errors.length, 0, 'reader has no browser runtime errors');
  ok('search snippets safely render plain highlighted excerpts and fit mobile width');
  console.log(`Reader screenshots: ${screenshots}`);
  console.log('all reader UI browser checks passed');
} finally {
  await browser?.close();
  await cli(['stop']).catch(() => {});
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit').catch(() => {}) : undefined));
  await rm(temporary, { recursive: true, force: true });
}
