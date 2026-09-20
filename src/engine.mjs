import {randomUUID} from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createJournal, diskId, digest, need, normalizeRequest, normalizeUsage, MAX_VISIBLE} from './journal.mjs';

export const HARD_MS=900000;
const CONTINUE='Continue from your previous answer without repeating it. Complete the original request.';
const SAFE=['PLANNED','CONTINUATION_READY'];
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function price(input,output,rates){if(rates===null)return null;const numerator=input*rates.inputMicrosPerMillion+output*rates.outputMicrosPerMillion;need(integer(numerator),'COST_OVERFLOW');return Math.ceil(numerator/1_000_000);}
function account(r){r.spentMicros=0;r.heldMicros=0;r.costUnknown=false;for(const round of r.rounds){r.spentMicros+=round.costMicros??0;r.heldMicros+=round.holdMicros??0;r.costUnknown ||= round.costMicros===null;}need(integer(r.spentMicros)&&integer(r.heldMicros),'COST_OVERFLOW');}
function messages(r){const route=r.request.route;const list=[{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:r.request.prompt}]}];for(const round of r.rounds){list.push({id:randomUUID(),role:'assistant',source:{kind:'model',provider:route.provider,model:route.model},content:[{type:'text',text:round.visibleText}]});list.push({id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:CONTINUE}]});}return list;}
// Diagnostic leaves only. Never retain a thrown object, message, request ID or raw chunk.
const DIAGNOSTIC_CODES=new Set(['HTTP_ERROR','API_ERROR','RATE_LIMITED','RATE_LIMIT','AUTHENTICATION_ERROR','AUTH','INVALID_REQUEST','INVALID_RESPONSE','NETWORK_ERROR','TRANSPORT','SERVER','QUOTA_EXCEEDED','TIMEOUT','EMPTY_RESPONSE','REQUEST_EXTENSION','STREAM_CLOSED','MALFORMED_RESPONSE','ABORTED','UNCERTAIN_FINISH','INVALID_USAGE','CONFIG_MISMATCH','LLM_UNAVAILABLE','CORRUPT','COST_OVERFLOW','INVALID_PREPARED_CALL','REVISION_CONFLICT','CHECKPOINT_CAPACITY','REVISION_LIMIT','PERSISTENCE_FAILED','CLOSED_SCHEMA','VISIBLE_LIMIT','INVALID_CHUNK','INVALID_TEXT']);
function failureLeaves(error){let code='UNKNOWN',httpStatus=null,failureCategory='OTHER';try{if(typeof error?.code==='string'&&DIAGNOSTIC_CODES.has(error.code))code=error.code;if(Number.isSafeInteger(error?.status)&&error.status>=400&&error.status<=599)httpStatus=error.status;if(typeof error?.message==='string'){if(/thinking|redacted_thinking|signature/i.test(error.message))failureCategory='THINKING_PROTOCOL';else if(/max_tokens|budget_tokens/i.test(error.message))failureCategory='TOKEN_CONFIGURATION';else if(/rate.?limit|quota/i.test(error.message))failureCategory='QUOTA';}}catch{}return {code,httpStatus,failureCategory};}
const finishLeaf=kind=>['stop','max-tokens','error','aborted','tool-calls'].includes(kind)?kind:'UNKNOWN';

/** Trusted owner binding. Diagnostics are process-local and never enter the journal. */
export function createTaskEngine({root,owner,getLlm,clock=Date.now,deadlineMs=HARD_MS}) {
  need(typeof owner==='string'&&owner.length>0&&owner.length<=256,'INVALID_OWNER');need(typeof getLlm==='function'&&typeof clock==='function','INVALID_FACTORY');need(integer(deadlineMs)&&deadlineMs>0&&deadlineMs<=HARD_MS,'INVALID_DEADLINE');
  const journal=createJournal(root,diskId(owner)), loaded=new Map(), busy=new Set(), controllers=new Set(), diagnostics=new WeakMap();let disposed=false;
  const checkId=id=>need(typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id),'INVALID_TASK_ID');
  const caller=exec=>{need(!disposed&&exec?.agent?.id===owner&&exec.signal&&typeof exec.signal.throwIfAborted==='function','OWNER_OR_LIFETIME_REFUSED');exec.signal.throwIfAborted();};
  function diagnosticView(r){return (diagnostics.get(r)??[]).map(d=>({phase:d.phase,code:d.code,httpStatus:d.httpStatus,failureCategory:d.failureCategory??null,finishKind:d.finishKind,usageCount:d.usageCount,finishCount:d.finishCount,round:d.round,visibleChars:d.visibleChars,aborted:d.aborted}));}
  function view(id,r,page=0){need(integer(page),'INVALID_PAGE');const text=r.rounds.map(x=>x.visibleText).join('');const offset=page*12000;need(integer(offset)&&offset<=text.length,'INVALID_PAGE');return {task_id:id,status:r.status,revision:r.revision,requestHash:r.requestHash,roundCount:r.rounds.length,maxRounds:r.request.maxRounds,spentMicros:r.spentMicros,settledKnownMicros:r.spentMicros,heldMicros:r.heldMicros,costUnknown:r.costUnknown,softTargetUsd:1,overTarget:r.spentMicros>1_000_000,approvalRequired:false,automaticRetries:false,resumable:SAFE.includes(r.status)&&!r.persistenceFailed&&clock()<r.request.deadlineAt,deadlineAt:r.request.deadlineAt,persistenceFailed:r.persistenceFailed===true,page,text:text.slice(offset,offset+12000),totalChars:text.length,nextPage:offset+12000<text.length?page+1:null,rounds:r.rounds.map(x=>({attemptId:x.attemptId,status:x.status,visibleChars:x.visibleText.length,finish:x.finish,costMicros:x.costMicros,holdMicros:x.holdMicros,
    // Rounds written before per-round routes existed fall back to the task route.
    provider:x.route?.provider??r.request.route.provider,model:x.route?.model??r.request.route.model,effort:x.route?.effort??r.request.route.effort,
    routeRecordedPerRound:x.route!==undefined})),
    route:{provider:r.request.route.provider,model:r.request.route.model,effort:r.request.route.effort,maxTokens:r.request.route.maxTokens},
    // The original request travels with the result so a saved task can be audited for
    // what was asked, not only for what the model returned.
    prompt:r.request.prompt,
    diagnosticPersisted:false,diagnostics:diagnosticView(r)};}
  async function save(r,status,emergency=false){const d=diagnostics.get(r)?.at(-1),previous=d?.phase;if(d)d.phase='checkpoint';need(!r.persistenceFailed,'PERSISTENCE_FAILED');need(r.revision<(emergency?1024:1023),'REVISION_LIMIT');r.status=status;account(r);const {persistenceFailed,...owned}=r;try{const saved=await journal.save(r.task,{...owned,revision:r.revision+1},r.revision);Object.assign(r,saved);if(d)d.phase=previous;}catch(error){r.persistenceFailed=true;throw error;}}
  async function load(id){checkId(id);if(loaded.has(id))return loaded.get(id);need(loaded.size<64,'TASK_CAPACITY');const r=await journal.load(diskId(id));need(r,'UNKNOWN_TASK');if(loaded.has(id))return loaded.get(id);loaded.set(id,r);return r;}
  async function exclusive(id,fn){checkId(id);need(!busy.has(id),'CONCURRENT_TASK');busy.add(id);try{return await fn();}finally{busy.delete(id);}}
  // Task directories are named by digest, so a readable id cannot be recovered from
  // storage. This side index maps one back without touching the closed record schema. It
  // is a convenience only: a task missing from it still lists, with a null id.
  const indexFile=()=>path.join(root,diskId(owner),'task-index.json');
  async function readIndex(){
    try{
      const parsed=JSON.parse(await fsp.readFile(indexFile(),'utf8'));
      return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
    }catch{return {};}
  }
  async function noteId(taskId){
    try{
      const index=await readIndex();
      if(index[diskId(taskId)]===taskId)return;
      index[diskId(taskId)]=taskId;
      await fsp.mkdir(path.dirname(indexFile()),{recursive:true,mode:0o700});
      await fsp.writeFile(indexFile(),JSON.stringify(index),{encoding:'utf8',mode:0o600});
    }catch{ /* Never fail a task because a lookup hint could not be written. */ }
  }
  async function dropId(taskId){
    try{
      const index=await readIndex();
      if(!(diskId(taskId) in index))return;
      delete index[diskId(taskId)];
      await fsp.writeFile(indexFile(),JSON.stringify(index),{encoding:'utf8',mode:0o600});
    }catch{ /* Losing a hint is harmless once the record itself is gone. */ }
  }
  async function plan({task_id,prompt,route,maxRounds=3,contextChars=160000,deadlineMs:taskMs=deadlineMs}){return exclusive(task_id,async()=>{
    need(!disposed,'DISPOSED');need(!loaded.has(task_id)&&loaded.size<64,'TASK_EXISTS_OR_CAPACITY');need(!(await journal.load(diskId(task_id))),'TASK_EXISTS');need(integer(taskMs)&&taskMs>0&&taskMs<=deadlineMs,'INVALID_DEADLINE');
    const createdAt=clock();const request=normalizeRequest({prompt,route,maxRounds,contextChars,createdAt,deadlineAt:createdAt+taskMs});
    const r={version:3,owner:diskId(owner),task:diskId(task_id),revision:0,status:'PLANNED',request,requestHash:digest(JSON.stringify(request)),rounds:[],spentMicros:0,heldMicros:0,costUnknown:false};loaded.set(task_id,r);await save(r,'PLANNED');await noteId(task_id);return view(task_id,r);
  });}
  async function run(id,exec){caller(exec);return exclusive(id,async()=>{
    const r=await load(id);caller(exec);need(!r.persistenceFailed,'PERSISTENCE_FAILED');
    if(['ATTEMPT_COMMITTED','RUNNING'].includes(r.status)){r.rounds.at(-1).status='INTERRUPTED_UNCERTAIN';await save(r,'INTERRUPTED_UNCERTAIN',true);return view(id,r);}
    if(!SAFE.includes(r.status))return view(id,r);
    while(SAFE.includes(r.status)){
      if(disposed||exec.signal.aborted)return view(id,r);
      if(clock()>=r.request.deadlineAt||r.rounds.length>=r.request.maxRounds){await save(r,'PARTIAL_LIMIT',true);break;}
      const wire=messages(r), chars=wire.reduce((n,m)=>n+m.content[0].text.length,0);
      if(chars>r.request.contextChars||r.rounds.reduce((n,x)=>n+x.visibleText.length,0)>=MAX_VISIBLE){await save(r,'PARTIAL_LIMIT',true);break;}
      const rates=r.request.route.costRates, inputEstimate=wire.reduce((n,m)=>n+Buffer.byteLength(m.content[0].text,'utf8')*2,1024);
      // The round is the unit of execution, so the exact route is recorded on it rather
      // than only on the enclosing task.
      const route=r.request.route;
      const round={attemptId:randomUUID(),status:'ATTEMPT_COMMITTED',visibleText:'',finish:null,usage:null,costMicros:null,holdMicros:price(inputEstimate,route.maxTokens,rates),
        route:{provider:route.provider,model:route.model,effort:route.effort}};
      r.rounds.push(round);
      const diagnostic={phase:'checkpoint',code:null,httpStatus:null,finishKind:null,usageCount:0,finishCount:0,round:r.rounds.length,visibleChars:0,aborted:false};
      if(!diagnostics.has(r))diagnostics.set(r,[]);diagnostics.get(r).push(diagnostic);
      const controller=new AbortController();controllers.add(controller);const relay=()=>controller.abort(exec.signal.reason);exec.signal.addEventListener('abort',relay,{once:true});if(exec.signal.aborted)relay();
      const remaining=Math.max(1,Math.min(deadlineMs,r.request.deadlineAt-clock()));const timer=setTimeout(()=>controller.abort(new DOMException('Task deadline','AbortError')),remaining);
      let checkpoint=0,usage=null,usageCount=0,finish=null,finishCount=0,bad=false,finishFailure=null;
      try{
        await save(r,'ATTEMPT_COMMITTED');controller.signal.throwIfAborted();diagnostic.phase='prepare';
        const llm=getLlm();need(llm&&typeof llm.prepareCall==='function','LLM_UNAVAILABLE');const route=r.request.route;
        const config={provider:route.provider,model:route.model,reasoningEffort:route.effort,maxTokens:route.maxTokens};
        const prepared=await llm.prepareCall(config,controller.signal);controller.signal.throwIfAborted();
        need(prepared?.config&&Object.entries(config).every(([k,v])=>prepared.config[k]===v)&&prepared.config.temperature===undefined&&prepared.config.stop===undefined,'CONFIG_MISMATCH');
        // save() returns detached records; reacquire the last round after each commit.
        r.rounds.at(-1).status='RUNNING';await save(r,'RUNNING');controller.signal.throwIfAborted();diagnostic.phase='dispatch';
        const stream=prepared.stream({...config,signal:controller.signal,messages:wire});diagnostic.phase='stream';
        for await(const chunk of stream){
          controller.signal.throwIfAborted();try{
            need(chunk&&typeof chunk.type==='string','INVALID_CHUNK');const active=r.rounds.at(-1);
            if(chunk.type==='text-delta'){
              need(typeof chunk.text==='string','INVALID_TEXT');const used=r.rounds.reduce((n,x)=>n+x.visibleText.length,0),room=MAX_VISIBLE-used;active.visibleText+=chunk.text.slice(0,room);diagnostic.visibleChars=active.visibleText.length;
              if(active.visibleText.length-checkpoint>=2048){await save(r,'RUNNING');checkpoint=r.rounds.at(-1).visibleText.length;}
              need(chunk.text.length<=room,'VISIBLE_LIMIT');
            }else if(chunk.type==='usage'){++usageCount;diagnostic.usageCount=usageCount;const u=chunk.usage;usage=u?{inputTokens:u.inputTokens,cacheReadTokens:u.cacheReadTokens??0,outputTokens:u.outputTokens,totalTokens:u.totalTokens,cacheWriteTokens:u.cacheWriteTokens??0,reasoningTokens:u.reasoningTokens??null}:null;}
            else if(chunk.type==='finish'){++finishCount;finish=chunk.reason?.kind;diagnostic.finishCount=finishCount;diagnostic.finishKind=finishLeaf(finish);if(finish==='error'||finish==='aborted')finishFailure=failureLeaves(chunk.reason.failure);}
            else if(chunk.type==='tool-call-delta')bad=true;
            // Reasoning/replay/unknown block payloads are never persisted.
          }catch(error){controller.abort(new DOMException('Consumer safety stop','AbortError'));throw error;}
        }
        diagnostic.phase='settle';controller.signal.throwIfAborted();need(!bad&&usageCount===1&&finishCount===1&&['stop','max-tokens'].includes(finish),'UNCERTAIN_FINISH');usage=normalizeUsage(usage);
        const active=r.rounds.at(-1);active.usage=usage;active.finish=finish;active.costMicros=usage.cacheWriteTokens>0?null:price(usage.inputTokens+usage.cacheReadTokens,usage.outputTokens,rates);active.holdMicros=rates===null?null:0;active.status='COMPLETED';
        const prior=r.rounds.slice(0,-1).map(x=>x.visibleText).join(''), visible=active.visibleText.trim();
        const progress=visible.length>0&&(!prior.trim()||!prior.includes(visible));
        let status=!progress?'NO_PROGRESS':finish==='stop'?'COMPLETED':r.rounds.length>=r.request.maxRounds?'PARTIAL_LIMIT':'CONTINUATION_READY';
        await save(r,status,true);
      }catch(error){
        const failure=finishFailure&&diagnostic.phase==='settle'?finishFailure:failureLeaves(error);if(finishFailure&&diagnostic.phase==='settle')diagnostic.phase='stream';diagnostic.code=failure.code;diagnostic.httpStatus=failure.httpStatus;diagnostic.failureCategory=failure.failureCategory;diagnostic.aborted=controller.signal.aborted||finish==='aborted';
        controller.abort(new DOMException('Execution uncertain','AbortError'));
        const active=r.rounds.at(-1);if(active.status!=='COMPLETED')active.status='INTERRUPTED_UNCERTAIN';
        if(r.persistenceFailed)r.status='INTERRUPTED_UNCERTAIN';
        if(!r.persistenceFailed&&active.status!=='COMPLETED'){try{await save(r,'INTERRUPTED_UNCERTAIN',true);}catch(checkpointError){r.persistenceFailed=true;const checkpointFailure=failureLeaves(checkpointError);diagnostic.phase='checkpoint';diagnostic.code=checkpointFailure.code;diagnostic.httpStatus=checkpointFailure.httpStatus;}}
      }finally{diagnostic.usageCount=usageCount;diagnostic.finishCount=finishCount;diagnostic.visibleChars=r.rounds.at(-1).visibleText.length;clearTimeout(timer);exec.signal.removeEventListener('abort',relay);controllers.delete(controller);}
      if(r.persistenceFailed||!SAFE.includes(r.status))break;
    }
    return view(id,r);
  });}
  /** Summaries of every stored task, newest first. A task whose readable id is unknown is
   * still listed with a null id and its digest, so nothing is silently hidden. */
  async function list(){
    need(!disposed,'DISPOSED');
    const index=await readIndex();
    const stored=await journal.tasks();
    return stored.map(({task,record})=>({
      task_id:index[task]??null,digest:task,
      status:record?record.status:'UNREADABLE',
      roundCount:record?record.rounds.length:0,maxRounds:record?record.request.maxRounds:null,
      provider:record?record.request.route.provider:null,model:record?record.request.route.model:null,
      effort:record?record.request.route.effort:null,
      spentMicros:record?record.spentMicros:null,costUnknown:record?record.costUnknown:null,
      createdAt:record?record.request.createdAt:null,deadlineAt:record?record.request.deadlineAt:null,
      totalChars:record?record.rounds.reduce((n,x)=>n+x.visibleText.length,0):0,
      resumable:record?SAFE.includes(record.status)&&clock()<record.request.deadlineAt:false,
    })).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0));
  }
  /** Delete one saved task. A task currently running is refused rather than deleted
   * beneath itself, and the in-memory copy is dropped so a stale record cannot be reused. */
  async function forget(taskId){
    need(!disposed,'DISPOSED');checkId(taskId);
    need(!busy.has(taskId),'CONCURRENT_TASK');
    const removed=await journal.remove(diskId(taskId));
    need(removed,'UNKNOWN_TASK');
    loaded.delete(taskId);
    await dropId(taskId);
    return {task_id:taskId,removed:true};
  }
  return Object.freeze({plan,run,resume:run,list,forget,async read(taskId,page=0){need(!disposed,'DISPOSED');const r=await load(taskId);if(['ATTEMPT_COMMITTED','RUNNING'].includes(r.status)&&!busy.has(taskId))return {...view(taskId,r,page),status:'INTERRUPTED_UNCERTAIN',resumable:false};return view(taskId,r,page);},dispose(){disposed=true;for(const controller of controllers)controller.abort(new DOMException('Engine disposed','AbortError'));}});
}
