import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-delivery-"));
const token = "delivery-fixture-not-a-deployed-secret";
let hub, base, logs = "";
const call = (p, method = "GET", body) => fetch(base + p, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
before(async () => {
  const probe = net.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve)); base = "http://127.0.0.1:" + port;
  hub = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.js"], { env: { ...process.env, HUB_DATA_DIR: dir, HUB_TOKEN: token, HOST: "127.0.0.1", PORT: String(port), OAUTH_ENABLED: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  hub.stdout.on("data", (d) => logs += d); hub.stderr.on("data", (d) => logs += d);
  for (let n = 0; n < 100; n++) {
    if (hub.exitCode !== null) throw new Error(logs);
    try { if ((await call("/api/health")).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Service did not start: " + logs);
});
after(async () => {
  if (hub && hub.exitCode === null) { const closed = once(hub, "exit"); hub.kill(); await closed; }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const json = async r => { assert.equal(r.ok, true, await r.clone().text()); return r.json(); };
const create = async (title, status = '执行中') => (await json(await call('/api/tasks', 'POST', { title, status, project: 'pause-fixture' }))).id;
const life = id => call('/api/tasks/' + id + '/lifecycle').then(json);
const task = id => call('/api/tasks/' + id).then(json);
const pauseBody = async (id, extra = {}) => ({ expectedFingerprint: (await life(id)).expectedFingerprint, reason: '临时处理插单', summary: '已确认主通道方案', nextAction: '修复两个断连用例', ...extra });
const pause = async (id, extra = {}) => json(await call('/api/tasks/' + id + '/pause', 'POST', await pauseBody(id, extra)));
const resume = async (id, extra = {}) => call('/api/tasks/' + id + '/resume', 'POST', { expectedFingerprint: (await life(id)).expectedFingerprint, ...extra });

const delivery = (id, revision='') => call('/api/tasks/'+id+'/delivery'+(revision?'/'+revision:'')).then(json);
const receipt = (id, extra={}) => call('/api/tasks/'+id+'/receipt','POST',{status:'done',summary:'Topology repaired',version:'experiment-v1',changed:['src/routes.js'],verify:[{cmd:'route tests',result:'pass'}],scope:'ok',risks:'无',...extra}).then(json);
const reviewBody = async id => { const v=await delivery(id); return {action:'merge',expectedDeliveryId:v.currentId,expectedFingerprint:v.expectedFingerprint,verificationConfirmed:true,acceptedCriteria:(v.selected.requirements?.acceptance||[]).map((_,i)=>i),note:'已人工核对实验和验收用例'}; };

test('immutable versions deduplicate across channels and retain concise changes without reverting on replay',async()=>{
  const id=await create('Versioned route experiment');
  const first=await receipt(id), firstSnapshot=(await delivery(id)).selected;
  const again=await receipt(id); assert.equal(again.skipped,true); assert.equal(again.deliveryId,first.deliveryId);
  const client=new Client({name:'delivery',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp?agent=codex'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  try {
    await client.callTool({name:'submit_receipt',arguments:{task:id,status:'done',summary:'Topology repaired',version:'experiment-v1',changed:['src/routes.js'],verify:[{cmd:'route tests',result:'pass'}],scope:'ok',risks:'无'}});
    assert.equal((await delivery(id)).versions.length,1);
    const context=JSON.parse((await client.callTool({name:'get_delivery',arguments:{id}})).content[0].text);
    assert.equal(context.currentId,first.deliveryId);
  }finally{await client.close();}
  const second=await receipt(id,{version:'experiment-v2',summary:'Second case fixed',changed:['src/routes.js','test/routes.js'],verify:[{cmd:'route tests',result:'pass'},{cmd:'snap tests',result:'pass'}]});
  let v=await delivery(id); assert.equal(v.versions.length,2); assert.deepEqual(v.difference.addedFiles,['test/routes.js']); assert.equal(v.difference.verification[0].cmd,'snap tests');
  assert.deepEqual((await delivery(id,first.deliveryId)).selected,firstSnapshot);
  await receipt(id); v=await delivery(id); assert.equal(v.currentId,second.deliveryId); assert.equal(v.versions.length,2);
});

test('review binds exact version, requirements and check; old approval cannot certify later output',async()=>{
  const id=await create('Review binding'); await receipt(id); const stale=await reviewBody(id);
  await receipt(id,{version:'experiment-v2',summary:'New result'});
  assert.equal((await call('/api/tasks/'+id+'/review','POST',stale)).status,409);
  const beforeCheck=await reviewBody(id), current=(await delivery(id)).currentId;
  await json(await call('/api/tasks/'+id+'/check','POST',{deliveryId:current,version:'experiment-v2',ok:false,verify:[{cmd:'snap tests',result:'fail'}]}));
  assert.equal((await call('/api/tasks/'+id+'/review','POST',beforeCheck)).status,409);
  assert.equal((await call('/api/tasks/'+id+'/review','POST',await reviewBody(id))).status,409);
  await json(await call('/api/tasks/'+id+'/check','POST',{deliveryId:current,version:'experiment-v2',ok:true,verify:[{cmd:'snap tests',result:'pass'}]}));
  const accepted=await json(await call('/api/tasks/'+id+'/review','POST',await reviewBody(id)));
  assert.equal(accepted.task.review.deliveryId,current); assert.equal((await delivery(id)).accepted,true);
  const approved=(await task(id)).deliveries.find(r=>r.id===current);
  const late=await receipt(id,{version:'experiment-v3',summary:'Output after acceptance'});
  assert.equal(late.archived,true); assert.equal((await delivery(id)).currentId,current); assert.equal((await task(id)).status,'已合并');
  assert.deepEqual((await task(id)).deliveries.find(r=>r.id===current),approved);
  const backup=await json(await call('/api/export')); await json(await call('/api/import','POST',backup));
  assert.deepEqual((await task(id)).deliveryReviews,backup.tasks.find(t=>t.id===id).deliveryReviews);
  assert.equal((await delivery(id)).versions.length,3);
});

test('progress ticks cannot replace explicit version acceptance, and generic writes cannot bypass it',async()=>{
  const id=await create('Human acceptance');
  await json(await call('/api/docs/tasks/'+id,'PATCH',{acceptance:[{text:'Primary road priority',done:false},{text:'No disconnected route',done:false}]}));
  await json(await call('/api/tasks/'+id+'/progress','POST',{acceptance:[0,1]})); await receipt(id);
  assert((await task(id)).acceptance.every(a=>a.done===false));
  const body=await reviewBody(id);
  assert.equal((await call('/api/tasks/'+id+'/review','POST',{...body,acceptedCriteria:[]})).status,409);
  assert.equal((await call('/api/tasks/'+id+'/review','POST',{...body,verificationConfirmed:false})).status,409);
  for(const patch of [{status:'已合并'},{receipt:{summary:'Overwrite'}},{deliveries:[]},{review:{at:new Date().toISOString()}},{lastCheck:{ok:true}}]) assert.equal((await call('/api/docs/tasks/'+id,'PATCH',patch)).status,409);
  assert.equal((await call('/api/tasks/'+id+'/transition','POST',{to:'已合并'})).status,409);
  assert.equal((await call('/api/tasks/'+id+'/merged','POST',{commit:'unverified'})).status,409);
  await json(await call('/api/tasks/'+id+'/review','POST',body));
  assert.deepEqual((await task(id)).deliveryReviews[0].acceptance,['Primary road priority','No disconnected route']);
});

test('requirements changes and unbound or dirty checks never inherit a previous verification',async()=>{
  const id=await create('Requirements revisions'); await receipt(id);
  await json(await call('/api/tasks/'+id+'/check','POST',{version:'experiment-v1',ok:true,verify:[{cmd:'route tests',result:'pass'}]}));
  assert((await delivery(id)).check);
  await json(await call('/api/docs/tasks/'+id,'PATCH',{goal:'Now support multiple via points'}));
  assert.equal((await delivery(id)).requirementsChanged,true);
  assert.equal((await call('/api/tasks/'+id+'/review','POST',await reviewBody(id))).status,409);
  await receipt(id,{summary:'New acceptance scope addressed'});
  assert.equal((await delivery(id)).check,null);
  await json(await call('/api/tasks/'+id+'/check','POST',{version:'other-version',ok:false,verify:[{cmd:'old tests',result:'fail'}]}));
  assert.equal((await delivery(id)).check,null); assert.equal((await delivery(id)).canReview,true);
  const current=(await delivery(id)).currentId;
  assert.equal((await call('/api/tasks/'+id+'/check','POST',{deliveryId:current,version:'wrong-version',ok:true})).status,409);
  assert.equal((await call('/api/tasks/'+id+'/check','POST',{deliveryId:current,version:'experiment-v1',dirty:true,ok:true})).status,409);
  const body=await reviewBody(id); assert.equal((await call('/api/tasks/'+id+'/review','POST',{...body,note:''})).status,409);
});

test('legacy receipts remain readable without invented provenance and require a new version before acceptance',async()=>{
  const id=await create('Legacy record'); const t=await task(id);
  const old={summary:'Old retained output',changed:['old.js'],verify:[],at:'2025-01-01T00:00:00Z'};
  await json(await call('/api/import','POST',{app:'agent-workbench',tasks:[{...t,status:'待评审',receipt:old}]}));
  assert.equal((await delivery(id)).selected.legacy,true);
  assert.equal((await call('/api/tasks/'+id+'/review','POST',await reviewBody(id))).status,409);
  await receipt(id); assert.equal((await delivery(id)).versions.length,2);
  assert.deepEqual((await task(id)).deliveries[0].receipt,old);
});

test('shell and MCP review use the same exact-version confirmation',async()=>{
  const id=await create('Shared review contract'); await receipt(id);
  const run=promisify(execFile),cwd=path.join(dir,'review-repo');fs.mkdirSync(cwd);
  await run('git',['init','-b','main'],{cwd});
  const env={...process.env,AGENT_HUB_URL:base,AGENT_HUB_TOKEN:token,AGENT_HUB_CONFIG:path.join(dir,'missing'),AGENT_HUB_DISABLE:'0',CF_ACCESS_CLIENT_ID:'',CF_ACCESS_CLIENT_SECRET:''};
  const script=path.resolve('kit/scripts/task.sh'),file=path.join(dir,'review.json');
  const v=JSON.parse((await run('bash',[script,'delivery',id],{cwd,env})).stdout);assert.equal(v.selected.version,'experiment-v1');
  fs.writeFileSync(file,JSON.stringify(await reviewBody(id))); await run('bash',[script,'review',id,file],{cwd,env});
  assert.equal((await delivery(id)).accepted,true);
  const client=new Client({name:'delivery',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp?agent=codex'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  try{
    const other=await create('MCP review');await receipt(other);
    assert((await client.callTool({name:'move_task',arguments:{id:other,action:'merge'}})).isError);
    const body=await reviewBody(other);
    assert(!(await client.callTool({name:'move_task',arguments:{id:other,...body}})).isError);
    assert.equal((await delivery(other)).accepted,true);
  }finally{await client.close();}
});

test('archived results can only become current by explicit selection after reopening, without carrying approval',async()=>{
  const id=await create('Explicit reuse');await receipt(id);
  await json(await call('/api/tasks/'+id+'/review','POST',await reviewBody(id)));
  const archived=await receipt(id,{version:'experiment-v2',summary:'Late but useful result'}), before=await delivery(id);
  const select=body=>call('/api/tasks/'+id+'/delivery/'+archived.deliveryId+'/select','POST',body);
  assert.equal((await select({expectedFingerprint:before.expectedFingerprint})).status,409);
  await json(await call('/api/tasks/'+id+'/transition','POST',{to:'待执行'}));
  assert.equal((await select({expectedFingerprint:before.expectedFingerprint})).status,409);
  const selected=await json(await select({expectedFingerprint:(await delivery(id)).expectedFingerprint}));
  assert.equal(selected.task.status,'待评审');assert.equal(selected.delivery.currentId,archived.deliveryId);assert.equal(selected.delivery.accepted,false);
  await json(await call('/api/tasks/'+id+'/review','POST',await reviewBody(id)));
  assert.equal((await delivery(id)).accepted,true);assert.equal((await task(id)).deliveryReviews.length,2);
  assert.equal((await call('/api/tasks/'+id+'/merged','POST',{commit:'merge-sha',sourceCommit:'wrong-version'})).status,409);
  assert.equal((await task(id)).mergeCommit,undefined);
});

test('placeholder versions and blank or mismatched receipts cannot produce an accepted result',async()=>{
  const id=await create('Version validation');
  assert.equal((await call('/api/tasks/'+id+'/receipt','POST',{summary:' ',version:'v1'})).status,400);
  assert.equal((await call('/api/tasks/'+id+'/receipt','POST',{task:'T-other',summary:'Wrong task',version:'v1'})).status,400);
  await receipt(id,{version:'unknown'});assert.equal((await delivery(id)).canReview,false);
  assert.equal((await call('/api/tasks/'+id+'/review','POST',await reviewBody(id))).status,409);
});

test('an earlier execution stays archived when a newer execution is paused again',async()=>{
  const id=await create('Repeated interruptions');
  const first=await json(await call('/api/tasks/'+id+'/start','POST',{agent:'codex'}));
  await pause(id); await json(await resume(id,{confirmedExternalStop:true}));
  const second=await json(await call('/api/tasks/'+id+'/start','POST',{agent:'codex'}));
  await pause(id);
  const current=await receipt(id,{run:second.run.id,version:'experiment-v2',summary:'Current paused execution result'});
  assert.equal(current.archived,false);
  const late=await receipt(id,{run:first.run.id,version:'experiment-v1',summary:'Older execution finally arrived'});
  assert.equal(late.archived,true);
  const remote=await receipt(id,{run:'unknown-remote-old-run',version:'experiment-v0',summary:'Unregistered earlier execution'});
  assert.equal(remote.archived,true);
  const v=await delivery(id);
  assert.equal(v.currentId,current.deliveryId); assert.equal(v.archivedCount,2);
  assert.equal((await task(id)).status,'已暂停');
  assert.equal((await task(id)).receipt.summary,'Current paused execution result');
  assert.equal((await delivery(id,late.deliveryId)).selected.receipt.summary,'Older execution finally arrived');
});

