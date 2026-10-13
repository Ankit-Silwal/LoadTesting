import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runLoadTest, normalizeConfig, importPostman, Metrics, redactHeaders, redactUrl } from '../packages/core/src/index.js';

async function fixture(t) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'loadtesting-core-'));
  let active = 0, peak = 0; const received = [];
  const server = http.createServer(async (req,res) => {
    active++; peak = Math.max(peak,active);
    res.on('close', () => active--);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url:req.url, method:req.method, headers:req.headers, body:Buffer.concat(chunks).toString() });
    if (req.url.startsWith('/slow')) { await new Promise(r => setTimeout(r, 150)); if (res.destroyed) return; }
    if (req.url.startsWith('/work')) await new Promise(r => setTimeout(r, 15));
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { location:'/ok' }); return res.end(); }
    if (req.url.startsWith('/fail')) { res.writeHead(503); return res.end('Unavailable'); }
    res.writeHead(200, { 'content-type':'application/json', 'set-cookie':'secret=session' });
    res.end(JSON.stringify({ ok:true, nested:{ value:7 } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(outputDir,{recursive:true,force:true}); });
  return { outputDir, base: `http://127.0.0.1:${server.address().port}`, received, peak:() => peak };
}
test('exact request budget, concurrency cap, mixed endpoint outcomes, two complete logs', async t => {
  const f = await fixture(t);
  const summary = await runLoadTest({ users:3, requests:17, endpoints:[
    { id:'ok', url:f.base+'/work', headers:{ Authorization:'Bearer confidential' } },
    { id:'fail', url:f.base+'/fail?api_key=private' },
  ] }, { outputDir:f.outputDir });
  assert.equal(summary.total,17); assert.equal(summary.successful,9); assert.equal(summary.failed,8);
  assert.ok(summary.peakConcurrency <= 3); assert.ok(summary.peakConcurrency > 1); assert.ok(f.peak() <= 3);
  assert.equal(summary.endpoints[0].total,9); assert.equal(summary.endpoints[1].total,8);
  assert.equal(summary.statusCodes['503'],8); assert.equal(summary.errors.http,8);
  const files = await readdir(path.dirname(summary.files.summary));
  assert.deepEqual(files.sort(),['requests.ndjson','summary.json']);
  const text = await readFile(summary.files.details,'utf8');
  assert.ok(!text.includes('confidential')); assert.ok(!text.includes('api_key=private')); assert.ok(!text.includes('secret=session'));
  const records = text.trim().split('\n').map(JSON.parse);
  assert.equal(records.length,17); assert.equal(new Set(records.map(r=>r.sequence)).size,17);
  assert.deepEqual(JSON.parse(await readFile(summary.files.summary,'utf8')),summary);
});
test('JSON body, query, basic auth, and assertions reach the server correctly', async t => {
  const f = await fixture(t);
  const s = await runLoadTest({ users:1, requests:2, variables:{ base:f.base }, endpoints:[{
    url:'{{base}}/ok', method:'POST', bodyType:'json', body:{ hello:'world' }, query:{ page:'2' },
    auth:{ type:'basic', username:'user', password:'pass' }, assertions:{ contains:'nested', json:{ 'nested.value':7, ok:true } },
  }] },{ outputDir:f.outputDir });
  assert.equal(s.successful,2); assert.equal(f.received[0].url,'/ok?page=2');
  assert.equal(f.received[0].headers.authorization,'Basic dXNlcjpwYXNz'); assert.equal(f.received[0].headers['content-type'],'application/json');
  assert.deepEqual(JSON.parse(f.received[0].body),{hello:'world'});
});
test('URL encoded, multipart text fields, and binary request bodies', async t => {
  const f = await fixture(t);
  const s = await runLoadTest({ users:1, requests:3, endpoints:[
    { url:f.base+'/ok', method:'POST', bodyType:'urlencoded', body:{ q:'a b' } },
    { url:f.base+'/ok', method:'POST', bodyType:'multipart', headers:{'Content-Type':'bad'}, body:{ q:'multipart value' } },
    { url:f.base+'/ok', method:'POST', bodyType:'binary', body:Buffer.from('binary-data').toString('base64') },
  ] },{outputDir:f.outputDir});
  assert.equal(s.successful,3); assert.equal(f.received[0].body,'q=a+b');
  assert.match(f.received[1].headers['content-type'],/^multipart\/form-data; boundary=/); assert.match(f.received[1].body,/multipart value/);
  assert.equal(f.received[2].body,'binary-data');
});
test('timeout, assertion failure, expected statuses, manual redirects, thresholds', async t => {
  const f = await fixture(t);
  const s = await runLoadTest({ users:2, requests:4, thresholds:{errorRate:0,p95:1}, endpoints:[
    { url:f.base+'/slow', timeout:20 },
    { url:f.base+'/ok', assertions:{json:{ok:false}} },
    { url:f.base+'/fail', expectedStatus:[503] },
    { url:f.base+'/redirect', redirect:'manual', expectedStatus:[302] },
  ] },{outputDir:f.outputDir});
  assert.equal(s.total,4); assert.equal(s.successful,2); assert.equal(s.failed,2);
  assert.equal(s.errors.timeout,1); assert.equal(s.errors.assertion,1); assert.equal(s.passed,false);
  assert.ok(s.thresholds.every(t=>!t.passed));
});
test('duration limits new attempts and rate cap paces a global budget', async t => {
  const f = await fixture(t);
  const s = await runLoadTest({ users:4, duration:.22, maxRps:20, endpoints:[{url:f.base+'/ok'}] },{outputDir:f.outputDir});
  assert.ok(s.total >= 3 && s.total <= 5, `received ${s.total}`); assert.ok(s.elapsedSeconds >= .2 && s.elapsedSeconds < 1);
  const finite = await runLoadTest({ users:3, requests:5, maxRps:20, endpoints:[{url:f.base+'/ok'}] },{outputDir:f.outputDir});
  assert.equal(finite.total,5); assert.ok(finite.elapsedSeconds >= .18);
});
test('cancellation stops inflight traffic and flushes both logs', async t => {
  const f = await fixture(t); const controller = new AbortController();
  setTimeout(()=>controller.abort(),30);
  const s = await runLoadTest({ users:2,duration:10,endpoints:[{url:f.base+'/slow'}] },{outputDir:f.outputDir,signal:controller.signal});
  assert.equal(s.cancelled,true); assert.equal(s.passed,false); assert.ok(s.elapsedSeconds < 1); assert.ok(s.total <= 2);
  assert.equal(s.failed,s.total); assert.ok(await readFile(s.files.summary,'utf8'));
});
test('invalid configuration rejects before creating output or sending requests', async t => {
  const f = await fixture(t);
  for (const input of [
    {users:0,endpoints:[{url:f.base}]}, {users:1.5,endpoints:[{url:f.base}]},
    {duration:1,requests:1,endpoints:[{url:f.base}]}, {endpoints:[{url:'file:///etc/passwd'}]},
    {endpoints:[{url:f.base,method:'GET',body:'bad'}]}, {endpoints:[{url:'{{unknown_variable_12345}}'}]},
    {endpoints:[{url:f.base,headers:{'bad\nkey':'value'}}]}, {endpoints:[{url:f.base},{url:f.base,id:'endpoint-1'}]},
  ]) await assert.rejects(runLoadTest(input,{outputDir:f.outputDir}));
  assert.equal(f.received.length,0); assert.deepEqual(await readdir(f.outputDir),[]);
});
test('bounded metrics give percentile upper bounds and redact known secret fields', () => {
  const metrics = new Metrics();
  for (let i=1;i<=10000;i++) metrics.add({latencyMs:i/10,success:true,bytes:5,status:200});
  assert.ok(metrics.buckets.size < 2000);
  const p95=metrics.percentile(95); assert.ok(p95>=950 && p95 <= 959.5);
  assert.equal(metrics.snapshot(10).requestsPerSecond,1000);
  assert.equal(redactHeaders({Authorization:'secret','x-api-key':'key',Accept:'json'}).Authorization,'[REDACTED]');
  assert.ok(!redactUrl('http://localhost/?access_token=secret').includes('secret'));
  assert.equal(normalizeConfig({endpoints:[{url:'http://localhost'}]}).duration,10);
});
test('Postman nested folders inherit auth and preserve active headers and variables', () => {
  const c = importPostman({ info:{name:'Example'},variable:[{key:'base',value:'http://localhost'}],auth:{type:'bearer',bearer:[{key:'token',value:'{{token}}'}]},item:[
    {name:'Folder',item:[{name:'Create',request:{method:'POST',url:{raw:'{{base}}/items'},header:[{key:'Accept',value:'json'},{key:'ignore',value:'x',disabled:true}],body:{mode:'raw',raw:'{"ok":true}',options:{raw:{language:'json'}}}}}]},
  ] },{token:'demo'});
  const config=normalizeConfig(c);
  assert.equal(config.endpoints.length,1); assert.equal(config.endpoints[0].headers.authorization,'Bearer demo');
  assert.equal(config.endpoints[0].body,'{"ok":true}'); assert.equal(config.endpoints[0].headers.ignore,undefined);
});
test('small finite budgets do not wait for unused users, rate slots, ramp-up or think-time', async t => {
  const f = await fixture(t);
  for (const settings of [
    { users:50, requests:1, maxRps:1 },
    { users:10, requests:2, rampUp:60 },
    { users:2, requests:2, thinkTime:30000 },
    { users:20, requests:3, maxRps:20 },
  ]) {
    const s = await runLoadTest({ ...settings, endpoints:[{url:f.base+'/ok'}] },{outputDir:f.outputDir});
    assert.equal(s.total,settings.requests); assert.ok(s.elapsedSeconds < 1, 'Unused pacing extended a completed budget');
  }
});
test('nested variables resolve, cycles/missing inherited names reject, auth overrides casing', () => {
  const c=normalizeConfig({ variables:{ base:'{{host}}', token:'{{secret}}' }, endpoints:[{url:'{{base}}/ok',headers:{Authorization:'old'},auth:{type:'bearer',token:'{{token}}'}}] },{host:'http://localhost',secret:'new'});
  assert.equal(c.endpoints[0].headers.authorization,'Bearer new');assert.equal(c.endpoints[0].url,'http://localhost/ok');
  assert.throws(()=>normalizeConfig({variables:{a:'{{b}}',b:'{{a}}'},endpoints:[{url:'{{a}}'}]}),/Circular variable/);
  assert.throws(()=>normalizeConfig({endpoints:[{url:'{{constructor}}'}]},{}),/Missing variable/);
  assert.throws(()=>normalizeConfig({endpoints:[null]}),/Each endpoint/);
});
test('Postman active query parameters resolve variables and disabled params stay excluded', () => {
  const imported=importPostman({variable:[{key:'base',value:'http://localhost'},{key:'id',value:'42'}],item:[{name:'Lookup',request:{url:{raw:'{{base}}/lookup?id={{id}}&disabled=bad',query:[{key:'id',value:'{{id}}'},{key:'disabled',value:'bad',disabled:true}]}}}]});
  assert.equal(normalizeConfig(imported).endpoints[0].url,'http://localhost/lookup?id=42');
});
test('response previews are available to callbacks but excluded from disk logs', async t => {
  const f=await fixture(t);let preview;
  const s=await runLoadTest({users:1,requests:1,endpoints:[{url:f.base+'/ok'}]}, {outputDir:f.outputDir,captureResponse:true,onRequest:r=>preview=r});
  assert.match(preview.responseBody,/"ok":true/);
  const record=JSON.parse((await readFile(s.files.details,'utf8')).trim());
  assert.equal(record.responseBody,undefined);
});
