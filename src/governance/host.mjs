import {randomUUID,createHash} from 'node:crypto';
import fsM4 from 'node:fs';
import pathM4 from 'node:path';
import {fileURLToPath as fileURLToPathM4} from 'node:url';
import {createProbePolicy,createStagePolicyV2} from './policy.mjs';
import {ownedJson,validatePlanV2,validateBindingV2,validateSubmission,same,digest} from './contracts.mjs';

/** All required probes remain explicit; an absent receipt is never a pass. */
export const REQUIRED_M0 = Object.freeze([
  'host.setup-before-publication', 'host.setup-rollback', 'host.definition-identity',
  'host.native-guard', 'host.unguarded-control', 'host.scoped-shadow', 'host.unknown-tool', 'host.body-revocation',
  'host.ptc-guard', 'host.preset-roster', 'host.unload-fail-closed', 'host.owner-disposal',
  'host.disabled-composition', 'host.failing-composition', 'host.unsafe-mounts-before', 'host.unsafe-mounts-after',
  'host.human-command-service', 'host.human-command-web', 'host.no-paid-route',
  'runner.tap', 'runner.write-boundary', 'runner.environment', 'runner.unknown-option',
  'runner.partial-tap', 'runner.confinement-failure', 'runner.acl-grants', 'runner.hardlink-limit',
  'runner.cancellation', 'runner.descendant-settlement',
]);
export function assessM0(receipts) {
  if (!Array.isArray(receipts)) throw new TypeError('M0 receipts must be an array');
  const checks = REQUIRED_M0.map(id => {
    const matches = receipts.filter(r => r?.id === id);
    return matches.length === 1 && ['PASS','FAIL','NOT_PROBED'].includes(matches[0].state)
      ? {id, state: matches[0].state, detail: String(matches[0].detail ?? '')}
      : {id, state: matches.length ? 'FAIL' : 'NOT_PROBED', detail: matches.length ? 'Duplicate or invalid receipt.' : 'No execution evidence.'};
  });
  return {decision: checks.every(c => c.state === 'PASS') ? 'CAPABILITY_PASS_REQUIRES_REVIEW' : 'NO_GO', checks};
}

function definition(name, body) {
  return {name, description: 'Disposable M0 sentinel; no product mutation.',
    parameters: {type: 'object', additionalProperties: false, properties: {}},
    output: {schema: {type:'object',additionalProperties:false,properties:{count:{type:'integer'}},required:['count']},
      render: (_args, value) => [{type:'text', text: `sentinel count ${value.count}`}]}, execute: body};
}

/** Trusted probe fiber only. Uses the real factory/registry, never synthetic Agent identities. */
export async function runHostProbes(ctx, {root, signal}) {
  const checks = [], handles = [], disposers = [];
  const record = (id, pass, detail) => checks.push({id, state:pass?'PASS':'FAIL', detail});
  let count = 0, scope, lease;
  const policy = createProbePolicy({resolveDefinition:(name,agent)=>ctx.tools.get(name,agent)});
  const def = definition('m0_owned', async (_args,exec) => {policy.assert(exec,def,lease);return {count:++count};});
  const raw = definition('m0_raw_sentinel', async () => ({count:++count}));
  const call = (agent,name,args={}) => ctx.tools.execute({agent,name,arguments:args,callId:randomUUID(),signal});
  let handle;
  try {
    let parentScope;
    const parent=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:root},setup(c){parentScope=c;}});handles.push(parent);
    const sid = randomUUID();let before = false, publishedSetup = false;
    disposers.push(ctx.tools.register(raw));
    // parentAgent records lineage; this handle stays probe-fiber-owned and is explicitly disposed.
    handle = await ctx.agents.create({sessionId:sid,parentAgent:parent.agent,meta:{cwd:root,origin:'subagent'},setup:async (agentCtx,agent)=>{
      scope = agentCtx;before = ctx.agents.get(sid) === undefined;
      agentCtx.get('tools').register(def);
      lease=policy.enroll(agent,{role:'probe-author',definitions:[def]});
      agentCtx.get('tools').guard(exec=>policy.guard(exec));
      return {commit(){publishedSetup=before && ctx.agents.get(sid)===undefined;}};
    }});handles.push(handle);
    const agent=handle.agent;
    record('host.setup-before-publication', publishedSetup && ctx.agents.get(sid)===agent && agent.session.header.cwd===root,
      'Unpublished setup and synchronous commit observed; exact cwd checked.');
    record('host.definition-identity',ctx.tools.get(def.name,agent)===def,'Exact registered object survives effective lookup.');
    const allowed=await call(agent,def.name);
    const allowedCount=count;
    const denied=await call(agent,raw.name,{role:'controller',approved:true});
    record('host.native-guard',!allowed.isError && denied.isError && denied.content.some(b=>b.type==='text'&&b.text.includes('PROBE_UNKNOWN_TOOL')) && allowedCount===1 && count===1,
      'Allowed body executed; registered but ungranted raw sentinel did not; caller role spoof ignored.');
    const missing=await call(agent,'m0_unknown');
    record('host.unknown-tool',missing.isError && count===1,'Unknown name denied through real execute pipeline.');
    const withoutGuard=await call(parent.agent,raw.name);
    record('host.unguarded-control',!withoutGuard.isError && count===2,'The same raw sentinel really executes on an unguarded actor; protected denial is not a missing/invalid body.');
    // A genuine child-scope shadow over an allowed global definition.
    const shadowPolicy=createProbePolicy({resolveDefinition:(name,a)=>ctx.tools.get(name,a)});let shadowLease;
    const globalDef=definition('m0_shadow_target',async(_args,exec)=>{shadowPolicy.assert(exec,globalDef,shadowLease);return {count:++count};});
    disposers.push(ctx.tools.register(globalDef));let shadowCtx;
    const shadowAgent=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:root},setup(c,a){
      shadowCtx=c;shadowLease=shadowPolicy.enroll(a,{role:'probe-author',definitions:[globalDef]});c.get('tools').guard(e=>shadowPolicy.guard(e));
    }});handles.push(shadowAgent);
    const beforeShadow=count;const globalCall=await call(shadowAgent.agent,globalDef.name);
    const shadow=definition(globalDef.name,async()=>({count:++count}));
    const shadowDispose=shadowCtx.get('tools').register(shadow);
    try {
      const result=await call(shadowAgent.agent,globalDef.name);
      record('host.scoped-shadow',!globalCall.isError && ctx.tools.get(globalDef.name,shadowAgent.agent)===shadow &&
        result.isError && count===beforeShadow+1,'Allowed global ran; real child-scoped foreign shadow was selected then denied.');
    }finally{shadowDispose();shadowPolicy.dispose();}
    const baseline=count;
    const ptc=await call(agent,'run_code',{code:'return await tools.m0_raw_sentinel({})',description:'Forbidden M0 raw-code probe'});
    record('host.ptc-guard',ptc.isError && count===baseline,'Required native-only profile rejects the PTC entry point; no SDK/body execution is allowed or claimed.');
    const badId=randomUUID();let failed=false,failedAgent;
    try {await ctx.agents.create({sessionId:badId,meta:{cwd:root},setup(c,a){failedAgent=a;c.get('tools').register(definition('m0_failed_setup',async()=>({count:++count})));throw new Error('M0 deliberate setup rollback');}});}
    catch(error){failed=error.message.includes('M0 deliberate setup rollback');}
    record('host.setup-rollback',failed && ctx.agents.get(badId)===undefined && failedAgent && ctx.tools.get('m0_failed_setup',failedAgent)===undefined,'Failing setup rolls back the registration as seen from the exact unpublished failed scope.');
    // Body-side check across an owned await: revoke only after the body reports admission.
    let enteredResolve,releaseResolve;const entered=new Promise(r=>enteredResolve=r),release=new Promise(r=>releaseResolve=r);
    const secondPolicy=createProbePolicy({resolveDefinition:(name,a)=>ctx.tools.get(name,a)});let secondLease;
    const delayed=definition('m0_delayed',async(_args,exec)=>{
      const admission=secondPolicy.bind(exec,delayed,secondLease);enteredResolve();await release;
      secondPolicy.check(admission,exec,delayed);return {count:++count};
    });
    const second=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:root},setup(c,a){
      c.get('tools').register(delayed);secondLease=secondPolicy.enroll(a,{role:'probe-author',definitions:[delayed]});
      c.get('tools').guard(exec=>secondPolicy.guard(exec));
    }});handles.push(second);
    const pending=call(second.agent,delayed.name);
    await Promise.race([entered,pending.then(()=>{throw new Error('Delayed sentinel failed before admission');})]);
    secondPolicy.revoke();releaseResolve();const late=await pending;
    record('host.body-revocation',late.isError && count===baseline,'Revoke between admission and mutation; real body remains untouched.');
    secondPolicy.dispose();
    let commands=0;
    disposers.push(ctx.commands.register({name:'m0-authority',description:'M0 authority probe only.',handler:inv=>{
      if(inv.agent!==agent||inv.rawInput.trim()!=='probe')return {kind:'error',text:'M0 identity/input rejected'};
      commands++;return {kind:'success',text:'M0 direct command observed; no grant created'};
    }}));
    const command=await ctx.commands.execute(agent,'/m0-authority probe',[],signal);
    record('host.human-command-service',commands===1 && command!==undefined,'Direct command service works; this is NOT browser provenance evidence.');
    const fakeCommand=await call(agent,'commands_execute',{line:'/m0-authority probe'});
    record('host.no-paid-route',ctx.llm.listProviders().length === 0 && fakeCommand.isError && commands===1,
      'Provider registry empty; no model invocation performed. An unknown command-shaped tool name did not invoke the human handler.');
    if(ctx.get('connection') && ctx.get('webServer')) {
      const connection=ctx.get('connection'), web=ctx.get('webServer');
      const base=`http://127.0.0.1:${web.port}`;
      const removeIndex=web.register({kind:'exact',path:'/',handler(req,res){if(connection.authorizeIndex(req,res)){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>M0 transport probe</title>Disposable M0 transport fixture');}}});
      try {
        const envelope={type:'client-request',rpcId:'m0-authority',method:'commands/execute',payload:{args:{agentId:sid,line:'/m0-authority probe',submittedAttachments:[]}}};
        const post=async(headers)=>{const r=await fetch(base+'/api/commands/execute',{method:'POST',headers:{'content-type':'application/json',origin:base,...headers},body:JSON.stringify(envelope),signal});return {status:r.status,body:await r.text()};};
        const anonymous=await post({});
        const index=await fetch(connection.authenticatedUrl(base+'/'),{redirect:'manual',signal});await index.arrayBuffer();
        const cookies=index.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
        const authorized=await post({cookie:cookies});
        const forged=await post({cookie:cookies,origin:'https://invalid.example'});
        record('host.human-command-web',anonymous.status===401 && authorized.status===200 && commands===2 && forged.status===403,
          `Real Connection/Typert HTTP: anonymous=${anonymous.status}, authenticated=${authorized.status}, foreign-origin=${forged.status}. Automated transport fixture, not stock SPA or actual human approval. Response: ${authorized.body.slice(0,1200)}`);
      }finally{removeIndex();}
    }
    async function unsafeMounts(){let refused=0;
      for(const id of ['standard','cordis','minimal']){
        const bad= randomUUID();let captured;
        try{const unexpected=await ctx.agents.create({sessionId:bad,meta:{cwd:root},setup:async(c,a)=>{captured=a;await ctx.agentPresets.mount(c,id);}});handles.push(unexpected);}
        catch{if(ctx.agents.get(bad)===undefined && captured && ctx.tools.get('write',captured)===undefined && ctx.tools.get('pwsh',captured)===undefined)refused++;}
      }return refused;
    }
    const roster=await ctx.agentPresets.list();const refused=await unsafeMounts();
    record('host.unsafe-mounts-before',refused===3,'Actual unsafe preset mounts rejected during unpublished setup; no raw write/pwsh surface in captured failed agents.');
    const presetAgent=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:root,agentPreset:'governed'},setup:async c=>{await ctx.agentPresets.mount(c,'governed');}});handles.push(presetAgent);
    record('host.preset-roster',roster.length===1 && roster[0].id==='governed' && refused===3,'Dedicated roster and real standing preset mount; unsafe IDs refused.');
    // Remove deliberately hostile probe globals before testing the actual empty base profile.
    for(const dispose of disposers.splice(0).reverse())dispose();
    const afterRemoval=await call(presetAgent.agent,'write',{file_path:'sentinel',content:'forbidden'});
    const shellAfter=await call(presetAgent.agent,'pwsh',{command:'forbidden'});
    let policyOwner,ownerLease;
    const ownerPolicy=createProbePolicy({resolveDefinition:(name,a)=>ctx.tools.get(name,a)});
    const ownedTool=definition('m0_lifetime',async(_args,exec)=>{ownerPolicy.assert(exec,ownedTool,ownerLease);return {count:++count};});
    const survivor=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:root,agentPreset:'governed'},setup:async c=>{
      await ctx.agentPresets.mount(c,'governed');
      policyOwner=await c.plugin({name:'m0-controller-lifetime-fixture',inject:['tools'],apply(pc){
        pc.effect(()=>()=>ownerPolicy.dispose());pc.tools.register(ownedTool);pc.tools.guard(exec=>ownerPolicy.guard(exec));
      }});
    }});handles.push(survivor);
    ownerLease=ownerPolicy.enroll(survivor.agent,{role:'probe-author',definitions:[ownedTool]});
    const liveOwner=await call(survivor.agent,ownedTool.name);const beforeUnload=count;
    await policyOwner.dispose();
    const unloaded=await call(survivor.agent,ownedTool.name);
    const unloadedShell=await call(survivor.agent,'pwsh',{command:'forbidden'});
    const afterRefused=await unsafeMounts();
    record('host.unsafe-mounts-after',afterRefused===3,'Actual unsafe preset mounts still rejected after controller fixture unload.');
    record('host.unload-fail-closed',afterRemoval.isError && shellAfter.isError && !liveOwner.isError &&
      unloaded.isError && unloadedShell.isError && count===beforeUnload && afterRefused===3 &&
      ctx.tools.get(ownedTool.name,survivor.agent)===undefined && ctx.tools.get('write',presetAgent.agent)===undefined,
      'Absent-controller base has no write/shell; loaded owner works; awaited owner unload removes its tools without fallback. Actual disabled/failing preset rows are separate receipts. This is a minimal lifetime fixture, not a production controller.');
    policy.revokeActor(agent);
    await handle.dispose();handles.splice(handles.indexOf(handle),1);
    const ownerChild=await parentScope.get('agents').create({sessionId:randomUUID(),parentAgent:parent.agent,meta:{cwd:root,origin:'subagent'}});handles.push(ownerChild);
    await parent.dispose();handles.splice(handles.indexOf(parent),1);
    record('host.owner-disposal',ctx.agents.get(sid)===undefined && ctx.agents.get(ownerChild.agent.id)===undefined,
      'Exact handle disposal and parent-owned child disposal both settled; registry identities removed. Process lifetime is tested separately.');
  } finally {
    policy.dispose();for(const handle of handles.reverse())await handle.dispose();
    for(const dispose of disposers.reverse())dispose();
  }
  return {kind:'m0-real-host-probes',checks,sideEffectSentinel:count,
    unprobed:REQUIRED_M0.filter(id=>id.startsWith('host.')&&!checks.some(c=>c.id===id)),decision:'NO_GO'};
}

const hostNeed=(value,code)=>{if(!value)throw Object.assign(new Error(code),{code});};
const hostToken=()=>Object.freeze(Object.create(null));
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});promise.catch(()=>{});return{promise,resolve,reject};};
const requestSchema={type:'object',properties:{request:{type:'object'}},required:['request'],additionalProperties:false};
const submissionSchema={type:'object',additionalProperties:false,required:['criteria','findings','evidenceIds'],properties:{
  criteria:{type:'array',maxItems:128,items:{type:'object',additionalProperties:false,required:['id','outcome'],properties:{id:{type:'string'},outcome:{enum:['pass','fail','unknown','skip']}}}},
  findings:{type:'array',maxItems:256,items:{type:'object',additionalProperties:false,required:['id','criterionId','detail','severity','status'],properties:{id:{type:'string'},criterionId:{type:'string'},detail:{type:'string'},severity:{enum:['blocker','note']},status:{enum:['open','resolved']}}}},
  evidenceIds:{type:'array',maxItems:1024,items:{type:'string'}},
}};

/** Owner-only adapter: tickets, live actors, submissions and lifecycle observations never cross model transport. */
export function createStageHostV2(ctx,{root,signal,authorize,setup:extraSetup}={}) {
  const agents=ctx.get('agents'),tools=ctx.get('tools'),llm=ctx.get('llm');
  hostNeed(agents&&tools&&llm&&typeof root==='string','V2_HOST_PREREQUISITES');
  hostNeed(process.platform==='win32'&&process.arch==='x64'&&process.versions.node==='26.9.0','V2_UNSUPPORTED_HOST');
  const tickets=new WeakMap(),runs=new WeakMap(),active=new Set();let stopped=false,drainFailure=null;
  hostNeed((authorize===undefined||typeof authorize==='function')&&(extraSetup===undefined||typeof extraSetup==='function'),'V2_HOST_OPTIONS');
  const authorized=agent=>{if(authorize){const value=authorize(agent);if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});hostNeed(false,'V2_ASYNC_AUTHORITY');}hostNeed(value===true,'V2_HOST_AUTHORITY');}};
  const live=()=>{hostNeed(!stopped&&!signal?.aborted,'V2_HOST_STOPPED');authorized();};
  function prepareStage(input){
    live();const spec=ownedJson(input);hostNeed(Object.keys(spec).sort().join(',')==='binding,id,plan,role,route','V2_STAGE_SHAPE');
    validatePlanV2(spec.plan);validateBindingV2(spec.binding);
    hostNeed(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(spec.id)&&['author','plan-review','validator','reviewer'].includes(spec.role),'V2_STAGE_ID');
    hostNeed(same(spec.route,spec.plan.executionPolicy.routes[spec.role]),'V2_ROUTE_CHANGED');
    hostNeed(llm.listProviders().some(p=>p.id===spec.route.provider),'V2_ROUTE_UNAVAILABLE');
    const retry=llm.providerRetryPolicy(spec.route.provider);hostNeed(retry.mode==='normal'&&retry.maxRetries===0,'V2_RETRY_UNSUPPORTED');
    const ticket=hostToken();tickets.set(ticket,{spec,used:false});return ticket;
  }
  async function start(ticket,{onActor}={}){
    live();const entry=tickets.get(ticket);hostNeed(entry&&!entry.used&&typeof onActor==='function','V2_STAGE_TICKET');entry.used=true;
    const {spec}=entry,run=hostToken(),execution=deferred(),disposed=deferred(),setupDone=deferred();
    const r={spec,execution,disposed,setupDone,actor:null,handle:null,policy:null,lease:null,submission:null,reason:null,requests:0,started:false,cancelled:false,task:null};
    active.add(r);runs.set(run,r);
    const check=()=>{live();hostNeed(!r.cancelled,'V2_STAGE_CANCELLED');if(r.handle)authorized(r.handle.agent);};
    const policy=createStagePolicyV2({resolveDefinition:(name,a)=>tools.get(name,a),isLive:a=>agents.get(a.id)===a,authorize:a=>{authorized(a);return !stopped&&!signal?.aborted&&!r.cancelled&&r.handle?.agent===a;}});r.policy=policy;
    try{
      const resolved=await llm.resolveCallConfig({provider:spec.route.provider,model:spec.route.model,reasoningEffort:spec.route.effort},signal);check();
      hostNeed(resolved.provider===spec.route.provider&&resolved.model===spec.route.model&&resolved.reasoningEffort===spec.route.effort,'V2_ROUTE_CHANGED');
      r.handle=await agents.create({sessionId:spec.id,meta:{cwd:root},agentOptions:{provider:spec.route.provider,model:spec.route.model,reasoningEffort:spec.route.effort},signal,
        setup:async(c,agent)=>{
          check();hostNeed(agents.get(spec.id)===undefined&&agent.id===spec.id,'V2_PREPUBLICATION_REQUIRED');
          if(extraSetup)await extraSetup(c,agent);check();authorized(agent);
          const options=agent.options;hostNeed(options.provider===spec.route.provider&&options.model===spec.route.model&&options.reasoningEffort===spec.route.effort,'V2_ROUTE_CHANGED');
          r.actor=ownedJson({id:agent.id,provider:options.provider,model:options.model,effort:options.reasoningEffort});
          const handlers=await onActor({actor:r.actor,execution:execution.promise,disposed:disposed.promise});check();
          hostNeed(handlers&&typeof handlers==='object','V2_STAGE_HANDLERS');
          const defs=[];
          function add(name,parameters,body){
            const def={name,description:'Required governance stage operation; authority is owned by the host.',parameters,
              output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
              async execute(args,exec){policy.assert(exec,def,r.lease);const value=await body(args);policy.assert(exec,def,r.lease);return ownedJson(value);}};
            defs.push(def);c.get('tools').register(def);
          }
          add('m3_plan',{type:'object',properties:{},additionalProperties:false},args=>{hostNeed(args&&Object.keys(args).length===0,'V2_TOOL_INPUT');return{plan:spec.plan,binding:spec.binding};});
          for(const name of ['read','file','evidence'])if(typeof handlers[name]==='function')add('m3_'+name,requestSchema,args=>{
            hostNeed(args&&Object.keys(args).length===1&&Object.hasOwn(args,'request'),'V2_TOOL_INPUT');return handlers[name](ownedJson(args.request));
          });
          if(typeof handlers.run==='function')add('m3_run',{type:'object',additionalProperties:false,required:['commandId'],properties:{commandId:{type:'string'}}},args=>{
            hostNeed(args&&Object.keys(args).length===1&&typeof args.commandId==='string','V2_TOOL_INPUT');return handlers.run(args.commandId);
          });
          if(spec.role!=='author')add('m3_submit',submissionSchema,args=>{hostNeed(r.submission===null,'V2_DUPLICATE_SUBMISSION');r.submission=validateSubmission(args);return{recorded:true};});
          hostNeed(defs.length>0,'V2_EMPTY_STAGE');r.lease=policy.enroll(agent,{role:spec.role,definitions:defs,route:spec.route});c.get('tools').guard(e=>policy.guard(e));
          c.on('agent/request',async(payload,next)=>{check();hostNeed(payload.agent===agent&&payload.turn===1&&payload.step<=64,'V2_STAGE_BOUNDARY');const config=await next();check();
            hostNeed(config.provider===spec.route.provider&&config.model===spec.route.model&&config.reasoningEffort===spec.route.effort,'V2_ROUTE_CHANGED');return config;});
          c.on('session/event',(session,event)=>{
            if(session!==agent.session||!r.started)return;
            if(event.type==='turn/end'){r.reason=event.data.reason.kind;return;}
            if(event.type==='request/context'&&(event.data.provider!==spec.route.provider||event.data.model!==spec.route.model)){r.reason='error';r.cancelled=true;agent.cancel({kind:'hook',reason:'V2_ROUTE_CHANGED'});}
          });
          c.effect(()=>()=>{policy.revoke();});
          return{commit(){check();authorized(agent);hostNeed(agents.get(spec.id)===undefined,'V2_PREPUBLICATION_REQUIRED');}};
        }});
      check();const agent=r.handle.agent;r.started=true;
      agent.send({id:randomUUID(),role:'user',source:{kind:'plugin',plugin:'governance-v2',form:'instructions'},content:[{type:'text',text:`Complete only your assigned ${spec.role} stage. Use only the provided governance tools. Read the exact plan and scoped evidence before acting. Never delegate or claim authority. ${spec.role==='author'?'Make only the authorized scoped changes, then finish.':'Submit exactly one structured judgment with m3_submit, then finish.'}`} ]},'next-turn',true);
      r.task=(async()=>{
        try{await agent.whenIdle();hostNeed(r.reason!==null,'V2_MISSING_TURN_END');}
        catch{r.reason='error';}
        finally{
          policy.revoke();const reason=r.cancelled?'cancelled':r.reason==='completed'?'completed':r.reason==='error'?'error':'inconclusive';
          execution.resolve(reason);
          try{await r.handle.dispose();disposed.resolve();}catch(error){r.reason='error';drainFailure??=error;disposed.reject(error);}
          active.delete(r);
        }
        return ownedJson({actor:r.actor,stopReason:r.cancelled?'cancelled':r.reason==='completed'?'completed':r.reason==='error'?'error':'inconclusive',submission:r.submission});
      })();setupDone.resolve();return run;
    }catch(error){policy.revoke();execution.resolve('error');try{await r.handle?.dispose();disposed.resolve();}catch(disposalError){drainFailure??=disposalError;disposed.reject(disposalError);}finally{active.delete(r);setupDone.resolve();}throw error;}
  }
  const removeStream=ctx.on('llm/stream',async function*(options,next){
    const r=[...active].find(v=>v.spec.id===options.sessionId);if(!r){yield*next();return;}
    checkStream();r.requests++;
    hostNeed(r.requests<=64,'V2_REQUEST_LIMIT');
    let finish=null;
    for await(const chunk of next()){checkStream();hostNeed(finish===null,'V2_CHUNKS_AFTER_FINISH');if(chunk.type==='finish')finish=chunk.reason.kind;yield chunk;}
    hostNeed(finish!==null,'V2_INCOMPLETE_MODEL_STREAM');
    function checkStream(){live();if(r.handle)authorized(r.handle.agent);hostNeed(!r.cancelled&&options.provider===r.spec.route.provider&&options.model===r.spec.route.model&&options.reasoningEffort===r.spec.route.effort,'V2_ROUTE_CHANGED');}
  });
  async function cancel(run){const r=runs.get(run);hostNeed(r,'V2_UNKNOWN_RUN');r.cancelled=true;r.policy?.revoke();r.handle?.agent.cancel({kind:'parent'});await r.task;}
  let closeTask;
  function close(){if(closeTask)return closeTask;stopped=true;const owned=[...active];for(const r of owned){r.cancelled=true;r.policy?.revoke();r.handle?.agent.cancel({kind:'disposed'});}closeTask=(async()=>{await Promise.all(owned.map(r=>r.setupDone.promise));await Promise.all(owned.map(r=>r.task));removeStream();if(drainFailure)throw drainFailure;})();return closeTask;}
  ctx.effect(()=>()=>close());
  const abort=()=>{close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});ctx.effect(()=>()=>signal?.removeEventListener('abort',abort));
  return Object.freeze({prepareStage,start,async observe(run){const r=runs.get(run);hostNeed(r&&r.task,'V2_UNKNOWN_RUN');return r.task;},cancel,close});
}

/** Captured human-command port; no model-facing method can bind or invoke its authority handler. */
export function createHumanDecisionPortV2(ctx,{receiverAgent,commandName='m3-authorize'}){
  const commands=ctx.get('commands'),agents=ctx.get('agents');hostNeed(commands&&agents&&receiverAgent,'V2_HUMAN_PORT_PREREQUISITES');
  hostNeed(/^m3-[a-z-]+$/.test(commandName),'V2_COMMAND_NAME');let handler=null,closed=false;
  const definition={name:commandName,description:'Authorize the exact independently reviewed governance plan.',async handler(inv){
    hostNeed(!closed&&handler&&inv.agent===receiverAgent&&agents.get(receiverAgent.id)===receiverAgent,'V2_HUMAN_RECEIVER');
    hostNeed(agents.currentInitiator()===undefined&&commands.find(receiverAgent,commandName)===registered,'V2_HUMAN_ORIGIN');
    const match=/^([a-f0-9]{64}) ([A-Za-z0-9][A-Za-z0-9_.:-]{0,127}) (authorize|reject)$/.exec(inv.rawInput.trim());hostNeed(match,'V2_HUMAN_INPUT');
    await handler(ownedJson({planDigest:match[1],reviewResultId:match[2],decision:match[3]}));hostNeed(!closed,'V2_HUMAN_PORT_CLOSED');return{kind:'success',text:'Exact plan decision recorded; operational gate remains inactive.'};
  }};
  const unregister=commands.register(definition),registered=commands.find(receiverAgent,commandName);
  try{hostNeed(registered?.handler===definition.handler,'V2_HUMAN_DEFINITION');}catch(error){unregister();throw error;}
  function close(){if(closed)return;closed=true;handler=null;unregister();}
  ctx.effect(()=>()=>close());
  return Object.freeze({bind(fn){hostNeed(!closed&&handler===null&&typeof fn==='function','V2_HUMAN_BINDING');handler=fn;return()=>{handler=null;};},close});
}

const m4Hash=value=>createHash('sha256').update(value).digest('hex');
const m4Hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const m4Exact=(value,keys)=>hostNeed(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(','),'M4_CLOSED_SHAPE');
const m4Absolute=p=>hostNeed(typeof p==='string'&&pathM4.isAbsolute(p)&&pathM4.normalize(p)===p&&!p.startsWith('\\\\')&&!/[\x00-\x1f]/.test(p)&&!p.split(/[\\/]/).some(v=>v==='..'||v==='.'||/[. ]$/.test(v)),'M4_CANONICAL_PATH');
const m4Within=(a,b)=>{const r=pathM4.relative(a.toLowerCase(),b.toLowerCase());return r===''||!r.startsWith('..')&&!pathM4.isAbsolute(r);};
/** Pure closed configuration validation. Neither inspection nor configuration grants execution. */
export function validateGovernanceConfigM4(input){
  const c=ownedJson(input);m4Exact(c,['role','schemaVersion','mode','roots','presetId','receiverId','toolchain','plan']);
  hostNeed(c.role==='host'&&c.schemaVersion===1&&['diagnostic','same-owner'].includes(c.mode),'M4_CONFIG_MODE');
  m4Exact(c.roots,['project','governance','workspace','scratch','legacy','config']);const roots=Object.values(c.roots);roots.forEach(m4Absolute);
  for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)hostNeed(!m4Within(roots[i],roots[j])&&!m4Within(roots[j],roots[i]),'M4_ROOT_OVERLAP');
  hostNeed(c.presetId==='governed-preset'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(c.receiverId),'M4_CONFIG_ID');
  m4Exact(c.toolchain,['git','host']);m4Exact(c.toolchain.git,['executable','sha256','version']);m4Exact(c.toolchain.host,['executable','sha256']);
  for(const pin of [c.toolchain.git,c.toolchain.host]){m4Absolute(pin.executable);hostNeed(m4Hex(pin.sha256),'M4_PIN_HASH');}
  hostNeed(typeof c.toolchain.git.version==='string'&&/^git version [0-9.]+\.windows\.\d+$/.test(c.toolchain.git.version),'M4_GIT_VERSION');
  validatePlanV2(c.plan);hostNeed(c.plan.projectId===digest(c.roots.project.toLowerCase()),'M4_PROJECT_ID');
  const n=c.plan.executionPolicy.node;m4Absolute(n.executable);m4Absolute(n.systemRoot);
  hostNeed(n.version==='26.9.0','M4_NODE_VERSION');return c;
}
function m4Path(p,{absent=false,file=false}={}){
  m4Absolute(p);let missing=false;
  for(let part=pathM4.parse(p).root,parts=p.slice(part.length).split(pathM4.sep).filter(Boolean),i=-1;i<parts.length;i++){
    if(i>=0)part=pathM4.join(part,parts[i]);let s;
    try{s=fsM4.lstatSync(part,{bigint:true});}catch(e){if(e.code==='ENOENT'&&absent){missing=true;continue;}throw e;}
    hostNeed(!missing&&!s.isSymbolicLink(),'M4_PATH_ALIAS');
    hostNeed(part===p&&file?s.isFile()&&s.nlink===1n:s.isDirectory(),'M4_PATH_TYPE');
    hostNeed(fsM4.realpathSync.native(part)===part,'M4_PATH_ALIAS');
  }return !missing;
}
const m4NodeId=(s,full=false)=>[s.dev,s.ino,...(full?[s.size,s.mtimeNs,s.ctimeNs,s.birthtimeNs,s.nlink]:[])].map(String).join(':');
/** Inspect pins before any allocation and retain filesystem identities across asynchronous boundaries. */
export function verifyGovernanceConfigM4(input){
  const c=validateGovernanceConfigM4(input);hostNeed(process.platform==='win32'&&process.arch==='x64'&&process.versions.node==='26.9.0','M4_UNSUPPORTED_HOST');
  const nodes=[];
  for(const [key,p]of Object.entries(c.roots)){
    const exists=m4Path(p,{absent:['governance','workspace'].includes(key)});
    const retained=exists?p:pathM4.dirname(p);m4Path(retained);nodes.push([retained,m4NodeId(fsM4.lstatSync(retained,{bigint:true})),false]);
  }
  const node=c.plan.executionPolicy.node;hostNeed(node.executable===process.execPath,'M4_NODE_EXECUTABLE');m4Path(node.systemRoot);
  for(const [kind,pin]of [['node',node],['git',c.toolchain.git],['host',c.toolchain.host]]){
    // The pinned Windows Git installation may have an installer-owned hardlink; state and source files may not.
    if(kind==='git'){m4Path(pathM4.dirname(pin.executable));m4Absolute(pin.executable);}else m4Path(pin.executable,{file:true});
    const before=fsM4.lstatSync(pin.executable,{bigint:true});hostNeed(before.isFile()&&!before.isSymbolicLink()&&(kind==='git'?before.nlink>=1n:before.nlink===1n)&&before.size<=268435456n,'M4_PIN_FILE');
    hostNeed(m4Hash(fsM4.readFileSync(pin.executable))===pin.sha256,'M4_PIN_CHANGED');const after=fsM4.lstatSync(pin.executable,{bigint:true});hostNeed(m4NodeId(before,true)===m4NodeId(after,true),'M4_PIN_CHANGED');nodes.push([pin.executable,m4NodeId(after,true),true]);
  }
  return Object.freeze({config:c,assert(){for(const[p,id,full]of nodes){const s=fsM4.lstatSync(p,{bigint:true});hostNeed(!s.isSymbolicLink()&&m4NodeId(s,full)===id,'M4_STARTUP_IDENTITY_CHANGED');}for(const[k,p]of Object.entries(c.roots))m4Path(p,{absent:['governance','workspace'].includes(k)});return true;}});
}
/** Capture the single effective preset from the real roster, then recheck its exact files synchronously. */
export async function captureGovernanceStartupM4(ctx,input){
  const pins=verifyGovernanceConfigM4(input),c=pins.config;
  const required=['agents','tools','commands','llm','agentPresets','sandboxPolicy','sandbox','subprocess'];
  const services=Object.fromEntries(required.map(k=>[k,ctx.get(k)]));hostNeed(required.every(k=>services[k]),'M4_MISSING_SERVICE');
  // Cordis creates a new caller-scoped proxy on each get; its public original symbol preserves registration identity.
  const original=service=>service?.[Symbol.for('cordis.original')]??service;
  const identities=required.map(k=>original(services[k]));
  const {agentPresets:presets,sandboxPolicy:policy,sandbox,llm,tools}=services;
  hostNeed(['read-only','workspace-write'].includes(policy.defaultMode),'M4_UNRESTRICTED_POLICY');
  hostNeed(tools.schemas().length===0,'M4_GLOBAL_TOOLS');
  const roster=await presets.list();pins.assert();hostNeed(roster.length===1&&roster[0].id===c.presetId&&roster[0].trust==='user'&&!roster[0].broken,'M4_PRESET_ROSTER');
  const composition=roster[0].path;m4Path(composition,{file:true});const dir=pathM4.dirname(composition),root=pathM4.dirname(dir);
  hostNeed(pathM4.basename(dir)===c.presetId,'M4_PRESET_DIRECTORY');
  const bytes=fsM4.readFileSync(composition);hostNeed(bytes.length<=65536,'M4_PRESET_SIZE');const rows=JSON.parse(bytes.toString('utf8'));
  hostNeed(Array.isArray(rows)&&rows.length===1,'M4_PRESET_ROWS');m4Exact(rows[0],['id','name','config']);m4Exact(rows[0].config,['role']);hostNeed(rows[0].config.role==='preset'&&typeof rows[0].name==='string'&&rows[0].name.startsWith('file:'),'M4_PRESET_ROW');
  const entry=fileURLToPathM4(rows[0].name);m4Path(entry,{file:true});
  const captured=[composition,entry].map(p=>[p,m4NodeId(fsM4.lstatSync(p,{bigint:true}),true),m4Hash(fsM4.readFileSync(p))]);
  const rootNames=fsM4.readdirSync(root).sort().join('\0');
  const inventory=await presets.compositionInventory();pins.assert();hostNeed(inventory.length===1&&inventory[0].id===c.presetId&&inventory[0].isDefault&&!inventory[0].broken&&inventory[0].rows.length===1&&inventory[0].rows[0].enabled===true&&inventory[0].rows[0].moduleName===rows[0].name,'M4_PRESET_INVENTORY');
  function assert(agent){
    pins.assert();hostNeed(required.every((k,i)=>original(ctx.get(k))===identities[i]),'M4_SERVICE_CHANGED');
    hostNeed(['read-only','workspace-write'].includes(policy.defaultMode)&&tools.schemas().length===0,'M4_UNRESTRICTED_POLICY');
    hostNeed(fsM4.readdirSync(root).sort().join('\0')===rootNames,'M4_PRESET_ROSTER_CHANGED');
    for(const[p,id,hash]of captured){m4Path(p,{file:true});hostNeed(m4NodeId(fsM4.lstatSync(p,{bigint:true}),true)===id&&m4Hash(fsM4.readFileSync(p))===hash,'M4_PRESET_CHANGED');}
    for(const route of Object.values(c.plan.executionPolicy.routes)){hostNeed(llm.listProviders().some(p=>p.id===route.provider),'M4_ROUTE_UNAVAILABLE');const retry=llm.providerRetryPolicy(route.provider);hostNeed(retry.mode==='normal'&&retry.maxRetries===0,'M4_ROUTE_RETRY');}
    if(agent){const p=policy.resolve({session:agent.session});hostNeed(['read-only','workspace-write'].includes(p.mode)&&p.workspaceRoot===c.roots.project&&presets.composedPreset(agent.ctx)===c.presetId,'M4_EFFECTIVE_POLICY');}
    const confined=sandbox.confine([c.plan.executionPolicy.node.executable,'--version'],{mode:'workspace-write',workspaceRoot:c.roots.scratch});
    hostNeed(confined&&['partial','full'].includes(confined.enforcement)&&Array.isArray(confined.argv)&&confined.argv.length>3&&confined.argv.at(-3)==='--'&&confined.argv.at(-2)===c.plan.executionPolicy.node.executable&&confined.argv.at(-1)==='--version','M4_CONFINEMENT_UNAVAILABLE');
    return true;
  }
  assert();return Object.freeze({config:c,assert});
}
const m4Stages=new WeakMap();
/** Preset-local guard survives host absence; only the exact host-enrolled live stage may pass it. */
export function installGovernedPresetM4(ctx){
  const tools=ctx.get('tools');hostNeed(tools,'M4_MISSING_SERVICE');
  const remove=tools.guard(exec=>{const allow=exec.agent&&m4Stages.get(exec.agent);try{return allow?.()===true?undefined:'M4_PRESET_READ_ONLY';}catch{return'M4_PRESET_READ_ONLY';}});
  ctx.effect(()=>remove);return remove;
}
export function enrollGovernedStageM4(ctx,agent,authorize){
  hostNeed(agent&&typeof authorize==='function'&&!m4Stages.has(agent),'M4_STAGE_ENROLLMENT');m4Stages.set(agent,authorize);ctx.effect(()=>()=>m4Stages.delete(agent));
}
/** Only exact registered human commands can reach these owner operations. */
export function createHumanCommandsM4(ctx,{receiverAgent,handlers}){
  const commands=ctx.get('commands'),agents=ctx.get('agents');hostNeed(commands&&agents&&receiverAgent&&handlers,'M4_HUMAN_PREREQUISITES');
  let closed=false;const registrations=[];
  // Web composers execute an argument-taking command only when it declares input; argless commands stay bare-only.
  const hints={'gov-read':'<status|history|evidence|artifact> <id|-> <offset> <limit> [cursor]','gov-open':'<projectId> <planDigest>','gov-stage':'<plan-review|author|seal|validate|review>','gov-authorize':'<planDigest> <reviewResultId> <authorize|reject>','gov-resume':'<checkpointDigest> author','gov-reassess':'<headDigest>'};
  const h='([a-f0-9]{64})',id='([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})';
  const definitions=[['gov-status',/^$/,'status',()=>[]],['gov-read',/^(status|history|evidence|artifact) (-|[a-f0-9]{64}) (0|[1-9][0-9]{0,8}) ([1-9][0-9]{0,4})(?: (-|[a-f0-9]{64}))?$/,'read',m=>[{kind:m[1],id:m[2]==='-'?null:m[2],offset:Number(m[3]),limit:Number(m[4]),cursor:!m[5]||m[5]==='-'?null:m[5]}]],
    ['gov-open',new RegExp('^'+h+' '+h+'$'),'open',m=>[m[1],m[2]]],['gov-stage',/^(plan-review|author|seal|validate|review)$/,'stage',m=>[m[1]]],['gov-authorize',new RegExp('^'+h+' '+id+' (authorize|reject)$'),'authorize',m=>[{planDigest:m[1],reviewResultId:m[2],decision:m[3]}]],
    ['gov-pause',/^$/,'pause',()=>[]],['gov-resume',new RegExp('^'+h+' (author)$'),'resume',m=>[{checkpointDigest:m[1],nextAction:m[2]}]],['gov-stop',/^$/,'stop',()=>[]],['gov-reassess',new RegExp('^'+h+'$'),'reassess',m=>[m[1]]]];
  function close(){if(closed)return;closed=true;for(const r of registrations.reverse())r.dispose();}
  try{for(const[name,pattern,key,parse]of definitions){hostNeed(typeof handlers[key]==='function','M4_HUMAN_HANDLER');let registered;
    const definition={name,description:'Governance diagnostic operation; never operational activation.',...(hints[name]?{input:{hint:hints[name]}}:{}),async handler(inv){
      hostNeed(!closed&&inv.agent===receiverAgent&&agents.get(receiverAgent.id)===receiverAgent,'M4_HUMAN_RECEIVER');
      hostNeed(agents.currentInitiator()===undefined&&commands.find(receiverAgent,name)===registered,'M4_HUMAN_ORIGIN');
      hostNeed(typeof inv.rawInput==='string'&&inv.rawInput.length<=1024,'M4_HUMAN_INPUT');const match=pattern.exec(inv.rawInput.trim());hostNeed(match,'M4_HUMAN_INPUT');
      try{const result=ownedJson(await handlers[key](...parse(match)));hostNeed(!closed,'M4_COMMAND_CLOSED');const text=JSON.stringify(result);hostNeed(Buffer.byteLength(text)<=16384,'M4_RESPONSE_LIMIT');return{kind:'success',text};}
      catch(error){return{kind:'error',text:JSON.stringify({gateActive:false,reason:typeof error?.code==='string'&&/^[A-Z0-9_]{1,96}$/.test(error.code)?error.code:'M4_OPERATION_FAILED'})};}
    }};
    const dispose=commands.register(definition);registered=commands.find(receiverAgent,name);registrations.push({dispose});hostNeed(registered?.handler===definition.handler,'M4_HUMAN_DEFINITION');
  }}catch(error){close();throw error;}
  ctx.effect(()=>close);return Object.freeze({close});
}

/** Additional human-only commands exist solely in the explicitly selected qualification entry. */
export function createHumanCommandsM4B(ctx,{receiverAgent,handlers}){
  const commands=ctx.get('commands'),agents=ctx.get('agents');
  hostNeed(commands&&agents&&receiverAgent&&handlers&&typeof handlers.qualify==='function'&&typeof handlers.export==='function'&&typeof handlers.stop==='function'&&typeof handlers.accept==='function','M4B_HUMAN_PREREQUISITES');
  let closed=false;const registrations=[];
  const definitions=[
    ['gov-qualify',/^([a-f0-9]{64}) ([a-f0-9]{64})$/,'qualify',m=>({candidateDigest:m[1],headDigest:m[2]})],
    ['gov-export',/^([a-f0-9]{64}) ([A-Za-z0-9_-]{1,64})$/,'export',m=>({qualificationReceiptDigest:m[1],destinationId:m[2]})],
    ['gov-accept',/^([a-f0-9]{64}) ([a-f0-9]{64})$/,'accept',m=>({candidateDigest:m[1],headDigest:m[2]})],
  ];
  const hints={'gov-qualify':'<candidateDigest> <headDigest>','gov-export':'<qualificationReceiptDigest> <destinationId>','gov-accept':'<candidateDigest> <headDigest>'};
  function close(){if(closed)return;closed=true;for(const dispose of registrations.reverse())dispose();}
  try{for(const[name,pattern,key,parse]of definitions){let registered;
    const definition={name,description:'Disposable qualification only; never operational acceptance or activation.',input:{hint:hints[name]},async handler(inv){
      hostNeed(!closed&&inv.agent===receiverAgent&&agents.get(receiverAgent.id)===receiverAgent,'M4_HUMAN_RECEIVER');
      hostNeed(agents.currentInitiator()===undefined&&commands.find(receiverAgent,name)===registered,'M4_HUMAN_ORIGIN');
      hostNeed(typeof inv.rawInput==='string'&&inv.rawInput.length<=1024,'M4_HUMAN_INPUT');
      const match=pattern.exec(inv.rawInput.trim());hostNeed(match,'M4_HUMAN_INPUT');
      let abortTask;
      const onAbort=()=>{if(!abortTask){try{abortTask=Promise.resolve(handlers.stop());}catch(error){abortTask=Promise.reject(error);}abortTask.catch(()=>{});}};
      try{
        hostNeed(!inv.signal?.aborted,'M4B_COMMAND_ABORTED');inv.signal?.addEventListener('abort',onAbort,{once:true});
        hostNeed(!inv.signal?.aborted,'M4B_COMMAND_ABORTED');const result=ownedJson(await handlers[key](parse(match)));
        if(abortTask)await abortTask;hostNeed(!closed&&!inv.signal?.aborted,'M4_COMMAND_CLOSED');
        const text=JSON.stringify(result);hostNeed(Buffer.byteLength(text)<=16384,'M4_RESPONSE_LIMIT');return{kind:'success',text};
      }catch(error){if(abortTask)try{await abortTask;}catch(cleanup){error=cleanup;}return{kind:'error',text:JSON.stringify({qualificationOnly:true,operationallyAccepted:false,gateActive:false,reason:typeof error?.code==='string'&&/^[A-Z0-9_]{1,96}$/.test(error.code)?error.code:'M4B_OPERATION_FAILED'})};}
      finally{inv.signal?.removeEventListener('abort',onAbort);}
    }};
    const dispose=commands.register(definition);registrations.push(dispose);registered=commands.find(receiverAgent,name);hostNeed(registered?.handler===definition.handler,'M4_HUMAN_DEFINITION');
  }}catch(error){close();throw error;}
  ctx.effect(()=>close);return Object.freeze({close});
}
