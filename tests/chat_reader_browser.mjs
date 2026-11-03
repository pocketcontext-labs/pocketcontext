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
 await page.addInitScript(() => {
   window.SpeechRecognition = class {
     start(){this.onresult({resultIndex:0,results:[{isFinal:true,0:{transcript:"hello"}}]});queueMicrotask(()=>this.onend());}
     stop(){} abort(){}
   };
 });
 await page.goto(signIn);
 await page.waitForURL(`${origin}/`);
 await page.getByRole('button',{name:'Chat',exact:true}).click();
 const dialog=page.getByRole('region',{name:'Chat workspace'});
 await dialog.getByRole('button',{name:/New chat/}).click();
 const shield=dialog.getByRole('button',{name:'Chat permissions',exact:true});
 await shield.click();
 await dialog.getByRole('radio',{name:/Read-only/}).waitFor();
 await page.keyboard.press('Escape');
 await dialog.getByRole('radio',{name:/Read-only/}).waitFor({state:'hidden'});
 const send=dialog.getByRole('button',{name:'Send',exact:true});
 await dialog.getByLabel('Model',{exact:true}).selectOption('second');
 await dialog.locator('input[type=file]').setInputFiles({name:'pixel.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ZkAAAAASUVORK5CYII=','base64')});
 await dialog.getByRole('img',{name:'Attachment 1',exact:true}).waitFor();
 await dialog.getByRole('button',{name:'Dictate message'}).click();
 assert.equal(await dialog.getByLabel('Message',{exact:true}).inputValue(),'hello');
 await send.click();
 await dialog.getByText('Synthetic response',{exact:true}).waitFor();
 await dialog.getByRole('img',{name:'Attached image 1',exact:true}).waitFor();
 assert.equal(await dialog.getByLabel('Model',{exact:true}).inputValue(),'second');
 const history=dialog.getByRole('navigation',{name:'Chat history'});
 const spaceHeader=dialog.getByLabel('Conversation space');
 assert.equal(await spaceHeader.isVisible(),true);
 const historyToggle=page.getByRole('button',{name:'Conversation history'});
 assert.equal(await history.isVisible(),false);
 await historyToggle.click();
 await history.getByRole('button',{name:'hello',exact:true}).first().click();
 assert.equal(await history.isVisible(),false);
 await page.setViewportSize({width:1280,height:800});
 assert.equal(await history.isVisible(),true);
 assert.equal(await spaceHeader.isVisible(),true);
 assert.equal(await dialog.getByLabel('Message',{exact:true}).isVisible(),true);
 const rail=await page.getByRole('navigation',{name:'Reader tools'}).boundingBox();
 const list=await history.boundingBox();
 const composer=await dialog.getByLabel('Message',{exact:true}).boundingBox();
 assert(rail.x+rail.width<=list.x+1 && list.x+list.width<=composer.x+1);
 await page.setViewportSize({width:390,height:844});
 await dialog.getByLabel('Message',{exact:true}).fill('permission');
 await send.click();
 await dialog.getByRole('heading',{name:'Approval requested'}).waitFor();
 await page.getByRole('button',{name:'Close chat'}).click();
 await page.reload();
 await page.getByRole('button',{name:'Chat',exact:true}).click();
 await dialog.getByRole('button',{name:'hello',exact:true}).first().click();
 await dialog.getByRole('heading',{name:'Approval requested'}).waitFor();
 const reject=dialog.getByRole('button',{name:/reject/i});
 await reject.click();
 await dialog.getByRole('heading',{name:'Approval requested'}).waitFor({state:'hidden'});
 await dialog.getByLabel('Message',{exact:true}).fill('hang');
 await send.click();
 await dialog.getByRole('button',{name:'Stop',exact:true}).waitFor();
 assert.equal(await send.count(),0);
 await dialog.getByRole('button',{name:'Stop',exact:true}).click();
 await dialog.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden'});
 await send.waitFor();
 assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'phone drawer fits viewport');
 assert.deepEqual(problems,[]);
 console.log('ok - phone chat, streaming, native permission rejection, reload reconnect, cancellation, end conversation');
 await context.close();
} finally {await browser.close();}
