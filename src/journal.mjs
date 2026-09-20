import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const STATUSES = Object.freeze(['PLANNED','ATTEMPT_COMMITTED','RUNNING','CONTINUATION_READY','COMPLETED','PARTIAL_LIMIT','NO_PROGRESS','INTERRUPTED_UNCERTAIN']);
export const MAX_REVISIONS = 1024, MAX_VISIBLE = 262144;
const MAX_BYTES = 3 * 1024 * 1024;
export const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
export const diskId = value => 'x' + digest(value).slice(0,63);
export function need(ok, code = 'INVALID_RECORD') {if (!ok) throw Object.assign(new Error(code), {code});}
const integer = n => Number.isSafeInteger(n) && n >= 0;
const exact = (o, keys) => need(o && typeof o === 'object' && !Array.isArray(o) && Reflect.ownKeys(o).length === keys.length && keys.every(k => Object.hasOwn(o,k)), 'CLOSED_SCHEMA');
const id = v => {need(typeof v === 'string' && /^x[a-f0-9]{63}$/.test(v), 'INVALID_ID'); return v;};
export function normalizeRoute(r) {
  need(r && typeof r === 'object' && !Array.isArray(r), 'INVALID_ROUTE');
  need(Object.keys(r).every(k => ['provider','model','effort','maxTokens','costRates'].includes(k)), 'INVALID_ROUTE');
  need(typeof r.provider === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(r.provider), 'INVALID_PROVIDER');
  need(typeof r.model === 'string' && /^[A-Za-z0-9_./:-]{1,192}$/.test(r.model), 'INVALID_MODEL');
  need(typeof r.effort === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(r.effort), 'INVALID_EFFORT');
  need(integer(r.maxTokens) && r.maxTokens > 0 && r.maxTokens <= 262144, 'INVALID_TOKENS');
  let rates = r.costRates === undefined ? (r.provider === 'deepseek-official' && r.model === 'deepseek-flash' ? {inputMicrosPerMillion:300000,outputMicrosPerMillion:1200000} : null) : r.costRates;
  if (rates !== null) {
    exact(rates,['inputMicrosPerMillion','outputMicrosPerMillion']);
    need(integer(rates.inputMicrosPerMillion) && integer(rates.outputMicrosPerMillion) && rates.inputMicrosPerMillion <= 1_000_000_000 && rates.outputMicrosPerMillion <= 1_000_000_000, 'INVALID_RATES');
    rates = {inputMicrosPerMillion:rates.inputMicrosPerMillion,outputMicrosPerMillion:rates.outputMicrosPerMillion};
  }
  return {provider:r.provider,model:r.model,effort:r.effort,maxTokens:r.maxTokens,costRates:rates};
}
export function normalizeRequest(r) {
  exact(r,['prompt','route','maxRounds','contextChars','createdAt','deadlineAt']);
  need(typeof r.prompt === 'string' && r.prompt.trim().length > 0 && r.prompt.length <= 160000, 'INVALID_PROMPT');
  need(integer(r.maxRounds) && r.maxRounds >= 1 && r.maxRounds <= 8, 'INVALID_ROUNDS');
  need(integer(r.contextChars) && r.contextChars >= 1 && r.contextChars <= 500000, 'INVALID_CONTEXT');
  need(integer(r.createdAt) && integer(r.deadlineAt) && r.deadlineAt > r.createdAt && r.deadlineAt-r.createdAt <= 900000, 'INVALID_DEADLINE');
  return {prompt:r.prompt,route:normalizeRoute(r.route),maxRounds:r.maxRounds,contextChars:r.contextChars,createdAt:r.createdAt,deadlineAt:r.deadlineAt};
}
export function normalizeUsage(u) {
  exact(u,['inputTokens','cacheReadTokens','outputTokens','totalTokens','cacheWriteTokens','reasoningTokens']);
  need([u.inputTokens,u.cacheReadTokens,u.outputTokens,u.cacheWriteTokens].every(integer), 'INVALID_USAGE');
  const total=u.inputTokens+u.cacheReadTokens+u.cacheWriteTokens+u.outputTokens;
  need(integer(total)&&(u.totalTokens===undefined||(integer(u.totalTokens)&&u.totalTokens===total)), 'INVALID_USAGE');
  need(u.reasoningTokens === null || (integer(u.reasoningTokens) && u.reasoningTokens <= u.outputTokens), 'INVALID_USAGE');
  return {inputTokens:u.inputTokens,cacheReadTokens:u.cacheReadTokens,outputTokens:u.outputTokens,totalTokens:total,cacheWriteTokens:u.cacheWriteTokens,reasoningTokens:u.reasoningTokens};
}
export function expectedCost(input,output,rates,cacheWriteTokens=0) {if(rates===null||cacheWriteTokens>0)return null;const n=input*rates.inputMicrosPerMillion+output*rates.outputMicrosPerMillion;need(integer(n),'COST_OVERFLOW');return Math.ceil(n/1_000_000);}
export function expectedHold(request,priorRounds) {
  let input=1024+Buffer.byteLength(request.prompt,'utf8')*2;
  for(const round of priorRounds)input+=2*(Buffer.byteLength(round.visibleText,'utf8')+Buffer.byteLength('Continue from your previous answer without repeating it. Complete the original request.','utf8'));
  return expectedCost(input,request.route.maxTokens,request.route.costRates);
}
function normalizeRecord(r, owner, task, revision) {
  exact(r,['version','owner','task','revision','status','request','requestHash','rounds','spentMicros','heldMicros','costUnknown']);
  need(r.version === 3 && r.owner === owner && r.task === task && r.revision === revision && integer(revision) && revision >= 1 && revision <= MAX_REVISIONS, 'IDENTITY_MISMATCH');
  need(STATUSES.includes(r.status), 'INVALID_STATUS');
  const request = normalizeRequest(r.request), requestHash = digest(JSON.stringify(request));
  need(r.requestHash === requestHash, 'REQUEST_HASH_MISMATCH');
  need(Array.isArray(r.rounds) && r.rounds.length <= request.maxRounds, 'INVALID_ROUNDS');
  const ids = new Set(); let chars = 0, spent = 0, held = 0, unknown = false;
  const rounds = r.rounds.map((v,i) => {
    exact(v,['attemptId','status','visibleText','finish','usage','costMicros','holdMicros']);
    need(typeof v.attemptId === 'string' && /^[a-f0-9-]{36}$/.test(v.attemptId) && !ids.has(v.attemptId), 'INVALID_ATTEMPT'); ids.add(v.attemptId);
    need(['ATTEMPT_COMMITTED','RUNNING','COMPLETED','INTERRUPTED_UNCERTAIN'].includes(v.status), 'INVALID_ROUND_STATUS');
    need(i === r.rounds.length-1 || v.status === 'COMPLETED', 'UNSETTLED_PREVIOUS_ROUND');
    need(typeof v.visibleText === 'string' && (chars += v.visibleText.length) <= MAX_VISIBLE, 'VISIBLE_BOUND');
    need(v.finish === null || ['stop','max-tokens','error','aborted','tool-calls'].includes(v.finish), 'INVALID_FINISH');
    const usage = v.usage === null ? null : normalizeUsage(v.usage);
    need(v.costMicros === null || integer(v.costMicros), 'INVALID_COST'); need(v.holdMicros === null || integer(v.holdMicros), 'INVALID_HOLD');
    if (v.status === 'COMPLETED') {
      need(usage && ['stop','max-tokens'].includes(v.finish), 'INVALID_SETTLEMENT');
      need(v.costMicros===expectedCost(usage.inputTokens+usage.cacheReadTokens,usage.outputTokens,request.route.costRates,usage.cacheWriteTokens)&&v.holdMicros===(request.route.costRates===null?null:0),'SETTLEMENT_MISMATCH');
    }
    if (v.status !== 'COMPLETED') need(v.costMicros===null&&v.holdMicros===expectedHold(request,r.rounds.slice(0,i)), 'UNSETTLED_COST');
    spent += v.costMicros ?? 0; held += v.holdMicros ?? 0; unknown ||= v.costMicros === null;
    return {attemptId:v.attemptId,status:v.status,visibleText:v.visibleText,finish:v.finish,usage,costMicros:v.costMicros,holdMicros:v.holdMicros};
  });
  need(integer(spent) && integer(held) && r.spentMicros === spent && r.heldMicros === held && r.costUnknown === unknown, 'LEDGER_MISMATCH');
  if (r.status === 'PLANNED') need(rounds.length === 0, 'INVALID_STATE');
  if (['ATTEMPT_COMMITTED','RUNNING','INTERRUPTED_UNCERTAIN'].includes(r.status)) need(rounds.length && rounds.at(-1).status === r.status, 'INVALID_STATE');
  if (r.status === 'CONTINUATION_READY') need(rounds.length && rounds.at(-1).status === 'COMPLETED' && rounds.at(-1).finish === 'max-tokens' && rounds.at(-1).visibleText.trim().length > 0 && rounds.length < request.maxRounds, 'INVALID_CONTINUATION');
  if (['COMPLETED','NO_PROGRESS'].includes(r.status)) need(rounds.length && rounds.at(-1).status === 'COMPLETED', 'INVALID_TERMINAL');
  return {version:3,owner,task,revision,status:r.status,request,requestHash,rounds,spentMicros:spent,heldMicros:held,costUnknown:unknown};
}
function validateTransition(before, after) {
  if (!before) {need(after.revision===1&&after.status==='PLANNED'&&after.rounds.length===0,'INVALID_INITIAL_STATE');return;}
  need(after.revision===before.revision+1&&after.requestHash===before.requestHash,'REQUEST_MUTATED');
  const transitions={PLANNED:['ATTEMPT_COMMITTED','PARTIAL_LIMIT'],ATTEMPT_COMMITTED:['RUNNING','INTERRUPTED_UNCERTAIN'],RUNNING:['RUNNING','CONTINUATION_READY','COMPLETED','PARTIAL_LIMIT','NO_PROGRESS','INTERRUPTED_UNCERTAIN'],CONTINUATION_READY:['ATTEMPT_COMMITTED','PARTIAL_LIMIT'],COMPLETED:[],PARTIAL_LIMIT:[],NO_PROGRESS:[],INTERRUPTED_UNCERTAIN:[]};
  need(transitions[before.status].includes(after.status),'STATE_ROLLBACK');
  const commits=after.status==='ATTEMPT_COMMITTED';need(after.rounds.length===before.rounds.length+(commits?1:0),'ROUND_RESET');
  for(let i=0;i<before.rounds.length;i++) {
    const a=before.rounds[i],b=after.rounds[i];need(a.attemptId===b.attemptId&&b.visibleText.startsWith(a.visibleText),'ROUND_MUTATED');
    if(a.status==='COMPLETED')need(JSON.stringify(a)===JSON.stringify(b),'SETTLED_ROUND_MUTATED');
    else {need((a.status==='ATTEMPT_COMMITTED'?['RUNNING','INTERRUPTED_UNCERTAIN']:['RUNNING','COMPLETED','INTERRUPTED_UNCERTAIN']).includes(b.status),'ROUND_STATE_ROLLBACK');if(b.status!=='COMPLETED')need(a.holdMicros===b.holdMicros,'HOLD_MUTATED');}
  }
}
async function directories(target, create) {
  const absolute=path.resolve(target), base=path.parse(absolute).root; let current=base;
  for(const part of ['',...absolute.slice(base.length).split(path.sep).filter(Boolean)]) {
    if(part) current=path.join(current,part); let stat;
    try {stat=await fs.lstat(current);} catch(e) {if(e.code!=='ENOENT') throw e;if(!create)return false;try {await fs.mkdir(current,{mode:0o700});}catch(m){if(m.code!=='EEXIST')throw m;}stat=await fs.lstat(current);}
    need(stat.isDirectory()&&!stat.isSymbolicLink(),'UNSAFE_PATH');
  } return true;
}
async function readRecord(filename,owner,task,revision) {
  const stat=await fs.lstat(filename);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=MAX_BYTES,'CORRUPT');
  const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0)); let text;
  try {const buffer=Buffer.alloc(MAX_BYTES+1);let length=0;while(length<buffer.length){const r=await handle.read(buffer,length,buffer.length-length,null);if(!r.bytesRead)break;length+=r.bytesRead;}need(length<=MAX_BYTES,'CORRUPT');text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));}finally{await handle.close();}
  try {const e=JSON.parse(text);exact(e,['record','sha256']);const r=normalizeRecord(e.record,owner,task,revision);need(e.sha256===digest(JSON.stringify(r)),'CORRUPT');return r;}catch {throw Object.assign(new Error('CORRUPT'),{code:'CORRUPT'});}
}
async function latest(directory,owner,task) {
  if(!await directories(directory,false))return null;
  const names=[];for await(const entry of await fs.opendir(directory)){need(names.length<MAX_REVISIONS&&/^[0-9]{8}\.json$/.test(entry.name)&&entry.isFile()&&!entry.isSymbolicLink(),'CORRUPT');names.push(entry.name);}
  names.sort();let last=null;
  for(let i=0;i<names.length;i++){need(names[i]===`${String(i+1).padStart(8,'0')}.json`,'CORRUPT');const next=await readRecord(path.join(directory,names[i]),owner,task,i+1);validateTransition(last,next);last=next;}
  return last;
}
export function createJournal(root, owner) {
  need(typeof root==='string'&&path.isAbsolute(root),'ABSOLUTE_ROOT_REQUIRED');id(owner);const queues=new Map();
  const serial=(task,fn)=>{const result=(queues.get(task)||Promise.resolve()).then(fn),settled=result.then(()=>{},()=>{});queues.set(task,settled);settled.then(()=>{if(queues.get(task)===settled)queues.delete(task);});return result;};
  return Object.freeze({load(task){id(task);return serial(task,()=>latest(path.join(root,owner,task),owner,task));},save(task,input,expectedRevision){
    id(task);need(integer(expectedRevision)&&expectedRevision<MAX_REVISIONS,'REVISION_LIMIT');
    const record=normalizeRecord(input,owner,task,expectedRevision+1), body=JSON.stringify({record,sha256:digest(JSON.stringify(record))});need(Buffer.byteLength(body,'utf8')<=MAX_BYTES,'RECORD_TOO_LARGE');
    return serial(task,async()=>{const directory=path.join(root,owner,task);await directories(directory,true);const current=await latest(directory,owner,task);need((current?.revision??0)===expectedRevision,'REVISION_CONFLICT');
      validateTransition(current,record);
      const handle=await fs.open(path.join(directory,`${String(record.revision).padStart(8,'0')}.json`),'wx',0o600);try{await handle.writeFile(body,'utf8');await handle.sync();}finally{await handle.close();}return record;
    });
  }});
}
