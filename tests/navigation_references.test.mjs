import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {referenceText,destinations,check}=require('../pb_hooks/references.js');
const local='lllllllllllllll', foreign='fffffffffffffff', source='sssssssssssssss';
const app={findRecordById(table,id){if(table==='sources'&&id===source)return {getString:()=>local};if(table==='spaces'&&id===foreign)return {};throw Error('missing');}};
const problems=(body,space=local)=>{const out=[];check(app,body,space,(...x)=>out.push(x));return out;};
test('source references require local originals; cross-space navigation has no publication dependency',()=>{
 assert.deepEqual(problems(`[Original](source:${source}) ![Diagram](source:${source}) [Other](space:${foreign}/not-published#Heading)`),[]);
 assert.equal(problems(`[Original](source:${source})`,foreign)[0][0],'source-reference');
 assert.equal(problems('[Bad](source:nope)')[0][0],'source-reference');
 assert.equal(problems('[Bad](space:xxxxxxxxxxxxxxx/page)')[0][0],'space-reference');
 assert.equal(problems(`[Bad](space:${foreign}/../page)`)[0][0],'space-reference');
});
test('literal Markdown code and escaped examples are not references',()=>{
 const body='[[real]] `[[inline]] [^2]`\n```md\n[[fenced]] [^3]\n```\n~~~\n[[tilde]]\n~~~\n\\[[escaped]]';
 assert.deepEqual([...referenceText(body).matchAll(/\[\[([^\]]+)\]\]/g)].map(x=>x[1]),['real']);
 assert.deepEqual(destinations('`[bad](source:bad)`\n```\n![bad](source:bad)\n```'),[]);
 assert.deepEqual(problems(`[^import-1]: [Original](source:${source})`),[]);
});
test('formatted Markdown page labels derive local publication dependencies',()=>{
 const {pageTargets}=require('../pb_hooks/references.js');
 assert.deepEqual(pageTargets("[BERT's `[CLS]`/`[SEP]` (token) scheme](page:bert-input#Token%20scheme)\n[Multiline\nlabel](page:other) `[literal](page:missing)`"),['bert-input','other']);
 assert.equal(problems('[bad](page:../outside)')[0][0],'page-reference');
 assert.equal(problems('[bad](page:Bad)')[0][0],'page-reference');
});
