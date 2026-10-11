#!/usr/bin/env node
// Synthetic fixture only: smoke-test the actual ONCE proxy and served reader.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/package.json'));
const {chromium, expect} = require('@playwright/test');
const [fixture, state] = process.argv.slice(2);
if (!fixture || !state) {
  console.error('Usage: browser_smoke.mjs SYNTHETIC_FIXTURE ENGINE_STATE');
  process.exit(2);
}
let browser;
try {
  const config = JSON.parse(fs.readFileSync(path.join(fixture, 'clone.private.json'), 'utf8'));
  const engine = JSON.parse(fs.readFileSync(state, 'utf8'));
  if (!Number.isInteger(engine.http_port) || engine.http_port < 1024 || engine.http_port > 65535 || config.test_users[0].email !== 'agent@example.com') throw new Error('Invalid fixture');
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage();
  await page.goto(`http://wiki-rehearsal.localhost:${engine.http_port}`, {waitUntil: 'networkidle'});
  await page.getByText('Sign in with a password', {exact: true}).click();
  await page.getByLabel('Email', {exact: true}).fill(config.test_users[0].email);
  await page.getByLabel('Password', {exact: true}).fill(config.test_users[0].password);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  const picker = page.getByLabel('Space', {exact: true});
  await expect(picker).toHaveValue('companyspace001', {timeout: 15000});
  const personal = await picker.locator('option').evaluateAll(opts => opts.map(o => o.value).find(v => v !== 'companyspace001'));
  if (!personal) throw new Error('Personal option absent');
  await picker.selectOption(personal);
  const privateLink = page.getByRole('link', {name: 'Private pearl', exact: true});
  await expect(privateLink).toBeVisible({timeout: 15000});
  await privateLink.click();
  await expect(page.getByRole('heading', {name: 'Private pearl', exact: true})).toBeVisible();
  await page.reload({waitUntil: 'networkidle'});
  await expect(picker).toHaveValue(personal);
  await expect(page.getByRole('heading', {name: 'Private pearl', exact: true})).toBeVisible();
  await picker.selectOption('companyspace001');
  await expect(page.getByText('Private pearl', {exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.getByText('Sign in with a password', {exact: true})).toBeVisible();
  console.log('PASS actual ONCE browser login, Company default, private page, reload, space switch and logout');
} catch {
  console.error('ONCE browser smoke failed; credentials and page contents suppressed.');
  process.exitCode = 1;
} finally {
  await browser?.close();
}
