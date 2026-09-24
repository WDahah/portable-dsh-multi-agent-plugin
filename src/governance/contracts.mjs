import {createHash} from 'node:crypto';

// M1 records are owned fixture data, never live Cordis objects or operational grants.
export const PROVENANCE = 'fixture-untrusted';
export const LIMITS = Object.freeze({depth:16,nodes:10000,bytes:1048576,text:16384});
export function need(ok, code='INVALID_RECORD') {
  if (!ok) throw Object.assign(new Error(code), {code});
}

/** Validate before copying; descriptors avoid evaluating accessors supplied as data. */
export function ownedJson(input) {
  let nodes=0,bytes=0;const seen=new Set();
  const charge=n=>{bytes+=n;need(bytes<=LIMITS.bytes,'ARTIFACT_TOO_LARGE');};
  function walk(value,depth) {
    need(depth<=LIMITS.depth && ++nodes<=LIMITS.nodes,'STRUCTURE_LIMIT');
    if(value===null){charge(4);return null;}
    if(typeof value==='boolean'){charge(value?4:5);return value;}
    if(typeof value==='number'){
      need(Number.isSafeInteger(value)&&!Object.is(value,-0),'INVALID_NUMBER');charge(String(value).length);return value;
    }
    if(typeof value==='string'){
      need(Buffer.byteLength(value,'utf8')<=LIMITS.bytes,'ARTIFACT_TOO_LARGE');
      // Lone surrogate replacement is a lossy UTF-8 encoding.
      need(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),'INVALID_UNICODE');
      charge(Buffer.byteLength(JSON.stringify(value),'utf8'));return value;
    }
    need(value!==null&&typeof value==='object','INVALID_JSON');
    const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
    need(array?proto===Array.prototype:proto===Object.prototype||proto===null,'INVALID_PROTOTYPE');
    need(!seen.has(value),'CYCLIC_DATA');seen.add(value);
    const keys=Reflect.ownKeys(value);need(keys.length<=LIMITS.nodes,'STRUCTURE_LIMIT');
    need(keys.every(k=>typeof k==='string'),'INVALID_JSON');
    charge(2);
    let out;
    if(array){
      need(keys.length===value.length+1 && value.length<=LIMITS.nodes,'SPARSE_ARRAY');out=[];
      for(let i=0;i<value.length;i++){
        const d=Object.getOwnPropertyDescriptor(value,String(i));need(d&&Object.hasOwn(d,'value')&&d.enumerable,'INVALID_DESCRIPTOR');
        if(i)charge(1);out.push(walk(d.value,depth+1));
      }
    }else{
      out={};
      keys.sort().forEach((key,i)=>{
        const d=Object.getOwnPropertyDescriptor(value,key);need(d&&Object.hasOwn(d,'value')&&d.enumerable,'INVALID_DESCRIPTOR');
        need(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(key),'INVALID_UNICODE');
        charge(Buffer.byteLength(JSON.stringify(key),'utf8')+1+(i?1:0));
        Object.defineProperty(out,key,{value:walk(d.value,depth+1),enumerable:true});
      });
    }
    seen.delete(value);return Object.freeze(out);
  }
  return walk(input,0);
}
export function canonicalize(value) {
  const owned=ownedJson(value);
  const encode=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(encode).join(',')+']':
    '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+encode(v[k])).join(',')+'}';
  return encode(owned);
}
export const digest=value=>createHash('sha256').update(canonicalize(value),'utf8').digest('hex');
export function exact(o,keys) {
  need(o&&typeof o==='object'&&!Array.isArray(o),'CLOSED_SCHEMA');
  const actual=Object.keys(o);need(actual.length===keys.length&&keys.every(k=>Object.hasOwn(o,k)),'CLOSED_SCHEMA');
}
export const id=value=>{need(typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value),'INVALID_ID');return value;};
export const hash=value=>{need(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),'INVALID_DIGEST');return value;};
export const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>{need(Number.isSafeInteger(v)&&v>=min&&v<=max,'INVALID_INTEGER');return v;};
export const text=v=>{need(typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v,'utf8')<=LIMITS.text,'INVALID_TEXT');return v;};
export const enumeration=(v,values)=>{need(values.includes(v),'INVALID_ENUM');return v;};
export function list(v,max,validate,unique=x=>x) {
  need(Array.isArray(v)&&v.length<=max,'INVALID_LIST');const ids=new Set();
  for(const item of v){validate(item);const key=unique(item);need(!ids.has(key),'DUPLICATE_ID');ids.add(key);}
}
export function relativePath(v) {
  text(v);need(v.length<=512&&!/[\\:\x00-\x1f\x7f<>"|?*]/.test(v),'INVALID_PATH');
  const parts=v.split('/');need(parts.every(p=>p&&p!=='.'&&p!=='..'&&!/[ .]$/.test(p)&&
    !/^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)),'INVALID_PATH');return v;
}
const paths=v=>list(v,256,relativePath,p=>p.toLowerCase());
const provenance=v=>need(v===PROVENANCE,'UNTRUSTED_PROVENANCE');
export function validateActor(value) {
  const o=ownedJson(value);exact(o,['id','provider']);id(o.id);id(o.provider);return o;
}
export function validatePlan(value) {
  const o=ownedJson(value);
  exact(o,['schemaVersion','jobId','projectId','baseline','objective','nonGoals','files','protectedTests','criteria','commands','policy','testInventory','environmentDigest']);
  need(o.schemaVersion===1,'SCHEMA_VERSION');id(o.jobId);hash(o.projectId);hash(o.baseline);text(o.objective);
  list(o.nonGoals,64,text);
  list(o.files,256,f=>{exact(f,['path','operation','expectedHash']);relativePath(f.path);
    enumeration(f.operation,['create','replace','edit','delete']);
    if(f.operation==='create')need(f.expectedHash===null,'INVALID_PRECONDITION');else hash(f.expectedHash);
  },f=>f.path.toLowerCase());
  paths(o.protectedTests);
  list(o.criteria,128,c=>{exact(c,['id','description','method']);id(c.id);text(c.description);enumeration(c.method,['test','review','human']);},c=>c.id);
  need(o.criteria.length>0,'MISSING_CRITERIA');
  list(o.commands,32,c=>{
    exact(c,['id','executable','argv','cwd','environment','timeoutMs','expectedExit','inventory']);
    id(c.id);text(c.executable);need(/^(?:[A-Za-z]:[\\/]|\/)/.test(c.executable),'EXECUTABLE_NOT_ABSOLUTE');
    need(Array.isArray(c.argv)&&c.argv.length<=128,'INVALID_LIST');c.argv.forEach(a=>{need(typeof a==='string'&&Buffer.byteLength(a,'utf8')<=LIMITS.text,'INVALID_TEXT');});
    enumeration(c.cwd,['frozen','scratch']);
    need(c.environment&&typeof c.environment==='object'&&!Array.isArray(c.environment)&&Object.keys(c.environment).length<=32,'INVALID_ENVIRONMENT');
    for(const [k,v]of Object.entries(c.environment)){need(/^[A-Z_][A-Z0-9_]*$/.test(k),'INVALID_ENVIRONMENT');text(v);}
    integer(c.timeoutMs,1,900000);integer(c.expectedExit,0,255);list(c.inventory,128,id);need(c.inventory.length>0,'MISSING_INVENTORY');
  },c=>c.id);
  exact(o.policy,['planner','implementerProvider','correctionLimit']);validateActor(o.policy.planner);id(o.policy.implementerProvider);need(o.policy.correctionLimit===2,'INVALID_BUDGET');
  list(o.testInventory,128,id);need(o.testInventory.length>0&&o.commands.length>0,'MISSING_INVENTORY');
  const commandInventory=new Set(o.commands.flatMap(c=>c.inventory));
  need(commandInventory.size===o.testInventory.length&&o.testInventory.every(x=>commandInventory.has(x)),'INVENTORY_MISMATCH');
  hash(o.environmentDigest);return o;
}
export function planIdentity(value) {
  const p=validatePlan(value);return Object.freeze({planDigest:digest(p),criteriaDigest:digest(p.criteria),commandsDigest:digest(p.commands),inventoryDigest:digest(p.testInventory),environmentDigest:p.environmentDigest});
}
export function validateSubmission(value) {
  const o=ownedJson(value);exact(o,['criteria','findings','evidenceIds']);
  list(o.criteria,128,c=>{exact(c,['id','outcome']);id(c.id);enumeration(c.outcome,['pass','fail','unknown','skip']);},c=>c.id);
  list(o.findings,256,f=>{exact(f,['id','criterionId','detail','severity','status']);id(f.id);id(f.criterionId);text(f.detail);enumeration(f.severity,['blocker','note']);enumeration(f.status,['open','resolved']);},f=>f.id);
  list(o.evidenceIds,1024,id);return o;
}
export function validateBinding(o) {
  exact(o,['planDigest','criteriaDigest','commandsDigest','candidateDigest','environmentDigest','inventoryDigest']);
  for(const k of ['planDigest','criteriaDigest','commandsDigest','environmentDigest','inventoryDigest'])hash(o[k]);
  if(o.candidateDigest!==null)hash(o.candidateDigest);
}
export function validateAssignment(value) {
  const o=ownedJson(value);exact(o,['id','actor','role','generation','binding','provenance']);
  id(o.id);validateActor(o.actor);enumeration(o.role,['plan-review','author','validator','reviewer']);integer(o.generation,1);validateBinding(o.binding);provenance(o.provenance);return o;
}
export function validateDecision(value) {
  const o=ownedJson(value);exact(o,['id','planDigest','reviewResultId','generation','decision','provenance']);
  id(o.id);hash(o.planDigest);id(o.reviewResultId);integer(o.generation,1);enumeration(o.decision,['authorize','reject']);provenance(o.provenance);return o;
}
export function validateResult(value) {
  const o=ownedJson(value);exact(o,['id','assignmentId','actor','role','generation','binding','outcome','submission','provenance']);
  id(o.id);id(o.assignmentId);validateActor(o.actor);enumeration(o.role,['plan-review','validator','reviewer']);integer(o.generation,1);validateBinding(o.binding);
  enumeration(o.outcome,['completed-pass','completed-fail','cancelled','error','inconclusive']);validateSubmission(o.submission);provenance(o.provenance);return o;
}
export function validateEvidence(value) {
  const o=ownedJson(value);exact(o,['id','kind','assignmentId','binding','contentDigest','status','details','provenance']);
  id(o.id);id(o.assignmentId);validateBinding(o.binding);hash(o.contentDigest);enumeration(o.status,['completed','failed','pending']);provenance(o.provenance);
  if(o.kind==='frozen'){
    exact(o.details,['manifest','inventory']);list(o.details.manifest,256,f=>{
      exact(f,['path','sha256','operation','mode']);relativePath(f.path);enumeration(f.operation,['present','deleted']);
      if(f.operation==='deleted')need(f.sha256===null,'INVALID_DIGEST');else hash(f.sha256);integer(f.mode,0,511);
    },f=>f.path.toLowerCase());list(o.details.inventory,128,id);
    need(digest(o.details.manifest)===o.contentDigest&&o.binding.candidateDigest===o.contentDigest,'EVIDENCE_DIGEST_MISMATCH');
    need(digest(o.details.inventory)===o.binding.inventoryDigest,'INVENTORY_MISMATCH');
  }else{
    need(o.kind==='test','INVALID_ENUM');exact(o.details,['commandId','commandDigest','expectedExit','actualExit','stdoutDigest','stderrDigest','captureComplete','inventory','managedSettled']);
    id(o.details.commandId);hash(o.details.commandDigest);integer(o.details.expectedExit,0,255);
    if(o.details.actualExit!==null)integer(o.details.actualExit,0,255);hash(o.details.stdoutDigest);hash(o.details.stderrDigest);
    need(typeof o.details.captureComplete==='boolean'&&typeof o.details.managedSettled==='boolean','INVALID_BOOLEAN');
    list(o.details.inventory,128,c=>{exact(c,['id','outcome']);id(c.id);enumeration(c.outcome,['pass','fail','skip','todo','unknown']);},c=>c.id);
    need(digest(o.details)===o.contentDigest,'EVIDENCE_DIGEST_MISMATCH');
  }
  return o;
}
export function bindingFor(plan,candidateDigest=null) {return ownedJson({...planIdentity(plan),candidateDigest});}
export function same(a,b) {return canonicalize(a)===canonicalize(b);}

// V2 diagnostics are authenticated by their process-local producer capabilities, not this marker.
export const V2_PROVENANCE='gate-owned-diagnostic';
const V2_ROLES=['plan-review','author','validator','reviewer'];
const V2_PLAN_KEYS=['schemaVersion','jobId','projectId','baseline','objective','nonGoals','files','protectedTests','criteria','commands','policy','testInventory','environmentDigest','executionPolicy'];
const V2_BINDING_KEYS=['planDigest','criteriaDigest','commandsDigest','candidateDigest','environmentDigest','inventoryDigest','executionPolicyDigest'];
const v2Header=o=>need(o.schemaVersion===2&&o.provenance===V2_PROVENANCE,'V2_IDENTITY_REQUIRED');
function v2Route(o){exact(o,['provider','model','effort']);id(o.provider);text(o.model);text(o.effort);}
export function validateExecutionPolicyV2(value){
  const o=ownedJson(value);exact(o,['schemaVersion','routes','node','enforcement','settlementGraceMs','testFiles','environmentRecipe']);
  need(o.schemaVersion===1,'EXECUTION_POLICY_VERSION');exact(o.routes,V2_ROLES);for(const role of V2_ROLES)v2Route(o.routes[role]);
  exact(o.node,['executable','sha256','version','systemRoot']);text(o.node.executable);need(/^[A-Za-z]:[\\/]|^\//.test(o.node.executable),'EXECUTABLE_NOT_ABSOLUTE');hash(o.node.sha256);text(o.node.version);
  need(o.node.systemRoot===null||typeof o.node.systemRoot==='string'&&/^[A-Za-z]:[\\/]|^\//.test(o.node.systemRoot),'INVALID_SYSTEM_ROOT');
  need(o.enforcement==='guarded-native-trusted-code','UNSUPPORTED_ENFORCEMENT');integer(o.settlementGraceMs,1,900000);
  need(o.environmentRecipe==='systemroot-owned-temp-v1','UNSUPPORTED_ENVIRONMENT');
  list(o.testFiles,256,f=>{exact(f,['path','sha256']);relativePath(f.path);hash(f.sha256);},f=>f.path.toLowerCase());need(o.testFiles.length>0,'MISSING_TEST_FILES');return o;
}
export function validatePlanV2(value){
  const o=ownedJson(value);exact(o,V2_PLAN_KEYS);need(o.schemaVersion===2,'SCHEMA_VERSION');
  id(o.jobId);hash(o.projectId);hash(o.baseline);text(o.objective);list(o.nonGoals,64,text);
  list(o.files,256,f=>{exact(f,['path','operation','expectedHash']);relativePath(f.path);enumeration(f.operation,['create','replace','edit','delete']);if(f.operation==='create')need(f.expectedHash===null,'INVALID_PRECONDITION');else hash(f.expectedHash);},f=>f.path.toLowerCase());
  paths(o.protectedTests);list(o.criteria,128,c=>{exact(c,['id','description','method']);id(c.id);text(c.description);enumeration(c.method,['test','review','human']);},c=>c.id);need(o.criteria.length>0,'MISSING_CRITERIA');
  const policy=validateExecutionPolicyV2(o.executionPolicy),tests=new Map(policy.testFiles.map(f=>[f.path,f]));
  list(o.commands,32,c=>{
    exact(c,['id','executable','argv','cwd','environment','timeoutMs','expectedExit','inventory']);id(c.id);
    need(c.executable===policy.node.executable&&c.cwd==='frozen'&&c.expectedExit===0,'UNSUPPORTED_COMMAND');
    need(Array.isArray(c.argv)&&c.argv.length>=4&&c.argv.length<=128&&same(c.argv.slice(0,3),['--test','--test-isolation=none','--test-reporter=tap']),'UNSUPPORTED_COMMAND');
    list(c.argv.slice(3),125,p=>{relativePath(p);need(tests.has(p)&&o.protectedTests.includes(p),'UNPROTECTED_TEST');},p=>p.toLowerCase());
    const expected=policy.node.systemRoot===null?{}:{SYSTEMROOT:policy.node.systemRoot};need(same(c.environment,expected),'INVALID_ENVIRONMENT');
    integer(c.timeoutMs,1,900000);list(c.inventory,128,id);need(c.inventory.length>0,'MISSING_INVENTORY');
  },c=>c.id);need(o.commands.length>0,'MISSING_COMMANDS');
  exact(o.policy,['planner','implementerProvider','correctionLimit']);validateActor(o.policy.planner);id(o.policy.implementerProvider);need(o.policy.correctionLimit===2,'INVALID_BUDGET');
  need(policy.routes.author.provider===o.policy.implementerProvider&&policy.routes['plan-review'].provider!==o.policy.planner.provider&&policy.routes.reviewer.provider!==o.policy.implementerProvider,'INDEPENDENCE_REQUIRED');
  need(o.files.every(f=>!o.protectedTests.some(p=>p.toLowerCase()===f.path.toLowerCase())),'PROTECTED_PATH');
  list(o.testInventory,128,id);const inventory=o.commands.flatMap(c=>c.inventory);need(new Set(inventory).size===inventory.length&&same(inventory,o.testInventory),'INVENTORY_MISMATCH');
  need(tests.size>0&&[...tests.keys()].every(p=>o.protectedTests.includes(p)&&o.commands.some(c=>c.argv.slice(3).includes(p))),'TEST_FILE_MISMATCH');
  hash(o.environmentDigest);need(o.environmentDigest===digest({node:policy.node,enforcement:policy.enforcement,environmentRecipe:policy.environmentRecipe}),'ENVIRONMENT_DIGEST_MISMATCH');return o;
}
export function planIdentityV2(value){const p=validatePlanV2(value);return ownedJson({planDigest:digest(p),criteriaDigest:digest(p.criteria),commandsDigest:digest(p.commands),inventoryDigest:digest(p.testInventory),environmentDigest:p.environmentDigest,executionPolicyDigest:digest(p.executionPolicy)});}
export function bindingForV2(plan,candidateDigest=null){if(candidateDigest!==null)hash(candidateDigest);return ownedJson({...planIdentityV2(plan),candidateDigest});}
export function validateBindingV2(value){const o=ownedJson(value);exact(o,V2_BINDING_KEYS);for(const k of V2_BINDING_KEYS)if(k!=='candidateDigest'||o[k]!==null)hash(o[k]);return o;}
export function validateActorV2(value){const o=ownedJson(value);exact(o,['id','provider','model','effort']);id(o.id);v2Route({provider:o.provider,model:o.model,effort:o.effort});return o;}
export function validateAssignmentV2(value){const o=ownedJson(value);exact(o,['schemaVersion','provenance','id','actor','role','generation','binding']);v2Header(o);id(o.id);validateActorV2(o.actor);enumeration(o.role,V2_ROLES);integer(o.generation,1);validateBindingV2(o.binding);return o;}
export function validateDecisionV2(value){const o=ownedJson(value);exact(o,['schemaVersion','provenance','id','planDigest','reviewResultId','generation','decision']);v2Header(o);id(o.id);hash(o.planDigest);id(o.reviewResultId);integer(o.generation,1);enumeration(o.decision,['authorize','reject']);return o;}
export function validateResultV2(value){const o=ownedJson(value);exact(o,['schemaVersion','provenance','id','assignmentId','actor','role','generation','binding','outcome','submission','submissionArtifactHash']);v2Header(o);id(o.id);id(o.assignmentId);validateActorV2(o.actor);enumeration(o.role,V2_ROLES);integer(o.generation,1);validateBindingV2(o.binding);enumeration(o.outcome,['completed-pass','completed-fail','cancelled','error','inconclusive']);if(o.submission!==null){validateSubmission(o.submission);hash(o.submissionArtifactHash);}else need(o.submissionArtifactHash===null&&o.outcome!=='completed-pass','SUBMISSION_REQUIRED');return o;}
export function validateEvidenceV2(value){
  const o=ownedJson(value);exact(o,['schemaVersion','provenance','id','kind','assignmentId','generation','binding','status','contentDigest','artifactHash','details']);v2Header(o);id(o.id);id(o.assignmentId);integer(o.generation,1);validateBindingV2(o.binding);enumeration(o.status,['completed','failed']);hash(o.contentDigest);hash(o.artifactHash);
  if(o.kind==='frozen'){
    exact(o.details,['descriptorArtifactHash','producerAssignmentId','stage']);hash(o.details.descriptorArtifactHash);id(o.details.producerAssignmentId);need(o.details.stage==='frozen'&&o.details.producerAssignmentId===o.assignmentId&&o.details.descriptorArtifactHash===o.artifactHash&&o.contentDigest===o.binding.candidateDigest&&o.status==='completed','INVALID_FREEZE');
  }else{
    need(o.kind==='test','INVALID_ENUM');exact(o.details,['commandId','commandDigest','expectedExit','actualExit','stdoutDigest','stderrDigest','captureComplete','inventory','managedSettled','enforcement','deadlineFired','signal','logArtifacts']);
    id(o.details.commandId);hash(o.details.commandDigest);integer(o.details.expectedExit,0,255);if(o.details.actualExit!==null)integer(o.details.actualExit,0,255);for(const k of ['stdoutDigest','stderrDigest'])if(o.details[k]===null)need(o.details.captureComplete===false&&o.status==='failed','INVALID_CAPTURE_DIGEST');else hash(o.details[k]);
    for(const k of ['captureComplete','managedSettled','deadlineFired'])need(typeof o.details[k]==='boolean','INVALID_BOOLEAN');enumeration(o.details.enforcement,['partial','full']);need(o.details.signal===null||typeof o.details.signal==='string','INVALID_SIGNAL');
    list(o.details.inventory,128,r=>{exact(r,['id','outcome']);id(r.id);enumeration(r.outcome,['pass','fail','skip','todo','unknown']);},r=>r.id);list(o.details.logArtifacts,1024,hash);need(digest(o.details)===o.contentDigest,'EVIDENCE_DIGEST_MISMATCH');
  }return o;
}
export function validateCandidateDescriptorV2(value){
  const o=ownedJson(value);exact(o,['schemaVersion','provenance','jobId','projectId','assignmentId','attempt','generation','revision','planDigest','criteriaDigest','commandsDigest','inventoryDigest','environmentDigest','executionPolicyDigest','baselineDigest','commit','objectFormat','git','files','deletions','changes','candidateDigest']);v2Header(o);id(o.jobId);hash(o.projectId);id(o.assignmentId);integer(o.attempt,0,2);integer(o.generation,1);integer(o.revision,1);
  for(const k of ['planDigest','criteriaDigest','commandsDigest','inventoryDigest','environmentDigest','executionPolicyDigest','baselineDigest','candidateDigest'])hash(o[k]);need(/^[a-f0-9]{40}$/.test(o.commit)&&o.objectFormat==='sha1','INVALID_BASELINE');exact(o.git,['sha256','version']);hash(o.git.sha256);text(o.git.version);
  const row=(r,kind='file')=>{exact(r,['path','kind','bytes','sha256','gitMode']);relativePath(r.path);need(r.kind===kind&&['100644','100755'].includes(r.gitMode),'INVALID_FILE');integer(r.bytes,0,1048576);hash(r.sha256);};
  list(o.files,256,r=>row(r),r=>r.path.toLowerCase());list(o.deletions,256,r=>row(r,'deleted'),r=>r.path.toLowerCase());need(o.files.reduce((n,f)=>n+f.bytes,0)<=16777216,'TOTAL_BYTES_LIMIT');
  need(o.files.every((r,i)=>!i||o.files[i-1].path<r.path)&&o.deletions.every((r,i)=>!i||o.deletions[i-1].path<r.path),'UNSORTED_FILES');
  const present=new Map(o.files.map(r=>[r.path,r])),removed=new Map(o.deletions.map(r=>[r.path,r]));need(o.files.every(r=>!removed.has(r.path)),'DUPLICATE_PATH');
  list(o.changes,512,c=>{exact(c,['path','operation','before','after']);relativePath(c.path);enumeration(c.operation,['create','delete','modify']);if(c.before!==null)row(c.before);if(c.after!==null)row(c.after);need(c.before===null?c.operation==='create':c.before.path===c.path,'INVALID_CHANGE');need(c.after===null?c.operation==='delete':c.after.path===c.path&&same(c.after,present.get(c.path)),'INVALID_CHANGE');need(c.before!==null||c.after!==null,'INVALID_CHANGE');if(c.operation==='delete')need(removed.has(c.path)&&same({...removed.get(c.path),kind:'file'},c.before),'INVALID_CHANGE');if(c.operation==='modify')need(c.before!==null&&c.after!==null&&!same(c.before,c.after),'INVALID_CHANGE');},c=>c.path.toLowerCase());
  need(o.deletions.every(r=>o.changes.some(c=>c.path===r.path&&c.operation==='delete')),'INVALID_CHANGE');const {candidateDigest,...body}=o;need(digest(body)===candidateDigest,'CANDIDATE_DIGEST_MISMATCH');return o;
}
export function validateStateV2(value){
  const o=ownedJson(value);exact(o,['schemaVersion','provenance','jobId','projectId','revision','generation','phase','planGeneration','plan','attempts','authors','assignments','results','evidence','decision','candidate','action']);v2Header(o);validatePlanV2(o.plan);need(o.jobId===o.plan.jobId&&o.projectId===o.plan.projectId,'JOB_IDENTITY_CHANGED');integer(o.revision,1,4096);integer(o.generation,1);integer(o.planGeneration,1);
  enumeration(o.phase,['PLANNING','AWAITING_HUMAN','PLAN_AUTHORIZED','AUTHORING','FROZEN','VALIDATING','REVIEWING','DIAGNOSTIC_READY','CORRECTION_REQUIRED','REASSESS_REQUIRED','STOPPED','RECONCILIATION_REQUIRED']);
  list(o.assignments,1024,validateAssignmentV2,a=>a.id);list(o.results,1024,validateResultV2,r=>r.id);list(o.evidence,1024,validateEvidenceV2,e=>e.id);list(o.authors,3,validateActorV2,a=>a.id);
  list(o.attempts,3,(a)=>{exact(a,['index','assignmentId','planDigest']);integer(a.index,0,2);id(a.assignmentId);hash(a.planDigest);},a=>a.assignmentId);need(o.attempts.every((a,i)=>a.index===i),'INVALID_ATTEMPT');if(o.decision!==null)validateDecisionV2(o.decision);if(o.candidate!==null)hash(o.candidate);need(o.action&&typeof o.action.type==='string','INVALID_ACTION');
  for(const a of o.assignments){need(same(a.binding,bindingForV2(o.plan,a.binding.candidateDigest)),'BINDING_MISMATCH');const route=o.plan.executionPolicy.routes[a.role];need(same({provider:a.actor.provider,model:a.actor.model,effort:a.actor.effort},route),'ACTUAL_ROUTE_CHANGED');}
  for(const r of o.results){const a=o.assignments.find(a=>a.id===r.assignmentId);need(a&&same(a.actor,r.actor)&&a.role===r.role&&a.generation===r.generation&&same(a.binding,r.binding),'ASSIGNMENT_MISMATCH');}
  need(new Set(o.results.map(r=>r.assignmentId)).size===o.results.length,'DUPLICATE_RESULT');exact(o.action,['type']);
  const authors=o.assignments.filter(a=>a.role==='author');need(authors.length===o.authors.length&&authors.length===o.attempts.length,'ATTEMPT_HISTORY_MISMATCH');
  for(let i=0;i<authors.length;i++){const a=authors[i],attempt=o.attempts[i];need(same(a.actor,o.authors[i])&&attempt.assignmentId===a.id&&attempt.planDigest===digest(o.plan)&&a.generation===i+2&&a.binding.candidateDigest===null,'ATTEMPT_HISTORY_MISMATCH');}
  need(new Set(o.assignments.map(a=>a.actor.id)).size===o.assignments.length&&new Set(o.assignments.map(a=>a.role+':'+a.generation)).size===o.assignments.length,'ACTOR_REUSED');
  for(const a of o.assignments){need(a.generation<=o.generation,'FUTURE_ASSIGNMENT');if(a.role==='plan-review')need(a.generation===o.planGeneration&&a.binding.candidateDigest===null&&a.actor.id!==o.plan.policy.planner.id&&a.actor.provider!==o.plan.policy.planner.provider,'INDEPENDENCE_REQUIRED');if(a.role==='validator'||a.role==='reviewer')need(a.binding.candidateDigest!==null&&a.actor.id!==o.plan.policy.planner.id&&!o.authors.some(v=>v.id===a.actor.id),'INDEPENDENCE_REQUIRED');}
  for(const e of o.evidence){const a=o.assignments.find(v=>v.id===e.assignmentId);need(a&&a.generation===e.generation&&same(e.binding,bindingForV2(o.plan,e.binding.candidateDigest))&&e.binding.candidateDigest!==null,'EVIDENCE_ASSIGNMENT_MISMATCH');need(e.kind==='frozen'?a.role==='author'&&a.binding.candidateDigest===null:a.role==='validator'&&same(a.binding,e.binding),'EVIDENCE_ASSIGNMENT_MISMATCH');}
  for(const r of o.results)if(r.submission!==null){need(r.submission.criteria.every(c=>o.plan.criteria.some(p=>p.id===c.id))&&r.submission.findings.every(f=>o.plan.criteria.some(p=>p.id===f.criterionId)),'UNKNOWN_CRITERION');need(r.submission.evidenceIds.every(id=>o.evidence.some(e=>e.id===id&&e.generation===r.generation&&same(e.binding,r.binding))),'FOREIGN_EVIDENCE');if(r.outcome==='completed-pass')need(r.submission.criteria.length===o.plan.criteria.length&&r.submission.criteria.every(c=>c.outcome==='pass')&&!r.submission.findings.some(f=>f.severity==='blocker'&&f.status!=='resolved'),'CRITERIA_NOT_PASSED');}
  if(o.decision!==null){const r=o.results.find(r=>r.id===o.decision.reviewResultId);need(r?.role==='plan-review'&&r.outcome==='completed-pass'&&o.decision.generation===o.planGeneration&&o.decision.planDigest===digest(o.plan),'INVALID_HUMAN_DECISION');}return o;
}
export function validateTransitionV2(previous,type,value){
  const s=validateStateV2(value);need(s.action.type===type,'EVENT_IDENTITY_MISMATCH');
  if(previous===null){need(type==='PLAN_PROPOSED'&&s.revision===1&&s.generation===1&&s.planGeneration===1&&s.phase==='PLANNING'&&!s.attempts.length&&!s.authors.length&&!s.assignments.length&&!s.results.length&&!s.evidence.length&&s.decision===null&&s.candidate===null,'INVALID_INITIAL_STATE');return s;}
  const p=validateStateV2(previous);need(!['STOPPED','REASSESS_REQUIRED','RECONCILIATION_REQUIRED'].includes(p.phase),'TERMINAL_STATE');
  need(s.revision===p.revision+1&&same(s.plan,p.plan)&&s.jobId===p.jobId&&s.projectId===p.projectId&&s.planGeneration===p.planGeneration,'STATE_IDENTITY_CHANGED');
  for(const key of ['attempts','authors','assignments','results','evidence'])need(s[key].length>=p[key].length&&same(s[key].slice(0,p[key].length),p[key]),'HISTORY_REWRITTEN');
  const delta=Object.fromEntries(['attempts','authors','assignments','results','evidence'].map(k=>[k,s[k].length-p[k].length]));
  const unchanged=keys=>keys.forEach(k=>need(delta[k]===0,'UNEXPECTED_STATE_CHANGE'));
  if(type==='ATTEMPT_RESERVED'){
    need(['PLAN_AUTHORIZED','CORRECTION_REQUIRED'].includes(p.phase)&&s.phase==='AUTHORING'&&p.attempts.length<3&&s.generation===p.generation+1&&s.candidate===null,'INVALID_AUTHOR_RESERVATION');
    need(delta.attempts===1&&delta.authors===1&&delta.assignments===1,'INVALID_AUTHOR_RESERVATION');unchanged(['results','evidence']);const a=s.assignments.at(-1),attempt=s.attempts.at(-1);need(a.role==='author'&&a.generation===s.generation&&same(a.actor,s.authors.at(-1))&&attempt.assignmentId===a.id&&attempt.planDigest===digest(s.plan),'INVALID_AUTHOR_RESERVATION');
  }else{
    need(s.generation===p.generation,'GENERATION_CHANGED');unchanged(['attempts','authors']);
    if(type==='ASSIGNMENT_CREATED'){need(delta.assignments===1,'ASSIGNMENT_REQUIRED');unchanged(['results','evidence']);const a=s.assignments.at(-1);need(a.role!=='author'&&a.generation===(a.role==='plan-review'?s.planGeneration:s.generation)&&s.phase===(a.role==='plan-review'?'PLANNING':a.role==='validator'?'VALIDATING':'REVIEWING'),'INVALID_ASSIGNMENT_PHASE');need(a.role==='plan-review'?p.phase==='PLANNING':['FROZEN','VALIDATING','REVIEWING'].includes(p.phase)&&p.candidate!==null&&a.binding.candidateDigest===p.candidate,'INVALID_ASSIGNMENT_PHASE');}
    else if(type==='RESULT_RECORDED'){unchanged(['assignments','evidence']);need(delta.results===1||delta.results===0&&['CORRECTION_REQUIRED','REASSESS_REQUIRED'].includes(s.phase),'RESULT_REQUIRED');if(delta.results===1){const r=s.results.at(-1);need(r.role==='plan-review'?p.phase==='PLANNING'&&s.phase===(r.outcome==='completed-pass'?'AWAITING_HUMAN':'REASSESS_REQUIRED'):r.role==='author'?p.phase==='AUTHORING'&&!['completed-pass','completed-fail'].includes(r.outcome)&&s.phase===(s.attempts.length>=3?'REASSESS_REQUIRED':'CORRECTION_REQUIRED'):[r.role==='validator'?'VALIDATING':'REVIEWING'].includes(p.phase)&&s.phase===p.phase,'INVALID_RESULT_PHASE');}else need(['VALIDATING','REVIEWING'].includes(p.phase)&&s.results.some(r=>r.role==='validator'&&r.generation===s.generation)&&s.results.some(r=>r.role==='reviewer'&&r.generation===s.generation)&&s.phase===(s.attempts.length>=3?'REASSESS_REQUIRED':'CORRECTION_REQUIRED'),'INVALID_RESULT_PHASE');}
    else if(type==='CANDIDATE_SEALED'){unchanged(['assignments']);need(p.phase==='AUTHORING'&&s.phase==='FROZEN'&&delta.results===1&&delta.evidence===1&&s.candidate!==null,'INVALID_FREEZE');const r=s.results.at(-1),e=s.evidence.at(-1);need(r.role==='author'&&['completed-pass','completed-fail'].includes(r.outcome)&&e.kind==='frozen'&&e.assignmentId===r.assignmentId&&e.contentDigest===s.candidate,'INVALID_FREEZE');}
    else if(type==='EVIDENCE_REGISTERED'){unchanged(['assignments','results']);need(delta.evidence===1&&p.phase==='VALIDATING'&&s.phase===p.phase&&s.evidence.at(-1).kind==='test','INVALID_EVIDENCE_STAGE');}
    else if(type==='HUMAN_DECIDED'){unchanged(['assignments','results','evidence']);need(p.phase==='AWAITING_HUMAN'&&p.decision===null&&s.decision!==null&&s.phase===(s.decision.decision==='authorize'?'PLAN_AUTHORIZED':'STOPPED'),'INVALID_HUMAN_DECISION');const r=s.results.find(v=>v.id===s.decision.reviewResultId);need(r?.role==='plan-review'&&r.outcome==='completed-pass'&&s.decision.planDigest===digest(s.plan),'PLAN_REVIEW_REQUIRED');}
    else if(type==='AUTHOR_FAILED'){unchanged(['assignments','results','evidence']);need(p.phase==='AUTHORING'&&['CORRECTION_REQUIRED','REASSESS_REQUIRED'].includes(s.phase),'INVALID_AUTHOR_FAILURE');}
    else if(type==='DIAGNOSTIC_READY'){unchanged(['assignments','results','evidence']);need(['VALIDATING','REVIEWING'].includes(p.phase)&&s.phase==='DIAGNOSTIC_READY'&&s.candidate!==null,'INVALID_READY');need(diagnosticFactsReadyV2(s),'INCOMPLETE_DIAGNOSTIC_FACTS');}
    else if(type==='STOPPED'){unchanged(['assignments','results','evidence']);need(s.phase==='STOPPED','INVALID_STOP');}
    else if(type==='CONTROL_RECORDED'){unchanged(['assignments','results','evidence']);need(['PLAN_AUTHORIZED','CORRECTION_REQUIRED'].includes(p.phase)&&s.phase===p.phase&&s.attempts.length<3,'INVALID_CONTROL_PHASE');const {revision:oldRevision,action:oldAction,...oldBusiness}=p,{revision:newRevision,action:newAction,...newBusiness}=s;need(same(oldBusiness,newBusiness),'CONTROL_BUSINESS_CHANGED');}
    else if(['QUALIFICATION_FINALIZED','DELIVERY_RESERVED','DELIVERY_COMPLETED',ACCEPTANCE_EVENT_V2].includes(type)){unchanged(['assignments','results','evidence']);need(p.phase==='DIAGNOSTIC_READY'&&s.phase===p.phase,'QUALIFICATION_PHASE_REQUIRED');const {revision:oldRevision,action:oldAction,...oldBusiness}=p,{revision:newRevision,action:newAction,...newBusiness}=s;need(same(oldBusiness,newBusiness),'QUALIFICATION_BUSINESS_CHANGED');need(diagnosticFactsReadyV2(s),'INCOMPLETE_DIAGNOSTIC_FACTS');}
    else need(false,'UNKNOWN_EVENT_TYPE');
  }
  if(type!=='HUMAN_DECIDED')need(same(s.decision,p.decision),'DECISION_CHANGED');
  if(!['ATTEMPT_RESERVED','CANDIDATE_SEALED'].includes(type))need(s.candidate===p.candidate,'CANDIDATE_CHANGED');
  if(type==='ATTEMPT_RESERVED'){const r=s.results.find(v=>v.id===s.decision?.reviewResultId);need(s.decision?.decision==='authorize'&&s.decision.planDigest===digest(s.plan)&&r?.outcome==='completed-pass','PLAN_NOT_AUTHORIZED');}
  return s;
}
/** Data consistency only; this function neither authenticates producers nor grants acceptance. */
export function diagnosticFactsReadyV2(value){
  try{const s=validateStateV2(value);need(s.candidate!==null&&s.decision?.decision==='authorize','PLAN_NOT_AUTHORIZED');
    const evidence=s.evidence.filter(e=>e.generation===s.generation&&same(e.binding,bindingForV2(s.plan,s.candidate))),frozen=evidence.filter(e=>e.kind==='frozen');need(frozen.length===1,'FROZEN_EVIDENCE_REQUIRED');
    const results=['validator','reviewer'].map(role=>s.results.find(r=>r.role===role&&r.generation===s.generation&&same(r.binding,bindingForV2(s.plan,s.candidate))));
    need(results.every(r=>r?.outcome==='completed-pass'&&evidence.every(e=>r.submission.evidenceIds.includes(e.id))),'MISSING_RESULT_EVIDENCE');
    need(results[0].actor.id!==results[1].actor.id&&results[1].actor.provider!==s.plan.policy.implementerProvider,'INDEPENDENCE_REQUIRED');
    for(const c of s.plan.commands){const matches=evidence.filter(e=>e.kind==='test'&&e.details.commandId===c.id);need(matches.length===1,'TEST_EVIDENCE_REQUIRED');const e=matches[0],d=e.details;need(e.status==='completed'&&d.commandDigest===digest(c)&&d.expectedExit===c.expectedExit&&d.actualExit===c.expectedExit&&d.captureComplete&&d.managedSettled&&!d.deadlineFired&&d.signal===null&&same(d.inventory,c.inventory.map(id=>({id,outcome:'pass'}))),'TEST_NOT_PASSED');}
    const binding=new Map(),open=new Set();for(const r of s.results)for(const f of r.submission?.findings??[]){const key=canonicalize([r.role,f.id]);need(!binding.has(key)||binding.get(key)===f.criterionId,'FINDING_ID_CONFLICT');binding.set(key,f.criterionId);if(f.severity==='blocker'){if(f.status==='open')open.add(key);else if(['completed-pass','completed-fail'].includes(r.outcome))open.delete(key);}}need(open.size===0,'OPEN_BLOCKER');return true;
  }catch{return false;}
}

const ACCEPTANCE_PREDICATE_IDS=Object.freeze(['P1','P2','P3','P4','P5','P6','P7','P8','P9']);
const ACCEPTANCE_FACT_KEYS=Object.freeze(['custodyVerified','journalHealthy','scopeClean','identityRecheck']);
/** Facts count only as owned boolean descriptors; accessors are refused and never invoked. */
function acceptanceFactsV2(facts){
  if(facts===null||typeof facts!=='object'||Array.isArray(facts))return null;
  const proto=Object.getPrototypeOf(facts);if(proto!==Object.prototype&&proto!==null)return null;
  const keys=Reflect.ownKeys(facts);if(keys.length!==ACCEPTANCE_FACT_KEYS.length||keys.some(k=>typeof k!=='string'||!ACCEPTANCE_FACT_KEYS.includes(k)))return null;
  const owned={};for(const key of ACCEPTANCE_FACT_KEYS){const d=Object.getOwnPropertyDescriptor(facts,key);if(!d||Object.hasOwn(d,'get')||Object.hasOwn(d,'set')||typeof d.value!=='boolean')return null;owned[key]=d.value;}
  return owned;
}
function acceptanceResultPairV2(s,cur,g){
  return {validator:s.results.find(r=>r.role==='validator'&&r.generation===g&&same(r.binding,cur))??null,reviewer:s.results.find(r=>r.role==='reviewer'&&r.generation===g&&same(r.binding,cur))??null};
}
/** The binding-key rule of diagnosticFactsReadyV2, reported as a code instead of thrown. */
function acceptanceFindingCodeV2(s){
  const bound=new Map(),open=new Set();
  for(const r of s.results)for(const f of r.submission?.findings??[]){const key=canonicalize([r.role,f.id]);if(bound.has(key)&&bound.get(key)!==f.criterionId)return 'FINDING_ID_CONFLICT';bound.set(key,f.criterionId);if(f.severity==='blocker'){if(f.status==='open')open.add(key);else if(['completed-pass','completed-fail'].includes(r.outcome))open.delete(key);}}
  return open.size===0?null:'OPEN_BLOCKER';
}
function acceptancePredicateV2(id,s,facts,factsValid){
  const g=s.generation;
  if(id==='P1'){
    const d=s.decision,authorized=d!==null&&d.decision==='authorize'&&d.planDigest===digest(s.plan)&&d.generation===s.planGeneration&&s.results.some(r=>r.id===d.reviewResultId&&r.role==='plan-review'&&r.outcome==='completed-pass'&&r.generation===s.planGeneration);
    if(!authorized)return 'PLAN_NOT_AUTHORIZED';try{acceptanceDigestV2(s.plan);return null;}catch(e){return typeof e?.code==='string'?e.code:'INVALID_STATE';}
  }
  const cur=bindingForV2(s.plan,s.candidate);
  if(id==='P2'){
    if(s.candidate===null)return 'CANDIDATE_REQUIRED';
    const frozen=s.evidence.filter(e=>e.kind==='frozen'&&e.generation===g&&same(e.binding,cur));
    if(frozen.length!==1||frozen[0].contentDigest!==s.candidate)return 'FROZEN_EVIDENCE_REQUIRED';
    const pair=acceptanceResultPairV2(s,cur,g);
    return pair.validator!==null&&pair.reviewer!==null?null:'CANDIDATE_RESULT_MISMATCH';
  }
  if(id==='P3'){
    const pair=acceptanceResultPairV2(s,cur,g),results=[pair.validator,pair.reviewer];
    if(results.some(r=>r===null||r.outcome!=='completed-pass'||r.submission===null))return 'RESULTS_REQUIRED';
    const expected=s.plan.criteria.map(c=>c.id);
    for(const r of results){const passed=r.submission.criteria.filter(c=>c.outcome==='pass').map(c=>c.id);
      if(passed.length!==expected.length||new Set(passed).size!==expected.length||!expected.every(x=>passed.includes(x)))return 'CRITERIA_NOT_PASSED';}
    const current=s.evidence.filter(e=>e.generation===g&&same(e.binding,cur)).map(e=>e.id);
    if(results.some(r=>!current.every(x=>r.submission.evidenceIds.includes(x))))return 'MISSING_RESULT_EVIDENCE';
    return null;
  }
  if(id==='P4'){
    for(const c of s.plan.commands){
      const matches=s.evidence.filter(e=>e.kind==='test'&&e.generation===g&&same(e.binding,cur)&&e.details?.commandId===c.id);
      if(matches.length!==1)return 'TEST_EVIDENCE_REQUIRED';
      const e=matches[0],d=e.details;
      if(!(e.status==='completed'&&d.commandDigest===digest(c)&&d.expectedExit===c.expectedExit&&d.actualExit===c.expectedExit&&d.captureComplete&&d.managedSettled&&!d.deadlineFired&&d.signal===null&&same(d.inventory,c.inventory.map(x=>({id:x,outcome:'pass'})))))return 'TEST_NOT_PASSED';
    }
    return null;
  }
  if(id==='P5'){
    const pair=acceptanceResultPairV2(s,cur,g);
    if(pair.validator===null||pair.reviewer===null)return 'INDEPENDENCE_REQUIRED';
    const validatorId=pair.validator.actor.id,reviewerId=pair.reviewer.actor.id,excluded=[s.plan.policy.planner.id,...s.authors.map(a=>a.id)];
    return validatorId!==reviewerId&&!excluded.includes(validatorId)&&!excluded.includes(reviewerId)?null:'INDEPENDENCE_REQUIRED';
  }
  if(id==='P6'){
    const pair=acceptanceResultPairV2(s,cur,g);
    const planReview=s.results.some(r=>r.role==='plan-review'&&r.generation===s.planGeneration&&r.actor.provider!==s.plan.policy.planner.provider);
    const reviewerDiverse=pair.reviewer!==null&&pair.reviewer.actor.provider!==s.plan.policy.implementerProvider;
    return planReview&&reviewerDiverse?null:'PROVIDER_DIVERSITY_REQUIRED';
  }
  if(id==='P7'){
    if(!factsValid)return 'FACTS_INVALID';
    const code=acceptanceFindingCodeV2(s);
    if(code!==null)return code;
    if(facts.scopeClean!==true)return 'SCOPE_NOT_CLEAN';
    if(facts.journalHealthy!==true)return 'JOURNAL_UNHEALTHY';
    return null;
  }
  if(id==='P8')return s.plan.policy.correctionLimit===2&&s.attempts.length<=3?null:'CORRECTION_BUDGET_EXCEEDED';
  if(!factsValid)return 'FACTS_INVALID';
  if(facts.identityRecheck!==true)return 'IDENTITY_RECHECK_REQUIRED';
  if(facts.custodyVerified!==true)return 'CUSTODY_NOT_VERIFIED';
  return null;
}
/** Pure diagnostics: evaluates the nine acceptance predicates; grants nothing; P1 requires an authorized plan whose acceptance digest computes. */
export function evaluateAcceptanceV2(state,facts){
  let owned=null,factsValid=false;
  try{owned=acceptanceFactsV2(facts);factsValid=owned!==null;}catch{owned=null;factsValid=false;}
  let s=null,stateCode='INVALID_STATE',stateValid=false;
  try{s=validateStateV2(state);stateValid=true;}catch(e){stateCode=typeof e?.code==='string'?e.code:'INVALID_STATE';}
  const predicates=[];
  for(const id of ACCEPTANCE_PREDICATE_IDS){
    let reason;
    if(!stateValid)reason=stateCode;
    else{try{reason=acceptancePredicateV2(id,s,owned,factsValid)??null;}catch(e){reason=typeof e?.code==='string'?e.code:'INVALID_STATE';}}
    predicates.push(Object.freeze({id,pass:reason===null,reason}));
  }
  const result={schemaVersion:1,kind:'acceptance-evaluation',complete:false,predicatesHold:predicates.every(p=>p.pass),stateValid,predicates:Object.freeze(predicates),operationallyAccepted:false,gateActive:false};
  return Object.freeze(result);
}
/** Plan-level acceptance contract digest (PROPOSAL.md:105). Producer: throws validatePlanV2 codes. Domain-separated from digest(plan). */
export function acceptanceDigestV2(value){
  const p=validatePlanV2(value);
  return digest({schemaVersion:1,kind:'acceptance-contract',criteria:p.criteria,protectedTests:p.protectedTests,testFiles:p.executionPolicy.testFiles,commands:p.commands,testInventory:p.testInventory,environmentDigest:p.environmentDigest});
}

export const M4_READ_LIMITS=Object.freeze({rows:64,bytes:16384,text:8192});
export function validateControlRecordM4(value){
  const o=ownedJson(value);exact(o,['schemaVersion','kind','id','checkpointDigest','ownerId','epoch','priorHeadDigest','planDigest','decisionDigest','attemptsDigest','attemptsUsed','nextAction']);
  need(o.schemaVersion===1,'CONTROL_SCHEMA_VERSION');enumeration(o.kind,['pause','resume']);id(o.id);id(o.ownerId);integer(o.epoch,1);integer(o.attemptsUsed,0,2);need(o.nextAction==='author','INVALID_NEXT_ACTION');for(const k of ['checkpointDigest','priorHeadDigest','planDigest','decisionDigest','attemptsDigest'])hash(o[k]);return o;
}
export function validateControlBindingM4(previous,state,previousDigest,artifacts){
  validateTransitionV2(previous,'CONTROL_RECORDED',state);need(Array.isArray(artifacts)&&artifacts.length===1,'CONTROL_ARTIFACT_REQUIRED');const record=validateControlRecordM4(artifacts[0]);
  need(record.priorHeadDigest===previousDigest&&record.planDigest===digest(state.plan)&&record.decisionDigest===digest(state.decision)&&record.attemptsDigest===digest(state.attempts)&&record.attemptsUsed===state.attempts.length,'CONTROL_BINDING_MISMATCH');return record;
}
export function validateReadRequestM4(value){
  const o=ownedJson(value);exact(o,['kind','id','offset','limit','cursor']);enumeration(o.kind,['status','history','evidence','artifact']);integer(o.offset);integer(o.limit,1,o.kind==='artifact'?M4_READ_LIMITS.text:M4_READ_LIMITS.rows);
  if(o.kind==='artifact')hash(o.id);else need(o.id===null,'INVALID_READ_ID');if(o.cursor!==null)hash(o.cursor);need(o.offset===0||o.cursor!==null,'CURSOR_REQUIRED');if(o.kind==='status')need(o.offset===0&&o.limit===1,'INVALID_STATUS_PAGE');return o;
}
export function validateResumeRequestM4(value){const o=ownedJson(value);exact(o,['checkpointDigest','nextAction']);hash(o.checkpointDigest);need(o.nextAction==='author','INVALID_NEXT_ACTION');return o;}
export function boundedResponseM4(value){const o=ownedJson(value);need(Buffer.byteLength(canonicalize(o),'utf8')<=M4_READ_LIMITS.bytes,'READ_RESPONSE_TOO_LARGE');return o;}

export const DELIVERY_EVENTS_M4B=Object.freeze(['QUALIFICATION_FINALIZED','DELIVERY_RESERVED','DELIVERY_COMPLETED']);
const m4bCommon=['schemaVersion','kind','qualificationOnly','operationallyAccepted','gateActive','id','nonce','jobId','projectId','generation','priorHeadDigest','candidateDigest'];
function m4bFlags(o){need(o.schemaVersion===1&&o.qualificationOnly===true&&o.operationallyAccepted===false&&o.gateActive===false,'QUALIFICATION_ONLY_REQUIRED');id(o.id);id(o.jobId);hash(o.nonce);hash(o.projectId);integer(o.generation,1);hash(o.priorHeadDigest);hash(o.candidateDigest);}
export function validateQualificationRecordM4B(value){const o=ownedJson(value);exact(o,[...m4bCommon,'qualifiedAccepted','planDigest','environmentDigest','executionPolicyDigest','frozenArtifactHash','authorResultId','validatorResultId','reviewerResultId','submissionArtifacts','testArtifacts','logArtifacts']);m4bFlags(o);need(o.kind==='qualification-finalized'&&o.qualifiedAccepted===true,'QUALIFICATION_KIND');for(const k of ['planDigest','environmentDigest','executionPolicyDigest','frozenArtifactHash'])hash(o[k]);for(const k of ['authorResultId','validatorResultId','reviewerResultId'])id(o[k]);for(const k of ['submissionArtifacts','testArtifacts','logArtifacts'])list(o[k],1024,hash);return o;}
export function validateDeliveryReservationM4B(value){const o=ownedJson(value);exact(o,[...m4bCommon,'qualificationReceiptDigest','destinationId','descriptorDigest','payloadInventoryDigest']);m4bFlags(o);need(o.kind==='delivery-reserved','DELIVERY_KIND');id(o.destinationId);for(const k of ['qualificationReceiptDigest','descriptorDigest','payloadInventoryDigest'])hash(o[k]);return o;}
export function validateDeliveryReceiptM4B(value){const o=ownedJson(value);exact(o,[...m4bCommon,'qualificationReceiptDigest','reservationId','reservationEventDigest','destinationId','descriptorDigest','payloadInventoryDigest']);m4bFlags(o);need(o.kind==='delivery-completed','DELIVERY_KIND');id(o.destinationId);id(o.reservationId);for(const k of ['qualificationReceiptDigest','reservationEventDigest','descriptorDigest','payloadInventoryDigest'])hash(o[k]);need(o.priorHeadDigest===o.reservationEventDigest,'RESERVATION_BINDING_MISMATCH');return o;}
export function validateDeliveryMarkerM4B(value){const o=ownedJson(value);exact(o,['schemaVersion','kind','qualificationOnly','operationallyAccepted','gateActive','eventDigest','receiptHash','candidateDigest','destinationId']);need(o.schemaVersion===1&&o.kind==='qualification-delivery-complete'&&o.qualificationOnly===true&&o.operationallyAccepted===false&&o.gateActive===false,'QUALIFICATION_ONLY_REQUIRED');for(const k of ['eventDigest','receiptHash','candidateDigest'])hash(o[k]);id(o.destinationId);return o;}
export function validateQualifyRequestM4B(value){const o=ownedJson(value);exact(o,['candidateDigest','headDigest']);hash(o.candidateDigest);hash(o.headDigest);return o;}
export function validateExportRequestM4B(value){const o=ownedJson(value);exact(o,['qualificationReceiptDigest','destinationId']);hash(o.qualificationReceiptDigest);id(o.destinationId);return o;}
export function qualificationReferencesM4B(value){const s=validateStateV2(value);need(diagnosticFactsReadyV2(s),'INCOMPLETE_DIAGNOSTIC_FACTS');const evidence=s.evidence.filter(e=>e.generation===s.generation&&same(e.binding,bindingForV2(s.plan,s.candidate))),frozen=evidence.find(e=>e.kind==='frozen'),results=s.results.filter(r=>r.generation===s.generation),author=results.find(r=>r.role==='author'),validator=results.find(r=>r.role==='validator'),reviewer=results.find(r=>r.role==='reviewer');need(author&&['completed-pass','completed-fail'].includes(author.outcome),'AUTHOR_NOT_COMPLETED');return ownedJson({frozenArtifactHash:frozen.artifactHash,authorResultId:author.id,validatorResultId:validator.id,reviewerResultId:reviewer.id,submissionArtifacts:[...new Set(s.results.filter(r=>r.generation===s.generation||r.role==='plan-review').filter(r=>r.submissionArtifactHash!==null).map(r=>r.submissionArtifactHash))],testArtifacts:evidence.filter(e=>e.kind==='test').map(e=>e.artifactHash),logArtifacts:[...new Set(evidence.filter(e=>e.kind==='test').flatMap(e=>e.details.logArtifacts))]});}
export function validateDeliveryAuditM4B(history,type,state,previousDigest,artifacts,resolveArtifact){
  need(DELIVERY_EVENTS_M4B.includes(type),'UNKNOWN_EVENT_TYPE');validateTransitionV2(history.at(-1)?.payload??null,type,state);need(Array.isArray(artifacts)&&artifacts.length===1,'DELIVERY_ARTIFACT_REQUIRED');
  const record=(type==='QUALIFICATION_FINALIZED'?validateQualificationRecordM4B:type==='DELIVERY_RESERVED'?validateDeliveryReservationM4B:validateDeliveryReceiptM4B)(artifacts[0]);
  need(record.jobId===state.jobId&&record.projectId===state.projectId&&record.generation===state.generation&&record.candidateDigest===state.candidate&&record.priorHeadDigest===previousDigest,'DELIVERY_BINDING_MISMATCH');
  const prior=history.filter(e=>DELIVERY_EVENTS_M4B.includes(e.type)&&e.payload.candidate===state.candidate),finalized=prior.filter(e=>e.type==='QUALIFICATION_FINALIZED'),reserved=prior.filter(e=>e.type==='DELIVERY_RESERVED'),completed=prior.filter(e=>e.type==='DELIVERY_COMPLETED');
  if(type==='QUALIFICATION_FINALIZED'){
    need(prior.length===0,'QUALIFICATION_ALREADY_FINALIZED');const refs=qualificationReferencesM4B(state);for(const key of Object.keys(refs))need(same(record[key],refs[key]),'QUALIFICATION_REFERENCE_MISMATCH');need(record.planDigest===digest(state.plan)&&record.environmentDigest===state.plan.environmentDigest&&record.executionPolicyDigest===digest(state.plan.executionPolicy),'QUALIFICATION_BINDING_MISMATCH');
  }else{
    need(finalized.length===1&&completed.length===0&&(type==='DELIVERY_RESERVED'?reserved.length===0:reserved.length===1),'DELIVERY_ORDER');const final=resolveArtifact(finalized[0].artifacts[0]);validateQualificationRecordM4B(final);need(record.qualificationReceiptDigest===finalized[0].artifacts[0],'QUALIFICATION_RECEIPT_MISMATCH');const descriptor=validateCandidateDescriptorV2(resolveArtifact(final.frozenArtifactHash));need(record.descriptorDigest===digest(descriptor)&&record.payloadInventoryDigest===digest(descriptor.files)&&descriptor.candidateDigest===state.candidate,'DELIVERY_DESCRIPTOR_MISMATCH');
    if(type==='DELIVERY_RESERVED')need(previousDigest===finalized[0].eventDigest,'FINALIZATION_HEAD_CHANGED');
    else{const reservation=validateDeliveryReservationM4B(resolveArtifact(reserved[0].artifacts[0]));need(record.reservationId===reservation.id&&record.reservationEventDigest===reserved[0].eventDigest&&record.destinationId===reservation.destinationId&&record.qualificationReceiptDigest===reservation.qualificationReceiptDigest&&record.descriptorDigest===reservation.descriptorDigest&&record.payloadInventoryDigest===reservation.payloadInventoryDigest,'RESERVATION_BINDING_MISMATCH');}
  }
  return record;
}

// Stage 6 bundle: the offline acceptance record. It attests owner-computed facts; it grants nothing.
export const ACCEPTANCE_EVENT_V2='ACCEPTANCE_RECORDED';
export function validateAcceptRequestV2(value){const o=ownedJson(value);exact(o,['candidateDigest','headDigest']);hash(o.candidateDigest);hash(o.headDigest);return o;}
/** Pure subset check over the trusted descriptor. The workspace producer owns `changes` completeness; the helper never re-derives it. */
export function acceptanceScopeCleanV2(plan,descriptor,candidate){
  try{
    const p=validatePlanV2(plan),d=validateCandidateDescriptorV2(descriptor);hash(candidate);
    need(d.candidateDigest===candidate&&d.planDigest===digest(p),'SCOPE_MISMATCH');
    const planned=new Map(p.files.map(f=>[f.path,f.operation]));
    for(const c of d.changes){const operation=planned.get(c.path);need(operation!==undefined,'SCOPE_MISMATCH');need(operation===(c.operation==='create'?'create':c.operation==='delete'?'delete':'replace')||c.operation==='modify'&&operation==='edit','SCOPE_MISMATCH');}
    return true;
  }catch{return false;}
}
export function validateAcceptanceReceiptV2(value){
  const o=ownedJson(value);exact(o,['schemaVersion','kind','operationallyAccepted','gateActive','id','nonce','jobId','projectId','generation','priorHeadDigest','candidateDigest','planDigest','acceptanceDigest','facts','frozenArtifactHash','authorResultId','validatorResultId','reviewerResultId','submissionArtifacts','testArtifacts','logArtifacts']);
  need(o.schemaVersion===1&&o.kind==='acceptance-recorded'&&o.operationallyAccepted===false&&o.gateActive===false,'ACCEPTANCE_RECEIPT_KIND');
  id(o.id);id(o.jobId);hash(o.nonce);hash(o.projectId);integer(o.generation,1);for(const k of ['priorHeadDigest','candidateDigest','planDigest','acceptanceDigest','frozenArtifactHash'])hash(o[k]);
  for(const k of ['authorResultId','validatorResultId','reviewerResultId'])id(o[k]);for(const k of ['submissionArtifacts','testArtifacts','logArtifacts'])list(o[k],1024,hash);
  exact(o.facts,ACCEPTANCE_FACT_KEYS);for(const k of ACCEPTANCE_FACT_KEYS)need(o.facts[k]===true,'ACCEPTANCE_FACTS_REQUIRED');return o;
}
export function validateAcceptanceAuditV2(history,type,state,previousDigest,artifacts){
  need(type===ACCEPTANCE_EVENT_V2,'UNKNOWN_EVENT_TYPE');validateTransitionV2(history.at(-1)?.payload??null,type,state);need(Array.isArray(artifacts)&&artifacts.length===1,'ACCEPTANCE_ARTIFACT_REQUIRED');
  const r=validateAcceptanceReceiptV2(artifacts[0]);
  need(r.jobId===state.jobId&&r.projectId===state.projectId&&r.generation===state.generation&&r.candidateDigest===state.candidate&&r.priorHeadDigest===previousDigest&&r.planDigest===digest(state.plan)&&r.acceptanceDigest===acceptanceDigestV2(state.plan),'ACCEPTANCE_BINDING_MISMATCH');
  const references=qualificationReferencesM4B(state);for(const key of Object.keys(references))need(same(r[key],references[key]),'ACCEPTANCE_REFERENCE_MISMATCH');
  need(!history.some(e=>e.type===ACCEPTANCE_EVENT_V2&&e.payload.candidate===state.candidate),'ACCEPTANCE_ALREADY_RECORDED');
  need(!history.some(e=>DELIVERY_EVENTS_M4B.includes(e.type)&&e.payload.candidate===state.candidate),'ACCEPTANCE_ORDER');
  need(evaluateAcceptanceV2(state,r.facts).predicatesHold===true,'ACCEPTANCE_PREDICATES_FAILED');return r;
}

