import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {assessM0,REQUIRED_M0} from '../src/governance/host.mjs';
import {checkProbeTap,probeTestArgv,confinedProbe} from '../src/governance/runner.mjs';
import {diagnoseM0} from '../scripts/doctor-governance.mjs';
import {runnerFixture,GOOD_TAP} from './helpers/governance.mjs';
import {makeTempRoot} from './helpers/tmp.mjs';

test('M0 every required item is explicit and missing/duplicate evidence fails closed',()=>{
  assert.equal(assessM0([]).decision,'NO_GO');
  assert.equal(new Set(REQUIRED_M0).size,REQUIRED_M0.length);
  const complete=REQUIRED_M0.map(id=>({id,state:'PASS'}));
  assert.equal(assessM0(complete).decision,'CAPABILITY_PASS_REQUIRES_REVIEW');
  for(let i=0;i<complete.length;i++){
    assert.equal(assessM0(complete.filter((_,j)=>i!==j)).decision,'NO_GO');
    assert.equal(assessM0([...complete,complete[i]]).decision,'NO_GO');
    assert.equal(assessM0(complete.map((c,j)=>j===i?{...c,state:'NOT_PROBED'}:c)).decision,'NO_GO');
    assert.equal(assessM0(complete.map((c,j)=>j===i?{...c,state:'FAIL'}:c)).decision,'NO_GO');
  }
  assert.throws(()=>assessM0(null));
});
test('TAP requires exact named inventory, one plan, zero failures and no skipped/todo',()=>{
  assert.equal(checkProbeTap(GOOD_TAP,['fixture'],0),true);
  for(const [text,names,exit] of [
    [GOOD_TAP,['other'],0],[GOOD_TAP,['fixture'],1],[GOOD_TAP,['fixture'],null],
    [GOOD_TAP.replace('1..1',''),['fixture'],0],[GOOD_TAP+'1..1\n',['fixture'],0],
    [GOOD_TAP.replace('ok 1','not ok 1'),['fixture'],0],
    [GOOD_TAP.replace('ok 1 - fixture','ok 1 - fixture # SKIP'),['fixture'],0],
    [GOOD_TAP.replace('# fail 0','# fail 1'),['fixture'],0],
    [GOOD_TAP.replace('# todo 0','# todo 1'),['fixture'],0],
    [GOOD_TAP+'Bail out!\n',['fixture'],0],['',[],0],
    [GOOD_TAP+'# cancelled 1\n',['fixture'],0],[GOOD_TAP+'# fail 2\n',['fixture'],0],
    [GOOD_TAP.replace('# cancelled 0','# cancelled 1'),['fixture'],0],
    [GOOD_TAP.replace('# tests 1','# tests 2'),['fixture'],0],
    [GOOD_TAP.replace('# pass 1','# pass 0'),['fixture'],0],
    [GOOD_TAP.replace('# pass 1\n',''),['fixture'],0],
    [GOOD_TAP+'# Subtest: unfinished\n',['fixture'],0],
    [GOOD_TAP.replace('# cancelled 0\n',''),['fixture'],0],
    [GOOD_TAP.replace('1..1','  not ok 2 - nested\n1..1'),['fixture'],0],
  ])assert.equal(checkProbeTap(text,names,exit),false);
});
test('pinned test template excludes shells and PATH lookup',()=>{
  const f=path.join(path.parse(process.execPath).root,'frozen','probe.test.mjs');
  assert.deepEqual(probeTestArgv(process.execPath,f),[process.execPath,'--test','--test-isolation=none','--test-reporter=tap',f]);
  assert.throws(()=>probeTestArgv('node',f));assert.throws(()=>probeTestArgv(process.execPath,'probe.test.mjs'));
  assert.throws(()=>probeTestArgv(process.execPath,path.join(path.dirname(f),'other.mjs')));
});
test('runner owns scratch only, tombstones ambient env and awaits cleanup',async()=>{
  const f=runnerFixture({stdout:GOOD_TAP});
  const r=await confinedProbe({...f.options,...f});
  assert.equal(r.exitCode,0);assert.equal(r.enforcement,'partial');
  assert.equal(f.calls[0].policy.workspaceRoot,f.options.scratch);
  const spec=f.calls[1].spec;assert.equal(spec.cwd,f.options.frozen);assert.equal(spec.argv[1],'runner-fixture');
  for(const [key,value] of Object.entries(spec.env))assert.ok(value===undefined||key==='SYSTEMROOT');
  assert.deepEqual(f.stats(),{terminated:1,waited:1});
  assert.equal(r.descendantQuiescenceProven,false);
});
test('runner rejects nested roots, missing confinement, unsupported enforcement, and pre-abort',async()=>{
  const f=runnerFixture();
  await assert.rejects(confinedProbe({...f.options,...f,frozen:f.options.scratch}),{code:'M0_INVALID_ROOTS'});
  await assert.rejects(confinedProbe({...f.options,...f,frozen:path.join(f.options.scratch,'frozen')}),{code:'M0_INVALID_ROOTS'});
  await assert.rejects(confinedProbe({...f.options,...f,scratch:path.join(f.options.frozen,'scratch')}),{code:'M0_INVALID_ROOTS'});
  await assert.rejects(confinedProbe({...f.options,...f,sandbox:undefined}),{code:'M0_CONFINEMENT_UNAVAILABLE'});
  await assert.rejects(confinedProbe({...f.options,...f,sandbox:{confine:argv=>({argv,enforcement:'full'})}}),{code:'M0_INVALID_CONFINEMENT'});
  const c=new AbortController();c.abort(new Error('aborted fixture'));
  await assert.rejects(confinedProbe({...f.options,...f,signal:c.signal}),/aborted fixture/);
  assert.equal(f.calls.length,0);
});
test('runner cleanup observes refused quiescence, lossy output and runner failure signatures',async()=>{
  const f=runnerFixture({quiescent:false});
  await assert.rejects(confinedProbe({...f.options,...f}),{code:'M0_PROCESS_RANGE_NOT_EMPTY'});
  assert.deepEqual(f.stats(),{terminated:1,waited:1});
  const bad=runnerFixture({lossy:true,stderr:'windows-acl-run: failed'});
  const r=await confinedProbe({...bad.options,...bad});assert.equal(r.lossy,true);assert.equal(r.invalidRunner,true);
});
test('runner failure signature respects documented exit-code gate',async()=>{
  for(const [exitCode,expected] of [[0,false],[9,false],[127,true]]){
    const f=runnerFixture({exitCode,stderr:'windows-acl-run: missing workspace'});
    const confine=f.sandbox.confine.bind(f.sandbox);
    f.sandbox.confine=(...args)=>({...confine(...args),runnerFailureRules:[{allowedExitCodes:[127],fatalSignatures:['windows-acl-run: ']}]});
    const r=await confinedProbe({...f.options,...f});assert.equal(r.invalidRunner,expected);
    assert.deepEqual(f.stats(),{terminated:1,waited:1});
  }
});
test('runner cleans up on outcome rejection and never retries unrestricted',async()=>{
  const f=runnerFixture();let spawned=0,terminated=0,waited=0;
  const subprocess={spawn(){spawned++;return {done:Promise.reject(new Error('spawn failed')),
    terminate(){terminated++;},async waitForExit(){waited++;return true;}};}};
  await assert.rejects(confinedProbe({...f.options,sandbox:f.sandbox,subprocess}),/spawn failed/);
  assert.deepEqual({spawned,terminated,waited},{spawned:1,terminated:1,waited:1});
});
test('runner preserves both execution and cleanup failures',async()=>{
  const f=runnerFixture();const original=new Error('primary execution failure');
  const subprocess={spawn(){return {done:Promise.reject(original),terminate(){},async waitForExit(){return false;}};}};
  await assert.rejects(confinedProbe({...f.options,sandbox:f.sandbox,subprocess}),error=>
    error instanceof AggregateError && error.errors[0]===original && error.errors[1].code==='M0_PROCESS_RANGE_NOT_EMPTY');
});
test('doctor is read-only and cannot turn claimed receipts into approval',async t=>{
  const root=await makeTempRoot('m0-doctor-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'report.json'),text=JSON.stringify({kind:'m0-live-report',checks:[]});await fs.writeFile(file,text);
  const r=await diagnoseM0(file);assert.equal(r.decision,'NO_GO');assert.equal(r.implementationAuthorized,false);
  assert.equal(await fs.readFile(file,'utf8'),text);assert.match(r.authority,/cannot grant GO/);
  await assert.rejects(diagnoseM0('relative.json'));await fs.writeFile(file,'{}');await assert.rejects(diagnoseM0(file),/Not an M0/);
});


import {createHumanDecisionPortV2,createStageHostV2} from '../src/governance/host.mjs';
// The governance host runs only on Windows x64 with Node 26.9.0 and refuses every other
// runtime at startup. Tests that start it are skipped elsewhere; the refusal is tested instead.
const supportedHost=process.platform==='win32'&&process.arch==='x64'&&process.versions.node==='26.9.0';
const onlySupportedHost={skip:supportedHost?false:'governance host requires Windows x64 with Node 26.9.0'};
const onlyWindows={skip:process.platform==='win32'?false:'fixture uses Windows roots and SYSTEMROOT'};
test('M3 host refuses to start outside the supported runtime',{skip:supportedHost?'supported runtime':false},()=>{
  assert.throws(()=>createStageHostV2({get:n=>({agents:{},tools:{},llm:{}})[n],on:()=>()=>{},effect:fn=>fn()},{root:process.cwd()}),{code:'V2_UNSUPPORTED_HOST'});
});
test('M3 command port pins normalized resolved definition, live receiver and non-model origin',async()=>{
  const receiver={id:'human'},effects=[];let current,initiator,live=true,handler,count=0;
  const commands={register(def){current=Object.freeze({...def});handler=current.handler;return()=>{current=undefined;};},find:()=>current};
  const agents={get:()=>live?receiver:undefined,currentInitiator:()=>initiator};const ctx={get:n=>({commands,agents})[n],effect:fn=>effects.push(fn())};
  const port=createHumanDecisionPortV2(ctx,{receiverAgent:receiver});port.bind(async v=>{assert.equal(v.decision,'authorize');count++;});
  const inv={agent:receiver,rawInput:'a'.repeat(64)+' reviewed authorize'};
  assert.equal((await handler(inv)).kind,'success');assert.equal(count,1);
  initiator={id:'model'};await assert.rejects(handler(inv),{code:'V2_HUMAN_ORIGIN'});initiator=undefined;
  const saved=current;current={...current};await assert.rejects(handler(inv),{code:'V2_HUMAN_ORIGIN'});current=saved;
  await assert.rejects(handler({...inv,agent:{id:'human'}}),{code:'V2_HUMAN_RECEIVER'});
  await assert.rejects(handler({...inv,rawInput:inv.rawInput+' true'}),{code:'V2_HUMAN_INPUT'});
  live=false;await assert.rejects(handler(inv),{code:'V2_HUMAN_RECEIVER'});assert.equal(count,1);port.close();for(const d of effects)d();
});
test('M3 host missing capabilities and fabricated run cannot create authority',onlySupportedHost,async()=>{
  assert.throws(()=>createStageHostV2({get:()=>undefined},{root:process.cwd()}),{code:'V2_HOST_PREREQUISITES'});
  let disposed=0;const effects=[];const host=createStageHostV2({get:n=>({agents:{},tools:{},llm:{}})[n],on:()=>()=>disposed++,effect:fn=>effects.push(fn())},{root:process.cwd()});
  await assert.rejects(host.observe({}),{code:'V2_UNKNOWN_RUN'});await assert.rejects(host.cancel({}),{code:'V2_UNKNOWN_RUN'});
  await host.close();await host.close();assert.equal(disposed,1);await Promise.all(effects.map(d=>d()));
});

import {validateGovernanceConfigM4,verifyGovernanceConfigM4,createHumanCommandsM4,installGovernedPresetM4,enrollGovernedStageM4} from '../src/governance/host.mjs';
import {digest as m4HostDigest} from '../src/governance/contracts.mjs';
import {createHash as m4CreateHash} from 'node:crypto';
import {createGovernancePluginM4} from '../src/governance/plugin.mjs';
const m4HostHash=b=>m4CreateHash('sha256').update(b).digest('hex');
function m4HostConfig(root,host){
  const roots=Object.fromEntries(['project','governance','workspace','scratch','legacy','config'].map(k=>[k,path.join(root,k)]));
  const route=p=>({provider:p,model:'script',effort:'none'}),node={executable:process.execPath,sha256:'a'.repeat(64),version:'26.9.0',systemRoot:process.env.SYSTEMROOT};
  const executionPolicy={schemaVersion:1,routes:{'plan-review':route('review'),author:route('author'),validator:route('validator'),reviewer:route('review')},node,enforcement:'guarded-native-trusted-code',settlementGraceMs:1000,testFiles:[{path:'fixed.test.mjs',sha256:'b'.repeat(64)}],environmentRecipe:'systemroot-owned-temp-v1'};
  const plan={schemaVersion:2,jobId:'m4-host-unit',projectId:m4HostDigest(roots.project.toLowerCase()),baseline:'b'.repeat(64),objective:'M4 host controls',nonGoals:[],files:[{path:'candidate.mjs',operation:'replace',expectedHash:'c'.repeat(64)}],protectedTests:['fixed.test.mjs'],criteria:[{id:'M4_VALUE',description:'fixed control',method:'test'}],commands:[{id:'fixed',executable:node.executable,argv:['--test','--test-isolation=none','--test-reporter=tap','fixed.test.mjs'],cwd:'frozen',environment:{SYSTEMROOT:node.systemRoot},timeoutMs:10000,expectedExit:0,inventory:['M4_VALUE']}],policy:{planner:{id:'planner',provider:'author'},implementerProvider:'author',correctionLimit:2},testInventory:['M4_VALUE'],environmentDigest:m4HostDigest({node,enforcement:executionPolicy.enforcement,environmentRecipe:executionPolicy.environmentRecipe}),executionPolicy};
  return{role:'host',schemaVersion:1,mode:'diagnostic',roots,presetId:'governed-preset',receiverId:'m4-receiver',toolchain:{git:{executable:host,sha256:'a'.repeat(64),version:'git version 2.55.0.windows.5'},host:{executable:host,sha256:'a'.repeat(64)}},plan};
}
test('M4 pure config is closed, disjoint and exact-project bound without allocating roots',onlyWindows,async t=>{
  const root=await makeTempRoot('m4-host-config-'),config=m4HostConfig(root,path.join(root,'host.mjs'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  assert.equal(validateGovernanceConfigM4(config).mode,'diagnostic');
  for(const mutate of [c=>c.extra=true,c=>c.mode='enabled',c=>c.roots.scratch=c.roots.project,c=>c.roots.config=path.join(c.roots.project,'config'),c=>c.plan.projectId='d'.repeat(64),c=>c.presetId='standard',c=>c.toolchain.git.extra=true,c=>c.receiverId='../reset',c=>c.plan.executionPolicy.node.version='20.0.0']){
    const bad=structuredClone(config);mutate(bad);assert.throws(()=>validateGovernanceConfigM4(bad));
  }
  assert.deepEqual(await fs.readdir(root),[]);
});
test('M4 pin verifier retains identities and refuses changed or linked control roots',onlySupportedHost,async t=>{
  const root=await makeTempRoot('m4-host-pins-'),host=path.join(root,'host.mjs');t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(host,'// pinned host fixture\n');
  const c=m4HostConfig(root,host);c.plan.executionPolicy.node.systemRoot=await fs.realpath(process.env.SYSTEMROOT);c.plan.commands[0].environment.SYSTEMROOT=c.plan.executionPolicy.node.systemRoot;for(const k of ['project','scratch','legacy','config'])await fs.mkdir(c.roots[k]);
  c.toolchain.host.sha256=m4HostHash(await fs.readFile(host));c.toolchain.git.sha256=c.toolchain.host.sha256;c.plan.executionPolicy.node.sha256=m4HostHash(await fs.readFile(process.execPath));c.plan.environmentDigest=m4HostDigest({node:c.plan.executionPolicy.node,enforcement:c.plan.executionPolicy.enforcement,environmentRecipe:c.plan.executionPolicy.environmentRecipe});
  const pins=verifyGovernanceConfigM4(c);assert.equal(pins.assert(),true);assert.equal(await fs.stat(c.roots.governance).then(()=>true,()=>false),false);
  await fs.rename(host,host+'.old');await fs.writeFile(host,'// pinned host fixture\n');assert.throws(()=>pins.assert(),{code:'M4_STARTUP_IDENTITY_CHANGED'});
  await fs.rename(c.roots.config,c.roots.config+'-old');await fs.symlink(c.roots.config+'-old',c.roots.config,'junction');assert.throws(()=>verifyGovernanceConfigM4(c));
});
function m4HumanFixture(){
  const receiver={id:'receiver'},map=new Map(),effects=[],calls=[];let initiator,live=true;
  const commands={register(d){const normalized={...d};assert.equal(map.has(d.name),false);map.set(d.name,normalized);return()=>{if(map.get(d.name)===normalized)map.delete(d.name);};},find(_a,n){return map.get(n);}};
  const agents={get:()=>live?receiver:undefined,currentInitiator:()=>initiator};
  const ctx={get:n=>({commands,agents})[n],effect:fn=>effects.push(fn())};
  const handlers=Object.fromEntries(['status','read','open','stage','authorize','pause','resume','stop','reassess'].map(n=>[n,async(...args)=>{calls.push({name:n,args});return{operation:n,gateActive:false};}]));
  const port=createHumanCommandsM4(ctx,{receiverAgent:receiver,handlers});
  return{ctx,receiver,map,effects,calls,handlers,port,setInitiator:v=>{initiator=v;},setLive:v=>{live=v;},invoke:(name,rawInput='',agent=receiver)=>map.get(name).handler({agent,rawInput})};
}
test('M4 command family enforces exact human/definition and closed grammar before effects',async()=>{
  const f=m4HumanFixture(),h='a'.repeat(64);
  assert.deepEqual([...f.map.keys()].sort(),['gov-authorize','gov-open','gov-pause','gov-read','gov-reassess','gov-resume','gov-stage','gov-status','gov-stop']);
  for(const[n,text]of [['gov-status',''],['gov-read','history - 0 64'],['gov-open',h+' '+h],['gov-stage','author'],['gov-authorize',h+' result authorize'],['gov-pause',''],['gov-resume',h+' author'],['gov-stop',''],['gov-reassess',h]])assert.equal((await f.invoke(n,text)).kind,'success');
  const count=f.calls.length;f.setInitiator(f.receiver);await assert.rejects(f.invoke('gov-resume',h+' author'),{code:'M4_HUMAN_ORIGIN'});f.setInitiator(undefined);
  await assert.rejects(f.invoke('gov-stage','author',{id:'receiver'}),{code:'M4_HUMAN_RECEIVER'});
  for(const[n,input]of [['gov-stage','author extra'],['gov-open',h+' '+h+' ../newroot'],['gov-resume',h+' validate'],['gov-read','artifact ../secret 0 1'],['gov-status','{}']])await assert.rejects(f.invoke(n,input),{code:'M4_HUMAN_INPUT'});
  const original=f.map.get('gov-stage');f.map.set('gov-stage',{...original});await assert.rejects(original.handler({agent:f.receiver,rawInput:'author'}),{code:'M4_HUMAN_ORIGIN'});f.map.set('gov-stage',original);
  for(const[n,d]of f.map){const takesArgs=!['gov-status','gov-pause','gov-stop'].includes(n);assert.equal(d.input===undefined,!takesArgs,n+' Web input descriptor');if(takesArgs){assert.equal(typeof d.input.hint,'string');assert.ok(d.input.hint.trim().length>0);assert.equal(d.input.attachments,undefined);}}
  f.setLive(false);await assert.rejects(f.invoke('gov-pause'),{code:'M4_HUMAN_RECEIVER'});assert.equal(f.calls.length,count);f.port.close();assert.equal(f.map.size,0);for(const close of f.effects)close();
});
test('M4 human command output is bounded and foreign exception details are redacted',async()=>{
  const f=m4HumanFixture();f.handlers.status=async()=>({tooLarge:'s'.repeat(17000)});const over=await f.invoke('gov-status');assert.equal(over.kind,'error');assert.equal(JSON.parse(over.text).reason,'M4_RESPONSE_LIMIT');
  f.handlers.status=async()=>{throw new Error('C:\\private\\credential secret');};const failure=await f.invoke('gov-status');assert.equal(failure.kind,'error');assert.equal(failure.text.includes('credential'),false);f.port.close();
});
test('M4 preset independently denies absent or revoked owner and admits only exact enrolled stage',async()=>{
  const effects=[],guards=[];let live=true;const ctx={get:n=>n==='tools'?{guard:g=>{guards.push(g);return()=>{};}}:undefined,effect:fn=>effects.push(fn())};
  installGovernedPresetM4(ctx);const actor={id:'actor'};assert.equal(guards[0]({agent:actor}),'M4_PRESET_READ_ONLY');enrollGovernedStageM4(ctx,actor,()=>live);
  assert.equal(guards[0]({agent:actor}),undefined);assert.equal(guards[0]({agent:{id:'actor'}}),'M4_PRESET_READ_ONLY');live=false;assert.equal(guards[0]({agent:actor}),'M4_PRESET_READ_ONLY');for(const dispose of effects)dispose();
});
test('M4 preset entry publishes no service and rejects extra configuration before allocation',async()=>{
  const effects=[],guards=[];const ctx={get:n=>n==='tools'?{guard:g=>{guards.push(g);return()=>{};}}:undefined,effect:fn=>effects.push(fn())};
  const plugin=createGovernancePluginM4(x=>x);await plugin.apply(ctx,{role:'preset'});assert.equal(guards.length,1);await assert.rejects(plugin.apply(ctx,{role:'preset',mode:'same-owner'}),{code:'M4_CLOSED_SHAPE'});assert.equal(guards.length,1);for(const dispose of effects)dispose();
});

import {startGovernanceM4} from '../src/governance/plugin.mjs';
import {pathToFileURL as m4LifecycleFileURL} from 'node:url';
const m4LifecycleDeferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function m4LifecycleFixture(t,{holdCreation=false,holdDisposal=false}={}){
  const root=await makeTempRoot('m4-host-lifecycle-'),host=path.join(root,'host.mjs');
  const createEntered=m4LifecycleDeferred(),createReleased=m4LifecycleDeferred(),disposeEntered=m4LifecycleDeferred(),disposeReleased=m4LifecycleDeferred();
  const effects=[],definitions=new Map(),live=new Map();let disposeCalls=0,creates=0,owner,start;
  t.after(async()=>{
    createReleased.resolve();disposeReleased.resolve();await start?.catch(()=>{});await owner?.close().catch(()=>{});
    for(const dispose of [...effects].reverse())await dispose();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  });
  await fs.writeFile(host,'// owned lifecycle host pin\n');const config=m4HostConfig(root,host);
  config.plan.executionPolicy.node.systemRoot=await fs.realpath(process.env.SYSTEMROOT);config.plan.commands[0].environment.SYSTEMROOT=config.plan.executionPolicy.node.systemRoot;
  for(const key of ['project','scratch','legacy','config'])await fs.mkdir(config.roots[key]);
  config.toolchain.host.sha256=m4HostHash(await fs.readFile(host));config.toolchain.git.sha256=config.toolchain.host.sha256;
  config.plan.executionPolicy.node.sha256=m4HostHash(await fs.readFile(process.execPath));
  config.plan.environmentDigest=m4HostDigest({node:config.plan.executionPolicy.node,enforcement:config.plan.executionPolicy.enforcement,environmentRecipe:config.plan.executionPolicy.environmentRecipe});
  const presetRoot=path.join(root,'presets'),preset=path.join(presetRoot,'governed-preset'),entry=path.join(root,'entry.mjs');
  await fs.mkdir(preset,{recursive:true});await fs.writeFile(entry,'export default {apply(){}};\n');const entryURL=m4LifecycleFileURL(entry).href;
  const composition=path.join(preset,'agent.cordis.yml');await fs.writeFile(composition,JSON.stringify([{id:'governed-preset',name:entryURL,config:{role:'preset'}}]));
  const tools={schemas:()=>[],guard:()=>()=>{}},commands={register(definition){assert.equal(definitions.has(definition.name),false);definitions.set(definition.name,definition);return()=>definitions.delete(definition.name);},find:(_agent,name)=>definitions.get(name)};
  const presets={async list(){return[{id:'governed-preset',path:composition,trust:'user',broken:false}];},async compositionInventory(){return[{id:'governed-preset',isDefault:true,broken:false,rows:[{enabled:true,moduleName:entryURL}]}];},async mount(){},composedPreset:()=> 'governed-preset'};
  const services={tools,commands,agentPresets:presets,sandboxPolicy:{defaultMode:'read-only',resolve:()=>({mode:'read-only',workspaceRoot:config.roots.project})},
    sandbox:{confine:argv=>({argv:[process.execPath,host,'--',...argv],enforcement:'partial'})},subprocess:{spawn(){throw Error('diagnostic startup must not spawn');}},
    llm:{listProviders:()=>['author','review','validator'].map(id=>({id})),providerRetryPolicy:()=>({mode:'normal',maxRetries:0})}};
  const ctx={get:name=>services[name],effect:fn=>{const dispose=fn();effects.push(dispose);return dispose;},on:()=>()=>{}};
  services.agents={get:id=>live.get(id),currentInitiator:()=>undefined,async create(options){
    creates++;const agent={id:options.sessionId,ctx,session:{}};const setup=await options.setup(ctx,agent);setup.commit();createEntered.resolve();
    if(holdCreation)await createReleased.promise;live.set(agent.id,agent);let disposal;
    return{agent,dispose(){if(disposal)return disposal;disposeCalls++;disposeEntered.resolve();disposal=(async()=>{if(holdDisposal)await disposeReleased.promise;live.delete(agent.id);})();return disposal;}};
  }};
  return{root,config,ctx,effects,definitions,live,createEntered,createReleased,disposeEntered,disposeReleased,
    get disposeCalls(){return disposeCalls;},get creates(){return creates;},
    start(){start=startGovernanceM4(ctx,config);start.then(value=>{owner=value;},()=>{});return start;}};
}

test('M4 close during pending receiver creation drains and disposes the late handle exactly once',onlySupportedHost,async t=>{
  const f=await m4LifecycleFixture(t,{holdCreation:true}),starting=f.start();
  await Promise.race([f.createEntered.promise,starting.then(()=>{throw Error('startup completed before creation barrier');})]);
  assert.equal(f.effects.length,1);let settled=false;const closing=f.effects[0]().then(()=>{settled=true;});
  await Promise.resolve();assert.equal(settled,false);assert.equal(f.disposeCalls,0);assert.equal(f.definitions.size,0);
  f.createReleased.resolve();await closing;await assert.rejects(starting,{code:'M4_OWNER_STOPPED'});
  assert.equal(f.disposeCalls,1);assert.equal(f.live.size,0);assert.equal(f.definitions.size,0);assert.equal(f.creates,1);
  await f.effects[0]();assert.equal(f.disposeCalls,1);await assert.rejects(fs.stat(f.config.roots.governance),{code:'ENOENT'});
});

test('M4 duplicate close shares one disposal and waits for receiver quiescence',onlySupportedHost,async t=>{
  const f=await m4LifecycleFixture(t,{holdDisposal:true}),owner=await f.start();assert.equal(f.definitions.size,9);
  const first=owner.close(),second=owner.close();assert.equal(first,second);let settled=false;first.then(()=>{settled=true;});
  await f.disposeEntered.promise;assert.equal(f.definitions.size,0);assert.equal(f.disposeCalls,1);assert.equal(f.live.size,1);assert.equal(settled,false);
  f.disposeReleased.resolve();await Promise.all([first,second]);assert.equal(f.live.size,0);assert.equal(f.disposeCalls,1);
  assert.equal((await owner.status()).status.admission,false);await assert.rejects(fs.stat(f.config.roots.governance),{code:'ENOENT'});
});

import {captureGovernanceStartupM4} from '../src/governance/host.mjs';
test('M4 startup accepts fresh Cordis trace proxies but rejects replaced service origins',onlySupportedHost,async t=>{
  const f=await m4LifecycleFixture(t),get=f.ctx.get;let replacement=null;
  f.ctx.get=name=>{const target=name==='sandboxPolicy'&&replacement?replacement:get(name);return target&&new Proxy(target,{get:(value,key)=>key===Symbol.for('cordis.original')?value:Reflect.get(value,key)});};
  assert.notEqual(f.ctx.get('tools'),f.ctx.get('tools'));const startup=await captureGovernanceStartupM4(f.ctx,f.config);assert.equal(startup.assert(),true);
  replacement={...get('sandboxPolicy')};assert.throws(()=>startup.assert(),{code:'M4_SERVICE_CHANGED'});
});

test('M4 startup revalidates each stage effective policy and preset before further effects',onlySupportedHost,async t=>{
  const f=await m4LifecycleFixture(t),startup=await captureGovernanceStartupM4(f.ctx,f.config),stage={session:{id:'stage'},ctx:f.ctx};let changed=false,effects=0;
  const policy=f.ctx.get('sandboxPolicy'),presets=f.ctx.get('agentPresets');policy.resolve=({session})=>({mode:changed&&session===stage.session?'danger-full-access':'read-only',workspaceRoot:f.config.roots.project});
  const operation=()=>{startup.assert(stage);effects++;};operation();assert.equal(effects,1);changed=true;assert.throws(operation,{code:'M4_EFFECTIVE_POLICY'});assert.equal(effects,1);
  changed=false;presets.composedPreset=()=> 'standard';assert.throws(operation,{code:'M4_EFFECTIVE_POLICY'});assert.equal(effects,1);
});
