// Source/space navigation is not evidence; local page: references create page_links. Keep the
// scanner in step with internal/client/references.go (including literal code).
function referenceText(body) {
 const chars=body.split('');
 const mask=(start,end)=>{for(let i=start;i<end;i++)if(chars[i]!=='\n'&&chars[i]!=='\r')chars[i]=' ';};
 let fence='',width=0;
 for(let start=0;start<body.length;){
  let end=body.indexOf('\n',start);end=end<0?body.length:end+1;
  const raw=body.slice(start,end),line=raw.replace(/^ */,'');const indent=raw.length-line.length;
  const match=line.match(/^(`+|~+)/),n=match?match[0].length:0;
  if(fence){mask(start,end);if(indent<=3&&n>=width&&line[0]===fence&&!line.slice(n).trim())fence='';}
  else if(indent<=3&&n>=3){fence=line[0];width=n;mask(start,end);}
  start=end;
 }
 for(let i=0;i<chars.length;){
  if(chars[i]==='\\'&&i+1<chars.length){mask(i,i+2);i+=2;continue;}
  if(chars[i]!=='`'){i++;continue;}
  let n=1;while(chars[i+n]==='`')n++;
  let end=-1;
  for(let j=i+n;j<chars.length;){if(chars[j]!=='`'){j++;continue;}let k=1;while(chars[j+k]==='`')k++;if(k===n){end=j+k;break;}j+=k;}
  if(end>=0){mask(i,end);i=end;}else i+=n;
 }
 return chars.join('');
}
function destinations(body){return [...referenceText(body).matchAll(/(?:\]\(\s*<?|^ {0,3}\[[^\]\n]+\]:\s*<?)((?:source|space|page):[^\s<>)]*)/gm)].map(m=>m[1]);}
const pagePattern=/^page:([a-z0-9]+(?:-[a-z0-9]+)*)(?:#[^\s<>]*)?$/;
function pageTargets(body){return destinations(body).map(value=>value.match(pagePattern)).filter(match=>match&&match[1].length<=150).map(match=>match[1]);}
function check(app,body,space,report){
 for(const destination of destinations(body)){
  if(destination.startsWith('source:')){
   const match=destination.match(/^source:([a-z0-9]{15})$/);
   if(!match){report('source-reference','Invalid source reference: '+destination);continue;}
   let source;try{source=app.findRecordById('sources',match[1]);}catch(_){}
   if(!source||source.getString('space')!==space)report('source-reference','Source reference not found in this space: '+match[1]);
  }else if(destination.startsWith('page:')){
   const match=destination.match(pagePattern);
   if(!match||match[1].length>150)report('page-reference','Invalid page reference: '+destination);
  }else{
   const match=destination.match(/^space:([a-z0-9]{15})\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:#[^\s<>]*)?$/);
   if(!match||match[2].length>150){report('space-reference','Invalid space reference: '+destination);continue;}
   // A destination page may be imported/published later or archived independently.
   let target;try{target=app.findRecordById('spaces',match[1]);}catch(_){}
   if(!target)report('space-reference','Navigation space not found: '+match[1]);
  }
 }
}
module.exports={referenceText,destinations,pageTargets,check};
