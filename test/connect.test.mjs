import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('connection profiles coexist and authentication pages never modify user configuration', async () => {
  const root=path.resolve('.cloudflare');
  await fs.mkdir(root,{recursive:true});
  const home=await fs.mkdtemp(path.join(root,'connect-test-'));
  const config=path.join(home,'.codex/config.toml');
  await fs.mkdir(path.dirname(config),{recursive:true});
  await fs.writeFile(config,'model = "fixture"\n[mcp_servers.existing]\nurl = "https://example.invalid/mcp"\n[mcp_servers.agent-hub-cloud]\nurl = "https://old.invalid/mcp"\n[mcp_servers.agent-hub-cloud.http_headers]\nAuthorization = "stale-fixture"\n[mcp_servers.after]\nurl = "https://after.invalid/mcp"\n');
  let responseMode='ok';
  const server=http.createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-token');
    if(responseMode==='redirect'){res.writeHead(302,{Location:'/login'});res.end();return;}
    if(responseMode==='html'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>Login</html>');return;}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({version:'fixture',baseUrl:'http://fixture',via:'token'}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const run=async(profile)=>{const child=spawn(process.execPath,['kit/connect.mjs','--url',base,'--agents','codex','--profile',profile,'--name','agent-hub-'+profile,'--no-otel'],{env:{...process.env,HOME:home,USERPROFILE:home,AGENT_HUB_TOKEN:'fixture-token',CF_ACCESS_CLIENT_ID:'',CF_ACCESS_CLIENT_SECRET:''},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);const [code]=await once(child,'exit');return {code,output};};
  try {
    assert.equal((await run('local')).code,0);
    assert.equal((await run('cloud')).code,0);
    const toml=await fs.readFile(config,'utf8');
    assert.ok(toml.includes('[mcp_servers.agent-hub-local]'));
    assert.ok(toml.includes('[mcp_servers.agent-hub-cloud]'));
    assert.ok(toml.includes('[mcp_servers.existing]')&&toml.includes('[mcp_servers.after]'));
    assert.ok(!toml.includes('stale-fixture')&&!toml.includes('[otel]'));
    const envRoot=path.join(home,'.config/agent-hub');
    assert.ok((await fs.readFile(path.join(envRoot,'local.env'),'utf8')).includes('AGENT_HUB_TOKEN=fixture-token'));
    assert.ok((await fs.readFile(path.join(envRoot,'cloud.env'),'utf8')).includes('AGENT_HUB_TOKEN=fixture-token'));
    await assert.rejects(fs.access(path.join(envRoot,'env')));
    responseMode='redirect';const redirect=await run('rejected');assert.notEqual(redirect.code,0);assert.match(redirect.output,/Access/);
    responseMode='html';assert.notEqual((await run('html')).code,0);
    await assert.rejects(fs.access(path.join(envRoot,'rejected.env')));
    await assert.rejects(fs.access(path.join(envRoot,'html.env')));
    assert.equal(await fs.readFile(config,'utf8'),toml);
  } finally {
    server.close();
    assert.ok(path.resolve(home).startsWith(root+path.sep));
    await fs.rm(home,{recursive:true,force:true});
  }
});

test('--remove deletes only the named MCP registration, keeps other entries and backs files up', async () => {
  const root=path.resolve('.cloudflare');
  await fs.mkdir(root,{recursive:true});
  const home=await fs.mkdtemp(path.join(root,'connect-remove-'));
  const toml=path.join(home,'.codex/config.toml'), cursor=path.join(home,'.cursor/mcp.json'), env=path.join(home,'.config/agent-hub/local.env');
  await fs.mkdir(path.dirname(toml),{recursive:true}); await fs.mkdir(path.dirname(cursor),{recursive:true}); await fs.mkdir(path.dirname(env),{recursive:true});
  await fs.writeFile(toml,'model = "fixture"\n[mcp_servers.agent-hub-local]\nurl = "http://127.0.0.1:8787/mcp?agent=codex"\n[mcp_servers.agent-hub-local.http_headers]\nAuthorization = "Bearer local"\n[mcp_servers.agent-hub-cloud]\nurl = "https://cloud.invalid/mcp?agent=codex"\n');
  await fs.writeFile(cursor,JSON.stringify({mcpServers:{'agent-hub-local':{url:'http://127.0.0.1:8787/mcp'},other:{url:'https://other.invalid'}}}));
  await fs.writeFile(env,'AGENT_HUB_URL=http://127.0.0.1:8787\nAGENT_HUB_TOKEN=local\n');
  try {
    const child=spawn(process.execPath,['kit/connect.mjs','--remove','agent-hub-local','--agents','codex,cursor,kiro','--profile','local'],{env:{...process.env,HOME:home,USERPROFILE:home},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    const [code]=await once(child,'exit');
    assert.equal(code,0,output);
    const t=await fs.readFile(toml,'utf8');
    assert.ok(!t.includes('agent-hub-local')&&!t.includes('Bearer local'));
    assert.ok(t.includes('[mcp_servers.agent-hub-cloud]')&&t.includes('model = "fixture"'));
    const c=JSON.parse(await fs.readFile(cursor,'utf8'));
    assert.deepEqual(Object.keys(c.mcpServers),['other']);
    await assert.rejects(fs.access(env));
    assert.ok((await fs.readdir(path.dirname(toml))).some(f=>f.includes('bak-agent-hub')));
    await assert.rejects(fs.access(path.join(home,'.kiro')));
  } finally {
    assert.ok(path.resolve(home).startsWith(root+path.sep));
    await fs.rm(home,{recursive:true,force:true});
  }
});
