import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ASSETS, WORKFLOW_TOOLS, releaseSnapshot, verifyRelease } from '../scripts/verify-release.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
function fixture(options = {}) {
  const body='fixture asset', expected={version:'0.6.1',commit:'a'.repeat(40),assets:Object.fromEntries(ASSETS.map(file=>[file,digest(body)]))};
  const requested=[], called=[]; let closed=false;
  const focus={items:[],remaining:[],updates:[],deferred:[],counts:{attention:0,urgent:0,unread:0,deferred:0}};
  const results={items:[],total:0,limit:1};
  const tasks=options.empty?[]:[{id:'T-fixture'}];
  const delivery={task:'T-fixture',versions:[],expectedFingerprint:'f'.repeat(64)};
  const values={
    '/api/health':{version:expected.version,build:{commit:expected.commit,dirty:false,assets:expected.assets}},
    '/api/capabilities':{version:expected.version,build:{commit:expected.commit,dirty:false,assets:expected.assets}},
    '/api/focus':focus, '/api/tasks':tasks,
    '/api/tasks/T-fixture/lifecycle':{id:'T-fixture',expectedFingerprint:'f'.repeat(64)},
    '/api/tasks/T-fixture/delivery':delivery,
  };
  const fetchImpl=async(url,init)=>{
    assert.equal(init.redirect,'manual'); assert.equal(init.method,undefined); requested.push(url);
    const path=new URL(url).pathname;
    if(options.badRoute===path) return new Response(options.badBody||'blocked',{status:options.status||403,headers:{'Content-Type':options.contentType||'text/plain'}});
    if(path==='/' || ASSETS.includes(path.slice(1))) return new Response(options.staleAsset&&path==='/results.js'?'old':body);
    return Response.json(path==='/api/deliveries'?results:values[path]);
  };
  const openMcp=async()=>({
    async listTools({cursor}) { const names=WORKFLOW_TOOLS.filter(name=>name!==options.missing); const split=5; return {tools:(cursor?names.slice(split):names.slice(0,split)).map(name=>({name})),...(cursor?{}:{nextCursor:'page-2'})}; },
    async callTool({name,arguments:args}) { called.push(name); assert(['get_focus','search_deliveries','get_work_context','get_delivery'].includes(name)); if(options.toolError===name)return {isError:true}; return {content:[{type:'text',text:JSON.stringify(name==='get_focus'?focus:name==='search_deliveries'?results:name==='get_work_context'?{expectedFingerprint:'f'.repeat(64)}:delivery)}]}; },
    async close(){closed=true;},
  });
  return { expected, requested, called, values, isClosed:()=>closed, run:()=>verifyRelease({origin:'https://hub.example',expected,headers:{},fetchImpl,openMcp}) };
}

test('release check covers new reads, seven served assets and paginated tool inventory without business writes',async()=>{
  const f=fixture(),result=await f.run(); assert.equal(result.workflowTools,13); assert.equal(result.taskSampled,true);
  assert.equal(result.assets,7); assert(f.requested.some(url=>url.endsWith('scope=all&limit=1')));
  assert.deepEqual(f.called,['get_focus','search_deliveries','get_work_context','get_delivery']); assert(f.isClosed());
});
test('empty production instance reports skipped task sampling without creating fixtures',async()=>{
  const f=fixture({empty:true}); assert.equal((await f.run()).taskSampled,false); assert.deepEqual(f.called,['get_focus','search_deliveries']);
});
test('missing P1 tool and failed read cannot pass release verification',async()=>{
  for(const options of [{missing:'reuse_delivery'},{toolError:'get_focus'}]){const f=fixture(options); await assert.rejects(f.run(),/MCP/); assert(f.isClosed());}
});
test('Access redirect, denied request and HTML login are explicit failures',async()=>{
  for(const status of [302,403,200]){const f=fixture({badRoute:'/api/health',status}); await assert.rejects(f.run(),status===200?/JSON/:new RegExp('HTTP '+status)); assert.equal(f.called.length,0);}
});
test('commit identity, dirty marker and stale served assets cannot pass',async()=>{
  const commit=fixture(); commit.values['/api/health'].build.commit='b'.repeat(40); await assert.rejects(commit.run(),/提交/);
  const dirty=fixture(); dirty.values['/api/capabilities'].build.dirty=true; await assert.rejects(dirty.run(),/工作区/);
  await assert.rejects(fixture({staleAsset:true}).run(),/results.js/);
});
test('release reference resolves an immutable tree independently of current checkout changes',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-release-ref-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const git=args=>execFileSync('git',args,{cwd:dir,stdio:['ignore','pipe','pipe'],encoding:'utf8'}).trim();
  git(['init']); git(['config','user.name','Release fixture']); git(['config','user.email','fixture@example.invalid']);
  await fs.mkdir(path.join(dir,'public')); await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({version:'0.6.0'}));
  for(const file of ASSETS)await fs.writeFile(path.join(dir,'public',file),'original');
  git(['add','.']); git(['commit','-m','original']); const commit=git(['rev-parse','HEAD']);
  await fs.writeFile(path.join(dir,'public','index.html'),'next'); git(['add','.']); git(['commit','-m','next']);
  await fs.writeFile(path.join(dir,'public','index.html'),'uncommitted');
  const snapshot=releaseSnapshot('HEAD^',dir); assert.equal(snapshot.commit,commit); assert.equal(snapshot.assets['index.html'],digest('original'));
  assert.equal(releaseSnapshot('HEAD',dir).assets['index.html'],digest('next'));
});
