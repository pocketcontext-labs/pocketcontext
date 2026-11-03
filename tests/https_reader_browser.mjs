#!/usr/bin/env node
// Invoked only by the opt-in synthetic Go fixture TestPublicHTTPSPhoneBrowser.
// Its self-signed TLS certificate is ignored in this isolated browser context;
// no trust store changes, external certificate requests, or real projects.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(fileURLToPath(new URL('../ui/package.json', import.meta.url)))('playwright');
const origin = 'https://knowledge.example.com';
const signIn = process.env.POCKETCONTEXT_SYNTHETIC_SIGNIN;
assert(signIn?.startsWith(`${origin}/bundle/login#`), 'requires synthetic Go fixture');
const port = process.env.POCKETCONTEXT_SYNTHETIC_PORT;
assert(/^\d+$/.test(port), 'requires synthetic TLS port');
const browser = await chromium.launch({args: ['--no-proxy-server', `--host-resolver-rules=MAP knowledge.example.com 127.0.0.1:${port}`]});
const problems = [];
async function phone() {
  const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,ignoreHTTPSErrors:true});
  await context.route('**/*', async route => {
    if (!route.request().url().startsWith(`${origin}/`)) {
      problems.push('unexpected external request');
      await route.abort();
    } else await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(error.message));
  page.on('response', response => {if (response.status() >= 500) problems.push(`server error ${response.status()}`);});
  return {context,page};
}
try {
  const {context,page} = await phone();
  await page.goto(origin);
  await page.getByLabel('Password', {exact:true}).waitFor();
  await page.goto(signIn);
  await page.waitForURL(`${origin}/`);
  await page.goto(`${origin}/#/sources/`);
  await page.getByRole('link', {name:'Synthetic phone evidence',exact:true}).waitFor();
  await page.reload();
  await page.getByRole('link', {name:'Synthetic phone evidence',exact:true}).waitFor();
  await page.getByRole('link', {name:'Synthetic phone evidence',exact:true}).click();
  await page.getByRole('heading', {name:'Synthetic phone evidence',exact:true}).waitFor();
  assert.equal(await page.evaluate(async () => (await fetch('/api/bundle/instance')).status),404);
  assert.equal(await page.evaluate(() => location.protocol),'https:');
  await context.close();
  const fresh = await phone();
  await fresh.page.goto(origin);
  await fresh.page.getByLabel('Password', {exact:true}).fill('synthetic-password');
  await fresh.page.getByRole('button', {name:'Sign in',exact:true}).click();
  await fresh.page.getByRole('button', {name:'Sign in',exact:true}).waitFor({state:'hidden'});
  await fresh.page.goto(`${origin}/#/sources/`);
  await fresh.page.getByRole('link', {name:'Synthetic phone evidence',exact:true}).waitFor();
  await fresh.context.close();
  assert.deepEqual(problems,[]);
  console.log('ok - mobile HTTPS sign-in link, persistent session, sources, password login, private route isolation');
} finally { await browser.close(); }
