import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configFromArgs } from '../packages/cli/src/index.js';
import { startServer } from '../packages/cli/src/server.js';

async function setup(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'loadtesting-cli-'));
  const app=await startServer({port:0,outputDir:dir});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const page=await fetch(app.url);
  const cookie=page.headers.get('set-cookie').split(';')[0];
  const headers={'content-type':'application/json',origin:app.url,cookie};
  return { app,dir,headers };
}
async function finished(app,id,headers) {
  for (let i=0;i<100;i++) {
    const r=await (await fetch(app.url+'/api/runs/'+id,{headers})).json();
    if(r.status!=='running')return r;
    await new Promise(r=>setTimeout(r,20));
  }
  throw new Error('Run did not complete');
}
async function cli(args) {
  const child=spawn(process.execPath,['packages/cli/src/index.js',...args],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  return {code,stdout,stderr};
}
test('CLI repeated arguments and config variables support mixed request details',async()=>{
  const c=await configFromArgs({url:['http://localhost/a','http://localhost/b'],method:'POST',header:['X-Test: one:two'],query:['q=a=b'],data:'{"hello":true}','body-type':'json',users:'2',requests:'4',var:['token=value'],bearer:'{{token}}'});
  assert.equal(c.endpoints.length,2);assert.equal(c.requests,4);assert.equal(c.endpoints[0].headers['X-Test'],'one:two');
  assert.equal(c.endpoints[0].query.q,'a=b');assert.equal(c.variables.token,'value');
  await assert.rejects(configFromArgs({url:['http://localhost'],requests:'2',duration:'1'}),/Choose requests or duration/);
});
test('local UI assets, session/origin checks, run lifecycle, conflict and log download',async t=>{
  const {app,headers}=await setup(t);
  assert.match(await (await fetch(app.url)).text(),/Request builder/);
  assert.equal((await fetch(app.url+'/styles.css')).status,200);
  assert.equal((await fetch(app.url+'/api/runs')).status,403);
  assert.equal((await fetch(app.url+'/api/runs',{headers:{...headers,origin:'https://evil.example'}})).status,403);
  const config={users:2,requests:4,endpoints:[{url:app.url+'/demo/slow'}]};
  const res=await fetch(app.url+'/api/runs',{method:'POST',headers,body:JSON.stringify(config)});
  assert.equal(res.status,202);const {id}=await res.json();
  assert.equal((await fetch(app.url+'/api/runs',{method:'POST',headers,body:JSON.stringify(config)})).status,409);
  const run=await finished(app,id,headers);assert.equal(run.status,'completed');assert.equal(run.stats.total,4);assert.equal(run.recent.length,4);
  const details=await fetch(app.url+'/api/runs/'+id+'/details',{headers});
  assert.match(details.headers.get('content-disposition'),/requests.ndjson/);
  assert.equal((await details.text()).trim().split('\n').length,4);
  const summary=await (await fetch(app.url+'/api/runs/'+id+'/summary',{headers})).json();
  assert.equal(summary.total,4);
  assert.equal((await fetch(app.url+'/api/runs/nope',{headers})).status,404);
});
test('web cancellation and invalid configurations',async t=>{
  const {app,headers}=await setup(t);
  const bad=await fetch(app.url+'/api/runs',{method:'POST',headers,body:JSON.stringify({users:0,endpoints:[{url:app.url}]})});
  assert.equal(bad.status,400);
  const response=await fetch(app.url+'/api/runs',{method:'POST',headers,body:JSON.stringify({users:2,duration:5,endpoints:[{url:app.url+'/demo/slow'}]})});
  const {id}=await response.json();
  await fetch(app.url+'/api/runs/'+id+'/stop',{method:'POST',headers,body:'{}'});
  const run=await finished(app,id,headers);assert.equal(run.status,'cancelled');assert.equal(run.stats.cancelled,true);
});
test('actual CLI process emits valid JSON, threshold exit 2, invalid argument exit 1',async t=>{
  const {app,dir}=await setup(t);
  const result=await cli(['run','--url',app.url+'/demo/health','--url',app.url+'/demo/fail','--users','2','--requests','6','--error-rate','0','--out',dir,'--json']);
  assert.equal(result.code,2,result.stderr);const s=JSON.parse(result.stdout);assert.equal(s.total,6);assert.equal(s.failed,3);
  assert.equal(JSON.parse(await readFile(s.files.summary,'utf8')).total,6);
  const invalid=await cli(['run','--url',app.url,'--users=-1']);assert.equal(invalid.code,1);assert.match(invalid.stderr,/users must/);
  const help=await cli(['--help']);assert.equal(help.code,0);assert.match(help.stdout,/--requests/);
});
