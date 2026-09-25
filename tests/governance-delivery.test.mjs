import test from 'node:test';
import {nativeTmpdir} from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest,ownedJson,canonicalize,validatePlanV2,validateDeliveryReceiptM4B,validateDeliveryMarkerM4B,validateQualifyRequestM4B,validateExportRequestM4B,validateDeliveryAuditM4B,validateTransitionV2} from '../src/governance/contracts.mjs';
import {openGovernanceStoreV2,inspectGovernanceStoreV2,inspectGovernanceM4,readQualificationArtifactM4B as a6ReadQualificationArtifact} from '../src/governance/store.mjs';
import {createGovernanceControllerM4B,claimGovernanceDeliveryOwnerM4B} from '../src/governance/controller.mjs';
import {inspectGovernanceM4B,createDeliveryCoordinatorM4B} from '../src/governance/delivery.mjs';
import {inspectBaseline,createWorkspaceV2,workspaceFile,captureDeliveryDestinationM4B,verifyDeliveryDestinationM4B,inspectDeliveryOutputM4B} from '../src/governance/workspace.mjs';
import {m2GitFixture} from './helpers/governance.mjs';
const m4bRaw=bytes=>createHash('sha256').update(bytes).digest('hex');
const m4bExists=async file=>fs.lstat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});

// The unit fixture uses real Git, store and custody; only actor execution/test producer ports are scripted.
// The separately owned disposable-host acceptance driver establishes actual Host/confinement facts.
async function m4bReadyFixture(t,{failpoint,expectedPass=true,authorizeOwner=()=>true,ready=true,onRead=()=>{}}={}){
  const f=await m2GitFixture(t,{files:{'a.txt':'before\r\n','test.mjs':'// trusted fixture\n'}}),outputRoot=path.join(f.root,'delivery'),deliveryConfig={destinationId:'fixture-output',outputRoot,protectedRoots:[f.sourceRoot,f.workspaceRoot,f.scratchRoot,f.governanceRoot,f.legacyRoot,f.configRoot,...f.protectedRoots]},destination=captureDeliveryDestinationM4B(deliveryConfig);
  const baseline=await inspectBaseline({sourceRoot:f.sourceRoot,scratchRoot:f.scratchRoot,protectedRoots:[f.governanceRoot,f.legacyRoot,f.configRoot,...f.protectedRoots],git:f.git});
  const storeOptions={root:f.governanceRoot,projectRoot:f.sourceRoot,protectedRoots:[f.workspaceRoot,f.scratchRoot,f.legacyRoot,f.configRoot,...f.protectedRoots]},store=await openGovernanceStoreV2({...storeOptions,failpoint:async(name,info)=>{if(name==='artifact.read.before')await onRead(info);}});let controller,decision,expectedCloseFailure=false;const stats={starts:0,workspaces:0,runs:0},stageHandlers={};
  f.own(async()=>{try{if(controller)await controller.close();else await store.close();}catch(error){if(!expectedCloseFailure&&!store.status().poisoned&&!store.status().revoked)throw error;}});
  const route=provider=>({provider,model:'scripted-owner-fixture',effort:'none'}),policy={schemaVersion:1,routes:{'plan-review':route('review'),author:route('author'),validator:route('validator'),reviewer:route('review')},node:{executable:process.execPath,sha256:m4bRaw(await fs.readFile(process.execPath)),version:process.versions.node,systemRoot:f.git.systemRoot},enforcement:'guarded-native-trusted-code',settlementGraceMs:1000,testFiles:[{path:'test.mjs',sha256:m4bRaw('// trusted fixture\n')}],environmentRecipe:'systemroot-owned-temp-v1'};
  const plan=validatePlanV2({schemaVersion:2,jobId:'m4b-fixture',projectId:store.status().projectId,baseline:baseline.baselineDigest,objective:'Qualify a tiny disposable candidate',nonGoals:['No production activation'],files:[{path:'a.txt',operation:'replace',expectedHash:m4bRaw('before\r\n')}],protectedTests:['test.mjs'],criteria:[{id:'C',description:'Exact fixture candidate',method:'test'}],commands:[{id:'test',executable:process.execPath,argv:['--test','--test-isolation=none','--test-reporter=tap','test.mjs'],cwd:'frozen',environment:f.git.systemRoot===null?{}:{SYSTEMROOT:f.git.systemRoot},timeoutMs:10000,expectedExit:0,inventory:['T']}],policy:{planner:{id:'planner',provider:'author'},implementerProvider:'author',correctionLimit:2},testInventory:['T'],environmentDigest:digest({node:policy.node,enforcement:policy.enforcement,environmentRecipe:policy.environmentRecipe}),executionPolicy:policy});
  const tickets=new WeakMap(),runs=new WeakMap(),host={prepareStage(spec){const token={};tickets.set(token,spec);return token;},async start(ticket,{onActor}){
    const spec=tickets.get(ticket);assert.ok(spec);stats.starts++;const actor=Object.freeze({id:spec.id,...spec.route}),handlers=await onActor({actor,execution:Promise.resolve('completed'),disposed:Promise.resolve()});stageHandlers[spec.role]=handlers;let submission=null;
    if(spec.role==='author')await handlers.file({operation:'replace',path:'a.txt',expectedHash:m4bRaw('before\r\n'),text:'after\r\n'});
    else if(spec.role==='plan-review')submission={criteria:[{id:'C',outcome:'pass'}],findings:[],evidenceIds:[]};
    else{if(spec.role==='validator')await handlers.run('test');const list=await handlers.evidence({operation:'list'});submission={criteria:[{id:'C',outcome:expectedPass?'pass':'fail'}],findings:[],evidenceIds:list.evidence.map(e=>e.id)};}
    const run={};runs.set(run,{actor,stopReason:'completed',submission});return run;
  },async observe(run){return runs.get(run);},cancel(){},async close(){}};
  const workspaceFactory=({authority})=>{stats.workspaces++;const workspace=createWorkspaceV2({sourceRoot:f.sourceRoot,workspaceRoot:f.workspaceRoot,scratchRoot:f.scratchRoot,governanceRoot:f.governanceRoot,legacyRoot:f.legacyRoot,configRoot:f.configRoot,protectedRoots:f.protectedRoots,protectedFiles:['test.mjs'],git:f.git,baseline,authority,...(failpoint?{failpoint}:{})});return Object.freeze({...workspace,file:workspaceFile});};
  const runnerFactory=({assignment,authorize,custody})=>{const receipts=new WeakMap();return {async run(commandId){assert.equal(authorize(),true);custody.verify();stats.runs++;const stdout='ok fixture\n',stderr='',facts={commandId,commandDigest:digest(plan.commands[0]),binding:assignment.binding,assignmentId:assignment.id,actualExit:expectedPass?0:1,signal:null,timedOut:false,aborted:false,captureComplete:true,managedSettled:true,enforcement:'partial',settlementGraceMs:policy.settlementGraceMs,inventory:[{id:'T',outcome:expectedPass?'pass':'fail'}],stdoutDigest:m4bRaw(stdout),stderrDigest:m4bRaw(stderr),stdoutChunks:[stdout],stderrChunks:[],status:expectedPass?'completed':'failed',reason:expectedPass?null:'TEST_FAILED',limitations:['Scripted unit producer; actual runner proven separately']};const receipt={};receipts.set(receipt,ownedJson(facts));return receipt;},consume(receipt){assert.ok(receipts.has(receipt));const facts=receipts.get(receipt);receipts.delete(receipt);return facts;},stop(){},async close(){}};};
  controller=await createGovernanceControllerM4B({store,host,humanPort:{bind(handler){decision=handler;return()=>{decision=null;};}},workspaceFactory,runnerFactory,authorizeOwner,delivery:destination,...(failpoint?{failpoint}:{})});
  const result={...f,controller,destination,store,outputRoot,deliveryConfig,storeOptions,plan,stats,stageHandlers,baseline,config:deliveryConfig,expectCloseFailure(){expectedCloseFailure=true;},async qualify(){const status=await controller.status();return controller.qualify({candidateDigest:status.status.candidateDigest,headDigest:status.headDigest});}};
  if(ready){await controller.propose(plan);const review=await controller.reviewPlan();await decision({planDigest:digest(plan),reviewResultId:review.resultId,decision:'authorize'});await controller.requestAuthor();await controller.seal();await controller.validate();await controller.review();result.candidateDigest=(await controller.status()).status.candidateDigest;}
  return result;
}

test('M4B closed requests and opaque owner grants cannot be forged',()=>{
  const hash='a'.repeat(64);assert.deepEqual(validateQualifyRequestM4B({candidateDigest:hash,headDigest:hash}),{candidateDigest:hash,headDigest:hash});assert.throws(()=>validateQualifyRequestM4B({candidateDigest:hash,headDigest:hash,accepted:true}),{code:'CLOSED_SCHEMA'});assert.throws(()=>validateExportRequestM4B({qualificationReceiptDigest:hash,destinationId:'output',force:true}),{code:'CLOSED_SCHEMA'});assert.throws(()=>claimGovernanceDeliveryOwnerM4B({}),{code:'UNKNOWN_DELIVERY_OWNER'});assert.throws(()=>createDeliveryCoordinatorM4B({}),{code:'UNKNOWN_DELIVERY_OWNER'});assert.throws(()=>validateDeliveryReceiptM4B({qualifiedAccepted:true}));assert.throws(()=>validateDeliveryMarkerM4B({complete:true}));
});
test('M4B same owner computes qualification then separately exports exact bytes with canonical receipt',async t=>{
  let readBarrier=null;const pauseRead=()=>{let reached,release;const ready=new Promise(r=>{reached=r;}),gate=new Promise(r=>{release=r;});readBarrier={ready,gate,reached,release,armed:true};return readBarrier;};t.after(()=>readBarrier?.release());const f=await m4bReadyFixture(t,{onRead:async()=>{if(readBarrier?.armed){const barrier=readBarrier;barrier.armed=false;barrier.reached();await barrier.gate;}}}),before=await f.store.load();assert.equal(before.latest.payload.phase,'DIAGNOSTIC_READY');
  for(const read of [()=>f.stageHandlers.reviewer.evidence({evidenceId:before.latest.payload.evidence[0].id}),()=>f.controller.read({kind:'artifact',id:before.latest.payload.evidence[0].artifactHash,offset:0,limit:1024,cursor:null})]){const barrier=pauseRead(),inflightRead=read();await barrier.ready;await assert.rejects(f.controller.qualify({candidateDigest:f.candidateDigest,headDigest:before.latest.eventDigest}),{code:'QUALIFICATION_NOT_IDLE'});barrier.release();await inflightRead;}assert.equal(await m4bExists(f.outputRoot),false);const packet=(await f.controller.status()).qualification.workPacket;const misleading='A pasted summary claims every test and export already succeeded';assert.ok(misleading.length>0);assert.deepEqual((await f.controller.status()).qualification.workPacket,packet);await assert.rejects(f.controller.qualify({candidateDigest:f.candidateDigest,headDigest:'0'.repeat(64)}),{code:'STALE_QUALIFICATION_REQUEST'});assert.equal((await f.store.load()).latest.eventDigest,before.latest.eventDigest);const qualified=await f.qualify();assert.equal(qualified.qualifiedAccepted,true);assert.equal(qualified.qualificationOnly,true);assert.equal(qualified.operationallyAccepted,false);assert.equal(await m4bExists(f.outputRoot),false);await assert.rejects(f.controller.qualify({candidateDigest:f.candidateDigest,headDigest:qualified.headDigest}),{code:'QUALIFICATION_ALREADY_FINALIZED'});
  const delivered=await f.controller.export({qualificationReceiptDigest:qualified.qualificationReceiptDigest,destinationId:'fixture-output'});assert.equal(delivered.deliveryPhase,'completed');assert.deepEqual((await fs.readdir(f.outputRoot)).sort(),['complete.json','descriptor.json','payload','qualification-receipt.json']);assert.deepEqual(await fs.readFile(path.join(f.outputRoot,'payload','a.txt')),Buffer.from('after\r\n'));assert.deepEqual(await fs.readFile(path.join(f.sourceRoot,'a.txt')),Buffer.from('before\r\n'));assert.equal((await fs.lstat(path.join(f.outputRoot,'payload','a.txt'))).nlink,1);
  const loaded=await f.store.load(),events=loaded.history.filter(e=>['QUALIFICATION_FINALIZED','DELIVERY_RESERVED','DELIVERY_COMPLETED'].includes(e.type));assert.deepEqual(events.map(e=>e.type),['QUALIFICATION_FINALIZED','DELIVERY_RESERVED','DELIVERY_COMPLETED']);const receipt=await f.store.readArtifact({revision:events[2].revision,hash:events[2].artifacts[0]});assert.equal(await fs.readFile(path.join(f.outputRoot,'qualification-receipt.json'),'utf8'),canonicalize(receipt));await inspectDeliveryOutputM4B(f.deliveryConfig,receipt,events[2].eventDigest);const auditArtifacts=new Map();for(const e of loaded.history)for(const h of e.artifacts)if(!auditArtifacts.has(h))auditArtifacts.set(h,await f.store.readArtifact({revision:e.revision,hash:h}));
  for(const event of events){const index=loaded.history.indexOf(event),previous=loaded.history[index-1];assert.deepEqual(validateDeliveryAuditM4B(loaded.history.slice(0,index),event.type,event.payload,event.previousDigest,[auditArtifacts.get(event.artifacts[0])],h=>auditArtifacts.get(h)),auditArtifacts.get(event.artifacts[0]));const business=s=>{const {revision,action,...rest}=s;return rest;};assert.deepEqual(business(event.payload),business(previous.payload));assert.throws(()=>validateDeliveryAuditM4B(loaded.history.slice(0,index),event.type,event.payload,event.previousDigest,[],h=>auditArtifacts.get(h)),{code:'DELIVERY_ARTIFACT_REQUIRED'});}
  const finalRecord=auditArtifacts.get(events[0].artifacts[0]),completeRecord=auditArtifacts.get(events[2].artifacts[0]);assert.throws(()=>validateDeliveryAuditM4B(loaded.history.slice(0,loaded.history.indexOf(events[0])),events[0].type,events[0].payload,events[0].previousDigest,[{...finalRecord,reviewerResultId:finalRecord.validatorResultId}],h=>auditArtifacts.get(h)),{code:'QUALIFICATION_REFERENCE_MISMATCH'});assert.throws(()=>validateDeliveryAuditM4B(loaded.history.slice(0,loaded.history.indexOf(events[2])),events[2].type,events[2].payload,events[2].previousDigest,[{...completeRecord,reservationId:'foreign'}],h=>auditArtifacts.get(h)),{code:'RESERVATION_BINDING_MISMATCH'});assert.throws(()=>validateTransitionV2(events[0].payload,'DELIVERY_RESERVED',{...events[1].payload,phase:'AUTHORING'}),{code:'QUALIFICATION_PHASE_REQUIRED'});
  const status=await f.controller.status();assert.equal(status.qualification.deliveryPhase,'completed');assert.equal(status.qualification.workPacket.criteriaDigest,digest(f.plan.criteria));assert.ok(Buffer.byteLength(canonicalize(status))<=16384);await assert.rejects(f.controller.export({qualificationReceiptDigest:qualified.qualificationReceiptDigest,destinationId:'fixture-output'}),{code:'DELIVERY_NOT_AUTHORIZED'});const stopBarrier=pauseRead(),readingAtStop=f.controller.read({kind:'artifact',id:events[2].artifacts[0],offset:0,limit:1024,cursor:null});readingAtStop.catch(()=>{});await stopBarrier.ready;let stopSettled=false;const stopping=f.controller.stop().then(()=>{stopSettled=true;});await Promise.resolve();assert.equal(stopSettled,false);stopBarrier.release();await assert.rejects(readingAtStop,{code:'DELIVERY_STOPPED'});await stopping;const cold=await inspectGovernanceM4B(f.storeOptions,f.deliveryConfig);assert.equal(cold.qualification.deliveryPhase,'completed');assert.equal(cold.qualification.qualifiedAccepted,false);assert.equal(cold.headAuthenticity,'unproven');
});
test('M4B unaccepted owner and stale finalization requests cannot allocate output',async t=>{
  const f=await m4bReadyFixture(t,{ready:false});await f.controller.propose(f.plan);await assert.rejects(f.controller.qualify({candidateDigest:'a'.repeat(64),headDigest:(await f.controller.status()).headDigest}),{code:'QUALIFICATION_NOT_IDLE'});await assert.rejects(f.controller.export({qualificationReceiptDigest:'b'.repeat(64),destinationId:'fixture-output'}),{code:'QUALIFICATION_NOT_IDLE'});assert.equal(f.stats.starts,0);assert.equal(await m4bExists(f.outputRoot),false);const inspected=await f.store.load();assert.equal(inspected.history.length,1);
});
test('M4B failed required tests cannot qualify or allocate delivery output',async t=>{
  const f=await m4bReadyFixture(t,{expectedPass:false}),status=await f.controller.status();assert.equal(status.status.phase,'CORRECTION_REQUIRED');await assert.rejects(f.controller.qualify({candidateDigest:f.candidateDigest,headDigest:status.headDigest}),{code:'QUALIFICATION_NOT_IDLE'});await assert.rejects(f.controller.export({qualificationReceiptDigest:'a'.repeat(64),destinationId:'fixture-output'}),{code:'QUALIFICATION_NOT_IDLE'});assert.equal(await m4bExists(f.outputRoot),false);
});

test('M4B consumption and durable reservation precede output and failed reservation cannot retry',async t=>{
  let armed=false,reached=false;const f=await m4bReadyFixture(t,{failpoint:async name=>{if(armed&&name==='delivery.reserve.afterAck'){reached=true;assert.equal(await m4bExists(f.outputRoot),false);const reserved=await f.store.load();assert.equal(reserved.latest.type,'DELIVERY_RESERVED');await assert.rejects(f.controller.export({qualificationReceiptDigest:qualified.qualificationReceiptDigest,destinationId:'fixture-output'}),{code:'DELIVERY_BUSY_OR_STOPPED'});throw Object.assign(new Error('reserved injected'),{code:'M4B_RESERVED_INJECTED'});}}});const qualified=await f.qualify();f.expectCloseFailure();armed=true;await assert.rejects(f.controller.export({qualificationReceiptDigest:qualified.qualificationReceiptDigest,destinationId:'fixture-output'}),{code:'M4B_RESERVED_INJECTED'});assert.equal(reached,true);assert.equal(await m4bExists(f.outputRoot),false);const cold=await inspectGovernanceM4B(f.storeOptions,f.deliveryConfig);assert.equal(cold.qualification.deliveryPhase,'reserved');assert.equal(cold.qualification.allowedNextAction,'none');assert.equal(cold.qualification.qualifiedAccepted,false);await assert.rejects(f.controller.export({qualificationReceiptDigest:qualified.qualificationReceiptDigest,destinationId:'fixture-output'}));
});
test('M4B acknowledged completion without marker is cold uncertain and never active',async t=>{
  let armed=false,reached=false;const f=await m4bReadyFixture(t,{failpoint:async name=>{if(armed&&name==='delivery.completed.afterAck'){reached=true;assert.equal(await m4bExists(path.join(f.outputRoot,'complete.json')),false);throw Object.assign(new Error('completed injected'),{code:'M4B_COMPLETED_INJECTED'});}}});const qualified=await f.qualify();f.expectCloseFailure();armed=true;await assert.rejects(f.controller.export({qualificationReceiptDigest:qualified.qualificationReceiptDigest,destinationId:'fixture-output'}),{code:'M4B_COMPLETED_INJECTED'});assert.equal(reached,true);const cold=await inspectGovernanceM4B(f.storeOptions,f.deliveryConfig);assert.equal(cold.qualification.deliveryPhase,'uncertain');assert.equal(cold.qualification.qualifiedAccepted,false);assert.equal(cold.qualification.allowedNextAction,'none');assert.equal(await m4bExists(path.join(f.outputRoot,'complete.json')),false);
});

// Parent-owned M4B human-command controls; merged only into the new delivery test file.
import {createHumanCommandsM4B as m4bHumanCommands,createHumanCommandsM4 as m4bLegacyCommands} from '../src/governance/host.mjs';
import {createGovernanceQualificationPluginM4B as m4bQualificationPlugin,createGovernancePluginM4 as m4bDefaultPlugin,startGovernanceM4B as m4bStartQualification} from '../src/governance/plugin.mjs';
function m4bCommandFixture(){
  const receiver={id:'receiver'},map=new Map(),effects=[],calls=[];let initiator,live=true;
  const commands={register(d){const normalized={...d};assert.equal(map.has(d.name)===false,true);map.set(d.name,normalized);return()=>{if(map.get(d.name)===normalized)map.delete(d.name);};},find:(_a,n)=>map.get(n)};
  const agents={get:()=>live?receiver:undefined,currentInitiator:()=>initiator};
  const ctx={get:n=>({commands,agents})[n],effect:fn=>effects.push(fn())};
  const handlers={accept:async r=>{calls.push(['accept',r]);return{qualificationOnly:true,gateActive:false};},stop:async()=>{calls.push(['stop']);},qualify:async r=>{calls.push(['qualify',r]);return{qualificationOnly:true,gateActive:false};},export:async r=>{calls.push(['export',r]);return{qualificationOnly:true,gateActive:false};}};
  const port=m4bHumanCommands(ctx,{receiverAgent:receiver,handlers});
  return{ctx,receiver,map,effects,calls,handlers,port,setInitiator:v=>{initiator=v;},setLive:v=>{live=v;},invoke:(name,rawInput,agent=receiver,signal)=>map.get(name).handler({agent,rawInput,signal})};
}
test('M4B human qualification commands bind exact receiver, definition and closed grammar',async()=>{
  const f=m4bCommandFixture(),h='a'.repeat(64);assert.deepEqual([...f.map.keys()],['gov-qualify','gov-export','gov-accept']);
  for(const[n,d]of f.map){assert.equal(typeof d.input?.hint,'string',n+' Web input descriptor');assert.ok(d.input.hint.trim().length>0);assert.equal(d.input.attachments,undefined);}
  assert.equal((await f.invoke('gov-qualify',h+' '+h)).kind,'success');assert.equal((await f.invoke('gov-export',h+' fixed-output')).kind,'success');assert.equal(f.calls.length,2);
  f.setInitiator(f.receiver);await assert.rejects(f.invoke('gov-export',h+' fixed-output'),{code:'M4_HUMAN_ORIGIN'});f.setInitiator(undefined);
  await assert.rejects(f.invoke('gov-qualify',h+' '+h,{id:'receiver'}),{code:'M4_HUMAN_RECEIVER'});
  for(const[name,args]of [['gov-qualify','{}'],['gov-qualify',h+' '+h+' force'],['gov-export',h+' ../escape'],['gov-export',h+' C:\\elsewhere'],['gov-export',h+' fixed extra'],['gov-export','b'.repeat(1025)]])await assert.rejects(f.invoke(name,args),{code:'M4_HUMAN_INPUT'});
  const definition=f.map.get('gov-export');f.map.set('gov-export',{...definition});await assert.rejects(definition.handler({agent:f.receiver,rawInput:h+' fixed-output'}),{code:'M4_HUMAN_ORIGIN'});f.map.set('gov-export',definition);
  f.setLive(false);await assert.rejects(f.invoke('gov-export',h+' fixed-output'),{code:'M4_HUMAN_RECEIVER'});f.setLive(true);
  const abort=new AbortController();abort.abort();assert.equal((await f.invoke('gov-export',h+' fixed-output',f.receiver,abort.signal)).kind,'error');assert.equal(f.calls.length,2);
  f.port.close();assert.equal(f.map.size,0);await assert.rejects(definition.handler({agent:f.receiver,rawInput:h+' fixed-output'}),{code:'M4_HUMAN_RECEIVER'});
});
test('M4B human results remain bounded, redacted and unable to acknowledge after unload',async()=>{
  const f=m4bCommandFixture(),h='a'.repeat(64);f.handlers.qualify=async()=>({payload:'x'.repeat(17000)});assert.equal(JSON.parse((await f.invoke('gov-qualify',h+' '+h)).text).reason,'M4_RESPONSE_LIMIT');
  f.handlers.qualify=async()=>{throw Error('C:\\private\\credential secret');};const failure=await f.invoke('gov-qualify',h+' '+h);assert.equal(failure.kind,'error');assert.equal(failure.text.includes('credential'),false);
  let release,entered;const barrier=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});f.handlers.export=async()=>{entered();await barrier;return{qualificationOnly:true,gateActive:false};};
  const pending=f.invoke('gov-export',h+' fixed-output');await ready;f.port.close();release();assert.equal((await pending).kind,'error');assert.equal(f.map.size,0);
});
test('M4B static qualification preset is inert and cannot be selected through default config',async()=>{
  const effects=[],guards=[];const ctx={get:n=>n==='tools'?{guard:g=>{guards.push(g);return()=>{};}}:undefined,effect:fn=>effects.push(fn())};
  const factory=m4bQualificationPlugin(x=>x,{destinationId:'fixed',outputRoot:'not-a-root',protectedRoots:[]});await factory.apply(ctx,{role:'preset'});assert.equal(guards.length,1);assert.equal(guards[0]({agent:{id:'nobody'}}),'M4_PRESET_READ_ONLY');
  await assert.rejects(factory.apply(ctx,{role:'preset',qualification:true}),{code:'M4_CLOSED_SHAPE'});assert.equal(guards.length,1);
  await assert.rejects(m4bDefaultPlugin(x=>x).apply(ctx,{role:'host',mode:'qualification'}),{code:'M4_CLOSED_SHAPE'});assert.equal(guards.length,1);
  assert.throws(()=>m4bQualificationPlugin(x=>x,{destinationId:'fixed',outputRoot:'not-a-root',protectedRoots:[],accepted:true}),{code:'M4B_CLOSED_DELIVERY'});
  for(const dispose of effects)dispose();
});
test('M4B command cancellation fences immediately and awaits delivery drain',async()=>{
  const f=m4bCommandFixture(),h='a'.repeat(64),abort=new AbortController();let entered,release,fenced=false,done=false;
  const ready=new Promise(r=>{entered=r;}),drain=new Promise(r=>{release=r;});
  f.handlers.export=async()=>{entered();await drain;return{qualificationOnly:true,gateActive:false};};
  f.handlers.stop=()=>{fenced=true;return drain;};
  const pending=f.invoke('gov-export',h+' fixed-output',f.receiver,abort.signal);pending.then(()=>{done=true;});await ready;abort.abort();assert.equal(fenced,true);await Promise.resolve();assert.equal(done,false);release();assert.equal((await pending).kind,'error');f.port.close();
});

// Self-contained imports use unique aliases so this fragment can append to the sole new product test file.
import {captureDeliveryDestinationM4B as wsCapture,verifyDeliveryDestinationM4B as wsVerify,
  inspectDeliveryOutputM4B as wsInspect,prepareCustodyDeliveryM4B as wsPrepare} from '../src/governance/workspace.mjs';
import wsTest from 'node:test';
import wsAssert from 'node:assert/strict';
import * as wsFs from 'node:fs/promises';
import wsPath from 'node:path';
import wsOs from 'node:os';
async function wsFixture(t){
  const root=await wsFs.mkdtemp(wsPath.join(nativeTmpdir(),'m4b-destination-'));t.after(()=>wsFs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const parent=wsPath.join(root,'parent'),protectedRoot=wsPath.join(root,'protected');await wsFs.mkdir(parent);await wsFs.mkdir(protectedRoot);
  const config={destinationId:'fixture-output',outputRoot:wsPath.join(parent,'delivery'),protectedRoots:[protectedRoot]};
  return{root,parent,protectedRoot,config};
}
wsTest('M4B destination capture is opaque absent-only and refuses closed-shape or overlap changes',async t=>{
  const f=await wsFixture(t),handle=wsCapture(f.config);wsAssert.deepEqual(Object.keys(handle),[]);wsAssert.equal(Object.isFrozen(handle),true);
  wsAssert.deepEqual(wsVerify(handle),{destinationId:'fixture-output'});wsAssert.throws(()=>wsVerify({}),{code:'UNKNOWN_DELIVERY_DESTINATION'});
  for(const config of [{...f.config,force:true},{...f.config,outputRoot:wsPath.join(f.protectedRoot,'delivery')},{...f.config,outputRoot:f.parent},{...f.config,outputRoot:f.parent+wsPath.sep+'x'+wsPath.sep+'..'+wsPath.sep+'delivery'}])wsAssert.throws(()=>wsCapture(config));
  wsAssert.throws(()=>wsPrepare({},{}),{code:'UNKNOWN_CUSTODY'});await wsAssert.rejects(wsFs.stat(f.config.outputRoot),{code:'ENOENT'});
});
wsTest('M4B destination retention rejects parent replacement with identical ordinary shape',async t=>{
  const f=await wsFixture(t),handle=wsCapture(f.config);await wsFs.rename(f.parent,f.parent+'-retained');await wsFs.mkdir(f.parent);
  wsAssert.throws(()=>wsVerify(handle),{code:'OWNER_DIRECTORY_CHANGED'});await wsFs.writeFile(wsPath.join(f.parent,'foreign'),'kept');
  wsAssert.equal(await wsFs.readFile(wsPath.join(f.parent,'foreign'),'utf8'),'kept');
});
wsTest('M4B destination retention refuses late foreign root and protected ancestor junction',async t=>{
  const f=await wsFixture(t),handle=wsCapture(f.config);await wsFs.mkdir(f.config.outputRoot);await wsFs.writeFile(wsPath.join(f.config.outputRoot,'foreign'),'kept');
  wsAssert.throws(()=>wsVerify(handle),{code:'DELIVERY_OUTPUT_EXISTS'});wsAssert.throws(()=>wsCapture(f.config),{code:'DELIVERY_OUTPUT_EXISTS'});
  const g=await wsFixture(t),second=wsCapture(g.config);await wsFs.rename(g.protectedRoot,g.protectedRoot+'-retained');await wsFs.symlink(g.protectedRoot+'-retained',g.protectedRoot,process.platform==='win32'?'junction':'dir');
  wsAssert.throws(()=>wsVerify(second));await wsFs.unlink(g.protectedRoot);
});
wsTest('M4B cold output consistency cannot bless missing partial or foreign roots',async t=>{
  const f=await wsFixture(t);wsAssert.throws(()=>wsInspect(f.config,{},'0'.repeat(64)));
  await wsFs.mkdir(f.config.outputRoot);await wsFs.mkdir(wsPath.join(f.config.outputRoot,'payload'));await wsFs.writeFile(wsPath.join(f.config.outputRoot,'complete.json'),'{}');
  const before=await wsFs.readdir(f.config.outputRoot);wsAssert.throws(()=>wsInspect(f.config,{},'0'.repeat(64)),{code:'DELIVERY_OUTPUT_INVENTORY'});
  wsAssert.deepEqual(await wsFs.readdir(f.config.outputRoot),before);
});
import {canonicalize as wsCanonical,digest as wsDigest} from '../src/governance/contracts.mjs';
const wsBarrier=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function wsExport(f){const receipt=await f.qualify();return f.controller.export({qualificationReceiptDigest:receipt.qualificationReceiptDigest,destinationId:f.deliveryConfig.destinationId});}
wsTest('M4B workspace payload copy and marker match canonical protected receipt without aliasing custody',async t=>{
  const f=await m4bReadyFixture(t),reply=await wsExport(f);
  wsAssert.equal(reply.deliveryPhase,'completed');wsAssert.deepEqual((await wsFs.readdir(f.outputRoot)).sort(),['complete.json','descriptor.json','payload','qualification-receipt.json']);
  const receipt=JSON.parse(await wsFs.readFile(wsPath.join(f.outputRoot,'qualification-receipt.json'),'utf8'));
  wsAssert.equal(wsDigest(receipt),reply.deliveryReceiptDigest);wsAssert.equal(await wsFs.readFile(wsPath.join(f.outputRoot,'qualification-receipt.json'),'utf8'),wsCanonical(receipt));
  const result=wsInspect(f.deliveryConfig,receipt,reply.eventDigest);wsAssert.equal(result.complete,true);wsAssert.equal(result.operationallyAccepted,false);
  const descriptor=JSON.parse(await wsFs.readFile(wsPath.join(f.outputRoot,'descriptor.json'),'utf8'));
  for(const row of descriptor.files){const file=wsPath.join(f.outputRoot,'payload',...row.path.split('/')),stat=await wsFs.lstat(file,{bigint:true});wsAssert.equal(stat.nlink,1n);wsAssert.equal(stat.isSymbolicLink(),false);}
  wsAssert.deepEqual(wsVerify(f.destination),{destinationId:f.deliveryConfig.destinationId});
});
wsTest('M4B workspace stop during payload write waits for owned descriptor closure and never acknowledges',async t=>{
  const reached=wsBarrier(),release=wsBarrier();let armed=false;
  t.after(()=>release.resolve());const f=await m4bReadyFixture(t,{failpoint:async stage=>{if(armed&&stage==='delivery.file.write.after'){reached.resolve();await release.promise;}}});
  const receipt=await f.qualify();armed=true;const exporting=f.controller.export({qualificationReceiptDigest:receipt.qualificationReceiptDigest,destinationId:f.deliveryConfig.destinationId});exporting.catch(()=>{});
  await Promise.race([reached.promise,exporting.then(()=>{throw Error('export bypassed payload barrier');})]);
  let stopped=false;const stopping=f.controller.stop().then(()=>{stopped=true;});await Promise.resolve();wsAssert.equal(stopped,false);release.resolve();
  await wsAssert.rejects(exporting);await stopping;await wsAssert.rejects(wsFs.stat(wsPath.join(f.outputRoot,'complete.json')),{code:'ENOENT'});
});
wsTest('M4B workspace marker close mutation invalidates reply while retaining foreign bytes',async t=>{
  let armed=false;const f=await m4bReadyFixture(t,{failpoint:async stage=>{if(armed&&stage==='delivery.marker.close.after'){
    await wsFs.unlink(wsPath.join(f.outputRoot,'complete.json'));await wsFs.writeFile(wsPath.join(f.outputRoot,'complete.json'),'FOREIGN MARKER');
  }}});
  const receipt=await f.qualify();f.expectCloseFailure();armed=true;await wsAssert.rejects(f.controller.export({qualificationReceiptDigest:receipt.qualificationReceiptDigest,destinationId:f.deliveryConfig.destinationId}));
  wsAssert.equal(await wsFs.readFile(wsPath.join(f.outputRoot,'complete.json'),'utf8'),'FOREIGN MARKER');
});
wsTest('M4B workspace partial payload rejects extra files and preserves uncertain output',async t=>{
  let injected=false;const f=await m4bReadyFixture(t,{failpoint:async stage=>{if(!injected&&stage==='delivery.file.close.after'){injected=true;await wsFs.writeFile(wsPath.join(f.outputRoot,'payload','extra.txt'),'FOREIGN');}}});
  f.expectCloseFailure();await wsAssert.rejects(wsExport(f));wsAssert.equal(injected,true);wsAssert.equal(await wsFs.readFile(wsPath.join(f.outputRoot,'payload','extra.txt'),'utf8'),'FOREIGN');
  await wsAssert.rejects(wsFs.stat(wsPath.join(f.outputRoot,'complete.json')),{code:'ENOENT'});
});

test('M4B reassess forwards current head and retains bounded read-only admission and stop guards',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(nativeTmpdir(),'m4b-reassess-'))),projectRoot=path.join(root,'project'),outputRoot=path.join(root,'output');
  let store,owner,effects=0;t.after(async()=>{try{if(owner)await owner.close();else if(store)await store.close();}finally{await fs.rm(root,{recursive:true,force:true});}});await fs.mkdir(projectRoot);
  const destination=captureDeliveryDestinationM4B({destinationId:'reassess-output',outputRoot,protectedRoots:[projectRoot,path.join(root,'journal')]});store=await openGovernanceStoreV2({root:path.join(root,'journal'),projectRoot,protectedRoots:[]});
  const forbidden=()=>{effects++;throw new Error('Unexpected reassessment execution');};
  owner=await createGovernanceControllerM4B({store,host:{prepareStage:forbidden,start:forbidden,observe:forbidden,cancel(){},async close(){}},humanPort:{bind(){return()=>{};}},workspaceFactory:forbidden,runnerFactory:forbidden,authorizeOwner:()=>true,delivery:destination});
  const route=provider=>({provider,model:'fixture',effort:'none'}),executionPolicy={schemaVersion:1,routes:{'plan-review':route('review'),author:route('author'),validator:route('validator'),reviewer:route('review')},node:{executable:process.execPath,sha256:digest('node'),version:process.versions.node,systemRoot:null},enforcement:'guarded-native-trusted-code',settlementGraceMs:1000,testFiles:[{path:'fixed.test.mjs',sha256:digest('test')}],environmentRecipe:'systemroot-owned-temp-v1'};
  const plan=validatePlanV2({schemaVersion:2,jobId:'reassess',projectId:store.status().projectId,baseline:digest('baseline'),objective:'Read bounded reassessment without execution',nonGoals:['No dispatch'],files:[{path:'a.txt',operation:'create',expectedHash:null}],protectedTests:['fixed.test.mjs'],criteria:[{id:'C',description:'Read the current head',method:'test'}],commands:[{id:'test',executable:process.execPath,argv:['--test','--test-isolation=none','--test-reporter=tap','fixed.test.mjs'],cwd:'frozen',environment:{},timeoutMs:1000,expectedExit:0,inventory:['CASE']}],policy:{planner:{id:'planner',provider:'author'},implementerProvider:'author',correctionLimit:2},testInventory:['CASE'],environmentDigest:digest({node:executionPolicy.node,enforcement:executionPolicy.enforcement,environmentRecipe:executionPolicy.environmentRecipe}),executionPolicy});
  await owner.propose(plan);const before=await store.load(),head=before.latest.eventDigest;
  const journalBytes=async()=>{const entries=[];for(const dir of ['revisions','artifacts'])for(const file of (await fs.readdir(path.join(root,'journal',dir))).sort())entries.push([dir+'/'+file,m4bRaw(await fs.readFile(path.join(root,'journal',dir,file)))]);return entries;},beforeBytes=await journalBytes();
  const page=await owner.reassess(head);assert.equal(page.headDigest,head);assert.equal(page.kind,'status');assert.equal(page.origin,'live-owner');assert.equal(page.headAuthenticity,'live-verified');assert.deepEqual(page.reassessment,{remainingBudget:3,mayChangePlan:false,mayResetBudget:false,mayResume:false});assert.equal(page.status.accepted,false);assert.equal(page.status.gateActive,false);assert.ok(Buffer.byteLength(canonicalize(page),'utf8')<=16384);
  await assert.rejects(owner.reassess('0'.repeat(64)),{code:'STALE_CURSOR'});for(const invalid of [undefined,null,7,{},[]])await assert.rejects(owner.reassess(invalid),{code:'INVALID_DIGEST'});
  const pending=owner.reassess(head);await assert.rejects(owner.qualify({candidateDigest:'a'.repeat(64),headDigest:head}),{code:'QUALIFICATION_NOT_IDLE'});assert.equal((await pending).headDigest,head);
  assert.deepEqual((await store.load()).history,before.history);assert.deepEqual(await journalBytes(),beforeBytes);assert.equal(effects,0);assert.equal(await m4bExists(outputRoot),false);
  const pendingAtStop=owner.reassess(head);pendingAtStop.catch(()=>{});let stopped=false;const stopping=owner.stop().then(()=>{stopped=true;});assert.equal(stopped,false);await assert.rejects(pendingAtStop,{code:'DELIVERY_STOPPED'});await stopping;assert.equal(stopped,true);await assert.rejects(owner.reassess(head),{code:'DELIVERY_BUSY_OR_STOPPED'});assert.equal(effects,0);assert.equal(await m4bExists(outputRoot),false);
});

// Stage 6 bundle: the offline acceptance record appended through the same-owner qualification lane.
import {ACCEPTANCE_EVENT_V2,acceptanceDigestV2,validateAcceptanceAuditV2} from '../src/governance/contracts.mjs';
async function a6Journal(root){const files=[];for(const dir of ['revisions','artifacts'])for(const name of (await fs.readdir(path.join(root,dir))).sort())files.push([dir+'/'+name,m4bRaw(await fs.readFile(path.join(root,dir,name)))]);return files;}
function a6Events(loaded){return loaded.history.filter(e=>e.type===ACCEPTANCE_EVENT_V2);}
test('T5 acceptance records one event and receipt without a phase change, and never authorizes export',async t=>{
  const f=await m4bReadyFixture(t),before=await f.store.load(),status=await f.controller.status();
  assert.equal(status.status.phase,'DIAGNOSTIC_READY');assert.equal(f.candidateDigest,status.status.candidateDigest);assert.equal(before.latest.payload.candidate,f.candidateDigest);
  const reply=await f.controller.accept({candidateDigest:f.candidateDigest,headDigest:before.latest.eventDigest});
  assert.deepEqual(Object.keys(reply).sort(),['acceptanceReceiptDigest','acceptanceRecorded','allowedNextAction','candidateDigest','gateActive','headDigest','operationallyAccepted','qualificationOnly','schemaVersion']);
  assert.equal(reply.schemaVersion,1);assert.equal(reply.qualificationOnly,true);assert.equal(reply.acceptanceRecorded,true);
  assert.equal(reply.operationallyAccepted,false);assert.equal(reply.gateActive,false);assert.equal(reply.allowedNextAction,'qualify');assert.equal(reply.candidateDigest,f.candidateDigest);
  const accepted=await f.store.load(),events=a6Events(accepted);
  assert.equal(accepted.history.length,before.history.length+1);assert.equal(events.length,1);assert.equal(accepted.latest.type,ACCEPTANCE_EVENT_V2);
  assert.equal(accepted.latest.eventDigest,reply.headDigest);assert.equal(accepted.latest.payload.phase,'DIAGNOSTIC_READY');assert.equal(accepted.latest.payload.revision,before.latest.payload.revision+1);
  assert.equal(accepted.latest.payload.candidate,f.candidateDigest);assert.equal(events[0].artifacts.length,1);assert.equal(events[0].artifacts[0],reply.acceptanceReceiptDigest);
  const receipt=await f.store.readArtifact({revision:events[0].revision,hash:events[0].artifacts[0]});
  assert.equal(m4bRaw(canonicalize(receipt)),reply.acceptanceReceiptDigest);
  assert.equal(receipt.kind,'acceptance-recorded');assert.equal(receipt.operationallyAccepted,false);assert.equal(receipt.gateActive,false);
  assert.equal(receipt.candidateDigest,f.candidateDigest);assert.equal(receipt.priorHeadDigest,before.latest.eventDigest);
  assert.equal(receipt.planDigest,digest(f.plan));assert.equal(receipt.acceptanceDigest,acceptanceDigestV2(f.plan));
  assert.deepEqual(receipt.facts,{custodyVerified:true,journalHealthy:true,scopeClean:true,identityRecheck:true});
  assert.deepEqual(Object.keys(receipt).sort(),['acceptanceDigest','authorResultId','candidateDigest','facts','frozenArtifactHash','gateActive','generation','id','jobId','kind','logArtifacts','nonce','operationallyAccepted','planDigest','priorHeadDigest','projectId','reviewerResultId','schemaVersion','submissionArtifacts','testArtifacts','validatorResultId']);
  const index=accepted.history.indexOf(events[0]);
  assert.deepEqual(validateAcceptanceAuditV2(accepted.history.slice(0,index),events[0].type,events[0].payload,events[0].previousDigest,[receipt]),receipt);
  const replay=await inspectGovernanceStoreV2(f.storeOptions);assert.equal(replay.latest.eventDigest,accepted.latest.eventDigest);assert.equal(a6Events(replay).length,1);
  const cold=await inspectGovernanceM4B(f.storeOptions,f.deliveryConfig);assert.equal(cold.status.accepted,false);assert.equal(cold.status.gateActive,false);assert.equal(cold.headDigest,accepted.latest.eventDigest);
  const qualified=await f.qualify();assert.equal(qualified.qualifiedAccepted,true);assert.equal(qualified.qualificationOnly,true);assert.equal(qualified.operationallyAccepted,false);assert.equal(await m4bExists(f.outputRoot),false);
  const delivered=await f.controller.export({qualificationReceiptDigest:qualified.qualificationReceiptDigest,destinationId:'fixture-output'});assert.equal(delivered.deliveryPhase,'completed');assert.equal(delivered.operationallyAccepted,false);assert.equal(delivered.gateActive,false);
  const outputBefore=(await fs.readdir(f.outputRoot)).sort();
  await assert.rejects(f.controller.export({qualificationReceiptDigest:reply.acceptanceReceiptDigest,destinationId:'fixture-output'}),{code:'DELIVERY_NOT_AUTHORIZED'});
  const final=await f.store.load();assert.deepEqual(a6Events(final).map(e=>e.eventDigest),[events[0].eventDigest]);assert.deepEqual((await fs.readdir(f.outputRoot)).sort(),outputBefore);
});
test('T6 acceptance refusals leave no event, no phase change and no output',async t=>{
  const f=await m4bReadyFixture(t),before=await f.store.load(),status=await f.controller.status(),journalBefore=await a6Journal(f.storeOptions.root);
  await assert.rejects(f.controller.accept({candidateDigest:f.candidateDigest,headDigest:'0'.repeat(64)}),{code:'STALE_ACCEPT_REQUEST'});
  await assert.rejects(f.controller.accept({candidateDigest:'b'.repeat(64),headDigest:before.latest.eventDigest}),{code:'STALE_ACCEPT_REQUEST'});
  await assert.rejects(f.controller.accept({candidateDigest:f.candidateDigest,headDigest:before.latest.eventDigest,accepted:true}),{code:'CLOSED_SCHEMA'});
  const refused=await f.store.load();assert.deepEqual(refused.history,before.history);assert.deepEqual(await a6Journal(f.storeOptions.root),journalBefore);assert.equal(await m4bExists(f.outputRoot),false);
  const accepted=await f.controller.accept({candidateDigest:f.candidateDigest,headDigest:status.headDigest});assert.equal(accepted.acceptanceRecorded,true);
  const afterAccept=await f.store.load();
  await assert.rejects(f.controller.accept({candidateDigest:f.candidateDigest,headDigest:afterAccept.latest.eventDigest}),{code:'ACCEPTANCE_NOT_ALLOWED'});
  const settled=await f.store.load();assert.equal(a6Events(settled).length,1);assert.equal(settled.latest.payload.phase,'DIAGNOSTIC_READY');assert.equal(settled.latest.eventDigest,afterAccept.latest.eventDigest);assert.equal(await m4bExists(f.outputRoot),false);
});
test('T6 a failed-test fixture cannot record acceptance, and acceptance is refused after qualification',async t=>{
  const failed=await m4bReadyFixture(t,{expectedPass:false}),failedStatus=await failed.controller.status();
  assert.equal(failedStatus.status.phase,'CORRECTION_REQUIRED');
  await assert.rejects(failed.controller.accept({candidateDigest:failed.candidateDigest,headDigest:failedStatus.headDigest}),{code:'QUALIFICATION_NOT_IDLE'});
  assert.equal(a6Events(await failed.store.load()).length,0);assert.equal(await m4bExists(failed.outputRoot),false);
  const f=await m4bReadyFixture(t),qualified=await f.qualify(),afterQualify=await f.store.load();
  await assert.rejects(f.controller.accept({candidateDigest:f.candidateDigest,headDigest:afterQualify.latest.eventDigest}),{code:'ACCEPTANCE_NOT_ALLOWED'});
  assert.deepEqual(a6Events(afterQualify),[]);assert.equal(await m4bExists(f.outputRoot),false);
});
test('T7 acceptance audit refuses tampered binding, references, facts, duplicate, order and artifact count',async t=>{
  const f=await m4bReadyFixture(t);await f.controller.accept({candidateDigest:f.candidateDigest,headDigest:(await f.controller.status()).headDigest});
  const loaded=await f.store.load(),event=a6Events(loaded)[0],index=loaded.history.indexOf(event),priorHistory=loaded.history.slice(0,index),receipt=await f.store.readArtifact({revision:event.revision,hash:event.artifacts[0]});
  const audit=(state=event.payload,history=priorHistory,artifacts=[receipt])=>validateAcceptanceAuditV2(history,event.type,state,event.previousDigest,artifacts);
  assert.deepEqual(audit(),receipt);
  for(const changed of [{priorHeadDigest:'b'.repeat(64)},{planDigest:'b'.repeat(64)}])assert.throws(()=>audit(event.payload,priorHistory,[{...receipt,...changed}]),{code:'ACCEPTANCE_BINDING_MISMATCH'});
  assert.throws(()=>audit(event.payload,priorHistory,[{...receipt,frozenArtifactHash:'b'.repeat(64)}]),{code:'ACCEPTANCE_REFERENCE_MISMATCH'});
  assert.throws(()=>audit(event.payload,priorHistory,[{...receipt,validatorResultId:'foreign'}]),{code:'ACCEPTANCE_REFERENCE_MISMATCH'});
  assert.throws(()=>audit(event.payload,priorHistory,[{...receipt,testArtifacts:['b'.repeat(64)]}]),{code:'ACCEPTANCE_REFERENCE_MISMATCH'});
  assert.throws(()=>audit(event.payload,priorHistory,[{...receipt,facts:{...receipt.facts,scopeClean:false}}]),{code:'ACCEPTANCE_FACTS_REQUIRED'});
  assert.throws(()=>audit(event.payload,priorHistory,[]),{code:'ACCEPTANCE_ARTIFACT_REQUIRED'});
  assert.throws(()=>audit(event.payload,priorHistory,[receipt,receipt]),{code:'ACCEPTANCE_ARTIFACT_REQUIRED'});
  const sealed=b=>({...b,eventDigest:digest(b)});
  const successor=sealed({...event,revision:event.revision+1,previousDigest:event.eventDigest,payload:{...event.payload,revision:event.payload.revision+1,action:{type:ACCEPTANCE_EVENT_V2}}});
  assert.throws(()=>audit(successor.payload,[...priorHistory,event]),{code:'ACCEPTANCE_ALREADY_RECORDED'});
  const finalized=sealed({...event,type:'QUALIFICATION_FINALIZED',previousDigest:event.eventDigest,payload:{...event.payload,action:{type:'QUALIFICATION_FINALIZED'}}});
  const foreignState={...successor.payload,action:{type:ACCEPTANCE_EVENT_V2}};
  assert.throws(()=>validateAcceptanceAuditV2([...priorHistory,finalized],event.type,foreignState,receipt.priorHeadDigest,[receipt]),{code:'ACCEPTANCE_ORDER'});
});
test('T8 acceptance failpoints never write on the pre-record boundary and cannot retry after the acknowledgement',async t=>{
  let armed=false;const f=await m4bReadyFixture(t,{failpoint:async name=>{if(armed&&name==='acceptance.record.beforeRecord'){armed=false;throw Object.assign(new Error('acceptance injected'),{code:'M4B_ACCEPT_INJECTED'});}}});
  const before=await f.store.load(),journalBefore=await a6Journal(f.storeOptions.root);armed=true;
  await assert.rejects(f.controller.accept({candidateDigest:f.candidateDigest,headDigest:before.latest.eventDigest}),{code:'M4B_ACCEPT_INJECTED'});
  assert.equal(f.store.status().poisoned,false);assert.equal(f.store.status().revoked,false);assert.deepEqual(await a6Journal(f.storeOptions.root),journalBefore);
  const retried=await f.controller.accept({candidateDigest:f.candidateDigest,headDigest:before.latest.eventDigest});assert.equal(retried.acceptanceRecorded,true);
  assert.equal(a6Events(await f.store.load()).length,1);assert.equal(await m4bExists(f.outputRoot),false);
});
test('T8 an acknowledged acceptance event cannot be retried and leaves the journal poisoned or revoked',async t=>{
  let armed=false;const f=await m4bReadyFixture(t,{failpoint:async name=>{if(armed&&name==='acceptance.record.afterAck'){armed=false;throw Object.assign(new Error('acceptance ack injected'),{code:'M4B_ACCEPT_ACK_INJECTED'});}}});
  const before=await f.store.load();armed=true;
  await assert.rejects(f.controller.accept({candidateDigest:f.candidateDigest,headDigest:before.latest.eventDigest}),{code:'M4B_ACCEPT_ACK_INJECTED'});
  const status=f.store.status();assert.equal(status.revoked,true);assert.equal(status.admission,false);assert.equal(status.poisoned||status.revoked,true);
  const revisions=await fs.readdir(path.join(f.storeOptions.root,'revisions'));assert.equal(revisions.length,before.history.length+1);
  await assert.rejects(f.controller.accept({candidateDigest:f.candidateDigest,headDigest:before.latest.eventDigest}));
  assert.equal(await m4bExists(f.outputRoot),false);
});
test('T9 the gov-accept human command forwards exactly the candidate and head digests',async()=>{
  const f=m4bCommandFixture(),h='a'.repeat(64),other='b'.repeat(64);
  const accepted=await f.invoke('gov-accept',h+' '+other);assert.equal(accepted.kind,'success');assert.deepEqual(f.calls,[['accept',{candidateDigest:h,headDigest:other}]]);
  assert.equal(JSON.parse(accepted.text).qualificationOnly,true);
  for(const raw of ['{}',h,h+' '+other+' force','A'.repeat(64)+' '+other,h.slice(0,63)+' '+other,'b'.repeat(1025)])await assert.rejects(f.invoke('gov-accept',raw),{code:'M4_HUMAN_INPUT'});
  assert.equal(f.calls.length,1);
  f.setInitiator(f.receiver);await assert.rejects(f.invoke('gov-accept',h+' '+other),{code:'M4_HUMAN_ORIGIN'});f.setInitiator(undefined);
  await assert.rejects(f.invoke('gov-accept',h+' '+other,{id:'receiver'}),{code:'M4_HUMAN_RECEIVER'});
  assert.throws(()=>m4bHumanCommands(f.ctx,{receiverAgent:f.receiver,handlers:{stop:async()=>{},qualify:async()=>({}),export:async()=>({})}}),{code:'M4B_HUMAN_PREREQUISITES'});
  assert.equal(f.calls.length,1);f.port.close();assert.equal(f.map.size,0);
});
test('T10 cold reads project the acceptance receipt without the acceptance-only fields',async t=>{
  const f=await m4bReadyFixture(t),reply=await f.controller.accept({candidateDigest:f.candidateDigest,headDigest:(await f.controller.status()).headDigest});
  const loaded=await f.store.load(),event=a6Events(loaded)[0],receipt=await f.store.readArtifact({revision:event.revision,hash:event.artifacts[0]});
  const page=await inspectGovernanceM4(f.storeOptions,{kind:'artifact',id:reply.acceptanceReceiptDigest,offset:0,limit:8192,cursor:null});
  assert.equal(page.complete,true);const projection=JSON.parse(page.text);
  assert.deepEqual(Object.keys(projection).sort(),['acceptanceDigest','candidateDigest','gateActive','id','kind','operationallyAccepted','planDigest','priorHeadDigest']);
  assert.equal(projection.kind,'acceptance-recorded');assert.equal(projection.operationallyAccepted,false);assert.equal(projection.gateActive,false);
  assert.equal(projection.id,receipt.id);assert.equal(projection.acceptanceDigest,receipt.acceptanceDigest);assert.equal(projection.planDigest,receipt.planDigest);
  assert.equal(projection.priorHeadDigest,receipt.priorHeadDigest);assert.equal(projection.candidateDigest,receipt.candidateDigest);
  await assert.rejects(a6ReadQualificationArtifact(f.storeOptions,{revision:event.revision,hash:reply.acceptanceReceiptDigest}),{code:'FOREIGN_ARTIFACT'});
  const cold=await inspectGovernanceM4B(f.storeOptions,f.deliveryConfig);assert.equal(cold.headDigest,loaded.latest.eventDigest);assert.equal(cold.status.accepted,false);assert.equal(cold.status.phase,'DIAGNOSTIC_READY');
  const replay=await inspectGovernanceStoreV2(f.storeOptions);assert.equal(a6Events(replay).length,1);assert.equal(replay.latest.payload.phase,'DIAGNOSTIC_READY');assert.equal(replay.latest.payload.candidate,f.candidateDigest);
});
