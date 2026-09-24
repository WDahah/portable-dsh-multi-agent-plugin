import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,ownedJson,validateReadRequestM4} from './contracts.mjs';
import {openGovernanceStoreV2,inspectGovernanceM4} from './store.mjs';
import {createGovernanceControllerM4,createGovernanceControllerM4B} from './controller.mjs';
import {inspectBaseline,createWorkspaceV2,workspaceFile,captureDeliveryDestinationM4B,verifyDeliveryDestinationM4B} from './workspace.mjs';
import {inspectGovernanceM4B} from './delivery.mjs';
import {createPinnedRunnerV2} from './runner.mjs';
import {validateGovernanceConfigM4,captureGovernanceStartupM4,createStageHostV2,createHumanCommandsM4,createHumanCommandsM4B,installGovernedPresetM4,enrollGovernedStageM4} from './host.mjs';

const need=(v,code)=>{if(!v)throw Object.assign(new Error(code),{code});};
const exists=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const nodeId=s=>[s.dev,s.ino,s.birthtimeNs].map(String).join(':');
const safeReason=e=>typeof e?.code==='string'&&/^[A-Z0-9_]{1,96}$/.test(e.code)?e.code:'M4_INSPECTION_FAILED';
const defaultRead=()=>({kind:'status',id:null,offset:0,limit:1,cursor:null});

/** Explicit disposable-host owner. This function never upgrades persisted records to live authority. */
export async function startGovernanceM4(ctx,input){return startGovernanceOwner(ctx,input,null);}

/** Delivery selection is a distinct trusted entry, never a field of M4 configuration. */
export async function startGovernanceM4B(ctx,input,deliveryConfig,options={}){
  const config=validateGovernanceConfigM4(input),qualification=prepareQualification(config,deliveryConfig,options);
  return startGovernanceOwner(ctx,config,qualification);
}
function prepareQualification(config,deliveryConfig,options){
  need(options&&typeof options==='object'&&!Array.isArray(options)&&Object.keys(options).every(k=>k==='failpoint'),'M4B_CLOSED_OPTIONS');
  need(options.failpoint===undefined||typeof options.failpoint==='function','M4B_FAILPOINT');
  const supplied=ownedJson(deliveryConfig);
  need(Object.keys(supplied).sort().join(',')==='destinationId,outputRoot,protectedRoots'&&Array.isArray(supplied.protectedRoots),'M4B_CLOSED_DELIVERY');
  const protectedRoots=[...new Set([...supplied.protectedRoots,...Object.values(config.roots),path.dirname(config.toolchain.host.executable),path.dirname(config.toolchain.git.executable),path.dirname(config.plan.executionPolicy.node.executable)])];
  const delivery=ownedJson({...supplied,protectedRoots});
  return Object.freeze({destination:captureDeliveryDestinationM4B(delivery),delivery,failpoint:options.failpoint});
}
async function startGovernanceOwner(ctx,input,qualification){
  const config=validateGovernanceConfigM4(input),roots=config.roots;
  const startup=await captureGovernanceStartupM4(ctx,config);
  if(qualification)verifyDeliveryDestinationM4B(qualification.destination);
  const agents=ctx.get('agents'),presets=ctx.get('agentPresets');
  const storeOptions={root:roots.governance,projectRoot:roots.project,protectedRoots:[roots.workspace,roots.scratch,roots.legacy,roots.config]};
  let receiver,commands,qualificationCommands,host,store,controller,decisionHandler,baseline,opening=false,disposed=false,terminal=false,reason=null,closing,workspaceId=null,openTask=null,drainFailure=null;
  let finishReceiver;const receiverSettled=new Promise(resolve=>{finishReceiver=resolve;});
  const activeStages=new Set();
  const existing=!!exists(roots.governance);
  if(existing)reason='RECONCILIATION_REQUIRED';
  function assertOwner(agent){
    startup.assert(agent??receiver?.agent);
    if(qualification)verifyDeliveryDestinationM4B(qualification.destination);
    for(const stage of activeStages)if(stage!==agent)startup.assert(stage);
    if(receiver)need(agents.get(receiver.agent.id)===receiver.agent,'M4_RECEIVER_LOST');
    if(workspaceId!==null){const s=fs.lstatSync(roots.workspace,{bigint:true});need(s.isDirectory()&&!s.isSymbolicLink()&&nodeId(s)===workspaceId,'M4_WORKSPACE_ROOT_CHANGED');}
    return true;
  }
  function assert(agent){need(!disposed&&!terminal,'M4_OWNER_STOPPED');return assertOwner(agent);}
  function block(error){terminal=true;reason=safeReason(error);return error;}
  const authorization=agent=>{try{return assertOwner(agent);}catch(e){block(e);throw e;}};
  const humanPort=Object.freeze({bind(fn){need(!decisionHandler&&typeof fn==='function','M4_HUMAN_BIND');decisionHandler=fn;return()=>{decisionHandler=null;};}});
  async function diagnostics(request=defaultRead()){
    request=validateReadRequestM4(request);
    if(controller&&!terminal&&!disposed)return controller.read(request);
    if(exists(roots.governance)){
      try{return qualification?await inspectGovernanceM4B(storeOptions,qualification.delivery,request):await inspectGovernanceM4(storeOptions,request);}
      catch(error){return ownedJson({schemaVersion:1,origin:'cold-diagnostic',headAuthenticity:'unproven',gateActive:false,reason:safeReason(error),locationId:digest(roots.governance.toLowerCase())});}
    }
    need(request.kind==='status'&&request.offset===0&&request.id===null&&request.cursor===null,'M4_STATE_ABSENT');
    return ownedJson({schemaVersion:1,origin:'cold-diagnostic',headAuthenticity:'unproven',headDigest:null,revision:0,gateActive:false,status:{phase:'EMPTY',admission:false,attemptsUsed:null,attemptsRemaining:null,planDigest:digest(config.plan),candidateDigest:null,refusalReason:reason??(config.mode==='diagnostic'?'DIAGNOSTIC_ONLY':'NOT_OPENED')}});
  }
  async function status(){
    if(controller&&!terminal&&!disposed){try{return await controller.status();}catch(error){block(error);}}
    return diagnostics();
  }
  function open(projectId,planDigest){
    need(!openTask,'M4_OPEN_IN_FLIGHT');const task=performOpen(projectId,planDigest);openTask=task;
    task.then(()=>{if(openTask===task)openTask=null;},()=>{if(openTask===task)openTask=null;});return task;
  }
  async function performOpen(projectId,planDigest){
    assert();need(config.mode==='same-owner'&&!existing&&!controller&&!opening&&!exists(roots.governance)&&!exists(roots.workspace),'M4_OPEN_REFUSED');
    need(projectId===config.plan.projectId&&planDigest===digest(config.plan),'M4_CONFIGURED_JOB_ONLY');opening=true;
    try{
      baseline=await inspectBaseline({sourceRoot:roots.project,scratchRoot:roots.scratch,protectedRoots:[roots.workspace,roots.governance,roots.legacy,roots.config],git:{...config.toolchain.git,systemRoot:config.plan.executionPolicy.node.systemRoot}});assert();
      need(baseline.baselineDigest===config.plan.baseline,'M4_BASELINE_CHANGED');
      store=await openGovernanceStoreV2(storeOptions);assert();store.assertOwner();
      host=createStageHostV2(ctx,{root:roots.project,authorize:authorization,setup:async(c,agent)=>{
        assert();await presets.mount(c,config.presetId);assert(agent);activeStages.add(agent);c.effect(()=>()=>activeStages.delete(agent));enrollGovernedStageM4(c,agent,()=>authorization(agent));
      }});
      controller=await (qualification?createGovernanceControllerM4B:createGovernanceControllerM4)({store,host,humanPort,authorizeOwner:authorization,
        ...(qualification?{delivery:qualification.destination,...(qualification.failpoint?{failpoint:qualification.failpoint}:{})}:{}),
        workspaceFactory({plan,authority}){
          assert();need(digest(plan)===digest(config.plan),'M4_CONFIGURED_PLAN_ONLY');
          if(workspaceId===null){need(!exists(roots.workspace),'M4_WORKSPACE_EXISTS');fs.mkdirSync(roots.workspace);workspaceId=nodeId(fs.lstatSync(roots.workspace,{bigint:true}));}assert();
          const owner=createWorkspaceV2({sourceRoot:roots.project,workspaceRoot:path.join(roots.workspace,'attempt-'+randomUUID()),scratchRoot:roots.scratch,governanceRoot:roots.governance,legacyRoot:roots.legacy,configRoot:roots.config,protectedRoots:[],protectedFiles:plan.protectedTests,git:{...config.toolchain.git,systemRoot:plan.executionPolicy.node.systemRoot},baseline,authority});
          return Object.freeze({...owner,file:workspaceFile});
        },
        runnerFactory(options){
          assert();const id=randomUUID();return createPinnedRunnerV2({...options,sandbox:ctx.get('sandbox'),subprocess:ctx.get('subprocess'),replicaRoot:path.join(roots.workspace,'replica-'+id),scratchRoot:path.join(roots.workspace,'run-'+id)});
        }});
      assert();await controller.propose(config.plan);assert();return controller.status();
    }catch(error){block(error);try{await controller?.close();await host?.close();await store?.close();}catch(cleanup){drainFailure=new AggregateError([error,cleanup],'M4_OPEN_CLEANUP_FAILED');throw drainFailure;}throw error;}
    finally{opening=false;}
  }
  const current=()=>{assert();need(config.mode==='same-owner'&&controller&&!existing,'M4_STAGE_INACTIVE');return controller;};
  async function stop(){
    terminal=true;reason='STOPPED';const stopping=controller?.stop();await Promise.allSettled([openTask,stopping].filter(Boolean));
    if(stopping)await stopping;if(drainFailure)throw drainFailure;return diagnostics();
  }
  function close(){if(closing)return closing;disposed=true;terminal=true;reason='OWNER_CLOSED';qualificationCommands?.close();commands?.close();
    const cancelled=controller?.close();closing=(async()=>{
      const errors=[];if(cancelled)try{await cancelled;}catch(e){errors.push(e);}
      await receiverSettled;await Promise.allSettled([openTask].filter(Boolean));
      for(const fn of [()=>controller?.close(),()=>host?.close(),()=>store?.close(),()=>receiver?.dispose()])try{await fn();}catch(e){errors.push(e);}
      if(drainFailure)errors.push(drainFailure);if(errors.length)throw new AggregateError(errors,'M4_OWNER_CLOSE_FAILED');
    })();return closing;
  }
  ctx.effect(()=>close);
  try{
    need(agents.get(config.receiverId)===undefined,'M4_RECEIVER_EXISTS');
    receiver=await agents.create({sessionId:config.receiverId,meta:{cwd:roots.project,agentPreset:config.presetId},agentOptions:{provider:config.plan.executionPolicy.routes['plan-review'].provider,model:config.plan.executionPolicy.routes['plan-review'].model,reasoningEffort:config.plan.executionPolicy.routes['plan-review'].effort},setup:async(c,agent)=>{
      need(!disposed,'M4_OWNER_STOPPED');startup.assert();await presets.mount(c,config.presetId);need(!disposed,'M4_OWNER_STOPPED');startup.assert(agent);c.get('tools').guard(()=> 'M4_HUMAN_RECEIVER_READ_ONLY');return{commit(){need(!disposed,'M4_OWNER_STOPPED');startup.assert(agent);}};
    }});
    finishReceiver();assert();
    ctx.on('agent-preset/selected',sessionId=>{if(sessionId===receiver.agent.id){terminal=true;reason='M4_PRESET_CHANGED';controller?.stop().catch(()=>{});}});
    commands=createHumanCommandsM4(ctx,{receiverAgent:receiver.agent,handlers:{status,read:diagnostics,open,
      async stage(stage){const owner=current();const names={'plan-review':'reviewPlan',author:'requestAuthor',seal:'seal',validate:'validate',review:'review'};return owner[names[stage]]();},
      async authorize(decision){current();need(typeof decisionHandler==='function','M4_HUMAN_BIND');await decisionHandler(decision);return controller.status();},
      pause:()=>current().pause(),resume:request=>current().resume(request),stop,
      async reassess(head){if(controller&&!terminal)return controller.reassess(head);const result=await status();need(head===result.headDigest,'STALE_CURSOR');return ownedJson({...result,reassessment:{mayChangePlan:false,mayResetBudget:false,mayResume:false}});},
    }});
    if(qualification)qualificationCommands=createHumanCommandsM4B(ctx,{receiverAgent:receiver.agent,handlers:{accept:request=>current().accept(request),qualify:request=>current().qualify(request),export:request=>current().export(request),stop}});
    return Object.freeze({status,close});
  }catch(error){finishReceiver();try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'M4_STARTUP_CLOSE_FAILED');}throw error;}
}

/** One entry supports a host row and a service-free preset row; importing it starts nothing. */
export function createGovernancePluginM4(defineTool){
  need(typeof defineTool==='function','M4_NATIVE_TOOL_FACTORY_REQUIRED');
  return {name:'portable-governance-m4',inject:['tools'],async apply(ctx,config={}){
    if(config?.role==='preset'){need(Object.keys(config).length===1,'M4_CLOSED_SHAPE');installGovernedPresetM4(ctx);return;}
    await startGovernanceM4(ctx,config);
  }};
}

/** Explicit disposable qualification factory; the default factory accepts no delivery selector. */
export function createGovernanceQualificationPluginM4B(defineTool,deliveryConfig,options={}){
  need(typeof defineTool==='function','M4_NATIVE_TOOL_FACTORY_REQUIRED');
  const delivery=ownedJson(deliveryConfig);
  need(Object.keys(delivery).sort().join(',')==='destinationId,outputRoot,protectedRoots','M4B_CLOSED_DELIVERY');
  need(options&&typeof options==='object'&&!Array.isArray(options)&&Object.keys(options).every(k=>k==='failpoint'),'M4B_CLOSED_OPTIONS');
  const failpoint=options.failpoint;need(failpoint===undefined||typeof failpoint==='function','M4B_FAILPOINT');
  return {name:'portable-governance-m4b-qualification',inject:['tools'],async apply(ctx,config={}){
    if(config?.role==='preset'){need(Object.keys(config).length===1,'M4_CLOSED_SHAPE');installGovernedPresetM4(ctx);return;}
    await startGovernanceM4B(ctx,config,delivery,failpoint?{failpoint}:{});
  }};
}
