import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createFocusService } from '../src/focus.js';
import { versionReceipt, deliveryContext, bindReview, recordCheck } from '../src/delivery.js';
import { searchDeliveries } from '../src/results.js';
import { mergeTask } from '../src/merge.js';

function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close()); const store=createStore(db);
  let now=Date.parse('2026-11-03T01:00:00Z'), stalled=false;
  const service=createFocusService(store,tasks=>tasks.filter(t=>t.status==='待评审'||stalled).map(t=>({id:t.id,level:stalled?'执行停滞':'待评审'})),()=>now);
  const task=(id,extra={})=>store.setDoc('tasks',id,{title:id,status:'执行中',project:'GIS',goal:'route experiment',acceptance:[{text:'handles disconnected routes',done:false}],...extra});
  const get=id=>({...store.getDoc('tasks',id).data,id});
  const deliver=(id,extra={})=>{const r=versionReceipt(get(id),{summary:'Navigation disconnected cases resolved',version:'v1',verify:[{cmd:'route test',result:'pass'}],changed:['src/route.js'],...extra},'fixture');store.updateDoc('tasks',id,{...r.patch,status:'待评审'});return r.revision;};
  const approve=id=>{const d=deliveryContext(get(id));const r=bindReview(get(id),'merge',{expectedDeliveryId:d.currentId,expectedFingerprint:d.expectedFingerprint,verificationConfirmed:true,acceptedCriteria:[0],note:'manually verified'},'human');store.updateDoc('tasks',id,{status:'已合并',deliveryReviews:[r]});};
  const defer=(id,minutes=60)=>service.defer(id,{expectedFingerprint:service.get(id).fingerprint,minutes});
  const all=()=>store.listDocs('tasks').map(d=>({...d.data,id:d.id}));
  return {store,service,task,get,deliver,approve,defer,all,advance:ms=>now+=ms,stall:()=>stalled=true};
}
const conflict=fn=>assert.throws(fn,e=>e.status===409);
test('deferral preserves unread and task state, survives noise, expires without a write',t=>{
  const f=fixture(t);f.task('review',{status:'待评审'});const original=f.service.get('review');
  f.defer('review');assert.equal(f.service.list().counts.attention,0);assert.equal(f.service.list().counts.deferred,1);
  assert.equal(f.service.get('review').unread,true);assert.equal(f.get('review').status,'待评审');
  f.store.updateDoc('tasks','review',{minutes:100,updatedAt:new Date().toISOString(),exec:{heartbeatAt:new Date().toISOString()}});
  assert.equal(f.service.get('review').fingerprint,original.fingerprint);assert.equal(f.service.get('review').deferred,true);
  const version=f.store.getDoc('tasks','review').version;f.advance(3600000);
  assert.equal(f.service.list().counts.attention,1);assert.equal(f.store.getDoc('tasks','review').version,version);
});
test('new evidence, changed relations and time-based urgent alerts break deferral',t=>{
  const f=fixture(t);f.task('review',{status:'待评审'});const old=f.service.get('review');f.defer('review');
  f.deliver('review');assert.equal(f.service.get('review').deferred,false);
  conflict(()=>f.service.defer('review',{expectedFingerprint:old.fingerprint,minutes:60}));
  f.defer('review');f.stall();assert.equal(f.service.get('review').deferred,false);assert.equal(f.service.list().counts.urgent,1);
  conflict(()=>f.defer('review'));
});
test('risks cannot be deferred and explicit cancellation persists through sync',t=>{
  const f=fixture(t);f.task('risk',{focus:{content:{risk:'Scope unresolved'}}});conflict(()=>f.defer('risk'));
  f.task('review',{status:'待评审'});f.defer('review');const before=f.get('review');f.advance(1);f.defer('review',0);const cleared=f.get('review');
  const merged=mergeTask(before,cleared,'2026-11-04','2026-11-03');
  assert.equal(merged.focus.deferral.until,null);assert.equal(f.service.list().counts.deferred,0);
  cleared.focus.deferral.at=before.focus.deferral.at;
  assert.equal(mergeTask(before,cleared).focus.deferral.until,null);assert.equal(mergeTask(cleared,before).focus.deferral.until,null);
  assert.throws(()=>f.service.defer('review',{expectedFingerprint:f.service.get('review').fingerprint,minutes:10081}),e=>e.status===400);
});
test('batch read skips changed, missing, urgent and decision items without accepting anything',t=>{
  const f=fixture(t);for(const id of ['normal','changed','urgent','decision'])f.task(id);
  const items=f.all().map(t=>({id:t.id,expectedFingerprint:f.service.get(t.id).fingerprint}));
  f.store.updateDoc('tasks','changed',{goal:'new goal'});f.store.updateDoc('tasks','urgent',{lastCheck:{ok:false}});
  f.service.update('decision',{expectedFingerprint:f.service.get('decision').fingerprint,content:{decision:'Proceed?',recommendation:'Yes'}});
  items.push({id:'missing',expectedFingerprint:'a'.repeat(64)});
  const result=f.service.markReadBatch({items});assert.deepEqual(result.read,['normal']);assert.equal(result.skipped.length,4);
  assert.equal(f.service.get('normal').unread,false);assert.equal(f.service.get('changed').unread,true);assert.equal(f.get('normal').status,'执行中');
});
test('search defaults to current acceptance and filters all keywords, project, revision and file',t=>{
  const f=fixture(t);f.task('source');const d=f.deliver('source');f.approve('source');f.task('pending');f.deliver('pending');
  f.task('legacy',{receipt:{summary:'Old navigation document'}});
  assert.deepEqual(searchDeliveries(f.all()).items.map(x=>x.taskId),['source']);
  const found=searchDeliveries(f.all(),{q:'NAVIGATION route.js',project:'GIS'});assert.equal(found.total,1);assert(found.items[0].matchedOn.includes('文件'));
  assert.equal(searchDeliveries(f.all(),{q:'Navigation impossible'}).total,0);
  assert.equal(searchDeliveries(f.all(),{q:d.id,scope:'all'}).total,1);
  assert.equal(searchDeliveries(f.all(),{scope:'all'}).items.find(x=>x.taskId==='legacy').legacy,true);
  assert.equal(searchDeliveries(f.all(),{q:'原文未提供'}).total,0);
  f.task('placeholder');const unknown=f.deliver('placeholder',{version:'unknown'});
  assert.equal(searchDeliveries(f.all(),{scope:'all',q:unknown.id}).items[0].reusable,false);
  conflict(()=>f.service.reuse('pending',{expectedFingerprint:f.service.get('pending').fingerprint,sourceTaskId:'placeholder',deliveryId:unknown.id,expectedSourceFingerprint:deliveryContext(f.get('placeholder')).expectedFingerprint,note:'Do not invent a version'}));
});
test('search pagination is bounded, stable and does not infer approval for older or newly unchecked versions',t=>{
  const f=fixture(t);f.task('source');f.deliver('source');f.approve('source');
  const task=f.get('source'),check=recordCheck(task,{version:'v1',ok:false},'fixture');f.store.updateDoc('tasks','source',check.patch);
  assert.equal(searchDeliveries(f.all()).total,0);
  f.deliver('source',{version:'v2',summary:'x'.repeat(1000)});
  const p1=searchDeliveries(f.all(),{scope:'all',limit:1}),p2=searchDeliveries(f.all(),{scope:'all',limit:1,offset:p1.nextOffset});
  assert.equal(p1.total,2);assert.equal(p2.nextOffset,null);assert.notEqual(p1.items[0].deliveryId,p2.items[0].deliveryId);
  assert(p1.items[0].summary.length<=280);assert(!('receipt' in p1.items[0]));
  assert.throws(()=>searchDeliveries(f.all(),{limit:51}),e=>e.status===400);
});
test('reuse pins the selected immutable version without copying acceptance, and source changes stay visible',t=>{
  const f=fixture(t);f.task('source');const first=f.deliver('source');f.approve('source');f.task('target');
  const v=deliveryContext(f.get('source')),base={expectedFingerprint:f.service.get('target').fingerprint,sourceTaskId:'source',deliveryId:first.id,expectedSourceFingerprint:v.expectedFingerprint,note:'Reuse routes, verify new floor independently'};
  const linked=f.service.reuse('target',base);assert.equal(linked.content.relations[0].deliveryId,first.id);
  assert.equal(f.get('target').status,'执行中');assert.equal(f.get('target').acceptance[0].done,false);assert.equal(f.get('target').deliveryReviews,undefined);
  assert.equal(linked.snapshot.relations[0].delivery.accepted,true);
  f.service.markRead('target',{expectedFingerprint:linked.fingerprint});f.defer('target');
  f.deliver('source',{version:'v2',summary:'New floor case'});
  const target=f.service.get('target');assert.equal(target.deferred,false);assert.equal(target.unread,true);
  assert.equal(target.snapshot.relations[0].delivery.version,'v1');assert.equal(target.snapshot.relations[0].delivery.current,false);
  assert.match(f.service.context('target').brief,/固定成果.*v1/);
  conflict(()=>f.service.reuse('target',{...base,expectedFingerprint:target.fingerprint}));
  f.store.deleteDoc('tasks','source');assert.equal(f.service.get('target').urgent,true);
});
test('reuse rejects stale targets, self-reference and closed targets and preserves unrelated context',t=>{
  const f=fixture(t);f.task('source');const d=f.deliver('source');f.task('target');
  const input={expectedFingerprint:f.service.get('target').fingerprint,sourceTaskId:'source',deliveryId:d.id,expectedSourceFingerprint:deliveryContext(f.get('source')).expectedFingerprint,note:'Use evidence'};
  f.service.update('target',{expectedFingerprint:input.expectedFingerprint,content:{summary:'Keep me',nextAction:'Run tests'}});
  conflict(()=>f.service.reuse('target',input));input.expectedFingerprint=f.service.get('target').fingerprint;
  f.service.reuse('target',input);assert.equal(f.service.get('target').content.summary,'Keep me');
  assert.throws(()=>f.service.reuse('source',{...input,expectedFingerprint:f.service.get('source').fingerprint}),e=>e.status===400);
  f.store.updateDoc('tasks','target',{status:'已合并'});conflict(()=>f.service.reuse('target',{...input,expectedFingerprint:f.service.get('target').fingerprint}));
});
