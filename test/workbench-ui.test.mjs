import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = name => fs.readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 160; i++) { if (check()) return; await pause(20); }
  assert.fail('UI condition did not become true');
}
const task = (id, title) => ({ id, title, status: '待执行', risk: 'L2', goal: 'Original goal', acceptance: [], history: [], createdAt: new Date().toISOString() });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
async function workbench(t, initial = []) {
  const dom = new JSDOM(html, { url: 'http://hub.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, docs = new Map(initial.map(d => [d.id, structuredClone(d)])), subscribers = new Map();
  const api = { puts: [], patches: [], briefs: [], copied: [], pauses: [], resumes: [], reviews: [], receipts: [], setGate: null, patchGate: null, failAfterPut: false, patchError: null, briefError: null, pauseError: null, pauseGate: null, pauseExecution: null };
  const lifecycle = id => {
    const d=docs.get(id);
    return { id, status:d.status, expectedFingerprint:'a'.repeat(64), summary:d.goal, nextAction:'Run the next experiment', content:{}, checkpoint:d.pauseState||null,
      execution:d.status==='已暂停'?(api.pauseExecution||{state:'stopped',manual:[],pending:[],message:'没有待停止的执行'}):null };
  };
  const snapshot = name => ({ docs: name === 'tasks' ? [...docs].map(([id,data]) => ({ id, data: () => structuredClone(data) })) : [] });
  const notify = () => subscribers.get('tasks')?.(snapshot('tasks'));
  const db = {
    collection(name) { return { onSnapshot(cb) { subscribers.set(name,cb); cb(snapshot(name)); } }; },
    doc(path) {
      const id = path.split('/')[1];
      return {
        onSnapshot(cb) { cb({ exists: true, data: () => ({ projects: [], agents: ['Codex'] }) }); },
        async set(body) {
          api.puts.push({ id, body: structuredClone(body) });
          if (api.setGate) await api.setGate.promise;
          docs.set(id, { ...structuredClone(body), id }); notify();
          if (api.failAfterPut) throw new Error('response lost after save');
        },
        async update(patch) {
          api.patches.push({ id, patch: structuredClone(patch) });
          if (api.patchGate) await api.patchGate.promise;
          if (api.patchError) throw api.patchError;
          docs.set(id, { ...docs.get(id), ...structuredClone(patch) }); notify();
        }
      };
    }
  };
  w.structuredClone = structuredClone; w.scrollTo = () => {};
  w.navigator.clipboard = { async writeText(text) { api.copied.push(text); } };
  const caps = { sample: false, version: '0.3.1', hub: { name: 'Test Hub', kind: 'cloud' } };
  w.hub = { caps: async () => caps, async req(method, url, body) {
    if (url.startsWith('/api/docs/tasks/')) {
      const d = docs.get(decodeURIComponent(url.split('/').at(-1)));
      if (!d) throw Object.assign(new Error('not_found'), { status: 404 });
      return { data: structuredClone(d) };
    }
    if (url === '/api/focus') return { items: [], remaining: [], updates: [], total: docs.size, counts: { attention: 0, updates: 0 } };
    if (url.endsWith('/focus')) throw Object.assign(new Error('No brief in fixture'), { status: 404 });
    if (url.endsWith('/lifecycle')) return lifecycle(url.split('/').at(-2));
    if (url.includes('/delivery')) {
      const id=url.split('/')[3], result=structuredClone(api.delivery || {task:id,selected:null,versions:[],expectedFingerprint:'f'.repeat(64),blockers:[],warnings:[],reviews:[]});
      if(api.deliveryGate) await api.deliveryGate.promise;
      return result;
    }
    if (url.endsWith('/review')) {
      const id=url.split('/').at(-2); api.reviews.push({id,body:structuredClone(body)});
      if(api.reviewGate) await api.reviewGate.promise;
      if(api.reviewError) throw api.reviewError;
      docs.get(id).status=body.action==='merge'?'已合并':body.action==='rework'?'执行中':'已放弃';
      if(api.delivery) api.delivery.accepted=body.action==='merge';
      notify(); return {task:structuredClone(docs.get(id))};
    }
    if (url.endsWith('/receipt')) {
      const id=url.split('/').at(-2);api.receipts.push({id,body:structuredClone(body)});
      if(api.receiptError) throw api.receiptError;
      docs.get(id).receipt={summary:'Saved new delivery'};notify();return {task:structuredClone(docs.get(id))};
    }
    if (url.endsWith('/pause')) {
      const id=url.split('/').at(-2); api.pauses.push({id,body:structuredClone(body)});
      if(api.pauseGate) await api.pauseGate.promise;
      if(api.pauseError) throw api.pauseError;
      const d=docs.get(id); docs.set(id,{...d,status:'已暂停',pauseState:{...body,at:new Date().toISOString()}}); notify(); return lifecycle(id);
    }
    if (url.endsWith('/resume')) {
      const id=url.split('/').at(-2); api.resumes.push({id,body:structuredClone(body)});
      if(api.pauseExecution?.manual.length && !body.confirmedExternalStop) throw new Error('请先在外部停止 Agent');
      docs.get(id).status='待执行'; notify(); return lifecycle(id);
    }
    if (url.endsWith('/brief')) {
      api.briefs.push(url);
      if (api.briefError) throw api.briefError;
      const d = docs.get(decodeURIComponent(url.split('/').at(-2)));
      return '# Server task sheet: ' + d.title + '\n' + d.goal + '\n阶段成果：update_work_brief';
    }
    if (url.startsWith('/api/exec')) return { runners: [], recent: [], active: [] };
    if (url.startsWith('/api/runs')) return [];
    if (url.startsWith('/api/sync')) return { configured: false };
    if (url.includes('/activity')) return { events: api.activityEvents || [], sessions: [] };
    return [];
  } };
  w.claude = { async use(name) { if (name === 'db') return db; throw new Error('disabled'); } };
  w.localStorage.setItem('awb.tab','board');
  w.eval(source('task-edits.js')); w.eval(source('focus.js')); w.eval(source('delivery.js'));
  w.eval(html.match(/<script>\s*([\s\S]*?)<\/script>/)[1]);
  await until(() => w.document.querySelector('#sync').textContent.includes('已连接'));
  const $ = s => w.document.querySelector(s);
  const click = s => { const el = $(s); assert(el, s); el.click(); };
  const input = (s,value) => { const el=$(s); assert(el,s); el.value=value; el.dispatchEvent(new w.Event('input',{bubbles:true})); };
  const open = async id => { click('[data-act="open"][data-id="'+id+'"]'); await until(() => $('#d-title')); };
  return { w, $, click, input, open, docs, notify, api };
}

test('create waits for acknowledgement, keeps a failed draft, prevents double submit, then opens a usable drawer', async t => {
  const b=await workbench(t); b.click('[data-act="new-task"]'); b.input('#n-title','Slow save'); b.input('#n-goal','Keep this goal');
  b.api.setGate=deferred(); b.click('[data-act="create"]');
  await until(() => b.api.puts.length === 1);
  assert.equal(b.$('#n-title').value,'Slow save'); assert.equal(b.$('[data-act="create"]').disabled,true);
  assert.equal(b.$('.drawer'),null); b.click('[data-act="create"]'); assert.equal(b.api.puts.length,1);
  const id=b.api.puts[0].id;
  b.api.setGate.reject(new Error('offline')); await until(() => b.$('#save-state').textContent.includes('未保存'));
  assert.equal(b.$('#n-goal').value,'Keep this goal'); assert.equal(b.$('[data-act="create"]').disabled,false);
  b.click('#tab-board'); b.click('[data-act="new-task"]');
  assert.equal(b.$('#n-title').value,'Slow save'); assert.equal(b.$('#n-goal').value,'Keep this goal');
  b.api.setGate=null; b.click('[data-act="create"]'); await until(() => b.$('#d-title'));
  assert.equal(b.api.puts[1].id,id); assert.equal(b.docs.size,1); assert.equal(b.$('#d-title').value,'Slow save');
  b.click('[data-act="close"]'); b.click('#tab-board'); assert.equal(b.$('#tab-board').getAttribute('aria-selected'),'true');
});

test('navigation during creation keeps the pending form and does not hijack the destination', async t => {
  const b=await workbench(t); b.click('[data-act="new-task"]'); b.input('#n-title','Background creation');
  b.api.setGate=deferred(); b.click('[data-act="create"]'); await until(() => b.api.puts.length === 1);
  assert.equal(b.$('#n-title').disabled,true);
  b.click('#tab-board'); b.click('[data-act="new-task"]');
  assert.equal(b.$('#n-title').value,'Background creation'); assert.equal(b.$('#n-title').disabled,true);
  b.click('#tab-board'); b.api.setGate.resolve(); await until(() => b.$('#save-state').textContent === '已保存');
  assert.equal(b.$('#tab-board').getAttribute('aria-selected'),'true'); assert.equal(b.$('.drawer'),null);
  b.click('[data-act="new-task"]'); assert.equal(b.$('#n-title').value,''); assert.equal(b.$('#n-title').disabled,false);
  assert.equal(b.docs.size,1);
});

test('retry after a lost response opens the existing task without overwriting subsequent work', async t => {
  const b=await workbench(t); b.click('[data-act="new-task"]'); b.input('#n-title','Ambiguous save');
  b.api.failAfterPut=true; b.click('[data-act="create"]'); await until(() => b.$('#save-state').textContent.includes('未保存'));
  const id=b.api.puts[0].id; b.docs.get(id).title='Updated by another session'; b.notify();
  b.api.failAfterPut=false; b.click('[data-act="create"]'); await until(() => b.$('#d-title'));
  assert.equal(b.api.puts.length,1); assert.equal(b.docs.size,1); assert.equal(b.$('#d-title').value,'Updated by another session');
});

test('input survives SSE replacement and saves even when the replaced input never fires change', async t => {
  const b=await workbench(t,[task('T-test','Draft test')]); await b.open('T-test');
  const old=b.$('#d-goal'); b.input('#d-goal','Draft through realtime refresh'); b.notify();
  await until(() => b.$('#d-goal') !== old); assert.equal(b.$('#d-goal').value,'Draft through realtime refresh');
  await until(() => b.docs.get('T-test').goal === 'Draft through realtime refresh');
  await until(() => b.$('#save-state').textContent === '已保存');
  b.click('[data-act="close"]'); await b.open('T-test'); assert.equal(b.$('#d-goal').value,'Draft through realtime refresh');
  b.docs.get('T-test').goal='Later remote update'; b.notify(); await until(() => b.$('#d-goal').value === 'Later remote update');
});

test('failed edits stay bound to the original task and can be retried after navigation and authentication recovery', async t => {
  const b=await workbench(t,[task('T-one','One'),task('T-two','Two')]); await b.open('T-one');
  b.api.patchError=Object.assign(new Error('Session expired'),{code:'revoked'}); b.input('#d-goal','Retained draft');
  await until(() => !b.$('#save-retry').hidden); assert.equal(b.docs.get('T-one').goal,'Original goal');
  b.click('[data-act="close"]'); await b.open('T-two'); assert.equal(b.$('#d-goal').value,'Original goal');
  b.api.patchError=null; b.click('#save-retry'); await until(() => b.docs.get('T-one').goal === 'Retained draft');
  assert.equal(b.docs.get('T-two').goal,'Original goal'); assert.equal(b.api.patches.length,2);
  await until(() => b.$('#save-state').textContent === '已保存');
});

test('an older successful response does not clear a newer edit', async t => {
  const b=await workbench(t,[task('T-race','Race')]); await b.open('T-race');
  b.api.patchGate=deferred(); b.input('#d-goal','First edit'); await until(() => b.api.patches.length === 1);
  b.input('#d-goal','Newest edit'); b.notify(); await pause(40); assert.equal(b.$('#d-goal').value,'Newest edit');
  const gate=b.api.patchGate; b.api.patchGate=null; gate.resolve();
  await until(() => b.docs.get('T-race').goal === 'Newest edit'); await until(() => b.$('#save-state').textContent === '已保存');
  assert.deepEqual(b.api.patches.map(p=>p.patch.goal),['First edit','Newest edit']);
});

test('copy task sheet waits for edits and uses the current server instructions', async t => {
  const b=await workbench(t,[task('T-copy','Copy current context')]); await b.open('T-copy');
  b.api.patchGate=deferred(); b.input('#d-goal','Latest saved goal');
  b.click('[data-act="copy"][data-what="brief"]'); await until(() => b.api.patches.length === 1);
  assert.equal(b.api.briefs.length,0); assert.equal(b.api.copied.length,0);
  b.api.patchGate.resolve(); await until(() => b.api.copied.length === 1);
  assert.match(b.api.copied[0], /Latest saved goal/); assert.match(b.api.copied[0], /update_work_brief/);
  b.api.patchGate=null; b.api.patchError=new Error('offline'); b.input('#d-goal','Unsaved goal');
  b.click('[data-act="copy"][data-what="brief"]'); await until(() => b.$('#toast').textContent.includes('任务单未复制'));
  assert.equal(b.api.briefs.length,1); assert.equal(b.api.copied.length,1);
});

test('create-and-copy failure preserves the saved task and can retry copying without another creation', async t => {
  const b=await workbench(t); b.click('[data-act="new-task"]'); b.input('#n-title','Saved despite copy failure');
  b.api.briefError=new Error('offline'); b.click('[data-act="create"][data-copy="1"]');
  await until(() => b.$('#d-title') && b.$('#toast').textContent.includes('任务单未复制'));
  assert.equal(b.docs.size,1); assert.equal(b.api.puts.length,1); assert.equal(b.api.copied.length,0);
  b.api.briefError=null; b.click('[data-act="copy"][data-what="brief"]'); await until(() => b.api.copied.length === 1);
  assert.match(b.api.copied[0], /Saved despite copy failure/); assert.equal(b.api.puts.length,1);
});

test('pause checkpoint draft survives realtime rendering and failure, then links the interruption', async t => {
  const b=await workbench(t,[task('T-main','Navigation'),task('T-urgent','Video fix')]); await b.open('T-main');
  b.click('[data-act="pause-open"]'); await until(()=>b.$('#pause-reason'));
  b.input('#pause-reason','Handle urgent video'); b.input('#pause-next','Run two disconnected cases'); b.input('#pause-interruption','T-urgent');
  b.notify(); await pause(30); assert.equal(b.$('#pause-reason').value,'Handle urgent video');
  b.api.pauseGate=deferred(); b.click('[data-act="pause-save"]'); await until(()=>b.api.pauses.length===1);
  assert.equal(b.$('[data-act="pause-save"]').disabled,true);
  b.api.pauseGate.reject(new Error('offline')); await until(()=>b.$('[role="alert"]')?.textContent.includes('草稿已保留'));
  assert.equal(b.$('#pause-next').value,'Run two disconnected cases'); assert.equal(b.docs.get('T-main').status,'待执行');
  b.api.pauseGate=null; b.click('[data-act="pause-save"]'); await until(()=>b.$('[data-act="task-resume"]'));
  assert.equal(b.docs.get('T-main').status,'已暂停'); assert.equal(b.api.pauses[1].body.interruptedBy,'T-urgent');
  assert.match(b.$('.drawer').textContent,/恢复第一步：Run two disconnected cases/);
  b.click('[data-act="close"]'); await b.open('T-urgent'); assert.match(b.$('.drawer').textContent,/插单处理后可返回/);
});

test('resume UI distinguishes runner acknowledgement from explicitly confirmed external stop', async t => {
  const paused={...task('T-paused','Paused task'),status:'已暂停',pauseState:{reason:'Interrupt',summary:'Checked topology',nextAction:'Repair gap'},exec:{run:'run-1',status:'running',cancel:true,mode:'exec',location:'local'}};
  const b=await workbench(t,[paused]); b.api.pauseExecution={state:'stopping',pending:['run-1'],manual:[],message:'等待执行端确认停止'};
  await b.open('T-paused'); await until(()=>b.$('.drawer').textContent.includes('等待执行端确认停止'));
  assert.equal(b.$('[data-act="task-resume"]').disabled,true);
  assert.equal(b.$('.h-stopping').textContent,'等待停止确认');
  b.api.pauseExecution={state:'external',pending:[],manual:['run-1'],message:'请在原会话停止 Agent'};
  b.click('[data-act="lifecycle-refresh"]'); await until(()=>b.$('#pause-external-stopped'));
  b.click('[data-act="task-resume"]'); await until(()=>b.api.resumes.length===1 && !b.$('[data-act="task-resume"]').disabled);
  assert.equal(b.docs.get('T-paused').status,'已暂停'); assert.equal(b.api.resumes[0].body.confirmedExternalStop,false);
  b.click('#pause-external-stopped'); b.click('[data-act="task-resume"]'); await until(()=>b.$('#toast').textContent.includes('已恢复到待执行'));
  assert.equal(b.api.resumes[1].body.confirmedExternalStop,true); assert.equal(b.api.puts.length,0);
});


test('archived receipts stay collapsed and separate from current work, with escaped content', async t => {
  const current={...task('T-archive','Current task'),receipt:{summary:'Current result'}};
  const b=await workbench(t,[current]);
  b.api.activityEvents=[{seq:42,kind:'receipt_late',at:new Date().toISOString(),agent:'codex',summary:'Retired output',receipt:{summary:'Old <img src=x onerror=alert(1)>',changed:['old.js'],verify:[{cmd:'old-check',result:'pass'}]}}];
  await b.open('T-archive'); await until(()=>b.$('.archived-receipt'));
  assert.equal(b.$('.archived-receipt').open,false);
  assert.match(b.$('.archived-receipt pre').textContent,/Old <img/);
  assert.equal(b.$('.archived-receipt img'),null);
  assert.match(b.$('.archived-receipt').textContent,/不代表当前执行的成果/);
  assert.equal(b.docs.get('T-archive').receipt.summary,'Current result');
});

function deliveryFixture(id,version='v1'){
  const selected={id:'D-'+version,version,at:'2026-10-30T10:00:00Z',by:'codex',receipt:{summary:'Result '+version,changed:['route.js'],verify:[{cmd:'route test',result:'pass'}],scope:'ok',risks:'无'},requirements:{acceptance:['Route priority','Disconnected case']}};
  return {task:id,status:'待评审',currentId:selected.id,expectedFingerprint:(version==='v1'?'a':'b').repeat(64),selected,versions:[{...selected,number:1,current:true,summary:selected.receipt.summary}],reviews:[],blockers:[],warnings:[],canReview:true,accepted:false,difference:{first:true}};
}
test('review binds explicit criteria, keeps its draft across SSE and failed saves, and prevents duplicate submissions',async t=>{
  const id='T-review',initial={...task(id,'Review result'),status:'待评审',acceptance:[{text:'Route priority',done:true},{text:'Disconnected case',done:true}]};
  const b=await workbench(t,[initial]);b.api.delivery=deliveryFixture(id);await b.open(id);
  b.click('[data-to="__merge"]');await until(()=>b.$('#rv-note'));
  assert.equal(b.$('#rv-criterion-0').checked,false,'progress completion is not acceptance');
  b.input('#rv-note','Verified both route cases');b.click('#rv-criterion-0');b.click('#rv-criterion-1');b.click('#rv-verified');
  b.notify();await pause(40);assert.equal(b.$('#rv-note').value,'Verified both route cases');assert.equal(b.$('#rv-criterion-0').checked,true);
  b.api.reviewGate=deferred();b.click('[data-act="rv-confirm"]');await until(()=>b.api.reviews.length===1);
  assert.equal(b.$('[data-act="rv-confirm"]').disabled,true);b.click('[data-act="rv-confirm"]');assert.equal(b.api.reviews.length,1);
  b.api.reviewGate.reject(new Error('offline'));await until(()=>b.$('[role="alert"]')?.textContent.includes('草稿已保留'));
  assert.equal(b.$('#rv-note').value,'Verified both route cases');assert.equal(b.docs.get(id).status,'待评审');
  b.api.reviewGate=null;b.click('[data-act="rv-confirm"]');await until(()=>b.$('#toast').textContent.includes('本版验收已保存'));
  assert.equal(b.api.reviews[1].body.expectedDeliveryId,'D-v1');assert.deepEqual(b.api.reviews[1].body.acceptedCriteria,[0,1]);assert.equal(b.api.reviews[1].body.verificationConfirmed,true);
});
test('changed delivery requires rereading and new confirmations while retaining review notes',async t=>{
  const id='T-stale';const b=await workbench(t,[{...task(id,'Stale review'),status:'待评审'}]);b.api.delivery=deliveryFixture(id);await b.open(id);
  b.click('[data-to="__merge"]');await until(()=>b.$('#rv-note'));b.input('#rv-note','Keep my review notes');b.click('#rv-criterion-0');b.click('#rv-verified');
  b.api.delivery=deliveryFixture(id,'v2');b.notify();await until(()=>b.$('.review').textContent.includes('成果或依据已变化'));
  assert.equal(b.$('[data-act="rv-confirm"]').disabled,true);b.click('[data-act="review-reload"]');await until(()=>b.$('.review').textContent.includes('D-v2'));
  assert.equal(b.$('#rv-note').value,'Keep my review notes');assert.equal(b.$('#rv-criterion-0').checked,false);assert.equal(b.$('#rv-verified').checked,false);
});
test('an older delivery read cannot overwrite a newer server response',async t=>{
  const id='T-order';const b=await workbench(t,[task(id,'Ordered reads')]);b.api.delivery=deliveryFixture(id);await b.open(id);await until(()=>b.$('#delivery-choice'));
  const gate=deferred();b.api.deliveryGate=gate;b.click('[data-act="delivery-refresh"]');await pause(20);
  b.api.deliveryGate=null;b.api.delivery=deliveryFixture(id,'v2');b.notify();await until(()=>b.$('#delivery-choice').value==='D-v2');
  gate.resolve();await pause(40);assert.equal(b.$('#delivery-choice').value,'D-v2');
});
test('pasted receipts use the version endpoint and retain text after a failed save',async t=>{
  const id='T-paste';const b=await workbench(t,[task(id,'Paste receipt')]);await b.open(id);
  b.input('#d-receipt','summary: Draft result\nversion: commit-v1');b.api.receiptError=new Error('offline');b.click('[data-act="d-receipt"]');
  await until(()=>b.$('[role="alert"]')?.textContent.includes('回执草稿已保留'));b.notify();await pause(40);
  assert.match(b.$('#d-receipt').value,/Draft result/);assert.equal(b.api.patches.length,0);
  b.api.receiptError=null;b.click('[data-act="d-receipt"]');await until(()=>b.$('#toast').textContent.includes('成果版本已保存'));
  assert.equal(b.api.receipts.length,2);assert.equal(b.$('#d-receipt').value,'');
});
