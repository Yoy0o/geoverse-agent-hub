import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createFocusService } from '../src/focus.js';
import { versionReceipt, bindReview, deliveryContext } from '../src/delivery.js';
import { searchDeliveries } from '../src/results.js';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(fn) { for(let i=0;i<120;i++){if(fn())return;await wait(20);}assert.fail('UI did not reach expected state'); }
function fixture(t,mode) {
  const dom=new JSDOM('<main id="root"></main>',{url:'http://hub.test',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;
  const db=new DatabaseSync(':memory:'),store=createStore(db);t.after(async()=>{await wait(0);w.close();db.close();});w.structuredClone=structuredClone;
  const service=createFocusService(store,tasks=>tasks.filter(t=>t.status==='待评审').map(t=>({id:t.id,level:t.status})));
  const get=id=>({...store.getDoc('tasks',id).data,id}),all=()=>store.listDocs('tasks').map(d=>({...d.data,id:d.id}));
  const task=(id,extra={})=>store.setDoc('tasks',id,{title:id,status:'执行中',project:'GIS',goal:'Original goal',acceptance:[],...extra});
  const deliver=(id,summary=id)=>{const r=versionReceipt(get(id),{summary,version:id+'-v1',verify:[{cmd:'test',result:'pass'}]},'fixture');store.updateDoc('tasks',id,{...r.patch,status:'待评审'});const v=deliveryContext(get(id));const review=bindReview(get(id),'merge',{expectedDeliveryId:v.currentId,expectedFingerprint:v.expectedFingerprint,verificationConfirmed:true,acceptedCriteria:[],note:'manually verified'},'human');store.updateDoc('tasks',id,{status:'已合并',deliveryReviews:[review]});return r.revision;};
  const api={calls:[],toasts:[],opened:[],texts:[],searchGates:new Map(),postGate:null,postError:null,linked:0};
  const request=async(method,url,body)=>{
    api.calls.push({method,url,body:structuredClone(body)});const u=new URL(url,'http://hub.test'),p=u.pathname.split('/').map(decodeURIComponent),id=p[3];
    if(method==='POST'){if(api.postGate)await api.postGate.promise;if(api.postError)throw api.postError;}
    if(u.pathname==='/api/deliveries') { const result=searchDeliveries(all(),Object.fromEntries(u.searchParams)); const g=api.searchGates.get(u.searchParams.get('q'));if(g)await g.promise;return result; }
    if(u.pathname==='/api/focus/read')return service.markReadBatch(body);
    if(u.pathname==='/api/focus')return service.list();
    if(p[4]==='delivery')return deliveryContext(get(id),p[5]);
    if(p[4]==='reuse')return service.reuse(id,body);
    if(p[5]==='defer')return service.defer(id,body);
    if(p[5]==='read')return service.markRead(id,body);
    if(p[4]==='focus')return method==='PUT'?service.update(id,body):service.get(id);
    throw new Error('Unexpected request '+url);
  };
  let ui;const render=()=>{if(ui)w.document.querySelector('#root').innerHTML=mode==='focus'?ui.today():ui.view();};
  const common={request,changed:render,toast:s=>api.toasts.push(s),showText:(title,text)=>api.texts.push(text),getTasks:all,connected:()=>true};
  w.eval(fs.readFileSync(new URL('../public/'+(mode==='focus'?'focus.js':'results.js'),import.meta.url),'utf8'));
  ui=mode==='focus'?w.createFocusUI({...common,currentTask:()=>null,relevant:()=>true}):w.createResultsUI({...common,openDelivery:(id,revision)=>api.opened.push({id,revision}),linked:()=>api.linked++});
  const $=s=>w.document.querySelector(s),click=s=>{const el=$(s);assert(el,s);el.click();},input=(s,value,type='input')=>{const el=$(s);assert(el,s);el.value=value;el.dispatchEvent(new w.Event(type,{bubbles:true}));};
  return {w,store,service,api,task,deliver,get,render,ui,$,click,input};
}
test('today defers normal work, prevents duplicate writes and brings new risk back',async t=>{
  const b=fixture(t,'focus');b.task('review',{status:'待评审'});b.render();await until(()=>b.$('[data-focus-action="defer-hour"]'));
  b.api.postGate=gate();b.click('[data-focus-action="defer-hour"]');b.click('[data-focus-action="defer-day"]');
  assert.equal(b.api.calls.filter(x=>x.method==='POST').length,1);b.api.postGate.resolve();b.api.postGate=null;
  await until(()=>b.$('#focus-deferred'));assert.equal(b.service.get('review').unread,true);assert.equal(b.get('review').status,'待评审');
  b.store.updateDoc('tasks','review',{lastCheck:{ok:false}});b.ui.invalidate();await until(()=>!b.$('#focus-deferred'));
  assert.match(b.$('#root').textContent,/验证未通过/);assert.equal(b.$('[data-focus-action="defer-hour"]'),null);
});
test('batch reading sends only displayed fingerprints and leaves changed work unread',async t=>{
  const b=fixture(t,'focus');b.task('normal');b.task('changed');b.task('review',{status:'待评审'});b.render();await until(()=>b.$('[data-focus-action="read-batch"]'));
  b.store.updateDoc('tasks','changed',{goal:'New unseen goal'});b.click('[data-focus-action="read-batch"]');
  await until(()=>b.api.toasts.length);
  assert.equal(b.service.get('normal').unread,false);assert.equal(b.service.get('changed').unread,true);assert.equal(b.service.get('review').unread,true);
  assert.match(b.api.toasts[0],/1 项已变化/);
  assert.deepEqual(b.api.calls.find(x=>x.url==='/api/focus/read').body.items.map(x=>x.id).sort(),['changed','normal']);
});
test('search ignores out-of-order responses and opens the exact version with escaped text',async t=>{
  const b=fixture(t,'results');b.task('older');b.deliver('older');b.task('newer');const revision=b.deliver('newer','newer <img src=x onerror=alert(1)>');
  b.render();await until(()=>b.$('[data-results-action="open"]'));
  const old=gate();b.api.searchGates.set('older',old);b.input('#results-query','older');b.click('[data-results-action="search"]');
  b.input('#results-query','newer');b.$('#results-query').dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await until(()=>b.$('[data-result-task="newer"]')&&!b.$('[data-result-task="older"]'));old.resolve();await wait(30);
  assert.equal(b.$('img'),null);assert.equal(b.$('[data-result-task="older"]'),null);
  b.click('[data-results-action="open"]');assert.deepEqual(b.api.opened,[{id:'newer',revision:revision.id}]);
});
test('reuse retains its note on conflicts and rereads both versions before retrying',async t=>{
  const b=fixture(t,'results');b.task('source');const revision=b.deliver('source');b.task('target');b.render();await until(()=>b.$('[data-results-action="reuse"]'));
  b.click('[data-results-action="reuse"]');await until(()=>b.$('#results-target'));b.input('#results-target','target','change');
  b.input('#results-note','Reuse routes, verify floor boundary');await until(()=>!b.$('[data-results-action="save"]').disabled);
  b.store.updateDoc('tasks','target',{goal:'A new unseen scope'});b.click('[data-results-action="save"]');await until(()=>b.$('[role="alert"]'));
  assert.equal(b.$('#results-note').value,'Reuse routes, verify floor boundary');assert.equal(b.get('target').focus,undefined);
  b.click('[data-results-action="reload"]');await until(()=>!b.$('[data-results-action="save"]').disabled);
  b.api.postGate=gate();b.click('[data-results-action="save"]');b.click('[data-results-action="save"]');
  assert.equal(b.api.calls.filter(x=>x.url==='/api/tasks/target/reuse').length,2);
  b.api.postGate.resolve();b.api.postGate=null;await until(()=>b.api.linked===1);
  assert.equal(b.get('target').focus.content.relations[0].deliveryId,revision.id);assert.equal(b.get('target').status,'执行中');assert.equal(b.get('target').deliveryReviews,undefined);
});
test('editing an ordinary brief preserves a pinned version reference',async t=>{
  const b=fixture(t,'focus');b.task('source');const revision=b.deliver('source');b.task('target');
  b.service.reuse('target',{expectedFingerprint:b.service.get('target').fingerprint,sourceTaskId:'source',deliveryId:revision.id,expectedSourceFingerprint:deliveryContext(b.get('source')).expectedFingerprint,note:'Use this version'});
  b.render();await until(()=>b.$('[data-focus-action="edit"][data-focus-id="target"]'));b.click('[data-focus-action="edit"][data-focus-id="target"]');
  assert.equal(b.$('[data-act="open"][data-id="source"]').dataset.revision,revision.id);
  b.input('textarea[id$="-summary"]','New summary');b.click('[data-focus-action="save"][data-focus-id="target"]');await until(()=>b.service.get('target').content.summary==='New summary');
  assert.equal(b.service.get('target').content.relations[0].deliveryId,revision.id);
});
