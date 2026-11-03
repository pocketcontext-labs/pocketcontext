#!/usr/bin/env node
// Only the opt-in Go fixture supplies this isolated server and fake ACP agent.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(fileURLToPath(new URL('../ui/package.json', import.meta.url)))('playwright');
const origin = process.env.POCKETCONTEXT_SYNTHETIC_CHAT_ORIGIN;
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || ''));
const signIn = process.env.POCKETCONTEXT_SYNTHETIC_SIGNIN;
assert(signIn?.startsWith(`${origin}/bundle/login#`));
const browser = await chromium.launch({args:['--no-proxy-server']});
const problems=[];
try {
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await context.route('**/*',async route=>{
  if(!route.request().url().startsWith(`${origin}/`)){problems.push('unexpected external request');await route.abort();}
  else await route.continue();
 });
 const page=await context.newPage();
 page.on('pageerror',error=>problems.push(error.message));
 await page.goto(signIn);
 await page.waitForURL(`${origin}/`);
 await page.getByRole('button',{name:'Chat',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('button',{name:'New conversation'}).click();
 const send=dialog.getByRole('button',{name:'Send',exact:true});
 await dialog.getByLabel('Message',{exact:true}).fill('hello');
 await send.click();
 await dialog.getByText('Synthetic response',{exact:true}).waitFor();
 await dialog.getByLabel('Message',{exact:true}).fill('permission');
 await send.click();
 await dialog.getByRole('heading',{name:'Approval requested'}).waitFor();
 await dialog.getByRole('button',{name:'Close chat'}).click();
 await page.reload();
 await page.getByRole('button',{name:'Chat',exact:true}).click();
 const select=dialog.getByRole('combobox');
 try { await select.locator('option').nth(1).waitFor({state:'attached',timeout:10000}); }
 catch(error) { console.error('Synthetic chat DOM:',await page.locator('body').innerText()); throw error; }
 await select.selectOption({index:1});
 await dialog.getByRole('heading',{name:'Approval requested'}).waitFor();
 const reject=dialog.getByRole('button',{name:/reject/i});
 await reject.click();
 await dialog.getByRole('heading',{name:'Approval requested'}).waitFor({state:'hidden'});
 await dialog.getByLabel('Message',{exact:true}).fill('hang');
 await send.click();
 await dialog.getByRole('button',{name:'Stop',exact:true}).click();
 await dialog.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden'});
 await dialog.getByRole('button',{name:'End conversation'}).click();
 await dialog.getByRole('button',{name:'End conversation'}).waitFor({state:'hidden'});
 assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'phone drawer fits viewport');
 assert.deepEqual(problems,[]);
 console.log('ok - phone chat, streaming, native permission rejection, reload reconnect, cancellation, end conversation');
 await context.close();
} finally {await browser.close();}
