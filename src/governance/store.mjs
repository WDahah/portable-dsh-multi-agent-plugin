import path from 'node:path';
import {randomBytes} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {canonicalize, ownedJson, digest, need} from './contracts.mjs';

export const STORE_LIMITS = Object.freeze({revisions:4096,jobs:64,artifactBytes:256*1024*1024,artifact:1024*1024,references:1024});
export const STORE_EVENT_TYPES = Object.freeze(['PLAN_PROPOSED','ASSIGNMENT_CREATED','RESULT_RECORDED','HUMAN_DECIDED','EVIDENCE_REGISTERED','ATTEMPT_RESERVED','CANDIDATE_SEALED','STOPPED','RECONCILIATION_REQUIRED']);
const PROVENANCE='fixture-untrusted';
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9_-]{1,64}$/;
const validId=value=>typeof value==='string'&&ID.test(value);
const REG_KEYS=['schemaVersion','provenance','jobId','projectId','projectRoot'];
const EVENT_KEYS=['schemaVersion','provenance','jobId','projectId','revision','previousDigest','type','payload','artifacts','eventDigest'];
const fold=p=>process.platform==='win32'?p.toLowerCase():p;
const error=(code,cause)=>Object.assign(new Error(code,cause===undefined?undefined:{cause}),{code});
const exact=(v,keys)=>need(v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'CLOSED_SCHEMA');
const jobPath=(root,id)=>path.join(root,'jobs',digest(id));
const revisionName=n=>String(n).padStart(6,'0')+'.json';
const plainRecord=(value,required,optional=[])=>{
  need(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,'CLOSED_SCHEMA');
  const keys=Reflect.ownKeys(value);
  need(keys.every(k=>typeof k==='string'&&[...required,...optional].includes(k))&&required.every(k=>keys.includes(k)),'CLOSED_SCHEMA');
  const out={};
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);need(d&&Object.hasOwn(d,'value')&&d.enumerable,'INVALID_DESCRIPTOR');out[k]=d.value;}
  return out;
};
async function maybeStat(file){try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function directory(file){const st=await fs.lstat(file);need(st.isDirectory()&&!st.isSymbolicLink(),'UNSUPPORTED_FILE_TYPE');}
async function names(dir,max){
  const result=[];const handle=await fs.opendir(dir);
  for await(const entry of handle){need(result.length<max,'RETENTION_EXHAUSTED');result.push(entry.name);}
  return result.sort();
}
async function canonicalRoot(input,mustExist){
  need(typeof input==='string'&&input.length>0&&input.length<=4096&&path.isAbsolute(input)&&!input.includes('\0'),'INVALID_ROOT');
  if(process.platform==='win32'){
    need(/^[A-Za-z]:[\\/]/.test(input)&&!/[<>"|?*\x00-\x1f]/.test(input)&&!input.slice(2).includes(':'),'INVALID_ROOT');
    need(input.slice(3).split(/[\\/]/).every(p=>!p||p==='.'||p==='..'||(!/[ .]$/.test(p)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))),'INVALID_ROOT');
  }else need(!input.startsWith('//'),'INVALID_ROOT');
  const absolute=path.resolve(input);let cursor=absolute;const suffix=[];
  for(;;){
    const st=await maybeStat(cursor);
    if(st){
      if(cursor===absolute)need(!st.isSymbolicLink(),'ROOT_SYMLINK');
      const target=st.isSymbolicLink()?await fs.stat(cursor):st;
      need(target.isDirectory(),'UNSUPPORTED_FILE_TYPE');
      const resolved=path.join(await fs.realpath(cursor),...suffix.reverse());
      return fold(resolved);
    }
    need(!mustExist,'ROOT_MISSING');const parent=path.dirname(cursor);need(parent!==cursor,'ROOT_MISSING');suffix.push(path.basename(cursor));cursor=parent;
  }
}
function overlapping(a,b){const rel=path.relative(a,b);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
async function settings(input,inspection){
  const opts=plainRecord(input,['root','legacyRoot','projectRoots','candidateRoots','validateTransition'],inspection?[]:['failpoint']);
  need(typeof opts.validateTransition==='function','VALIDATOR_REQUIRED');need(opts.failpoint===undefined||typeof opts.failpoint==='function','INVALID_FAILPOINT');
  const projects=ownedJson(opts.projectRoots),candidates=ownedJson(opts.candidateRoots);
  need(Array.isArray(projects)&&projects.length>0&&projects.length<=64&&Array.isArray(candidates)&&candidates.length<=64,'INVALID_ROOTS');
  const root=await canonicalRoot(opts.root,false),legacyRoot=await canonicalRoot(opts.legacyRoot,false);
  const projectRoots=await Promise.all(projects.map(p=>canonicalRoot(p,true)));
  const candidateRoots=await Promise.all(candidates.map(p=>canonicalRoot(p,false)));
  const all=[root,legacyRoot,...projectRoots,...candidateRoots];
  for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)need(!overlapping(all[i],all[j])&&!overlapping(all[j],all[i]),'ROOT_OVERLAP');
  return Object.freeze({root,legacyRoot,projectRoots:Object.freeze(projectRoots),candidateRoots:Object.freeze(candidateRoots),validateTransition:opts.validateTransition,failpoint:opts.failpoint});
}
function payloadIdentity(payload,jobId,projectId){
  if(payload!==null&&typeof payload==='object'){
    if(Object.hasOwn(payload,'jobId'))need(payload.jobId===jobId,'EVENT_IDENTITY_MISMATCH');
    if(Object.hasOwn(payload,'projectId'))need(payload.projectId===projectId,'EVENT_IDENTITY_MISMATCH');
  }
}
function transition(validate,previous,next,type){
  const result=validate(previous,next,type);
  if(result!==null&&(typeof result==='object'||typeof result==='function')&&typeof result.then==='function'){
    Promise.resolve(result).catch(()=>{});throw error('ASYNC_VALIDATOR');
  }
  need(result===undefined,'INVALID_VALIDATOR_RESULT');
}
async function readCanonical(file){
  const st=await fs.lstat(file);need(st.isFile()&&!st.isSymbolicLink(),'UNSUPPORTED_FILE_TYPE');need(st.size<=STORE_LIMITS.artifact,'ARTIFACT_TOO_LARGE');
  const handle=await fs.open(file,'r');let bytes;
  try{
    // Bound allocation even if a trusted-host file changes after lstat.
    const buffer=Buffer.alloc(st.size+1);let length=0;
    while(length<buffer.length){const r=await handle.read(buffer,length,buffer.length-length,null);if(!r.bytesRead)break;length+=r.bytesRead;}
    need(length===st.size,'CONCURRENT_FILE_CHANGE');bytes=buffer.subarray(0,length);
  }finally{await handle.close();}
  const text=bytes.toString('utf8');need(Buffer.from(text,'utf8').equals(bytes),'INVALID_UTF8');
  let value;try{value=ownedJson(JSON.parse(text));}catch(e){throw error('CORRUPT_JSON',e);}
  need(canonicalize(value)===text,'NONCANONICAL_RECORD');return {value,text,size:bytes.length};
}
async function readArtifact(dir,hash){
  need(HASH.test(hash),'INVALID_DIGEST');const result=await readCanonical(path.join(dir,hash+'.json'));
  need(digest(result.value)===hash,'ARTIFACT_DIGEST_MISMATCH');return result;
}
async function artifactInventory(dir){
  await directory(dir);let bytes=0;const handle=await fs.opendir(dir);
  for await(const item of handle){
    need(/^[a-f0-9]{64}\.json$/.test(item.name),'UNKNOWN_ARTIFACT_ENTRY');
    const record=await readArtifact(dir,item.name.slice(0,-5));bytes+=record.size;need(bytes<=STORE_LIMITS.artifactBytes,'ARTIFACT_RETENTION_EXHAUSTED');
  }
  return bytes;
}
async function readJob(config,folder){
  const dir=path.join(config.root,'jobs',folder);await directory(dir);
  const entries=await names(dir,4);need(entries.length===3&&['artifacts','registration.json','revisions'].every(n=>entries.includes(n)),'UNKNOWN_JOB_ENTRY');
  const {value:reg}=await readCanonical(path.join(dir,'registration.json'));exact(reg,REG_KEYS);
  need(reg.schemaVersion===1,'SCHEMA_VERSION');need(reg.provenance===PROVENANCE,'UNTRUSTED_PROVENANCE');need(validId(reg.jobId)&&HASH.test(reg.projectId),'INVALID_ID');
  need(folder===digest(reg.jobId)&&config.projectRoots.includes(reg.projectRoot)&&reg.projectId===digest(reg.projectRoot),'PROJECT_ID_MISMATCH');
  need(await canonicalRoot(reg.projectRoot,true)===reg.projectRoot,'PROJECT_ID_MISMATCH');
  await directory(path.join(dir,'revisions'));const revisions=await names(path.join(dir,'revisions'),STORE_LIMITS.revisions+1);
  need(revisions.length<=STORE_LIMITS.revisions,'REVISION_RETENTION_EXHAUSTED');
  const artifactBytes=await artifactInventory(path.join(dir,'artifacts'));const history=[];
  for(let i=0;i<revisions.length;i++){
    need(revisions[i]===revisionName(i+1),'REVISION_GAP_OR_UNKNOWN');
    const {value:event}=await readCanonical(path.join(dir,'revisions',revisions[i]));exact(event,EVENT_KEYS);
    need(event.schemaVersion===1,'SCHEMA_VERSION');need(event.provenance===PROVENANCE,'UNTRUSTED_PROVENANCE');
    need(event.jobId===reg.jobId&&event.projectId===reg.projectId,'EVENT_IDENTITY_MISMATCH');
    need(event.revision===i+1&&event.previousDigest===(i?history[i-1].eventDigest:null),'REVISION_CHAIN_MISMATCH');
    need(STORE_EVENT_TYPES.includes(event.type),'UNKNOWN_EVENT_TYPE');need(HASH.test(event.eventDigest),'INVALID_DIGEST');
    const {eventDigest,...body}=event;need(digest(body)===eventDigest,'EVENT_DIGEST_MISMATCH');
    need(Array.isArray(event.artifacts)&&event.artifacts.length<=STORE_LIMITS.references&&new Set(event.artifacts).size===event.artifacts.length,'INVALID_ARTIFACT_REFERENCES');
    for(const hash of event.artifacts)await readArtifact(path.join(dir,'artifacts'),hash);
    payloadIdentity(event.payload,reg.jobId,reg.projectId);transition(config.validateTransition,i?history[i-1].payload:null,event.payload,event.type);history.push(event);
  }
  const refusals=[];if(history.length===STORE_LIMITS.revisions)refusals.push('REVISION_RETENTION_EXHAUSTED');if(artifactBytes===STORE_LIMITS.artifactBytes)refusals.push('ARTIFACT_RETENTION_EXHAUSTED');
  return Object.freeze({jobId:reg.jobId,projectId:reg.projectId,history:Object.freeze(history),latest:history.at(-1)??null,readiness:'inactive',provenance:PROVENANCE,refusals:Object.freeze(refusals),artifactBytes});
}
async function scan(config,allowMissing=false){
  const st=await maybeStat(config.root);if(!st){need(allowMissing,'ROOT_MISSING');return [];}
  await directory(config.root);const entries=await names(config.root,3);need(entries.every(n=>n==='jobs'||n==='lock.json'),'UNKNOWN_ROOT_ENTRY');
  if(!entries.includes('jobs')){need(entries.length===0||entries.length===1&&entries[0]==='lock.json','UNKNOWN_ROOT_ENTRY');return [];}
  const jobsDir=path.join(config.root,'jobs');await directory(jobsDir);const folders=await names(jobsDir,STORE_LIMITS.jobs+1);need(folders.length<=STORE_LIMITS.jobs,'JOB_RETENTION_EXHAUSTED');
  const jobs=[],projects=new Set();
  for(const folder of folders){need(HASH.test(folder),'UNKNOWN_JOB_ENTRY');const job=await readJob(config,folder);need(!projects.has(job.projectId),'PROJECT_BUSY');projects.add(job.projectId);jobs.push(job);}
  return jobs;
}

/** Diagnostic only: never creates a directory, reclaims a lock, or repairs a chain. */
export async function inspectGovernanceStore(options){
  const config=await settings(options,true);const jobs=await scan(config);const lock=await maybeStat(path.join(config.root,'lock.json'));
  const refusals=[];if(lock)refusals.push('LOCKED');if(jobs.length===STORE_LIMITS.jobs)refusals.push('JOB_RETENTION_EXHAUSTED');
  for(const job of jobs)for(const code of job.refusals)if(!refusals.includes(code))refusals.push(code);
  return Object.freeze({readiness:'inactive',provenance:PROVENANCE,locked:!!lock,reconciliationRequired:!!lock||jobs.some(j=>j.latest!==null),jobs:Object.freeze(jobs),refusals:Object.freeze(refusals)});
}

/** Awaited explicit open is the only entry that can create a governance root. */
export async function openGovernanceStore(options){
  const config=await settings(options,false);const hook=config.failpoint;
  let admission=true,revoked=false,closed=false,poisoned=null,queue=Promise.resolve(),closing=null;
  const owner=ownedJson({schemaVersion:1,nonce:randomBytes(32).toString('hex'),generation:randomBytes(32).toString('hex'),pid:process.pid});
  const ownerText=canonicalize(owner),lockPath=path.join(config.root,'lock.json');
  const hit=async(name,context={})=>{if(hook)await hook(name,Object.freeze({...context}));};
  const poison=e=>{admission=false;poisoned??=e;return e;};
  const checkOwner=async()=>{
    try{const {text}=await readCanonical(lockPath);need(text===ownerText,'OWNER_LOST');}
    catch(e){throw poison(e.code==='OWNER_LOST'?e:error('OWNER_LOST',e));}
  };
  async function writeExclusive(file,text,stage,context={},guard=true){
    let handle;let original;
    const boundary=async phase=>{
      await hit(stage+'.'+phase,{stage,...context});
      if(guard){await checkOwner();need(!revoked,'STORE_CLOSED');}
    };
    try{
      await boundary('open');handle=await fs.open(file,'wx',0o600);await boundary('opened');
      await boundary('write');await handle.writeFile(text,'utf8');await boundary('written');
      await boundary('sync');await handle.sync();await boundary('synced');
      await boundary('close');await handle.close();handle=undefined;await boundary('closed');
    }catch(e){original=e;}
    if(original){
      const cleanup=[];
      if(handle){
        try{await hit('cleanup.close',{stage,...context});}catch(e){cleanup.push(e);}
        try{await handle.close();}catch(e){cleanup.push(e);}
      }
      if(cleanup.length)throw Object.assign(new AggregateError([original,...cleanup],'WRITE_AND_CLEANUP_FAILED',{cause:original}),{code:'WRITE_AND_CLEANUP_FAILED'});
      throw original;
    }
  }
  // Existing locks always win, including zero-byte locks and apparently dead PIDs.
  const rootStat=await maybeStat(config.root);
  if(rootStat){await directory(config.root);need(!(await maybeStat(lockPath)),'LOCKED');await scan(config);}
  await fs.mkdir(config.root,{recursive:true,mode:0o700});
  try{await writeExclusive(lockPath,ownerText,'lock',{},false);}catch(e){if(e.code==='EEXIST')throw error('LOCKED',e);throw e;}
  try{
    await checkOwner();if(!(await maybeStat(path.join(config.root,'jobs'))))await fs.mkdir(path.join(config.root,'jobs'),{mode:0o700});
    await scan(config);await checkOwner();
  }catch(e){throw poison(e);}
  const enqueue=operation=>{
    if(!admission)return Promise.reject(poisoned?error('STORE_POISONED',poisoned):error('STORE_CLOSED'));
    const task=queue.then(async()=>{if(poisoned)throw error('STORE_POISONED',poisoned);await checkOwner();return operation();});
    queue=task.catch(()=>{});return task;
  };
  async function checkedScan(){try{return await scan(config);}catch(e){throw poison(e);}}
  async function registerJob(input){
    const regInput=ownedJson(input);exact(regInput,['jobId','projectRoot']);need(validId(regInput.jobId),'INVALID_ID');
    return enqueue(async()=>{
      need(typeof regInput.projectRoot==='string'&&path.isAbsolute(regInput.projectRoot),'INVALID_ROOT');
      const projectRoot=await canonicalRoot(await fs.realpath(regInput.projectRoot),true);need(config.projectRoots.includes(projectRoot),'PROJECT_NOT_SUPPLIED');
      const projectId=digest(projectRoot),jobs=await checkedScan();await checkOwner();need(!revoked,'STORE_CLOSED');
      const existing=jobs.find(j=>j.jobId===regInput.jobId);
      if(existing){need(existing.projectId===projectId,'JOB_ID_CONFLICT');return projectId;}
      need(jobs.length<STORE_LIMITS.jobs,'JOB_RETENTION_EXHAUSTED');need(!jobs.some(j=>j.projectId===projectId),'PROJECT_BUSY');
      const dir=jobPath(config.root,regInput.jobId),reg=ownedJson({schemaVersion:1,provenance:PROVENANCE,jobId:regInput.jobId,projectId,projectRoot});
      try{
        await checkOwner();need(!revoked,'STORE_CLOSED');await fs.mkdir(dir,{mode:0o700});
        await checkOwner();need(!revoked,'STORE_CLOSED');await fs.mkdir(path.join(dir,'revisions'),{mode:0o700});
        await checkOwner();need(!revoked,'STORE_CLOSED');await fs.mkdir(path.join(dir,'artifacts'),{mode:0o700});
        await writeExclusive(path.join(dir,'registration.json'),canonicalize(reg),'registration',{jobId:regInput.jobId});await checkOwner();need(!revoked,'STORE_CLOSED');return projectId;
      }catch(e){throw poison(e);}
    });
  }
  async function append(jobId,input,expectedRevision){
    need(validId(jobId),'INVALID_ID');need(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0,'INVALID_REVISION');
    const opts=plainRecord(input,['type','payload'],['artifacts']);need(STORE_EVENT_TYPES.includes(opts.type),'UNKNOWN_EVENT_TYPE');const payload=ownedJson(opts.payload);
    let artifacts=[];
    if(opts.artifacts!==undefined){
      need(Array.isArray(opts.artifacts)&&Object.getPrototypeOf(opts.artifacts)===Array.prototype&&opts.artifacts.length<=STORE_LIMITS.references,'INVALID_ARTIFACT_REFERENCES');
      const keys=Reflect.ownKeys(opts.artifacts);need(keys.length===opts.artifacts.length+1,'INVALID_ARTIFACT_REFERENCES');
      let total=0;
      for(let i=0;i<opts.artifacts.length;i++){
        const d=Object.getOwnPropertyDescriptor(opts.artifacts,String(i));need(d&&Object.hasOwn(d,'value')&&d.enumerable,'INVALID_DESCRIPTOR');
        const value=ownedJson(d.value),text=canonicalize(value);total+=Buffer.byteLength(text);need(total<=STORE_LIMITS.artifactBytes,'ARTIFACT_RETENTION_EXHAUSTED');artifacts.push({hash:digest(value),text});
      }
      need(new Set(artifacts.map(a=>a.hash)).size===artifacts.length,'DUPLICATE_ARTIFACT');
    }
    return enqueue(async()=>{
      const jobs=await checkedScan(),job=jobs.find(j=>j.jobId===jobId);need(job,'JOB_NOT_REGISTERED');need((job.latest?.revision??0)===expectedRevision,'REVISION_CONFLICT');need(expectedRevision<STORE_LIMITS.revisions,'REVISION_RETENTION_EXHAUSTED');
      payloadIdentity(payload,jobId,job.projectId);transition(config.validateTransition,job.latest?.payload??null,payload,opts.type);await checkOwner();need(!revoked,'STORE_CLOSED');
      const body={schemaVersion:1,provenance:PROVENANCE,jobId,projectId:job.projectId,revision:expectedRevision+1,previousDigest:job.latest?.eventDigest??null,type:opts.type,payload,artifacts:artifacts.map(a=>a.hash)};
      const event=ownedJson({...body,eventDigest:digest(body)}),eventText=canonicalize(event),dir=jobPath(config.root,jobId),artifactDir=path.join(dir,'artifacts');
      let extra=0;const missing=[];
      try{
        for(const artifact of artifacts){
          const file=path.join(artifactDir,artifact.hash+'.json');
          if(await maybeStat(file)){const stored=await readArtifact(artifactDir,artifact.hash);need(stored.text===artifact.text,'ARTIFACT_DIGEST_MISMATCH');}
          else{extra+=Buffer.byteLength(artifact.text);missing.push(artifact);}
        }
      }catch(e){throw poison(e);}
      need(job.artifactBytes+extra<=STORE_LIMITS.artifactBytes,'ARTIFACT_RETENTION_EXHAUSTED');
      try{
        await checkOwner();
        for(const artifact of missing)await writeExclusive(path.join(artifactDir,artifact.hash+'.json'),artifact.text,'artifact',{jobId,revision:event.revision});
        await writeExclusive(path.join(dir,'revisions',revisionName(event.revision)),eventText,'event',{jobId,revision:event.revision});
        await hit('event.postcommit',{stage:'event',jobId,revision:event.revision});await checkOwner();need(!revoked,'STORE_CLOSED');return event;
      }catch(e){throw poison(e);}
    });
  }
  async function load(jobId){
    need(validId(jobId),'INVALID_ID');
    return enqueue(async()=>{const jobs=await checkedScan();await checkOwner();const job=jobs.find(j=>j.jobId===jobId);need(job,'JOB_NOT_REGISTERED');return job;});
  }
  function revoke(){admission=false;revoked=true;}
  function close(){
    if(closing)return closing;revoke();
    closing=(async()=>{
      await queue;if(poisoned)throw error('STORE_POISONED',poisoned);
      try{await checkOwner();await hit('lock.release',{stage:'lock'});await checkOwner();await fs.unlink(lockPath);closed=true;}
      catch(e){throw poison(e);}
    })();return closing;
  }
  function status(){return Object.freeze({readiness:'inactive',provenance:PROVENANCE,admission,revoked,closed,poisoned:!!poisoned,reconciliationRequired:!!poisoned,refusals:Object.freeze(poisoned?['STORE_POISONED',poisoned.code??'IO_ERROR']:closed||revoked?['STORE_CLOSED']:[])});}
  return Object.freeze({registerJob,append,load,revoke,close,status});
}

// V2 is a separate absent-root journal. Reopening never recreates live admission.
import * as fsV2 from 'node:fs';
import {V2_PROVENANCE, validateStateV2, validateTransitionV2,validateControlBindingM4,validateReadRequestM4,boundedResponseM4,M4_READ_LIMITS,DELIVERY_EVENTS_M4B,validateDeliveryAuditM4B,ACCEPTANCE_EVENT_V2,validateAcceptanceAuditV2} from './contracts.mjs';
const V2_TYPES=Object.freeze(['PLAN_PROPOSED','ASSIGNMENT_CREATED','RESULT_RECORDED','HUMAN_DECIDED','ATTEMPT_RESERVED','CANDIDATE_SEALED','EVIDENCE_REGISTERED','DIAGNOSTIC_READY','AUTHOR_FAILED','STOPPED','CONTROL_RECORDED',...DELIVERY_EVENTS_M4B,ACCEPTANCE_EVENT_V2]);
const m4StoreAuthorities=new WeakMap();
export function bindGovernanceAuthorityM4(store,authorize){const binding=m4StoreAuthorities.get(store);need(binding&&!binding.bound,'M4_OWNER_ALREADY_BOUND_OR_UNKNOWN');need(typeof authorize==='function','MISSING_OWNER_AUTHORITY');binding.bound=true;need(authorize()===true,'OWNER_AUTHORITY_REFUSED');binding.callback=authorize;store.assertOwner();}
const v2Node=st=>({dev:st.dev,ino:st.ino,mode:st.mode,nlink:st.nlink,size:st.size,mtime:st.mtimeNs,ctime:st.ctimeNs});
const v2Stat=p=>fsV2.lstatSync(p,{bigint:true});
const v2Same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const v2Identity=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs??s.mtime,s.ctimeNs??s.ctime].join(':');
function v2Maybe(p){try{return v2Stat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function v2Dir(st){need(st&&st.isDirectory()&&!st.isSymbolicLink()&&st.ino>0n,'UNSUPPORTED_DIRECTORY');}
function v2File(st){need(st&&st.isFile()&&!st.isSymbolicLink()&&st.nlink===1n&&st.ino>0n,'UNSUPPORTED_FILE_TYPE');}
function v2Names(dir,max=65536){const out=[],d=fsV2.opendirSync(dir);try{for(let e;(e=d.readSync())!==null;){need(out.length<max,'ENTRY_LIMIT');out.push(e.name);}}finally{d.closeSync();}return out.sort();}
function v2Path(input,{missing=false,file=false}={}){
  need(typeof input==='string'&&input.length>0&&input.length<=4096&&path.isAbsolute(input)&&!/[\x00-\x1f\x7f]/.test(input),'INVALID_ROOT');
  const parsed=path.parse(input);need(input!==parsed.root&&!input.startsWith('\\\\')&&!input.startsWith('//'),'INVALID_ROOT');
  if(process.platform==='win32')need(/^[A-Za-z]:[\\/]/.test(input)&&!/[<>"|?*]/.test(input)&&!input.slice(2).includes(':'),'INVALID_ROOT');
  const parts=input.slice(parsed.root.length).split(/[\\/]/);need(parts.every(p=>p&&p!=='.'&&p!=='..'&&!/[ .]$/.test(p)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)),'INVALID_ROOT');
  const target=path.normalize(input);let dir=path.parse(target).root,absent=false,last=dir;v2Dir(v2Stat(dir));
  const segments=target.slice(dir.length).split(path.sep);
  for(let i=0;i<segments.length;i++){const name=segments[i],next=path.join(dir,name);if(!absent){const names=v2Names(dir);if(!names.includes(name)){need(!names.some(n=>n.toLowerCase()===name.toLowerCase()),'PATH_ALIAS');need(missing,'PATH_MISSING');absent=true;}else{const st=v2Stat(next);if(file&&i===segments.length-1)v2File(st);else v2Dir(st);last=next;}}dir=next;}
  const spelling=s=>process.platform==='win32'?s[0].toUpperCase()+s.slice(1):s;need(spelling(fsV2.realpathSync.native(last))===spelling(last),'PATH_ALIAS');return target;
}
function v2Retain(dir){v2Path(dir);const nodes=new Map();let p=path.parse(dir).root;nodes.set(p,v2Node(v2Stat(p)));for(const part of dir.slice(p.length).split(path.sep)){p=path.join(p,part);nodes.set(p,v2Node(v2Stat(p)));}return nodes;}
function v2CheckNodes(nodes){for(const [p,st]of nodes){if(p!==path.parse(p).root)v2Path(p);const now=v2Stat(p);v2Dir(now);need(v2Same(st,now),'OWNER_DIRECTORY_CHANGED');}}
function v2CheckRetained(retained){
  for(const [file,identity]of retained){const stat=v2Maybe(file);need(stat!==null,'RETAINED_FILE_MISSING');v2File(stat);need(v2Identity(stat)===identity,'FILE_IDENTITY_CHANGED');}
}
function v2Read(file){
  v2Path(file,{file:true});const initial=v2Stat(file);v2File(initial);need(initial.size<=BigInt(STORE_LIMITS.artifact),'ARTIFACT_TOO_LARGE');let fd;
  try{fd=fsV2.openSync(file,'r');const opened=fsV2.fstatSync(fd,{bigint:true});v2File(opened);need(v2Identity(initial)===v2Identity(opened),'FILE_CHANGED');
    const bytes=Buffer.alloc(Number(opened.size)+1);let length=0;while(length<bytes.length){const n=fsV2.readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n;}
    const after=fsV2.fstatSync(fd,{bigint:true});need(length===Number(opened.size)&&v2Identity(opened)===v2Identity(after)&&v2Identity(v2Stat(file))===v2Identity(after),'FILE_CHANGED');
    const text=bytes.subarray(0,length).toString('utf8');need(Buffer.from(text,'utf8').equals(bytes.subarray(0,length)),'INVALID_UTF8');let value;try{value=ownedJson(JSON.parse(text));}catch(e){throw error('CORRUPT_JSON',e);}need(canonicalize(value)===text,'NONCANONICAL_RECORD');return {value,text,identity:v2Identity(after),node:v2Node(after),bytes:length};
  }finally{if(fd!==undefined)fsV2.closeSync(fd);}
}
function v2Settings(input){const o=plainRecord(input,['root','projectRoot','protectedRoots'],['failpoint']);need(o.failpoint===undefined||typeof o.failpoint==='function','INVALID_FAILPOINT');const protectedRoots=ownedJson(o.protectedRoots);need(Array.isArray(protectedRoots)&&protectedRoots.length<=64,'INVALID_ROOTS');const projectRoot=v2Path(o.projectRoot),root=v2Path(o.root,{missing:true}),others=protectedRoots.map(p=>v2Path(p,{missing:true}));const roots=[root,projectRoot,...others].map(fold);for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)need(!overlapping(roots[i],roots[j])&&!overlapping(roots[j],roots[i]),'ROOT_OVERLAP');return {root,projectRoot,projectId:digest(fold(projectRoot)),protectedRoots:others,failpoint:o.failpoint};}
function v2Scan(c,retained){
  v2Path(c.root);const names=v2Names(c.root,5);need(names.includes('version.json')&&names.includes('artifacts')&&names.includes('revisions')&&names.every(n=>['version.json','artifacts','revisions','lock.json'].includes(n)),'UNKNOWN_ROOT_ENTRY');
  const read=p=>{const r=v2Read(p);if(retained){const old=retained.get(p);need(old!==undefined&&old===r.identity,'FILE_IDENTITY_CHANGED');}return r;};
  const marker=read(path.join(c.root,'version.json')).value;exact(marker,['schemaVersion','provenance','projectId','projectRoot']);need(marker.schemaVersion===2&&marker.provenance===V2_PROVENANCE&&marker.projectId===c.projectId&&marker.projectRoot===c.projectRoot,'V2_STORE_IDENTITY');
  const artifactDir=path.join(c.root,'artifacts'),revisionDir=path.join(c.root,'revisions');v2Path(artifactDir);v2Path(revisionDir);let artifactBytes=0;const artifacts=new Map();
  for(const name of v2Names(artifactDir,STORE_LIMITS.references*STORE_LIMITS.revisions)){need(/^[a-f0-9]{64}\.json$/.test(name),'UNKNOWN_ARTIFACT_ENTRY');const r=read(path.join(artifactDir,name));need(digest(r.value)===name.slice(0,-5),'ARTIFACT_DIGEST_MISMATCH');artifactBytes+=r.bytes;need(artifactBytes<=STORE_LIMITS.artifactBytes,'ARTIFACT_RETENTION_EXHAUSTED');artifacts.set(name.slice(0,-5),r.value);}
  const revisions=v2Names(revisionDir,STORE_LIMITS.revisions+1),history=[];need(revisions.length<=STORE_LIMITS.revisions,'REVISION_RETENTION_EXHAUSTED');
  for(let i=0;i<revisions.length;i++){
    need(revisions[i]===revisionName(i+1),'REVISION_GAP_OR_UNKNOWN');const event=read(path.join(revisionDir,revisions[i])).value;exact(event,['schemaVersion','provenance','revision','previousDigest','type','payload','artifacts','eventDigest']);need(event.schemaVersion===2&&event.provenance===V2_PROVENANCE&&V2_TYPES.includes(event.type)&&event.revision===i+1&&event.previousDigest===(i?history[i-1].eventDigest:null),'REVISION_CHAIN_MISMATCH');
    const {eventDigest,...body}=event;need(digest(body)===eventDigest,'EVENT_DIGEST_MISMATCH');const state=validateTransitionV2(i?history[i-1].payload:null,event.type,event.payload);need(state.revision===event.revision&&state.projectId===c.projectId&&state.action.type===event.type,'EVENT_IDENTITY_MISMATCH');
    need(Array.isArray(event.artifacts)&&event.artifacts.length<=STORE_LIMITS.references&&new Set(event.artifacts).size===event.artifacts.length,'INVALID_ARTIFACT_REFERENCES');for(const hash of event.artifacts)need(HASH.test(hash)&&artifacts.has(hash),'ARTIFACT_MISSING');
    if(event.type==='CONTROL_RECORDED')validateControlBindingM4(history.at(-1)?.payload??null,state,event.previousDigest,event.artifacts.map(hash=>artifacts.get(hash)));
    if(DELIVERY_EVENTS_M4B.includes(event.type))validateDeliveryAuditM4B(history,event.type,state,event.previousDigest,event.artifacts.map(hash=>artifacts.get(hash)),hash=>artifacts.get(hash));
    if(event.type===ACCEPTANCE_EVENT_V2)validateAcceptanceAuditV2(history,event.type,state,event.previousDigest,event.artifacts.map(hash=>artifacts.get(hash)));
    const references=new Set([...history.flatMap(e=>e.artifacts),...event.artifacts]);for(const result of state.results)if(result.submissionArtifactHash!==null)need(references.has(result.submissionArtifactHash)&&digest(result.submission)===result.submissionArtifactHash,'SUBMISSION_ARTIFACT_MISSING');
    for(const evidence of state.evidence){need(references.has(evidence.artifactHash),'EVIDENCE_ARTIFACT_MISSING');if(evidence.kind==='test')for(const hash of evidence.details.logArtifacts)need(references.has(hash),'LOG_ARTIFACT_MISSING');}history.push(event);
  }
  return {history,latest:history.at(-1)??null,artifactBytes,artifacts};
}
function v2Snapshot(c,scan,reconciliationRequired,extra={}){
  // Each scanned event is already independently owned and bounded; history has its own retention cap.
  need(scan.history.length<=STORE_LIMITS.revisions,'REVISION_RETENTION_EXHAUSTED');
  const header=ownedJson({schemaVersion:2,provenance:V2_PROVENANCE,projectId:c.projectId,projectRoot:c.projectRoot,readiness:'inactive',reconciliationRequired,...extra});
  const history=Object.freeze(scan.history.slice());return Object.freeze({...header,history,latest:history.at(-1)??null});
}
export async function inspectGovernanceStoreV2(input){const c=v2Settings(input),s=v2Scan(c);return v2Snapshot(c,s,true,{locked:!!v2Maybe(path.join(c.root,'lock.json'))});}
export async function openGovernanceStoreV2(input){
  const c=v2Settings(input);
  if(v2Maybe(c.root)){
    const snapshot=await inspectGovernanceStoreV2(input);const refuse=()=>{throw error('RECONCILIATION_REQUIRED');};
    return Object.freeze({load:async()=>snapshot,append:refuse,readArtifact:refuse,assertOwner:refuse,revoke(){},close:async()=>{},status:()=>Object.freeze({schemaVersion:2,provenance:V2_PROVENANCE,admission:false,revoked:true,closed:true,poisoned:false,reconciliationRequired:true,projectId:c.projectId,revision:snapshot.latest?.revision??0})});
  }
  const nodes=v2Retain(path.dirname(c.root)),retained=new Map(),root=c.root,lock=path.join(root,'lock.json'),artifactDir=path.join(root,'artifacts'),revisionDir=path.join(root,'revisions');
  let poisoned=null,revoked=false,closed=false,epoch=0,lockIdentity=null,queue=Promise.resolve(),closing,latest=null;const m4Authority={callback:null,bound:false};
  const ownerText=canonicalize({schemaVersion:2,provenance:V2_PROVENANCE,nonce:randomBytes(32).toString('hex'),projectId:c.projectId});
  const poison=e=>{poisoned??=e;revoked=true;epoch++;return e;};
  const hit=async(name,context={})=>{if(c.failpoint)try{await c.failpoint(name,ownedJson(context));}catch(e){throw typeof e?.code==='string'?e:error('FAILPOINT_FAILED',e);}};
  function ownerCheck(allowRevoked=false){try{need(!poisoned,'STORE_POISONED');need(allowRevoked||!revoked,'STORE_CLOSED');const observedEpoch=epoch;if(m4Authority.callback)need(m4Authority.callback()===true,'OWNER_AUTHORITY_REFUSED');need(!poisoned&&observedEpoch===epoch&&(allowRevoked||!revoked),'STALE_EPOCH');v2CheckNodes(nodes);v2CheckRetained(retained);if(latest!==null)need(retained.get(path.join(revisionDir,revisionName(latest.revision)))===latest.identity,'JOURNAL_ROLLBACK');if(lockIdentity!==null){const r=v2Read(lock);need(r.identity===lockIdentity&&r.text===ownerText,'OWNER_LOST');}}catch(e){if(e.code==='STORE_CLOSED')throw e;throw poison(e);}}
  function admitted(e){ownerCheck();need(epoch===e,'STALE_EPOCH');}
  async function mkdir(dir,stage){await hit(stage+'.mkdir.before',{path:dir});ownerCheck();v2Path(dir,{missing:true});need(!v2Maybe(dir),'TARGET_EXISTS');fsV2.mkdirSync(dir,{mode:0o700});nodes.set(dir,v2Node(v2Stat(dir)));await hit(stage+'.mkdir.after',{path:dir});ownerCheck();}
  async function write(file,text,stage,e){let fd,opened,primary,verified;const context={path:file,stage};
    const check=()=>{admitted(e);if(fd!==undefined){const st=fsV2.fstatSync(fd,{bigint:true}),named=v2Stat(file);v2File(st);v2File(named);need(v2Same(opened,st)&&v2Same(st,named),'WRITE_TARGET_CHANGED');}};
    try{
      await hit(stage+'.open.before',context);admitted(e);v2Path(file,{missing:true,file:true});need(!v2Maybe(file),'TARGET_EXISTS');fd=fsV2.openSync(file,'wx',0o600);opened=fsV2.fstatSync(fd,{bigint:true});v2File(opened);await hit(stage+'.open.after',context);check();
      const bytes=Buffer.from(text);let offset=0;do{await hit(stage+'.write.before',{...context,offset});check();const n=fsV2.writeSync(fd,bytes,offset,bytes.length-offset,null);need(n>0||bytes.length===0,'INCOMPLETE_WRITE');offset+=n;await hit(stage+'.write.after',{...context,offset});check();}while(offset<bytes.length);
      await hit(stage+'.sync.before',context);check();fsV2.fsyncSync(fd);await hit(stage+'.sync.after',context);check();await hit(stage+'.close.before',context);check();fsV2.closeSync(fd);fd=undefined;
      await hit(stage+'.close.after',context);admitted(e);const read=v2Read(file);need(v2Same(opened,read.node)&&read.text===text,'WRITE_TARGET_CHANGED');verified=read.identity;
    }catch(e){primary=e;}finally{if(fd!==undefined)try{fsV2.closeSync(fd);}catch(e){primary=error('WRITE_AND_CLEANUP_FAILED',new AggregateError([primary,e].filter(Boolean)));}}
    if(primary)throw primary;need(!retained.has(file),'RETAINED_FILE_REBOUND');retained.set(file,verified);return verified;
  }
  function scan(){ownerCheck();try{const s=v2Scan(c,retained);if(latest!==null)need(s.history[latest.revision-1]?.eventDigest===latest.eventDigest,'JOURNAL_ROLLBACK');ownerCheck();return s;}catch(e){throw poison(e);}}
  try{
    await mkdir(root,'root');const e=epoch;lockIdentity=await write(lock,ownerText,'lock',e);ownerCheck();
    await write(path.join(root,'version.json'),canonicalize({schemaVersion:2,provenance:V2_PROVENANCE,projectId:c.projectId,projectRoot:c.projectRoot}),'version',e);
    await mkdir(artifactDir,'artifacts');await mkdir(revisionDir,'revisions');scan();
  }catch(e){throw poison(e);}
  const enqueue=fn=>{if(revoked)return Promise.reject(error(poisoned?'STORE_POISONED':'STORE_CLOSED'));const e=epoch;const task=queue.then(()=>{admitted(e);return fn(e);});queue=task.catch(()=>{});return task;};
  function append(input,expectedRevision){
    const o=ownedJson(input);exact(o,['type','payload','artifacts']);need(V2_TYPES.includes(o.type),'UNKNOWN_EVENT_TYPE');const state=validateStateV2(o.payload);need(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0&&state.revision===expectedRevision+1&&state.projectId===c.projectId&&state.action.type===o.type,'INVALID_REVISION');
    need(Array.isArray(o.artifacts)&&o.artifacts.length<=STORE_LIMITS.references,'INVALID_ARTIFACT_REFERENCES');const prepared=o.artifacts.map(value=>({hash:digest(value),text:canonicalize(value)}));need(new Set(prepared.map(a=>a.hash)).size===prepared.length,'DUPLICATE_ARTIFACT');
    return enqueue(async e=>{const s=scan();need((s.latest?.revision??0)===expectedRevision,'REVISION_CONFLICT');validateTransitionV2(s.latest?.payload??null,o.type,state);if(o.type==='CONTROL_RECORDED')validateControlBindingM4(s.latest?.payload??null,state,s.latest?.eventDigest??null,o.artifacts);if(DELIVERY_EVENTS_M4B.includes(o.type))validateDeliveryAuditM4B(s.history,o.type,state,s.latest?.eventDigest??null,o.artifacts,hash=>s.artifacts.get(hash));if(o.type===ACCEPTANCE_EVENT_V2)validateAcceptanceAuditV2(s.history,o.type,state,s.latest?.eventDigest??null,o.artifacts);need(expectedRevision<STORE_LIMITS.revisions,'REVISION_RETENTION_EXHAUSTED');
      const body={schemaVersion:2,provenance:V2_PROVENANCE,revision:expectedRevision+1,previousDigest:s.latest?.eventDigest??null,type:o.type,payload:state,artifacts:prepared.map(a=>a.hash)},event=ownedJson({...body,eventDigest:digest(body)});
      let extra=0;for(const a of prepared)if(!s.artifacts.has(a.hash))extra+=Buffer.byteLength(a.text);need(s.artifactBytes+extra<=STORE_LIMITS.artifactBytes,'ARTIFACT_RETENTION_EXHAUSTED');
      try{for(const a of prepared)if(!s.artifacts.has(a.hash))await write(path.join(artifactDir,a.hash+'.json'),a.text,'artifact',e);await write(path.join(revisionDir,revisionName(event.revision)),canonicalize(event),'event',e);await hit('event.beforeAck',{revision:event.revision});admitted(e);const reread=scan();need(reread.latest.eventDigest===event.eventDigest,'EVENT_CHANGED');latest=Object.freeze({revision:event.revision,eventDigest:event.eventDigest,identity:retained.get(path.join(revisionDir,revisionName(event.revision)))});return event;}catch(e){throw poison(e);}
    });
  }
  function load(){return enqueue(()=>v2Snapshot(c,scan(),false));}
  function readArtifact(input){const o=ownedJson(input);exact(o,['revision','hash']);need(Number.isSafeInteger(o.revision)&&o.revision>0&&HASH.test(o.hash),'INVALID_ARTIFACT_REFERENCE');return enqueue(async e=>{await hit('artifact.read.before',o);admitted(e);const s=scan(),event=s.history[o.revision-1];need(event&&event.artifacts.includes(o.hash),'FOREIGN_ARTIFACT');const value=s.artifacts.get(o.hash);need(value!==undefined,'ARTIFACT_MISSING');await hit('artifact.read.after',o);admitted(e);scan();return value;});}
  function revoke(){if(!revoked){revoked=true;epoch++;}}
  function close(){if(closing)return closing;revoke();closing=(async()=>{await queue;ownerCheck(true);await hit('lock.release.before',{});ownerCheck(true);fsV2.unlinkSync(lock);lockIdentity=null;closed=true;await hit('lock.release.after',{});})();return closing;}
  const status=()=>Object.freeze({schemaVersion:2,provenance:V2_PROVENANCE,admission:!revoked&&!poisoned,revoked,closed,poisoned:!!poisoned,reconciliationRequired:!!poisoned,projectId:c.projectId,revision:latest?.revision??0});
  const api=Object.freeze({append,load,readArtifact,assertOwner:()=>ownerCheck(),status,revoke,close});m4StoreAuthorities.set(api,m4Authority);return api;
}

const m4DefaultRead=()=>({kind:'status',id:null,offset:0,limit:1,cursor:null});
function m4Status(snapshot,live){const s=snapshot.latest?.payload;return {mode:live?'same-owner':'diagnostic',phase:s?.phase??'EMPTY',jobId:s?.jobId??null,projectId:s?.projectId??null,planReviewResultId:s?.results.findLast(r=>r.role==='plan-review')?.id??null,planDigest:s?digest(s.plan):null,candidateDigest:s?.candidate??null,attemptsUsed:s?.attempts.length??0,attemptsRemaining:live?3-(s?.attempts.length??0):null,admission:live,gateActive:false,accepted:false,refusalReason:live?null:'RECONCILIATION_REQUIRED'};}
function m4ArtifactProjection(snapshot,hash,value){
  const s=snapshot.latest?.payload;need(s,'FOREIGN_ARTIFACT');
  const evidence=s.evidence.find(e=>e.artifactHash===hash);
  if(evidence)return evidence.kind==='frozen'?{kind:'frozen',candidateDigest:evidence.contentDigest,assignmentId:evidence.assignmentId,generation:evidence.generation,fileCount:value.files.length,deletionCount:value.deletions.length,files:value.files.map(f=>({path:f.path,sha256:f.sha256,bytes:f.bytes})),deletions:value.deletions.map(f=>({path:f.path,sha256:f.sha256}))}:{kind:'test',id:evidence.id,status:evidence.status,binding:evidence.binding,details:evidence.details};
  const result=s.results.find(r=>r.submissionArtifactHash===hash);if(result)return {kind:'submission',role:result.role,assignmentId:result.assignmentId,outcome:result.outcome,criteria:result.submission.criteria,findings:result.submission.findings.map(f=>({id:f.id,criterionId:f.criterionId,severity:f.severity,status:f.status})),evidenceIds:result.submission.evidenceIds};
  if(s.evidence.some(e=>e.kind==='test'&&e.details.logArtifacts.includes(hash)))return {kind:'log-metadata',stream:value.stream,offset:value.offset,characters:typeof value.text==='string'?value.text.length:0,rawTextAvailable:false};
  if(snapshot.history.some(e=>e.type==='CONTROL_RECORDED'&&e.artifacts.includes(hash)))return {kind:'control',operation:value.kind,checkpointDigest:value.checkpointDigest,epoch:value.epoch,priorHeadDigest:value.priorHeadDigest,planDigest:value.planDigest,decisionDigest:value.decisionDigest,attemptsDigest:value.attemptsDigest,attemptsUsed:value.attemptsUsed,nextAction:value.nextAction};
  if(snapshot.history.some(e=>DELIVERY_EVENTS_M4B.includes(e.type)&&e.artifacts.includes(hash)))return {kind:value.kind,qualificationOnly:true,operationallyAccepted:false,gateActive:false,id:value.id,candidateDigest:value.candidateDigest,priorHeadDigest:value.priorHeadDigest,qualificationReceiptDigest:value.qualificationReceiptDigest??hash,destinationId:value.destinationId??null,descriptorDigest:value.descriptorDigest??null,payloadInventoryDigest:value.payloadInventoryDigest??null};
  if(snapshot.history.some(e=>e.type===ACCEPTANCE_EVENT_V2&&e.artifacts.includes(hash)))return {kind:'acceptance-recorded',operationallyAccepted:false,gateActive:false,id:value.id,candidateDigest:value.candidateDigest,priorHeadDigest:value.priorHeadDigest,planDigest:value.planDigest,acceptanceDigest:value.acceptanceDigest};
  need(false,'ARTIFACT_NOT_PUBLIC');
}
function m4Page(snapshot,request,live,artifact){
  const r=validateReadRequestM4(request),headDigest=snapshot.latest?.eventDigest??null,cursor=digest({headDigest,kind:r.kind,id:r.id});need(r.cursor===null||r.cursor===cursor,'STALE_CURSOR');
  const base={schemaVersion:1,origin:live?'live-owner':'cold-diagnostic',headAuthenticity:live?'live-verified':'unproven',headDigest,revision:snapshot.latest?.revision??0,cursor,kind:r.kind,id:r.id,offset:r.offset,nextOffset:null,complete:true,rows:[],text:null,status:null};
  if(r.kind==='status')return boundedResponseM4({...base,status:m4Status(snapshot,live)});
  if(r.kind==='artifact'){
    const full=canonicalize(m4ArtifactProjection(snapshot,r.id,artifact));need(r.offset<=full.length,'INVALID_OFFSET');need(!(r.offset>0&&/[\uDC00-\uDFFF]/.test(full[r.offset])),'INVALID_OFFSET');let end=Math.min(full.length,r.offset+r.limit);if(end<full.length&&/[\uDC00-\uDFFF]/.test(full[end]))end--;need(end>r.offset||end===full.length,'PAGE_LIMIT_TOO_SMALL');
    for(;;){const page={...base,text:full.slice(r.offset,end),complete:end===full.length,nextOffset:end===full.length?null:end};try{return boundedResponseM4(page);}catch(e){if(e.code!=='READ_RESPONSE_TOO_LARGE')throw e;end--;if(end>r.offset&&/[\uDC00-\uDFFF]/.test(full[end]))end--;need(end>r.offset,'PAGE_LIMIT_TOO_SMALL');}}
  }
  const all=r.kind==='history'?snapshot.history.map(e=>({revision:e.revision,eventDigest:e.eventDigest,type:e.type,phase:e.payload.phase,artifacts:e.artifacts})):snapshot.latest?.payload.evidence.map(e=>({id:e.id,kind:e.kind,status:e.status,generation:e.generation,candidateDigest:e.binding.candidateDigest,artifactHash:e.artifactHash}))??[];
  need(r.offset<=all.length,'INVALID_OFFSET');let rows=all.slice(r.offset,r.offset+r.limit);
  for(;;){const end=r.offset+rows.length;try{return boundedResponseM4({...base,rows,complete:end===all.length,nextOffset:end===all.length?null:end});}catch(e){if(e.code!=='READ_RESPONSE_TOO_LARGE')throw e;need(rows.length>1,'READ_ROW_TOO_LARGE');rows=rows.slice(0,-1);}}
}
export async function readGovernanceM4(store,request=m4DefaultRead()){
  const r=validateReadRequestM4(request);need(store&&typeof store.assertOwner==='function','MISSING_OWNER_PORT');store.assertOwner();const snapshot=await store.load();store.assertOwner();need(!snapshot.reconciliationRequired,'RECONCILIATION_REQUIRED');let artifact;
  if(r.kind==='artifact'){const event=snapshot.history.find(e=>e.artifacts.includes(r.id));need(event,'FOREIGN_ARTIFACT');artifact=await store.readArtifact({revision:event.revision,hash:r.id});store.assertOwner();}
  const response=m4Page(snapshot,r,true,artifact),current=await store.load();store.assertOwner();need(current.latest?.eventDigest===snapshot.latest?.eventDigest,'STALE_CURSOR');return response;
}
export async function readQualificationArtifactM4B(options,request){
  const r=ownedJson(request);exact(r,['revision','hash']);need(Number.isSafeInteger(r.revision)&&r.revision>0&&HASH.test(r.hash),'INVALID_ARTIFACT_REFERENCE');const c=v2Settings(options),snapshot=v2Scan(c),event=snapshot.history[r.revision-1];need(event&&DELIVERY_EVENTS_M4B.includes(event.type)&&event.artifacts.length===1&&event.artifacts[0]===r.hash,'FOREIGN_ARTIFACT');return snapshot.artifacts.get(r.hash);
}
export async function inspectGovernanceM4(options,request=m4DefaultRead()){
  const r=validateReadRequestM4(request),c=v2Settings(options),snapshot=v2Scan(c);let artifact;
  if(r.kind==='artifact'){need(snapshot.history.some(e=>e.artifacts.includes(r.id)),'FOREIGN_ARTIFACT');artifact=snapshot.artifacts.get(r.id);need(artifact!==undefined,'ARTIFACT_MISSING');}
  const response=m4Page(snapshot,r,false,artifact),again=v2Scan(c);need(again.latest?.eventDigest===snapshot.latest?.eventDigest,'STALE_CURSOR');return response;
}

