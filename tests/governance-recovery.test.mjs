import test from 'node:test';
import {nativeTmpdir} from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {canonicalize,digest} from '../src/governance/contracts.mjs';
import {openGovernanceStore,inspectGovernanceStore,STORE_LIMITS} from '../src/governance/store.mjs';
import {m1Deferred,m1FixtureValidator,m1Payload,m1Marker,m1WaitMarker,m1Spawn,M1_STORE_CHILD_SOURCE,M1_IMPORT_CHILD_SOURCE} from './helpers/governance.mjs';

const storeURL=pathToFileURL(path.resolve('src/governance/store.mjs')).href;
const code=c=>e=>e.code===c;
async function fixture(t,extra={}){
  const base=await fs.mkdtemp(path.join(nativeTmpdir(),'governance-m1-'));
  const projectRoot=path.join(base,'project');await fs.mkdir(projectRoot);
  const options={root:path.join(base,'state'),legacyRoot:path.join(base,'legacy'),projectRoots:[projectRoot],candidateRoots:[path.join(base,'candidate')],validateTransition:m1FixtureValidator,...extra};
  const stores=[],children=[];
  t.after(async()=>{
    try{for(const child of children)await child.dispose();for(const store of stores){try{await store.close();}catch(e){if(!store.status().poisoned)throw e;}}}
    finally{await fs.rm(base,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
  });
  const open=async opts=>{const store=await openGovernanceStore(opts??options);stores.push(store);return store;};
  return {base,projectRoot,options,open,children};
}
const registration=(f,jobId='job')=>({jobId,projectRoot:f.projectRoot});
const jobDir=f=>path.join(f.options.root,'jobs',digest('job'));
const revFile=(f,n)=>path.join(jobDir(f),'revisions',String(n).padStart(6,'0')+'.json');
async function seed(f,store,artifacts=[]){await store.registerJob(registration(f));return store.append('job',{type:'PLAN_PROPOSED',payload:m1Payload(),artifacts},0);}
async function snapshot(dir,prefix=''){
  const result={};for(const entry of await fs.readdir(dir,{withFileTypes:true})){
    const name=prefix+entry.name,file=path.join(dir,entry.name);
    if(entry.isDirectory())Object.assign(result,await snapshot(file,name+'/'));else result[name]=(await fs.readFile(file)).toString('base64');
  }return result;
}
async function rewrite(file,mutate){const event=JSON.parse(await fs.readFile(file,'utf8'));mutate(event);const {eventDigest,...body}=event;event.eventDigest=digest(body);await fs.writeFile(file,canonicalize(event));}
function childArgs(f,marker,mode,point=''){return [storeURL,f.options.root,f.options.legacyRoot,f.projectRoot,f.options.candidateRoots[0],marker,mode,point];}
function ownChild(f,child){f.children.push(child);return child;}
async function exitWithin(child,timeoutMs=15000){
  let timer;try{return await Promise.race([child.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Child exit timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}
}

test('M1-10 explicit roots are canonical, disjoint, bounded and construction has no default',async t=>{
  const f=await fixture(t);
  for(const change of [{root:'relative'},{root:f.projectRoot},{legacyRoot:f.options.root},{candidateRoots:[path.join(f.options.root,'nested')]},{projectRoots:[]},{enabled:true},{validateTransition:undefined}]){
    await assert.rejects(openGovernanceStore({...f.options,...change}));
    assert.equal(await fs.stat(f.options.root).then(()=>true,()=>false),false);
  }
  const link=path.join(f.base,'linked');await fs.symlink(f.projectRoot,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(openGovernanceStore({...f.options,root:link}));
  const file=path.join(f.base,'file');await fs.writeFile(file,'not a directory');await assert.rejects(openGovernanceStore({...f.options,root:file}));
  const store=await f.open();assert.equal(store.status().readiness,'inactive');await store.close();
  assert.deepEqual(await fs.readdir(f.projectRoot),[]);
});

test('M1-10 canonical project alias and duplicate ownership refuse; graceful close transfers root',async t=>{
  const f=await fixture(t),store=await f.open();const projectId=await store.registerJob(registration(f));
  const real=await fs.realpath(f.projectRoot);assert.equal(projectId,digest(process.platform==='win32'?real.toLowerCase():real));
  const alias=path.join(f.base,'alias');await fs.symlink(f.projectRoot,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(store.registerJob({jobId:'other',projectRoot:alias}),code('PROJECT_BUSY'));
  assert.equal(await store.registerJob({jobId:'job',projectRoot:alias}),projectId);
  await assert.rejects(f.open(),code('LOCKED'));await store.close();
  const replacement=await f.open();assert.equal(await replacement.registerJob(registration(f)),projectId);assert.equal(replacement.status().readiness,'inactive');
});

test('M1-10 actual simultaneous processes admit exactly one owner and clean exit releases lock',async t=>{
  const f=await fixture(t),a=path.join(f.base,'a'),b=path.join(f.base,'b');
  const readyA=m1WaitMarker(a+'.ready'),readyB=m1WaitMarker(b+'.ready');
  const childA=ownChild(f,m1Spawn(M1_STORE_CHILD_SOURCE,childArgs(f,a,'lock'))),childB=ownChild(f,m1Spawn(M1_STORE_CHILD_SOURCE,childArgs(f,b,'lock')));
  const results=await Promise.all([readyA,readyB]);assert.deepEqual([...results].sort(),['HELD','LOCKED']);
  const lock=JSON.parse(await fs.readFile(path.join(f.options.root,'lock.json'),'utf8'));assert.match(lock.nonce,/^[a-f0-9]{64}$/);assert.match(lock.generation,/^[a-f0-9]{64}$/);
  assert.equal(lock.pid,results[0]==='HELD'?childA.child.pid:childB.child.pid);
  await m1Marker((results[0]==='HELD'?a:b)+'.release');
  for(const child of [childA,childB])assert.deepEqual(await exitWithin(child),{code:0,signal:null});
  assert.equal(await fs.stat(path.join(f.options.root,'lock.json')).then(()=>true,()=>false),false);await f.open();
});

test('M1-10 dead PID, empty and foreign lock files are retained without recovery',async t=>{
  for(const text of ['',canonicalize({pid:2147483647,nonce:'foreign',generation:1})]){
    const f=await fixture(t);await fs.mkdir(f.options.root);const file=path.join(f.options.root,'lock.json');await fs.writeFile(file,text);
    const before=await snapshot(f.options.root);await assert.rejects(f.open(),code('LOCKED'));
    const state=await inspectGovernanceStore(f.options);assert.equal(state.locked,true);assert.equal(state.reconciliationRequired,true);assert.deepEqual(state.refusals,['LOCKED']);assert.deepEqual(await snapshot(f.options.root),before);
  }
});

test('M1-11 owned artifacts and payload commit immutably; wrong revisions and invalid transitions never write',async t=>{
  const f=await fixture(t),store=await f.open();await store.registerJob(registration(f));
  const payload=m1Payload(),artifact={fixture:'original'};const pending=store.append('job',{type:'PLAN_PROPOSED',payload,artifacts:[artifact]},0);payload.count=99;artifact.fixture='mutated';
  const first=await pending;assert.equal(first.payload.count,0);assert.equal(Object.isFrozen(first.payload),true);assert.deepEqual(first.artifacts,[digest({fixture:'original'})]);
  const before=await snapshot(f.options.root);
  await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(2)},1),code('FIXTURE_TRANSITION'));
  await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1)},0),code('REVISION_CONFLICT'));
  await assert.rejects(store.append('job',{type:'NOT_A_TYPE',payload:m1Payload(1)},1),code('UNKNOWN_EVENT_TYPE'));
  await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:{...m1Payload(1),trusted:true}},1),code('FIXTURE_SCHEMA'));
  await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1),validateTransition:()=>{}},1),code('CLOSED_SCHEMA'));
  assert.deepEqual(await snapshot(f.options.root),before);
  const second=await store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1),artifacts:[{fixture:'original'}]},1);
  assert.equal(second.previousDigest,first.eventDigest);assert.equal(second.revision,2);assert.equal((await fs.readdir(path.join(jobDir(f),'artifacts'))).length,1);
  const loaded=await store.load('job');assert.equal(loaded.latest.eventDigest,second.eventDigest);assert.equal(loaded.history.length,2);
  assert.equal(await fs.readFile(revFile(f,1),'utf8'),canonicalize(first));assert.deepEqual(await fs.readdir(f.projectRoot),[]);
});

test('M1-11 root queue serializes overlapping stale revisions with exactly one winner',async t=>{
  const entered=m1Deferred(),release=m1Deferred();let active=false;
  const f=await fixture(t,{failpoint:async(name,ctx)=>{if(active&&name==='event.open'&&ctx.revision===2){entered.resolve();await release.promise;}}}),store=await f.open();
  await seed(f,store);active=true;
  const one=store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1)},1);await entered.promise;
  const two=store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1)},1);const settled=Promise.allSettled([one,two]);release.resolve();
  const results=await settled;assert.equal(results[0].status,'fulfilled');assert.equal(results[1].reason.code,'REVISION_CONFLICT');assert.equal((await store.load('job')).history.length,2);
});

test('M1-11 required validator is captured once and cannot return a promise',async t=>{
  const f=await fixture(t);const store=await f.open();f.options.validateTransition=()=>{};
  await store.registerJob(registration(f));await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload()},0),code('FIXTURE_TRANSITION'));
  const g=await fixture(t,{validateTransition:async()=>{throw new Error('observed fixture rejection');}}),asyncStore=await g.open();await asyncStore.registerJob(registration(g));
  await assert.rejects(asyncStore.append('job',{type:'PLAN_PROPOSED',payload:m1Payload()},0),code('ASYNC_VALIDATOR'));assert.deepEqual(await fs.readdir(path.join(jobDir(g),'revisions')),[]);
  const h=await fixture(t,{validateTransition:()=>false}),falseStore=await h.open();await falseStore.registerJob(registration(h));
  await assert.rejects(falseStore.append('job',{type:'PLAN_PROPOSED',payload:m1Payload()},0),code('INVALID_VALIDATOR_RESULT'));
});

const corruptions=[
  ['wrong revision',async f=>rewrite(revFile(f,2),e=>{e.revision=1;})],
  ['duplicate event',async f=>fs.copyFile(revFile(f,1),revFile(f,2))],
  ['reordered chain',async f=>{const a=await fs.readFile(revFile(f,1)),b=await fs.readFile(revFile(f,2));await fs.writeFile(revFile(f,1),b);await fs.writeFile(revFile(f,2),a);}],
  ['gapped chain',async f=>fs.rename(revFile(f,2),revFile(f,3))],
  ['truncated next',async f=>fs.writeFile(revFile(f,3),'{')],
  ['unknown entry',async f=>fs.writeFile(path.join(jobDir(f),'revisions','latest.json'),'{}')],
  ['wrong digest',async f=>{const e=JSON.parse(await fs.readFile(revFile(f,2),'utf8'));e.eventDigest='0'.repeat(64);await fs.writeFile(revFile(f,2),canonicalize(e));}],
  ['forged provenance',async f=>rewrite(revFile(f,2),e=>{e.provenance='host-verified';})],
  ['missing provenance',async f=>rewrite(revFile(f,2),e=>{delete e.provenance;})],
  ['invalid payload transition',async f=>rewrite(revFile(f,2),e=>{e.payload.count=99;})],
  ['forged payload provenance',async f=>rewrite(revFile(f,2),e=>{e.payload.provenance='trusted';})],
  ['missing artifact in earlier revision',async f=>fs.unlink(path.join(jobDir(f),'artifacts',digest({fixture:'artifact'})+'.json'))],
  ['tampered artifact in earlier revision',async f=>fs.writeFile(path.join(jobDir(f),'artifacts',digest({fixture:'artifact'})+'.json'),canonicalize({fixture:'tampered'}))],
  ['unknown event field',async f=>rewrite(revFile(f,2),e=>{e.approved=true;})],
];
for(const [name,corrupt]of corruptions)test('M1-11/16 full-chain '+name+' refuses without fallback or diagnostic repair',async t=>{
  const f=await fixture(t),store=await f.open();await seed(f,store,[{fixture:'artifact'}]);await store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1)},1);await store.close();
  const good=await inspectGovernanceStore(f.options);assert.equal(good.jobs[0].history.length,2);await corrupt(f);const before=await snapshot(f.options.root);
  await assert.rejects(inspectGovernanceStore(f.options));await assert.rejects(f.open());assert.deepEqual(await snapshot(f.options.root),before);
});

for(const stage of ['artifact','event'])for(const phase of ['open','opened','write','written','sync','synced','close','closed',...(stage==='event'?['postcommit']:[])]){
  const point=stage+'.'+phase;
  test('M1-12 '+point+' failure poisons writer and preserves evidence',async t=>{
    const failure=Object.assign(new Error('fixture '+point),{code:'INJECTED'});let active=false;
    const f=await fixture(t,{failpoint:name=>{if(active&&name===point)throw failure;}}),store=await f.open();await seed(f,store);active=true;
    await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1),artifacts:[{fixture:point}]},1),e=>e===failure);
    assert.equal(store.status().poisoned,true);const before=await snapshot(f.options.root);
    await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1)},1),code('STORE_POISONED'));await assert.rejects(store.close(),code('STORE_POISONED'));
    assert.deepEqual(await snapshot(f.options.root),before);assert.equal(Object.hasOwn(before,'lock.json'),true);assert.equal(JSON.parse(await fs.readFile(revFile(f,1),'utf8')).payload.count,0);
    if(['event.closed','event.postcommit'].includes(point)){const {failpoint,...readOptions}=f.options;assert.equal((await inspectGovernanceStore(readOptions)).jobs[0].history.length,2);}
  });
}

test('M1-12 primary and cleanup failures are both observable; handles settle',async t=>{
  const original=new Error('original write failure'),cleanup=new Error('cleanup failure');let active=false;
  const f=await fixture(t,{failpoint:(name,ctx)=>{if(active&&name==='event.write')throw original;if(active&&name==='cleanup.close'&&ctx.stage==='event')throw cleanup;}}),store=await f.open();await seed(f,store);active=true;
  await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1)},1),e=>e instanceof AggregateError&&e.cause===original&&e.errors[0]===original&&e.errors[1]===cleanup);
  assert.equal(store.status().poisoned,true);await fs.rename(revFile(f,2),revFile(f,2)+'.retained');
});

test('M1-12 lock release uncertainty preserves original owner lock and refusal',async t=>{
  const f=await fixture(t,{failpoint:name=>{if(name==='lock.release')throw Object.assign(new Error('release refused'),{code:'RELEASE_FAILURE'});}}),store=await f.open();
  const bytes=await fs.readFile(path.join(f.options.root,'lock.json'));await assert.rejects(store.close(),code('RELEASE_FAILURE'));assert.equal(store.status().poisoned,true);
  assert.deepEqual(await fs.readFile(path.join(f.options.root,'lock.json')),bytes);await assert.rejects(f.open(),code('LOCKED'));
});

test('M1-12 incomplete lock creation is never reclaimed',async t=>{
  const f=await fixture(t,{failpoint:name=>{if(name==='lock.write')throw Object.assign(new Error('lock interrupted'),{code:'LOCK_INTERRUPTED'});}});
  await assert.rejects(f.open(),code('LOCK_INTERRUPTED'));assert.equal((await fs.stat(path.join(f.options.root,'lock.json'))).size,0);await assert.rejects(f.open(),code('LOCKED'));
});

for(const [point,count,invalid]of [['artifact.synced',1,false],['event.opened',1,true],['event.synced',2,false],['event.postcommit',2,false]])test('M1-13 real child crash at '+point+' retains lock, durable budget and zero replay',async t=>{
  const f=await fixture(t),marker=path.join(f.base,'crash');const ready=m1WaitMarker(marker+'.ready');const child=ownChild(f,m1Spawn(M1_STORE_CHILD_SOURCE,childArgs(f,marker,'crash',point)));
  assert.equal(await ready,point);const lockBefore=await fs.readFile(path.join(f.options.root,'lock.json'));
  await m1Marker(marker+'.crash');assert.deepEqual(await exitWithin(child),{code:73,signal:null});
  assert.deepEqual(await fs.readFile(path.join(f.options.root,'lock.json')),lockBefore);const before=await snapshot(f.options.root);
  await assert.rejects(f.open(),code('LOCKED'));
  if(invalid)await assert.rejects(inspectGovernanceStore(f.options));
  else{const inspected=await inspectGovernanceStore(f.options);assert.equal(inspected.readiness,'inactive');assert.equal(inspected.reconciliationRequired,true);assert.equal(inspected.jobs[0].history.length,count);assert.equal(inspected.jobs[0].latest.payload.budget,count);}
  assert.deepEqual(await snapshot(f.options.root),before);assert.deepEqual(await fs.readdir(f.projectRoot),[]);
});

test('M1-14 close revokes held writes, awaits settlement and preserves uncertain lock',async t=>{
  const entered=m1Deferred(),release=m1Deferred();let active=false,closeSettled=false;
  const f=await fixture(t,{failpoint:async name=>{if(active&&name==='event.write'){entered.resolve();await release.promise;}}}),store=await f.open();await seed(f,store);active=true;
  const pending=store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1)},1);const failed=assert.rejects(pending,code('STORE_CLOSED'));await entered.promise;
  const closing=store.close();closing.then(()=>{closeSettled=true;},()=>{closeSettled=true;});const closed=assert.rejects(closing,code('STORE_POISONED'));
  await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1)},1),code('STORE_CLOSED'));assert.equal(closeSettled,false);
  release.resolve();await failed;await closed;assert.equal(closeSettled,true);assert.equal((await fs.stat(revFile(f,2))).size,0);assert.equal(store.status().readiness,'inactive');
});

test('M1-14 owner replacement while write is held prevents acknowledgement and retains foreign lock',async t=>{
  const entered=m1Deferred(),release=m1Deferred();let active=false;
  const f=await fixture(t,{failpoint:async name=>{if(active&&name==='event.write'){entered.resolve();await release.promise;}}}),store=await f.open();await seed(f,store);active=true;
  const pending=store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1)},1);const failed=assert.rejects(pending,code('OWNER_LOST'));await entered.promise;
  const foreign=canonicalize({foreign:true});await fs.writeFile(path.join(f.options.root,'lock.json'),foreign);release.resolve();await failed;
  await assert.rejects(store.close(),code('STORE_POISONED'));assert.equal(await fs.readFile(path.join(f.options.root,'lock.json'),'utf8'),foreign);assert.equal((await fs.stat(revFile(f,2))).size,0);
});

test('M1-14 revoke rejects an admitted registration before filesystem work',async t=>{
  const f=await fixture(t),store=await f.open();const registering=store.registerJob(registration(f));store.revoke();
  await assert.rejects(registering,code('STORE_CLOSED'));assert.deepEqual(await fs.readdir(path.join(f.options.root,'jobs')),[]);
  assert.ok(store.status().refusals.includes('STORE_CLOSED'));await store.close();
});

test('M1-11 active-chain corruption poisons append and never overwrites artifacts',async t=>{
  const f=await fixture(t),store=await f.open();await seed(f,store,[{fixture:'artifact'}]);
  const artifact=path.join(jobDir(f),'artifacts',digest({fixture:'artifact'})+'.json');await fs.writeFile(artifact,canonicalize({fixture:'changed'}));const before=await snapshot(f.options.root);
  await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1),artifacts:[{fixture:'artifact'}]},1),code('ARTIFACT_DIGEST_MISMATCH'));
  assert.equal(store.status().poisoned,true);assert.deepEqual(await snapshot(f.options.root),before);
});

test('M1-14 explicit revoke holds lock until separately awaited close and never restores admission',async t=>{
  const f=await fixture(t),store=await f.open();await seed(f,store);const before=await fs.readFile(path.join(f.options.root,'lock.json'));
  assert.equal(store.revoke(),undefined);assert.equal(store.status().revoked,true);assert.equal(store.status().closed,false);
  await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1)},1),code('STORE_CLOSED'));
  await assert.rejects(f.open(),code('LOCKED'));assert.deepEqual(await fs.readFile(path.join(f.options.root,'lock.json')),before);
  await store.close();const next=await f.open();assert.equal(next.status().readiness,'inactive');
});

test('M1-15 clean child imports have no filesystem, environment or retained resource effects',async t=>{
  const f=await fixture(t),cwd=path.join(f.base,'empty');await fs.mkdir(cwd);
  const child=ownChild(f,m1Spawn(M1_IMPORT_CHILD_SOURCE,[storeURL],{cwd}));assert.deepEqual(await exitWithin(child),{code:0,signal:null});assert.deepEqual(await fs.readdir(cwd),[]);
});

test('M1-16 inspection is read-only, inactive, provenance preserving and no unknown options',async t=>{
  const f=await fixture(t);await assert.rejects(inspectGovernanceStore(f.options),code('ROOT_MISSING'));assert.equal(await fs.stat(f.options.root).then(()=>true,()=>false),false);
  const store=await f.open();await seed(f,store);await store.close();const before=await snapshot(f.options.root);
  const inspected=await inspectGovernanceStore(f.options);assert.equal(inspected.readiness,'inactive');assert.equal(inspected.provenance,'fixture-untrusted');assert.equal(inspected.jobs[0].latest.payload.provenance,'fixture-untrusted');assert.equal(inspected.locked,false);
  await assert.rejects(inspectGovernanceStore({...f.options,summary:'accepted'}),code('CLOSED_SCHEMA'));assert.deepEqual(await snapshot(f.options.root),before);
  const reopened=await f.open();assert.equal(reopened.status().readiness,'inactive');assert.equal((await reopened.load('job')).latest.payload.budget,1);assert.deepEqual(await fs.readdir(f.projectRoot),[]);
});

test('M1-16 revision retention limit remains readable but refuses further commits',async t=>{
  const f=await fixture(t),store=await f.open();let previous=await seed(f,store);await store.close();
  for(let n=2;n<=STORE_LIMITS.revisions;n++){
    const body={schemaVersion:1,provenance:'fixture-untrusted',jobId:'job',projectId:previous.projectId,revision:n,previousDigest:previous.eventDigest,type:'RESULT_RECORDED',payload:m1Payload(n-1),artifacts:[]};
    previous={...body,eventDigest:digest(body)};await fs.writeFile(revFile(f,n),canonicalize(previous),{flag:'wx'});
  }
  const inspected=await inspectGovernanceStore(f.options);assert.equal(inspected.jobs[0].history.length,4096);assert.ok(inspected.refusals.includes('REVISION_RETENTION_EXHAUSTED'));
  const reopened=await f.open();await assert.rejects(reopened.append('job',{type:'RESULT_RECORDED',payload:m1Payload(4096)},4096),code('REVISION_RETENTION_EXHAUSTED'));assert.equal((await reopened.load('job')).latest.revision,4096);
});

test('M1-16 job retention limit refuses overflow while preserving all registrations',async t=>{
  const f=await fixture(t);for(let i=1;i<64;i++){const p=path.join(f.base,'project'+i);await fs.mkdir(p);f.options.projectRoots.push(p);}
  const store=await f.open();for(let i=0;i<64;i++)await store.registerJob({jobId:'job'+i,projectRoot:f.options.projectRoots[i]});
  await assert.rejects(store.registerJob({jobId:'overflow',projectRoot:f.projectRoot}),code('JOB_RETENTION_EXHAUSTED'));
  const inspected=await inspectGovernanceStore(f.options);assert.equal(inspected.jobs.length,64);assert.ok(inspected.refusals.includes('JOB_RETENTION_EXHAUSTED'));
});

test('M1-16 artifact size/depth bounds reject before writing',async t=>{
  const f=await fixture(t),store=await f.open();await seed(f,store);const before=await snapshot(f.options.root);
  let deep={};for(let i=0;i<18;i++)deep={nested:deep};
  for(const artifacts of [[{text:'x'.repeat(1048576)}],[deep],Array.from({length:1025},(_,i)=>({i}))])await assert.rejects(store.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1),artifacts},1));
  assert.deepEqual(await snapshot(f.options.root),before);assert.equal(store.status().poisoned,false);
});

test('M1-16 aggregate artifact retention is enforced on orphan and committed bytes',{timeout:180000},async t=>{
  const f=await fixture(t),store=await f.open();await seed(f,store);await store.close();const dir=path.join(jobDir(f),'artifacts');
  // Exact 1 MiB canonical strings: independent bytes rather than sparse files or a lowered limit.
  const prefix='x'.repeat(STORE_LIMITS.artifact-8);
  for(let i=0;i<256;i++){const value=prefix+String(i).padStart(6,'0'),bytes=canonicalize(value);assert.equal(Buffer.byteLength(bytes),STORE_LIMITS.artifact);await fs.writeFile(path.join(dir,digest(value)+'.json'),bytes,{flag:'wx'});}
  const inspected=await inspectGovernanceStore(f.options);assert.equal(inspected.jobs[0].artifactBytes,STORE_LIMITS.artifactBytes);assert.ok(inspected.refusals.includes('ARTIFACT_RETENTION_EXHAUSTED'));
  const reopened=await f.open();await assert.rejects(reopened.append('job',{type:'RESULT_RECORDED',payload:m1Payload(1),artifacts:[{extra:true}]},1),code('ARTIFACT_RETENTION_EXHAUSTED'));assert.equal((await reopened.load('job')).latest.revision,1);
});

import {openGovernanceStoreV2,inspectGovernanceStoreV2} from '../src/governance/store.mjs';
import {V2_PROVENANCE,validatePlanV2,ownedJson as m3Owned} from '../src/governance/contracts.mjs';
async function m3StoreFixture(t,failpoint){const root=await fs.mkdtemp(path.join(nativeTmpdir(),'m3-store-')),projectRoot=path.join(root,'project');await fs.mkdir(projectRoot);const options={root:path.join(root,'journal'),projectRoot,protectedRoots:[],...(failpoint?{failpoint}:{})};const stores=[];t.after(async()=>{for(const s of stores)try{await s.close();}catch(e){if(!s.status().poisoned)throw e;}await fs.rm(root,{recursive:true,force:true});});return {root,options,stores,async open(){const s=await openGovernanceStoreV2(options);stores.push(s);return s;}};}
function m3InitialState(projectId){const policy={schemaVersion:1,routes:{'plan-review':{provider:'other',model:'test',effort:'low'},author:{provider:'author',model:'test',effort:'low'},validator:{provider:'validator',model:'test',effort:'low'},reviewer:{provider:'other',model:'test',effort:'low'}},node:{executable:process.execPath,sha256:digest('node'),version:process.version,systemRoot:null},enforcement:'guarded-native-trusted-code',settlementGraceMs:1000,testFiles:[{path:'test.mjs',sha256:digest('test')}],environmentRecipe:'systemroot-owned-temp-v1'};const plan=validatePlanV2({schemaVersion:2,jobId:'job-v2',projectId,baseline:digest('base'),objective:'Controlled diagnostic only',nonGoals:['No activation'],files:[{path:'a.txt',operation:'create',expectedHash:null}],protectedTests:['test.mjs'],criteria:[{id:'C',description:'Behavior',method:'test'}],commands:[{id:'unit',executable:process.execPath,argv:['--test','--test-isolation=none','--test-reporter=tap','test.mjs'],cwd:'frozen',environment:{},timeoutMs:1000,expectedExit:0,inventory:['T']}],policy:{planner:{id:'planner',provider:'author'},implementerProvider:'author',correctionLimit:2},testInventory:['T'],environmentDigest:digest({node:policy.node,enforcement:policy.enforcement,environmentRecipe:policy.environmentRecipe}),executionPolicy:policy});return m3Owned({schemaVersion:2,provenance:V2_PROVENANCE,jobId:plan.jobId,projectId,revision:1,generation:1,phase:'PLANNING',planGeneration:1,plan,attempts:[],authors:[],assignments:[],results:[],evidence:[],decision:null,candidate:null,action:{type:'PLAN_PROPOSED'}});}
test('M3-02 v2 artifacts are revision-bound and reopen is diagnostic only',async t=>{
  const f=await m3StoreFixture(t),store=await f.open(),state=m3InitialState(store.status().projectId),artifact={fixture:'owned'};await store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[artifact]},0);assert.deepEqual(await store.readArtifact({revision:1,hash:digest(artifact)}),artifact);await assert.rejects(store.readArtifact({revision:2,hash:digest(artifact)}),{code:'FOREIGN_ARTIFACT'});await store.close();const inspect=await inspectGovernanceStoreV2(f.options);assert.equal(inspect.latest.revision,1);assert.equal(inspect.reconciliationRequired,true);const reopened=await f.open();assert.throws(()=>reopened.assertOwner(),{code:'RECONCILIATION_REQUIRED'});assert.throws(()=>reopened.append({type:'PLAN_PROPOSED',payload:state,artifacts:[]},1),{code:'RECONCILIATION_REQUIRED'});
});
test('M3-02 original root identity survives initial lock acquisition hooks',async t=>{
  let f,injected=false;f=await m3StoreFixture(t,async(name,c)=>{if(name==='lock.open.before'){await fs.rename(f.options.root,f.options.root+'-retained');await fs.mkdir(f.options.root);injected=true;}});await assert.rejects(f.open(),{code:'OWNER_DIRECTORY_CHANGED'});assert.equal(injected,true);assert.deepEqual(await fs.readdir(f.options.root),[]);
});
test('M3-02 same-byte postclose lock replacement never becomes owned',async t=>{
  let f,injected=false;f=await m3StoreFixture(t,async(name,c)=>{if(name==='lock.close.after'){const bytes=await fs.readFile(c.path);await fs.rename(c.path,c.path+'-original');await fs.writeFile(c.path,bytes,{flag:'wx'});injected=true;}});await assert.rejects(f.open(),{code:'WRITE_TARGET_CHANGED'});assert.equal(injected,true);assert.deepEqual((await fs.readdir(f.options.root)).sort(),['lock.json','lock.json-original']);
});
test('M3-02 artifact same-byte inode replacement is rejected before protected read',async t=>{
  const f=await m3StoreFixture(t),store=await f.open(),artifact={value:'protected'};await store.append({type:'PLAN_PROPOSED',payload:m3InitialState(store.status().projectId),artifacts:[artifact]},0);const file=path.join(f.options.root,'artifacts',digest(artifact)+'.json'),bytes=await fs.readFile(file);await fs.rename(file,path.join(f.root,'old-artifact'));await fs.writeFile(file,bytes,{flag:'wx'});await assert.rejects(store.readArtifact({revision:1,hash:digest(artifact)}),{code:'FILE_IDENTITY_CHANGED'});assert.equal(store.status().poisoned,true);
});
test('M3-02 live store never adopts externally inserted hash-valid artifacts',async t=>{
  const f=await m3StoreFixture(t),store=await f.open(),artifact={value:'foreign'};await fs.writeFile(path.join(f.options.root,'artifacts',digest(artifact)+'.json'),canonicalize(artifact),{flag:'wx'});await assert.rejects(store.load(),{code:'FILE_IDENTITY_CHANGED'});assert.equal(store.status().poisoned,true);
});
test('M3-02 v2 journal refuses retroactive plan changes without writing revision',async t=>{
  const f=await m3StoreFixture(t),store=await f.open(),state=m3InitialState(store.status().projectId);await store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[]},0);const changed={...state,revision:2,plan:{...state.plan,objective:'Rewritten'},phase:'STOPPED',action:{type:'STOPPED'}};await assert.rejects(store.append({type:'STOPPED',payload:changed,artifacts:[]},1),{code:'STATE_IDENTITY_CHANGED'});assert.deepEqual(await fs.readdir(path.join(f.options.root,'revisions')),['000001.json']);assert.equal(store.status().poisoned,false);
});

// C1 preserves the complete C0 test prefix and uses independently allocated real journals.
const m3c1Revision=(f,n)=>path.join(f.options.root,'revisions',String(n).padStart(6,'0')+'.json');
const m3c1Stopped=state=>({...state,revision:2,phase:'STOPPED',action:{type:'STOPPED'}});
const m3c1Variants=[
  {name:'load refuses removal of the entire acknowledged journal',operation:'load',remove:'head'},
  {name:'direct append cannot reset a deleted journal to revision one',operation:'reset',remove:'head'},
  {name:'assertOwner refuses a deleted acknowledged revision',operation:'owner',remove:'head'},
  {name:'close retains its lock after acknowledged revision deletion',operation:'close',remove:'head'},
  {name:'load refuses suffix rollback with a valid earlier revision',operation:'load',remove:'suffix'},
  {name:'artifact read refuses a missing retained artifact',operation:'read',remove:'artifact'},
  {name:'close rechecks journal retention after its release hook',operation:'close',hook:'lock.release.before',remove:'head'},
  {name:'artifact creation refuses earlier revision deletion in its open hook',operation:'append-artifact',hook:'artifact.open.before',remove:'head'},
  {name:'event creation refuses earlier revision deletion in its open hook',operation:'append',hook:'event.open.before',remove:'head'},
  {name:'new event deletion before acknowledgment preserves the earlier watermark',operation:'append',hook:'event.beforeAck',remove:'pending'},
  {name:'artifact read cannot acknowledge after its after-hook deletes the journal',operation:'read',hook:'artifact.read.after',remove:'head'},
];
for(const variant of m3c1Variants)test('M3-C1 '+variant.name,async t=>{
  let f,armed=false,injectionCompleted=false,removedPath;
  const inject=async()=>{await fs.unlink(removedPath);injectionCompleted=true;};
  f=await m3StoreFixture(t,async name=>{if(armed&&name===variant.hook){armed=false;await inject();}});
  const store=await f.open(),state=m3InitialState(store.status().projectId),artifact={fixture:'retained-C1'};
  const initial=await store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[artifact]},0);
  assert.equal((await store.load()).latest.eventDigest,initial.eventDigest);
  assert.equal(store.status().admission,true);assert.deepEqual(await store.readArtifact({revision:1,hash:digest(artifact)}),artifact);
  let acknowledged=initial;
  if(variant.remove==='suffix')acknowledged=await store.append({type:'STOPPED',payload:m3c1Stopped(state),artifacts:[]},1);
  const lockPath=path.join(f.options.root,'lock.json'),lockBytes=await fs.readFile(lockPath),lockNode=await fs.lstat(lockPath,{bigint:true});
  removedPath=variant.remove==='artifact'?path.join(f.options.root,'artifacts',digest(artifact)+'.json'):m3c1Revision(f,['suffix','pending'].includes(variant.remove)?2:1);
  if(variant.hook)armed=true;else await inject();
  let acknowledgedAfterInjection=false;
  const operation=async()=>{
    if(variant.operation==='load')await store.load();
    else if(variant.operation==='owner')store.assertOwner();
    else if(variant.operation==='close')await store.close();
    else if(variant.operation==='read')await store.readArtifact({revision:1,hash:digest(artifact)});
    else if(variant.operation==='reset')await store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[artifact]},0);
    else await store.append({type:'STOPPED',payload:m3c1Stopped(state),artifacts:variant.operation==='append-artifact'?[{fixture:'new-C1'}]:[]},1);
    acknowledgedAfterInjection=true;
  };
  await assert.rejects(operation(),{code:'RETAINED_FILE_MISSING'});assert.equal(injectionCompleted,true);assert.equal(acknowledgedAfterInjection,false);
  assert.equal(await fs.lstat(removedPath).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),false);
  const status=store.status();assert.equal(status.revision,acknowledged.revision);assert.equal(status.admission,false);assert.equal(status.revoked,true);assert.equal(status.poisoned,true);assert.equal(status.reconciliationRequired,true);assert.equal(status.closed,false);
  await assert.rejects(store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[]},0),{code:'STORE_POISONED'});assert.throws(()=>store.assertOwner(),{code:'STORE_POISONED'});await assert.rejects(store.close());
  assert.deepEqual(await fs.readFile(lockPath),lockBytes);const now=await fs.lstat(lockPath,{bigint:true});assert.equal(now.dev,lockNode.dev);assert.equal(now.ino,lockNode.ino);
  if(['append-artifact','append'].includes(variant.operation)){assert.equal(await fs.lstat(m3c1Revision(f,2)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),false);assert.deepEqual(await fs.readdir(path.join(f.options.root,'artifacts')),[digest(artifact)+'.json']);}
});
test('M3-C1 legitimate empty journal authority and close remain usable',async t=>{
  const f=await m3StoreFixture(t),store=await f.open();assert.equal((await store.load()).latest,null);store.assertOwner();assert.equal(store.status().admission,true);await store.close();assert.equal(store.status().closed,true);assert.deepEqual(await fs.readdir(path.join(f.options.root,'revisions')),[]);assert.equal((await inspectGovernanceStoreV2(f.options)).reconciliationRequired,true);
});
test('M3-C1 legitimate next event advances the acknowledged head after all hooks',async t=>{
  const hits=[];let armed=false,store;const f=await m3StoreFixture(t,async name=>{if(armed&&name==='event.beforeAck'){hits.push({name,revision:store.status().revision});store.assertOwner();}});store=await f.open();const state=m3InitialState(store.status().projectId),first=await store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[]},0);armed=true;const next=await store.append({type:'STOPPED',payload:m3c1Stopped(state),artifacts:[]},1);assert.deepEqual(hits,[{name:'event.beforeAck',revision:1}]);assert.equal(next.previousDigest,first.eventDigest);assert.equal(store.status().revision,2);const loaded=await store.load();assert.equal(loaded.history.length,2);assert.equal(loaded.latest.eventDigest,next.eventDigest);store.assertOwner();await store.close();assert.equal(store.status().closed,true);
});
test('M3-C1 legitimate artifact reuse and protected reads preserve original identities',async t=>{
  let releaseChecks=0,armed=false,store;const f=await m3StoreFixture(t,async name=>{if(armed&&name==='artifact.read.after')store.assertOwner();if(armed&&name==='lock.release.before')releaseChecks++;});store=await f.open();const state=m3InitialState(store.status().projectId),artifact={fixture:'reuse-C1'};await store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[artifact]},0);const file=path.join(f.options.root,'artifacts',digest(artifact)+'.json'),before=await fs.lstat(file,{bigint:true});armed=true;await store.append({type:'STOPPED',payload:m3c1Stopped(state),artifacts:[artifact]},1);assert.deepEqual(await store.readArtifact({revision:1,hash:digest(artifact)}),artifact);assert.deepEqual(await store.readArtifact({revision:2,hash:digest(artifact)}),artifact);const after=await fs.lstat(file,{bigint:true});assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);assert.equal(after.ctimeNs,before.ctimeNs);assert.equal(store.status().revision,2);await store.close();assert.equal(releaseChecks,1);const inspected=await inspectGovernanceStoreV2(f.options);assert.equal(inspected.latest.revision,2);assert.equal(inspected.locked,false);
});

import {readGovernanceM4,inspectGovernanceM4} from '../src/governance/store.mjs';
const m4Read=(kind='status',changes={})=>({kind,id:null,offset:0,limit:kind==='status'?1:64,cursor:null,...changes});
test('M4 bounded reads bind cursors to the current head and omit roots',async t=>{
  const f=await m3StoreFixture(t),store=await f.open(),state=m3InitialState(store.status().projectId);await store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[]},0);const before=await snapshot(f.options.root),status=await readGovernanceM4(store);assert.equal(status.headAuthenticity,'live-verified');assert.equal(status.status.attemptsRemaining,3);assert.equal(canonicalize(status).includes(f.root),false);assert.ok(Buffer.byteLength(canonicalize(status))<=16384);assert.deepEqual(await snapshot(f.options.root),before);const history=await readGovernanceM4(store,m4Read('history',{limit:1}));assert.equal(history.rows.length,1);await store.append({type:'STOPPED',payload:m3c1Stopped(state),artifacts:[]},1);await assert.rejects(readGovernanceM4(store,m4Read('history',{cursor:history.cursor})),{code:'STALE_CURSOR'});await assert.rejects(readGovernanceM4(store,m4Read('history',{limit:65})),{code:'INVALID_INTEGER'});await assert.rejects(readGovernanceM4(store,m4Read('history',{offset:1})),{code:'CURSOR_REQUIRED'});
});
test('M4 cold diagnosis rechecks disk and labels a shortened valid history unproven',async t=>{
  const f=await m3StoreFixture(t),store=await f.open(),state=m3InitialState(store.status().projectId);await store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[]},0);await store.append({type:'STOPPED',payload:m3c1Stopped(state),artifacts:[]},1);await store.close();const before=await snapshot(f.options.root),first=await inspectGovernanceM4(f.options);assert.equal(first.revision,2);assert.equal(first.headAuthenticity,'unproven');assert.equal(first.status.attemptsRemaining,null);assert.equal(first.status.admission,false);assert.deepEqual(await snapshot(f.options.root),before);await fs.unlink(m3c1Revision(f,2));const second=await inspectGovernanceM4(f.options);assert.equal(second.revision,1);assert.equal(second.headAuthenticity,'unproven');const reopened=await openGovernanceStoreV2(f.options);assert.throws(()=>reopened.assertOwner(),{code:'RECONCILIATION_REQUIRED'});
});
test('M4 protected reads refuse journal loss and arbitrary artifact disclosure',async t=>{
  const f=await m3StoreFixture(t),store=await f.open(),state=m3InitialState(store.status().projectId),secret={secret:f.root};await store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[secret]},0);await assert.rejects(readGovernanceM4(store,m4Read('artifact',{id:digest(secret),limit:8192})),{code:'ARTIFACT_NOT_PUBLIC'});await fs.unlink(m3c1Revision(f,1));await assert.rejects(readGovernanceM4(store),{code:'RETAINED_FILE_MISSING'});assert.equal(store.status().poisoned,true);
});
import {bindGovernanceAuthorityM4} from '../src/governance/store.mjs';
test('M4 store checks its one-time owner policy after an awaited write hook',async t=>{
  let allowed=true,armed=false,injected=false;const f=await m3StoreFixture(t,async name=>{if(armed&&name==='event.open.before'){allowed=false;injected=true;}}),store=await f.open();bindGovernanceAuthorityM4(store,()=>allowed);assert.throws(()=>bindGovernanceAuthorityM4(store,()=>true),{code:'M4_OWNER_ALREADY_BOUND_OR_UNKNOWN'});const state=m3InitialState(store.status().projectId);await store.append({type:'PLAN_PROPOSED',payload:state,artifacts:[]},0);armed=true;await assert.rejects(store.append({type:'STOPPED',payload:m3c1Stopped(state),artifacts:[]},1),{code:'OWNER_AUTHORITY_REFUSED'});assert.equal(injected,true);assert.deepEqual(await fs.readdir(path.join(f.options.root,'revisions')),['000001.json']);assert.equal(store.status().poisoned,true);assert.equal((await fs.lstat(path.join(f.options.root,'lock.json'))).isFile(),true);
});
test('M4 async policy callbacks and copied store facades cannot establish ownership',async t=>{
  const f=await m3StoreFixture(t),store=await f.open();assert.throws(()=>bindGovernanceAuthorityM4({...store},()=>true),{code:'M4_OWNER_ALREADY_BOUND_OR_UNKNOWN'});assert.throws(()=>bindGovernanceAuthorityM4(store,async()=>true),{code:'OWNER_AUTHORITY_REFUSED'});store.assertOwner();assert.equal(store.status().poisoned,false);
});

import {bindingForV2,planIdentityV2,validateCandidateDescriptorV2,LIMITS} from '../src/governance/contracts.mjs';
test('M4 aggregate history preserves three complete attempts beyond a single-record node budget',async t=>{
  const f=await m3StoreFixture(t),store=await f.open(),initial=m3InitialState(store.status().projectId),header={schemaVersion:2,provenance:V2_PROVENANCE};let state=null,head=null;const acknowledged=[];
  const commit=async(type,changes,artifacts=[])=>{state=m3Owned({...state,...changes,revision:(state?.revision??0)+1,action:{type}});const unique=[...new Map(artifacts.map(a=>[digest(a),a])).values()];head=await store.append({type,payload:state,artifacts:unique},state.revision-1);acknowledged.push(head.eventDigest);};
  const assignment=(role,generation,candidate)=>({...header,id:role+'-'+generation,actor:{id:role+'-'+generation,...initial.plan.executionPolicy.routes[role]},role,generation,binding:bindingForV2(initial.plan,candidate)});
  const result=(a,outcome,submission)=>({...header,id:'result-'+a.id,assignmentId:a.id,actor:a.actor,role:a.role,generation:a.generation,binding:a.binding,outcome,submission,submissionArtifactHash:submission===null?null:digest(submission)});
  const submission=(outcome,ids)=>({criteria:[{id:'C',outcome}],findings:[],evidenceIds:ids});
  const controls=async()=>{for(const kind of ['pause','resume']){const record={schemaVersion:1,kind,id:kind+'-'+state.revision,checkpointDigest:digest('checkpoint-'+state.generation),ownerId:'original-owner',epoch:state.generation,priorHeadDigest:head.eventDigest,planDigest:digest(state.plan),decisionDigest:digest(state.decision),attemptsDigest:digest(state.attempts),attemptsUsed:state.attempts.length,nextAction:'author'};await commit('CONTROL_RECORDED',{},[record]);}};
  await commit('PLAN_PROPOSED',initial);const review=assignment('plan-review',1,null);await commit('ASSIGNMENT_CREATED',{assignments:[review]});const planSubmission=submission('pass',[]);await commit('RESULT_RECORDED',{phase:'AWAITING_HUMAN',results:[result(review,'completed-pass',planSubmission)]},[planSubmission]);await commit('HUMAN_DECIDED',{phase:'PLAN_AUTHORIZED',decision:{...header,id:'human',planDigest:digest(state.plan),reviewResultId:'result-'+review.id,generation:1,decision:'authorize'}});await controls();
  for(let attempt=0;attempt<3;attempt++){
    const generation=attempt+2,author=assignment('author',generation,null);await commit('ATTEMPT_RESERVED',{phase:'AUTHORING',generation,candidate:null,attempts:[...state.attempts,{index:attempt,assignmentId:author.id,planDigest:digest(state.plan)}],authors:[...state.authors,author.actor],assignments:[...state.assignments,author]});
    const row={path:'a.txt',kind:'file',bytes:1,sha256:digest('candidate-'+attempt),gitMode:'100644'},descriptorBody={...header,jobId:state.jobId,projectId:state.projectId,assignmentId:author.id,attempt,generation,revision:state.revision,...planIdentityV2(state.plan),baselineDigest:state.plan.baseline,commit:'a'.repeat(40),objectFormat:'sha1',git:{sha256:digest('git'),version:'git fixture'},files:[row],deletions:[],changes:[{path:row.path,operation:'create',before:null,after:row}]},descriptor=validateCandidateDescriptorV2({...descriptorBody,candidateDigest:digest(descriptorBody)}),candidate=descriptor.candidateDigest;
    const frozen={...header,id:'frozen-'+generation,kind:'frozen',assignmentId:author.id,generation,binding:bindingForV2(state.plan,candidate),status:'completed',contentDigest:candidate,artifactHash:digest(descriptor),details:{descriptorArtifactHash:digest(descriptor),producerAssignmentId:author.id,stage:'frozen'}};
    await commit('CANDIDATE_SEALED',{phase:'FROZEN',candidate,results:[...state.results,result(author,'completed-fail',null)],evidence:[...state.evidence,frozen]},[descriptor]);
    const validator=assignment('validator',generation,candidate);await commit('ASSIGNMENT_CREATED',{phase:'VALIDATING',assignments:[...state.assignments,validator]});const command=state.plan.commands[0],facts={commandId:command.id,commandDigest:digest(command),assignmentId:validator.id,binding:validator.binding,actualExit:1},details={commandId:command.id,commandDigest:digest(command),expectedExit:0,actualExit:1,stdoutDigest:digest('failed-output'),stderrDigest:digest(''),captureComplete:true,inventory:[{id:'T',outcome:'fail'}],managedSettled:true,enforcement:'partial',deadlineFired:false,signal:null,logArtifacts:[]},testEvidence={...header,id:'test-'+generation,kind:'test',assignmentId:validator.id,generation,binding:validator.binding,status:'failed',contentDigest:digest(details),artifactHash:digest(facts),details};await commit('EVIDENCE_REGISTERED',{evidence:[...state.evidence,testEvidence]},[facts]);
    const failed=submission('fail',[frozen.id,testEvidence.id]);await commit('RESULT_RECORDED',{results:[...state.results,result(validator,'completed-fail',failed)]},[failed]);const reviewer=assignment('reviewer',generation,candidate);await commit('ASSIGNMENT_CREATED',{phase:'REVIEWING',assignments:[...state.assignments,reviewer]});await commit('RESULT_RECORDED',{results:[...state.results,result(reviewer,'completed-fail',failed)]},[failed]);await commit('RESULT_RECORDED',{phase:attempt===2?'REASSESS_REQUIRED':'CORRECTION_REQUIRED'});if(attempt<2)await controls();
  }
  const loaded=await store.load(),count=v=>v!==null&&typeof v==='object'?1+Object.values(v).reduce((n,c)=>n+count(c),0):1;assert.ok(count(loaded)>LIMITS.nodes);assert.throws(()=>m3Owned(loaded),{code:'STRUCTURE_LIMIT'});assert.deepEqual(loaded.history.map(e=>e.eventDigest),acknowledged);assert.equal(loaded.latest,loaded.history.at(-1));assert.equal(loaded.latest.payload.attempts.length,3);assert.equal(loaded.latest.payload.phase,'REASSESS_REQUIRED');assert.equal(loaded.history.length,34);
  for(const value of [loaded,loaded.history,loaded.history[0],loaded.latest.payload,loaded.latest.payload.plan])assert.equal(Object.isFrozen(value),true);assert.throws(()=>loaded.history.pop(),TypeError);assert.throws(()=>{loaded.latest.payload.phase='PLANNING';},TypeError);assert.equal((await store.load()).latest.eventDigest,head.eventDigest);
  assert.throws(()=>store.append({type:'UNKNOWN_EVENT',payload:{...state,revision:state.revision+1,action:{type:'UNKNOWN_EVENT'}},artifacts:[]},state.revision),{code:'UNKNOWN_EVENT_TYPE'});assert.throws(()=>store.append({type:'STOPPED',payload:{...state,revision:state.revision+1,action:{type:'STOPPED'}},artifacts:['x'.repeat(LIMITS.bytes)]},state.revision),{code:'ARTIFACT_TOO_LARGE'});assert.equal(store.status().poisoned,false);
  const page=await readGovernanceM4(store,m4Read('history'));assert.equal(page.rows.length,34);assert.ok(Buffer.byteLength(canonicalize(page))<=16384);await store.close();const cold=await inspectGovernanceStoreV2(f.options);assert.deepEqual(cold.history.map(e=>e.eventDigest),acknowledged);assert.equal(Object.isFrozen(cold.history),true);const status=await inspectGovernanceM4(f.options);assert.equal(status.headAuthenticity,'unproven');assert.equal(status.status.attemptsUsed,3);assert.equal(status.status.attemptsRemaining,null);
});
test('M4 aggregate snapshot retains the independent journal revision cap',async t=>{
  const f=await m3StoreFixture(t),store=await f.open();await store.close();for(let offset=1;offset<=STORE_LIMITS.revisions+1;offset+=64){const count=Math.min(64,STORE_LIMITS.revisions+2-offset);await Promise.all(Array.from({length:count},(_,i)=>fs.writeFile(m3c1Revision(f,offset+i),'',{flag:'wx'})));}assert.equal((await fs.readdir(path.join(f.options.root,'revisions'))).length,STORE_LIMITS.revisions+1);await assert.rejects(inspectGovernanceStoreV2(f.options),{code:'REVISION_RETENTION_EXHAUSTED'});
});
