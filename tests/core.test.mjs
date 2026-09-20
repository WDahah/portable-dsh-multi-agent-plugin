import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import createPlugin, {createPlugin as namedFactory} from '../src/plugin.mjs';
import {registerLifetimeTool} from '../src/cancellation.mjs';
import {BUILD_ID,createQualificationManager,createRecordStore,keyOf} from '../src/qualification.mjs';
import {createAgentDispatcher} from '../src/agent-dispatch.mjs';
import {createTaskEngine} from '../src/engine.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'multi-agent-test-core-'));let sequence=0;
after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('multi-agent-test-core-'));await fs.rm(root,{recursive:true,force:true});});
const fresh=()=>path.join(root,String(++sequence));
const exec=(owner='parent')=>({agent:{id:owner},signal:new AbortController().signal});
// Explicit synthetic boundary: this is NOT the actual DSH defineTool or registry.
const defineTool=definition=>({...definition});
function context(services={}){const tools=new Map(),cleanups=[];return {tools,ctx:{tools:{register(tool){assert.equal(tools.has(tool.name),false);tools.set(tool.name,tool);return ()=>tools.delete(tool.name);}},get(name){return services[name];},effect(fn){const release=fn();cleanups.push(release);return release;}},dispose(){for(const release of cleanups.reverse())release?.();}};}
test('portable factory injects native definition adapter, mounts nine tools, and defaults disabled',async()=>{
  assert.equal(createPlugin,namedFactory);assert.throws(()=>createPlugin(),/defineTool/);
  const plugin=createPlugin(defineTool);assert.equal(plugin.name,'portable-multi-agent');assert.deepEqual(plugin.inject,['tools']);
  const h=context();plugin.apply(h.ctx,{stateRoot:fresh()});assert.equal(h.tools.size,9);
  const inventory=await h.tools.get('orchestrator_inventory').execute({},exec());assert.equal(inventory.enabled,false);assert.equal(inventory.build_id,'portable-multi-agent-1');assert.equal(inventory.approval_required,false);assert.equal(inventory.hard_budget_cap,false);assert.deepEqual(inventory.qualifications,[]);
  assert.equal(h.tools.get('orchestrator_plan').timeoutMs,60000);assert.equal(h.tools.get('orchestrator_run').timeoutMs,910000);
  const refused=await h.tools.get('orchestrator_qualify').execute({route_id:'codex-terra',effort:'medium'},exec());assert.equal(refused.status,'BRIDGE_REFUSED_OR_FAILED');assert.equal(refused.reason,'DISABLED');h.dispose();assert.equal(h.tools.size,0);
});
test('refusals name an actionable cause without leaking provider or path detail',async()=>{
  const h=context({llm:{listProviders:()=>[],prepareCall(){throw Object.assign(new Error('https://provider.example/v1 key sk-secret'),{code:'SECRET_TOKEN_LEAK',status:401});}}});
  createPlugin(defineTool).apply(h.ctx,{stateRoot:fresh(),enabled:true});
  const cases=[['orchestrator_qualify',{route_id:'no-such-route',effort:'medium'},'UNKNOWN_ROUTE'],
    ['orchestrator_qualify',{route_id:'codex-terra',effort:'not-an-effort'},'EFFORT_NOT_IN_ROUTE_POLICY'],
    ['orchestrator_qualify',{route_id:'codex-terra',effort:'medium',capabilities:['telepathy']},'UNKNOWN_CAPABILITY_PROBE'],
    ['orchestrator_delegate_read',{run_id:'../escape'},'INVALID_RUN_ID'],
    ['orchestrator_read',{task_id:'absent'},'UNKNOWN_TASK']];
  for(const [tool,args,expected] of cases){
    const result=await h.tools.get(tool).execute(args,exec());
    assert.equal(result.status,'BRIDGE_REFUSED_OR_FAILED');assert.equal(result.reason,expected);assert.equal(result.details_redacted,true);
  }
  // A provider failure is recorded as an unavailable route, never surfaced as raw text.
  const probed=await h.tools.get('orchestrator_qualify').execute({route_id:'codex-terra',effort:'medium'},exec());
  assert.equal(probed.qualification.available,false);assert.equal(probed.stop_reason,'error');
  const serialized=JSON.stringify(probed);
  assert.equal(serialized.includes('sk-secret'),false);assert.equal(serialized.includes('provider.example'),false);assert.equal(serialized.includes('SECRET_TOKEN_LEAK'),false);
  h.dispose();
});
test('plugin rejects relative state root and invalid enabled values',()=>{const p=createPlugin(defineTool);assert.throws(()=>p.apply(context().ctx,{stateRoot:'relative'}));assert.throws(()=>p.apply(context().ctx,{stateRoot:fresh(),enabled:'true'}));});
test('lifetime disposal cancels active tool without aborting parent',async()=>{
  const h=context(),parent=new AbortController();let started;const ready=new Promise(resolve=>started=resolve);
  registerLifetimeTool(h.ctx,{name:'wait',async execute(_args,e){started();await new Promise((_r,reject)=>e.signal.addEventListener('abort',()=>reject(e.signal.reason),{once:true}));}});
  const tool=h.tools.get('wait'),pending=tool.execute({},{agent:{id:'parent'},signal:parent.signal});const rejected=assert.rejects(pending);await ready;h.dispose();await rejected;assert.equal(parent.signal.aborted,false);await assert.rejects(tool.execute({},exec()));
});
test('fresh portable build filters old qualification evidence rather than importing it',async()=>{
  const directory=fresh(),store=createRecordStore(directory,'parent','qualifications');const provider='codex',model='gpt-5.6-terra',effort='medium';const key=keyOf(provider+'\0'+model+'\0'+effort);
  const oldBuild='unrelated-old-build';await store.save(key,{schemaVersion:1,runtimeBuildId:oldBuild,provider,model,effort,adapterFingerprint:createHash('sha256').update(provider+'\0'+model+'\0'+oldBuild).digest('hex')},0);
  const manager=createQualificationManager({root:directory,owner:'parent',getLlm:()=>{throw new Error('no inference');},getSubagents:()=>{throw new Error('no child');}});assert.notEqual(BUILD_ID,oldBuild);assert.deepEqual(await manager.list(),[]);manager.dispose();
});
test('synthetic native qualification binds one echo to the returned child',async()=>{
  const directory=fresh(),h=context();let calls=0;
  const services={llm:{listProviders:()=>[{id:'codex'}],prepareCall:async config=>({config})},subagents:{async start(_backend,request){calls++;assert.equal(request.parent.id,'parent');assert.deepEqual(request.toolFilter,{allow:['orchestrator_qualification_echo']});const token=request.prompt[0].text.match(/token ([a-f0-9-]+)/)[1];const answer=await h.tools.get('orchestrator_qualification_echo').execute({token},exec('synthetic-child'));return {id:'synthetic-child',result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:'QUALIFIED:'+answer.marker+':42'}]}),async dispose(){}};}}};
  h.ctx.get=name=>services[name];createPlugin(defineTool).apply(h.ctx,{stateRoot:directory,enabled:true});const result=await h.tools.get('orchestrator_qualify').execute({route_id:'codex-terra',effort:'medium'},exec());assert.equal(result.qualification.available,true);assert.equal(result.qualification.runtimeBuildId,BUILD_ID);assert.equal(result.cost_unknown,true);assert.equal(calls,1);h.dispose();
});
test('readonly assignment continues but side-effecting work never repeats automatically',async()=>{
  for(const allowed_tools of [['read'],['write']]){let calls=0;const dispatcher=createAgentDispatcher({root:fresh(),owner:'parent',getSubagents:()=>({async start(_name,r){calls++;assert.deepEqual(r.toolFilter.allow,allowed_tools);return {id:'child-'+calls,result:Promise.resolve({stopReason:calls===1?'max-tokens':'completed',output:[{type:'text',text:calls===1?'first ':'second'}]}),async dispose(){}};}})});const a={run_id:'assignment',prompt:'Scoped synthetic task',allowed_tools,max_rounds:2};const result=await dispatcher.delegate(a,{provider:'test',model:'test'},'low',exec());assert.equal(result.state,allowed_tools[0]==='read'?'COMPLETED':'PARTIAL_NEEDS_RECONCILIATION');assert.equal(calls,allowed_tools[0]==='read'?2:1);assert.equal(result.cost_unknown,true);await assert.rejects(dispatcher.delegate(a,{provider:'test',model:'test'},'low',exec()));dispatcher.dispose();}
});
test('diagnostics redact unknown uppercase codes and do not enter disk records',async()=>{
  const directory=fresh(),engine=createTaskEngine({root:directory,owner:'parent',getLlm:()=>({async prepareCall(){throw Object.assign(new Error('private-secret'),{code:'SECRET_API_KEY_123',status:401});}})});
  await engine.plan({task_id:'redaction',prompt:'Synthetic task',route:{provider:'test',model:'test',effort:'low',maxTokens:64,costRates:null}});const result=await engine.run('redaction',exec());assert.equal(result.status,'INTERRUPTED_UNCERTAIN');assert.equal(result.diagnostics[0].code,'UNKNOWN');assert.equal(result.diagnosticPersisted,false);assert.equal(JSON.stringify(result).includes('SECRET_API_KEY'),false);const reopened=createTaskEngine({root:directory,owner:'parent',getLlm:()=>null});assert.deepEqual((await reopened.read('redaction')).diagnostics,[]);
});
