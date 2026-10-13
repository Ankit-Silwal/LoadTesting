import { spawn,spawnSync } from 'node:child_process';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const npm=process.env.npm_execpath;
if(!npm)throw new Error('Run through npm run smoke:package');
const root=process.cwd();
function npmRun(args,cwd=root) {
  const r=spawnSync(process.execPath,[npm,...args],{cwd,encoding:'utf8'});
  if(r.status!==0)throw new Error(r.stderr||r.stdout);
  return r.stdout;
}
npmRun(['run','build']);
const packed=JSON.parse(npmRun(['pack','--workspace','@ankit-silwal/loadtesting','--ignore-scripts','--json']));
assert.equal(packed.length,1);
const tarball=path.join(root,packed[0].filename);
const temp=await mkdtemp(path.join(os.tmpdir(),'loadtesting-package-'));
let child;
try{
  await writeFile(path.join(temp,'package.json'),JSON.stringify({name:'package-smoke',private:true,type:'module'}));
  npmRun(['install',tarball,'--ignore-scripts','--no-audit','--no-fund'],temp);
  const entry=path.join(temp,'node_modules/@ankit-silwal/loadtesting/dist/index.js');
  const help=spawnSync(process.execPath,[entry,'--help'],{cwd:temp,encoding:'utf8'});
  assert.equal(help.status,0);assert.match(help.stdout,/LoadTesting/);
  const core=await import(pathToFileURL(path.join(temp,'node_modules/@ankit-silwal/loadtesting/dist/core/index.js')));
  assert.equal(typeof core.runLoadTest,'function');
  child=spawn(process.execPath,[entry,'web','--port','0'],{cwd:temp,stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{
    let output='',error='';const timer=setTimeout(()=>reject(new Error('Packaged web server timed out')),10000);
    child.stdout.on('data',c=>{output+=c;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
    child.stderr.on('data',c=>error+=c);
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Packaged server exited '+code+': '+error));});
  });
  assert.match(await(await fetch(url)).text(),/Request builder/);
  assert.match(await(await fetch(url+'/app.js')).text(),/renderEditor/);
  const run=spawnSync(process.execPath,[entry,'run','--url',url+'/demo/health','--requests','7','--users','2','--json'],{cwd:temp,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const summary=JSON.parse(run.stdout);assert.equal(summary.total,7);assert.equal(summary.successful,7);
  assert.ok(summary.files.summary.startsWith(temp));
  console.log('Packed package verified: isolated install, CLI, module export, web assets, and seven logged HTTP requests.');
}finally{
  if(child&&!child.killed){child.kill();await new Promise(r=>child.once('exit',r));}
  await rm(temp,{recursive:true,force:true});
}
