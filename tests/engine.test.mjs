import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createTaskEngine} from '../src/engine.mjs';
import {createJournal,diskId,digest,expectedHold} from '../src/journal.mjs';
import {makeTempRoot, resolvedTmpdir} from './helpers/tmp.mjs';
const root=await makeTempRoot('multi-agent-test-engine-');let sequence=0;
after(async()=>{assert.equal(path.dirname(root),await resolvedTmpdir());assert.ok(path.basename(root).startsWith('multi-agent-test-engine-'));await fs.rm(root,{recursive:true,force:true});});
const fresh=()=>path.join(root,String(++sequence));const owner='owner-session';
const exec=()=>({agent:{id:owner},signal:new AbortController().signal});
const route={provider:'deepseek-official',model:'deepseek-flash',effort:'low',maxTokens:8192};
const args={task_id:'task',prompt:'Write a complete answer.',route};
const usage=(input=10,output=20)=>({type:'usage',usage:{inputTokens:input,cacheReadTokens:0,outputTokens:output,totalTokens:input+output,reasoningTokens:0}});
const end=kind=>({type:'finish',reason:{kind}});
function llm(stream){let calls=0;return {get calls(){return calls;},async prepareCall(config,signal){return {config,stream(options){calls++;return stream(options,calls,signal);}};}};}
function engine(directory,provider,extra={}){return createTaskEngine({root:directory,owner,getLlm:()=>provider,...extra});}
async function seed(directory,state='CONTINUATION_READY'){
  const e=engine(directory,llm(async function*(){}));await e.plan(args);const j=createJournal(directory,diskId(owner));const r=await j.load(diskId('task'));
  const hold=expectedHold(r.request,[]);r.revision=2;r.status='ATTEMPT_COMMITTED';r.rounds=[{attemptId:randomUUID(),status:'ATTEMPT_COMMITTED',visibleText:'',finish:null,usage:null,costMicros:null,holdMicros:hold}];r.heldMicros=hold;r.costUnknown=true;let saved=await j.save(diskId('task'),r,1);
  if(state!=='ATTEMPT_COMMITTED'){saved.revision=3;saved.status='RUNNING';saved.rounds[0].status='RUNNING';saved.rounds[0].visibleText='saved prefix';saved=await j.save(diskId('task'),saved,2);}
  if(state==='CONTINUATION_READY'){saved.revision=4;saved.status=state;Object.assign(saved.rounds[0],{status:'COMPLETED',finish:'max-tokens',usage:{inputTokens:10,cacheReadTokens:0,outputTokens:20,totalTokens:30,cacheWriteTokens:0,reasoningTokens:0},costMicros:27,holdMicros:0});saved.spentMicros=27;saved.heldMicros=0;saved.costUnknown=false;await j.save(diskId('task'),saved,3);}return j;
}
test('two rounds preserve proper assistant history, settle above $1 and never repeat completed task',async()=>{
  const requests=[];const p=llm(async function*(o,n){requests.push(o);yield {type:'text-delta',text:n===1?'First part. ':'Final part.'};yield usage(1_000_000,1_000_000);yield end(n===1?'max-tokens':'stop');});const directory=fresh(),e=engine(directory,p);await e.plan(args);const r=await e.run('task',exec());assert.equal(r.status,'COMPLETED');assert.equal(r.roundCount,2);assert.equal(r.spentMicros,3_000_000);assert.equal(r.overTarget,true);assert.equal(r.text,'First part. Final part.');assert.equal(requests[1].messages[1].role,'assistant');assert.deepEqual(requests[1].messages[1].source,{kind:'model',provider:route.provider,model:route.model});assert.equal(requests[1].messages[0].content[0].text,args.prompt);await e.resume('task',exec());assert.equal(p.calls,2);const disk=await createJournal(directory,diskId(owner)).load(diskId('task'));assert.equal(disk.request.prompt,args.prompt);assert.equal(disk.spentMicros,3_000_000);
});
test('reasoning-only and repeated visible progress stop without another continuation',async()=>{
  for(const reasoning of [true,false]){const p=llm(async function*(_o,n){yield reasoning?{type:'reasoning-delta',text:'hidden'}:{type:'text-delta',text:'same answer'};yield usage();yield end('max-tokens');});const e=engine(fresh(),p);await e.plan(args);const r=await e.run('task',exec());assert.equal(r.status,'NO_PROGRESS');assert.equal(p.calls,reasoning?1:2);assert.equal(r.text.includes('hidden'),false);}
});
test('CONTINUATION_READY resumes in fresh engine from durable request',async()=>{const directory=fresh();await seed(directory);const p=llm(async function*(o){assert.equal(o.messages[0].content[0].text,args.prompt);assert.equal(o.messages[1].content[0].text,'saved prefix');yield {type:'text-delta',text:' continuation'};yield usage();yield end('stop');});const e=engine(directory,p);const r=await e.resume('task',exec());assert.equal(r.status,'COMPLETED');assert.equal(r.roundCount,2);assert.equal(p.calls,1);await assert.rejects(e.plan(args));});
test('recovered committed and running rounds retain unknown cost and cannot dispatch',async()=>{for(const status of ['ATTEMPT_COMMITTED','RUNNING']){const directory=fresh();await seed(directory,status);const p=llm(async function*(){throw new Error('must not call');});const e=engine(directory,p);assert.equal((await e.read('task')).status,'INTERRUPTED_UNCERTAIN');const r=await e.run('task',exec());assert.equal(r.status,'INTERRUPTED_UNCERTAIN');assert.ok(r.heldMicros>0);assert.equal(p.calls,0);assert.equal((await createJournal(directory,diskId(owner)).load(diskId('task'))).status,'INTERRUPTED_UNCERTAIN');}});
test('unknown-priced route continues with valid usage and records unknown—not zero cost',async()=>{const p=llm(async function*(_o,n){yield {type:'text-delta',text:n===1?'one':'two'};yield usage();yield end(n===1?'max-tokens':'stop');});const e=engine(fresh(),p);await e.plan({...args,route:{...route,provider:'subscription',model:'test',costRates:null}});const r=await e.run('task',exec());assert.equal(r.status,'COMPLETED');assert.equal(r.costUnknown,true);assert.ok(r.rounds.every(x=>x.costMicros===null&&x.holdMicros===null));assert.equal(p.calls,2);});
test('missing usage or error finish keeps reservation and never retries',async()=>{for(const variant of ['missing','error']){const p=llm(async function*(){yield {type:'text-delta',text:'partial'};if(variant==='error')yield usage();yield end(variant==='error'?'error':'stop');});const e=engine(fresh(),p);await e.plan(args);const r=await e.run('task',exec());assert.equal(r.status,'INTERRUPTED_UNCERTAIN');assert.equal(r.text,'partial');assert.ok(r.heldMicros>0);await e.resume('task',exec());assert.equal(p.calls,1);}});
test('context, round and persistent deadline limits do not truncate or financially stop',async()=>{
  const p=llm(async function*(){yield {type:'text-delta',text:'progress'};yield usage();yield end('max-tokens');});const e=engine(fresh(),p);await e.plan({...args,contextChars:1});assert.equal((await e.run('task',exec())).status,'PARTIAL_LIMIT');assert.equal(p.calls,0);
  const e2=engine(fresh(),p);await e2.plan({...args,maxRounds:1});assert.equal((await e2.run('task',exec())).status,'PARTIAL_LIMIT');assert.equal(p.calls,1);
  let now=1000;const directory=fresh(),e3=engine(directory,p,{clock:()=>now,deadlineMs:100});await e3.plan(args);now=1101;const restored=engine(directory,p,{clock:()=>now});assert.equal((await restored.run('task',exec())).status,'PARTIAL_LIMIT');assert.equal(p.calls,1);
});
test('concurrent same-task run is refused; reads are nonblocking and dispose aborts with prefix saved',async()=>{
  let ready;const started=new Promise(r=>ready=r);const p=llm(async function*(o){yield {type:'text-delta',text:'x'.repeat(2100)};ready();await new Promise((_r,reject)=>{o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true});});});const directory=fresh(),e=engine(directory,p);await e.plan(args);const parent=new AbortController();const running=e.run('task',{agent:{id:owner},signal:parent.signal});await started;await assert.rejects(e.run('task',exec()),/CONCURRENT_TASK/);assert.equal((await e.read('task')).text.length,2100);e.dispose();const r=await running;assert.equal(r.status,'INTERRUPTED_UNCERTAIN');assert.equal(parent.signal.aborted,false);assert.equal((await engine(directory,p).read('task')).text.length,2100);assert.equal(p.calls,1);
});
// The task deadline starts at plan time, so a fixture that also depends on real elapsed
// time races its own setup: on a slow runner the journal fsync in plan() can consume the
// whole budget, and run() then refuses to dispatch with PARTIAL_LIMIT. The clock is frozen
// so only the in-flight abort under test decides the outcome; the deadline stays the
// subject, and the timer that fires it still runs on real time.
test('hard deadline aborts an active request without cancelling parent',async()=>{const p=llm(async function*(o){await new Promise((_r,reject)=>o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true}));});const now=Date.now();const e=engine(fresh(),p,{deadlineMs:100,clock:()=>now});await e.plan(args);const x=exec();const r=await e.run('task',x);assert.equal(r.status,'INTERRUPTED_UNCERTAIN');assert.equal(r.roundCount,1);assert.equal(x.signal.aborted,false);});
test('checkpoint commitment precedes prepare and prepared route mismatch prevents stream',async()=>{const directory=fresh();let prepares=0,calls=0;const p={async prepareCall(config){prepares++;const r=await createJournal(directory,diskId(owner)).load(diskId('task'));assert.equal(r.status,'ATTEMPT_COMMITTED');assert.equal(r.rounds.length,1);return {config:{...config,model:'wrong'},stream(){calls++;}};}};const e=engine(directory,p);await e.plan(args);assert.equal((await e.run('task',exec())).status,'INTERRUPTED_UNCERTAIN');assert.equal(prepares,1);assert.equal(calls,0);});
test('latest corruption and request mutation refuse recovery without fallback',async()=>{
  const directory=fresh();const j=await seed(directory);const r=await j.load(diskId('task'));r.revision++;r.request.prompt='changed';r.requestHash=digest(JSON.stringify(r.request));await assert.rejects(j.save(diskId('task'),r,4),/REQUEST_MUTATED/);
  const folder=path.join(directory,diskId(owner),diskId('task'));await fs.writeFile(path.join(folder,'00000005.json'),'{torn',{flag:'wx'});await assert.rejects(engine(directory,llm(async function*(){})).read('task'),/CORRUPT/);
});
test('historical request replacement is detected even with a valid recomputed checksum',async()=>{
  const directory=fresh();await seed(directory);const file=path.join(directory,diskId(owner),diskId('task'),'00000002.json');const envelope=JSON.parse(await fs.readFile(file,'utf8'));envelope.record.request.prompt='mutated persisted prompt';envelope.record.requestHash=digest(JSON.stringify(envelope.record.request));envelope.sha256=digest(JSON.stringify(envelope.record));await fs.writeFile(file,JSON.stringify(envelope));await assert.rejects(createJournal(directory,diskId(owner)).load(diskId('task')),/REQUEST_MUTATED/);
});
test('rehashing a planned rollback or fabricated settled cost cannot reset accounting',async()=>{
  for(const mode of ['reset','cost']){const directory=fresh();await seed(directory,mode==='reset'?'ATTEMPT_COMMITTED':'CONTINUATION_READY');const folder=path.join(directory,diskId(owner),diskId('task'));const previous=mode==='reset'?2:4;const envelope=JSON.parse(await fs.readFile(path.join(folder,`${String(previous).padStart(8,'0')}.json`),'utf8'));
    if(mode==='reset'){envelope.record.revision=3;envelope.record.status='PLANNED';envelope.record.rounds=[];envelope.record.spentMicros=0;envelope.record.heldMicros=0;envelope.record.costUnknown=false;}
    else {envelope.record.spentMicros=0;envelope.record.rounds[0].costMicros=0;}
    envelope.sha256=digest(JSON.stringify(envelope.record));await fs.writeFile(path.join(folder,`${String(envelope.record.revision).padStart(8,'0')}.json`),JSON.stringify(envelope));const p=llm(async function*(){});await assert.rejects(engine(directory,p).run('task',exec()));assert.equal(p.calls,0);
  }
});
test('unpriced DeepSeek model does not silently inherit Flash pricing',async()=>{const p=llm(async function*(){yield {type:'text-delta',text:'done'};yield usage();yield end('stop');});const e=engine(fresh(),p);await e.plan({...args,route:{...route,model:'deepseek-pro'}});const r=await e.run('task',exec());assert.equal(r.status,'COMPLETED');assert.equal(r.costUnknown,true);assert.equal(r.rounds[0].costMicros,null);});
test('Codex-shaped missing total and cached input continue with normalized durable usage',async()=>{
  const p=llm(async function*(_o,n){yield {type:'text-delta',text:n===1?'first':'second'};yield {type:'usage',usage:{inputTokens:7,cacheReadTokens:3,outputTokens:5,reasoningTokens:2}};yield end(n===1?'max-tokens':'stop');});const directory=fresh(),e=engine(directory,p);await e.plan({...args,route:{...route,provider:'codex-subscription',costRates:null}});const r=await e.run('task',exec());assert.equal(r.status,'COMPLETED');assert.equal(r.roundCount,2);assert.equal(r.costUnknown,true);const disk=await createJournal(directory,diskId(owner)).load(diskId('task'));assert.equal(disk.rounds[0].usage.totalTokens,15);assert.equal(disk.rounds[0].usage.reasoningTokens,2);assert.equal(p.calls,2);
});
test('Claude-shaped cache writes and omitted total continue without invented pricing',async()=>{
  const p=llm(async function*(_o,n){yield {type:'text-delta',text:n===1?'alpha':'beta'};yield {type:'usage',usage:{inputTokens:7,cacheReadTokens:3,cacheWriteTokens:4,outputTokens:5}};yield end(n===1?'max-tokens':'stop');});const directory=fresh(),e=engine(directory,p);await e.plan({...args,route:{...route,provider:'claude-subscription',costRates:null}});const r=await e.run('task',exec());assert.equal(r.status,'COMPLETED');assert.equal(r.roundCount,2);assert.equal(r.costUnknown,true);assert.ok(r.rounds.every(x=>x.costMicros===null&&x.holdMicros===null));const disk=await createJournal(directory,diskId(owner)).load(diskId('task'));assert.equal(disk.rounds[0].usage.totalTokens,19);assert.equal(disk.rounds[0].usage.cacheWriteTokens,4);assert.equal(p.calls,2);
});
test('priced route cache writes clear reservations but leave charge unknown',async()=>{
  const p=llm(async function*(){yield {type:'text-delta',text:'done'};yield {type:'usage',usage:{inputTokens:7,cacheReadTokens:3,cacheWriteTokens:4,outputTokens:5,totalTokens:19}};yield end('stop');});const directory=fresh(),e=engine(directory,p);await e.plan(args);const r=await e.run('task',exec());assert.equal(r.status,'COMPLETED');assert.equal(r.costUnknown,true);assert.equal(r.rounds[0].costMicros,null);assert.equal(r.heldMicros,0);assert.equal((await createJournal(directory,diskId(owner)).load(diskId('task'))).rounds[0].costMicros,null);
});
test('owner, closed request and persisted ledger reset checks make no model calls',async()=>{const p=llm(async function*(){}),directory=fresh(),e=engine(directory,p);await e.plan(args);await assert.rejects(e.run('task',{agent:{id:'other'},signal:new AbortController().signal}));await assert.rejects(engine(directory,p).plan(args));await assert.rejects(e.plan({...args,task_id:'other',route:{...route,unexpected:true}}));assert.equal(p.calls,0);});
