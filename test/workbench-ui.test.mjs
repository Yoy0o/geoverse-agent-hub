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
  const api = { puts: [], patches: [], briefs: [], copied: [], setGate: null, patchGate: null, failAfterPut: false, patchError: null, briefError: null };
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
  w.hub = { caps: async () => caps, async req(method, url) {
    if (url.startsWith('/api/docs/tasks/')) {
      const d = docs.get(decodeURIComponent(url.split('/').at(-1)));
      if (!d) throw Object.assign(new Error('not_found'), { status: 404 });
      return { data: structuredClone(d) };
    }
    if (url === '/api/focus') return { items: [], remaining: [], updates: [], total: docs.size, counts: { attention: 0, updates: 0 } };
    if (url.endsWith('/focus')) throw Object.assign(new Error('No brief in fixture'), { status: 404 });
    if (url.endsWith('/brief')) {
      api.briefs.push(url);
      if (api.briefError) throw api.briefError;
      const d = docs.get(decodeURIComponent(url.split('/').at(-2)));
      return '# Server task sheet: ' + d.title + '\n' + d.goal + '\n阶段成果：update_work_brief';
    }
    if (url.startsWith('/api/exec')) return { runners: [], recent: [], active: [] };
    if (url.startsWith('/api/runs')) return [];
    if (url.startsWith('/api/sync')) return { configured: false };
    if (url.includes('/activity')) return { events: [], sessions: [] };
    return [];
  } };
  w.claude = { async use(name) { if (name === 'db') return db; throw new Error('disabled'); } };
  w.localStorage.setItem('awb.tab','board');
  w.eval(source('task-edits.js')); w.eval(source('focus.js'));
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
