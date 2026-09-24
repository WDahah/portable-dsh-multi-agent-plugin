import {randomUUID} from 'node:crypto';
import {PROVENANCE, ownedJson, canonicalize, digest, need, exact, id, integer, enumeration, validatePlan,
  validateActor, validateAssignment, validateSubmission, validateResult, validateEvidence, validateDecision,
  bindingFor, same} from './contracts.mjs';

const terminal=new Set(['STOPPED','RECONCILIATION_REQUIRED','REASSESS_REQUIRED']);
const resultFor=(s,role)=>s.results.findLast(r=>r.role===role&&r.generation===(role==='plan-review'?s.planGeneration:s.generation)&&same(r.binding,bindingFor(s.plan,role==='plan-review'?null:s.candidate)));
const currentEvidence=(s,e)=>s.assignments.some(a=>a.id===e.assignmentId&&a.generation===s.generation);
function requirePlan(s) {
  const r=resultFor(s,'plan-review');
  need(r?.outcome==='completed-pass'&&s.decision?.decision==='authorize'&&s.decision.planDigest===digest(s.plan)&&
    s.decision.generation===s.planGeneration&&s.decision.reviewResultId===r.id,'PLAN_NOT_AUTHORIZED');
}
function criteriaPass(plan,submission) {
  need(submission.criteria.length===plan.criteria.length&&plan.criteria.every(c=>submission.criteria.some(x=>x.id===c.id&&x.outcome==='pass')),'CRITERIA_NOT_PASSED');
  need(!submission.findings.some(f=>f.severity==='blocker'&&f.status!=='resolved'),'OPEN_BLOCKER');
}
function validateJudgments(plan,submission) {
  const ids=new Set(plan.criteria.map(c=>c.id));
  need(submission.criteria.every(c=>ids.has(c.id))&&submission.findings.every(f=>ids.has(f.criterionId)),'UNKNOWN_CRITERION');
}
function evidenceMatches(s,e) {
  need(currentEvidence(s,e)&&same(e.binding,bindingFor(s.plan,s.candidate)),'STALE_EVIDENCE');
  need(e.status==='completed','INCOMPLETE_EVIDENCE');
}
function unresolvedFindings(results) {
  const bindings=new Map(),open=new Map();
  for(const result of results)for(const f of result.submission.findings){
    // Role owns a finding across fresh actors/candidates; IDs cannot silently change criteria.
    const bindingKey=canonicalize([result.role,f.id]),key=canonicalize([result.role,f.criterionId,f.id]);
    need(!bindings.has(bindingKey)||bindings.get(bindingKey)===f.criterionId,'FINDING_ID_CONFLICT');
    bindings.set(bindingKey,f.criterionId);
    if(f.severity!=='blocker')continue;
    if(f.status==='open')open.set(key,{criterionId:f.criterionId,role:result.role,id:f.id});
    else if(['completed-pass','completed-fail'].includes(result.outcome))open.delete(key);
  }
  return [...open.values()];
}
function independence(s,actor,role) {
  if(role==='plan-review')need(actor.id!==s.plan.policy.planner.id&&actor.provider!==s.plan.policy.planner.provider,'INDEPENDENCE_REQUIRED');
  if(role==='author')need(actor.provider===s.plan.policy.implementerProvider,'AUTHOR_ROUTE_CHANGED');
  if(role==='validator'||role==='reviewer'){
    need(actor.id!==s.plan.policy.planner.id&&!s.authors.some(a=>a.id===actor.id),'INDEPENDENCE_REQUIRED');
    need(!s.assignments.some(a=>a.actor.id===actor.id&&a.role!=='plan-review'),'ACTOR_REUSED');
    if(role==='reviewer')need(actor.provider!==s.plan.policy.implementerProvider,'INDEPENDENCE_REQUIRED');
  }
}

/** Structural diagnostics only. Success can never grant operational acceptance. */
export function structuralAcceptance(state) {
  try {
    const s=ownedJson(state);validatePlan(s.plan);s.assignments.forEach(validateAssignment);s.results.forEach(validateResult);s.evidence.forEach(validateEvidence);if(s.decision)validateDecision(s.decision);
    requirePlan(s);need(s.candidate!==null,'CANDIDATE_REQUIRED');
    const frozen=s.evidence.filter(e=>e.kind==='frozen'&&currentEvidence(s,e)&&e.binding.candidateDigest===s.candidate);
    need(frozen.length===1,'FROZEN_EVIDENCE_REQUIRED');evidenceMatches(s,frozen[0]);
    for(const command of s.plan.commands){
      const receipts=s.evidence.filter(e=>e.kind==='test'&&currentEvidence(s,e)&&e.details.commandId===command.id&&same(e.binding,bindingFor(s.plan,s.candidate)));
      need(receipts.length===1,'TEST_EVIDENCE_REQUIRED');const e=receipts[0];evidenceMatches(s,e);
      need(e.details.commandDigest===digest(command)&&e.details.expectedExit===command.expectedExit&&e.details.actualExit===command.expectedExit&&
        e.details.captureComplete&&e.details.managedSettled,'INVALID_TEST_EVIDENCE');
      need(e.details.inventory.length===command.inventory.length&&command.inventory.every(i=>e.details.inventory.some(x=>x.id===i&&x.outcome==='pass')),'TEST_INVENTORY_FAILED');
    }
    const validation=resultFor(s,'validator'),review=resultFor(s,'reviewer');
    need(validation?.outcome==='completed-pass'&&review?.outcome==='completed-pass','RESULTS_REQUIRED');
    need(validation.actor.id!==review.actor.id&&!s.authors.some(a=>[validation.actor.id,review.actor.id].includes(a.id))&&review.actor.provider!==s.plan.policy.implementerProvider,'INDEPENDENCE_REQUIRED');
    for(const r of [validation,review]){
      criteriaPass(s.plan,r.submission);
      const required=s.evidence.filter(e=>currentEvidence(s,e)&&same(e.binding,bindingFor(s.plan,s.candidate))).map(e=>e.id);
      need(required.every(e=>r.submission.evidenceIds.includes(e)),'MISSING_RESULT_EVIDENCE');
    }
    need(unresolvedFindings(s.results).length===0,'OPEN_BLOCKER');
    need(!terminal.has(s.phase),'TERMINAL_STATE');
    return Object.freeze({structurallyReady:true,operationallyAccepted:false,provenance:PROVENANCE});
  }catch(error){return Object.freeze({structurallyReady:false,operationallyAccepted:false,provenance:PROVENANCE,reason:error.code??'INVALID_STATE'});}
}
export function operationalAcceptance() {return Object.freeze({accepted:false,reason:'UNTRUSTED_PROVENANCE',readiness:'inactive'});}

/** Predicts a fixture transition. No dispatch, filesystem mutation or live lease is returned. */
export function reduceState(previous,input) {
  const a=ownedJson(input);need(a&&typeof a==='object','INVALID_ACTION');
  if(previous===null){
    exact(a,['type','plan']);need(a.type==='PLAN_PROPOSED','INVALID_INITIAL_STATE');const plan=validatePlan(a.plan);
    return ownedJson({schemaVersion:1,provenance:PROVENANCE,jobId:plan.jobId,projectId:plan.projectId,revision:1,generation:1,
      phase:'PLANNING',planGeneration:1,plan,attempts:[],authors:[],assignments:[],results:[],evidence:[],decision:null,candidate:null,action:a});
  }
  const s=ownedJson(previous);need(s.schemaVersion===1&&s.provenance===PROVENANCE,'INVALID_STATE');
  const n=JSON.parse(canonicalize(s));n.action=a;n.revision++;
  need(!terminal.has(s.phase),'TERMINAL_STATE');
  switch(a.type){
    case 'PLAN_PROPOSED':{
      exact(a,['type','plan']);const p=validatePlan(a.plan);need(p.jobId===s.jobId&&p.projectId===s.projectId,'JOB_IDENTITY_CHANGED');
      need(!s.attempts.length||p.policy.implementerProvider===s.plan.policy.implementerProvider,'AUTHOR_ROUTE_CHANGED');
      need(s.phase!=='AUTHORING'&&!s.assignments.some(x=>x.generation===s.generation&&!s.results.some(r=>r.assignmentId===x.id)&&x.role!=='author'),'UNSETTLED_ASSIGNMENT');
      n.plan=p;n.generation++;n.planGeneration=n.generation;
      n.phase=unresolvedFindings(s.results).some(f=>!p.criteria.some(c=>c.id===f.criterionId))?'REASSESS_REQUIRED':'PLANNING';
      n.decision=null;n.candidate=null;break;
    }
    case 'ASSIGNMENT_CREATED':{
      exact(a,['type','assignment']);const v=validateAssignment(a.assignment);
      need(!s.assignments.some(x=>x.id===v.id),'ASSIGNMENT_EXISTS');need(v.generation===s.generation,'STALE_GENERATION');
      need(v.role!=='author','USE_ATTEMPT_RESERVATION');
      if(v.role==='plan-review')need(s.phase==='PLANNING','INVALID_PHASE');else {requirePlan(s);need(s.phase==='FROZEN','INVALID_PHASE');}
      need(!s.assignments.some(x=>x.generation===s.generation&&x.role===v.role&&same(x.binding,v.binding)),'ROLE_ALREADY_ASSIGNED');
      need(same(v.binding,bindingFor(s.plan,v.role==='plan-review'?null:s.candidate)),'BINDING_MISMATCH');independence(s,v.actor,v.role);n.assignments.push(v);break;
    }
    case 'RESULT_RECORDED':{
      exact(a,['type','result']);const r=validateResult(a.result),assignment=s.assignments.find(x=>x.id===r.assignmentId);
      need(assignment&&same(r.actor,assignment.actor)&&r.role===assignment.role&&same(r.binding,assignment.binding),'ASSIGNMENT_MISMATCH');
      need(r.generation===s.generation&&assignment.generation===s.generation,'STALE_GENERATION');
      need(!s.results.some(x=>x.id===r.id||x.assignmentId===r.assignmentId),'RESULT_EXISTS');
      need(r.role==='plan-review'?s.phase==='PLANNING':s.phase==='FROZEN','INVALID_PHASE');
      validateJudgments(s.plan,r.submission);
      for(const eid of r.submission.evidenceIds){const e=s.evidence.find(x=>x.id===eid);need(e,'UNKNOWN_EVIDENCE');evidenceMatches(s,e);}
      if(r.outcome==='completed-pass')criteriaPass(s.plan,r.submission);
      unresolvedFindings([...s.results,r]); // Reject a conflicting persistent finding identity before commit.
      n.results.push(r);
      if(r.role==='plan-review')n.phase=r.outcome==='completed-pass'?'AWAITING_HUMAN':'PLANNING';
      else {
        const pending=s.assignments.some(x=>x.generation===s.generation&&['validator','reviewer'].includes(x.role)&&!n.results.some(v=>v.assignmentId===x.id));
        const failed=n.results.some(x=>x.generation===s.generation&&['validator','reviewer'].includes(x.role)&&x.outcome!=='completed-pass');
        if(!pending&&failed)n.phase=s.attempts.length>=3?'REASSESS_REQUIRED':'CORRECTION_REQUIRED';
        else if(!pending&&['validator','reviewer'].every(role=>s.assignments.some(x=>x.generation===s.generation&&x.role===role))){
          n.phase=structuralAcceptance(n).structurallyReady?'STRUCTURALLY_READY':s.attempts.length>=3?'REASSESS_REQUIRED':'CORRECTION_REQUIRED';
        }
      }
      break;
    }
    case 'HUMAN_DECIDED':{
      exact(a,['type','decision']);const d=validateDecision(a.decision),r=resultFor(s,'plan-review');
      need(s.phase==='AWAITING_HUMAN'&&r?.outcome==='completed-pass'&&d.reviewResultId===r.id&&d.planDigest===digest(s.plan)&&d.generation===s.generation,'PLAN_REVIEW_REQUIRED');
      n.decision=d;n.phase=d.decision==='authorize'?'PLAN_AUTHORIZED':'PLANNING';break;
    }
    case 'ATTEMPT_RESERVED':{
      exact(a,['type','assignment']);requirePlan(s);need(['PLAN_AUTHORIZED','CORRECTION_REQUIRED'].includes(s.phase),'INVALID_PHASE');
      need(s.attempts.length<3,'CORRECTION_LIMIT');const v=validateAssignment(a.assignment);
      const nextGeneration=s.generation+1;
      need(v.role==='author'&&v.generation===nextGeneration&&same(v.binding,bindingFor(s.plan,null)),'ASSIGNMENT_MISMATCH');
      n.generation=nextGeneration;
      need(!s.assignments.some(x=>x.id===v.id),'ASSIGNMENT_EXISTS');independence(s,v.actor,'author');
      n.attempts.push({index:s.attempts.length,assignmentId:v.id,planDigest:digest(s.plan)});n.assignments.push(v);
      if(!n.authors.some(x=>x.id===v.actor.id))n.authors.push(v.actor);n.candidate=null;n.phase='AUTHORING';break;
    }
    case 'CANDIDATE_SEALED':{
      exact(a,['type','evidence']);requirePlan(s);need(s.phase==='AUTHORING','INVALID_PHASE');const e=validateEvidence(a.evidence);
      const last=s.attempts.at(-1);need(e.kind==='frozen'&&e.status==='completed'&&e.assignmentId===last.assignmentId,'INVALID_FREEZE');
      need(same(e.binding,bindingFor(s.plan,e.contentDigest)),'BINDING_MISMATCH');need(!s.evidence.some(x=>x.id===e.id),'EVIDENCE_EXISTS');
      n.candidate=e.contentDigest;n.evidence.push(e);n.phase='FROZEN';break;
    }
    case 'EVIDENCE_REGISTERED':{
      exact(a,['type','evidence']);need(s.phase==='FROZEN','INVALID_PHASE');const e=validateEvidence(a.evidence);
      const assignment=s.assignments.find(x=>x.id===e.assignmentId);
      need(e.kind==='test'&&assignment?.role==='validator'&&assignment.generation===s.generation&&same(assignment.binding,e.binding),'ASSIGNMENT_MISMATCH');
      need(!s.evidence.some(x=>x.id===e.id),'EVIDENCE_EXISTS');need(currentEvidence(s,e)&&same(e.binding,bindingFor(s.plan,s.candidate)),'STALE_EVIDENCE');
      need(s.plan.commands.some(c=>c.id===e.details.commandId&&digest(c)===e.details.commandDigest),'COMMAND_MISMATCH');n.evidence.push(e);break;
    }
    case 'STOPPED':case 'RECONCILIATION_REQUIRED':{
      exact(a,['type']);n.generation++;n.phase=a.type;break;
    }
    default:need(false,'INVALID_EVENT_TYPE');
  }
  return ownedJson(n);
}
export function validateTransition(previous,next,type) {
  const n=ownedJson(next);need(n.action?.type===type,'EVENT_TYPE_MISMATCH');
  need(same(reduceState(previous,n.action),n),'INVALID_TRANSITION');
}
export function assertModelMutation(state,{assignmentId,actor,generation,planDigest,revision}) {
  const s=ownedJson(state);requirePlan(s);need(s.phase==='AUTHORING','INVALID_PHASE');
  const a=s.assignments.find(x=>x.id===assignmentId);
  need(a&&a.role==='author'&&same(a.actor,validateActor(actor))&&a.id===s.attempts.at(-1)?.assignmentId,'ASSIGNMENT_MISMATCH');
  need(generation===s.generation&&a.generation===generation&&planDigest===digest(s.plan)&&revision===s.revision,'STALE_ADMISSION');
  return Object.freeze({simulationOnly:true,provenance:PROVENANCE});
}

/** Trusted offline owner only. No plugin/tool export and no operational execution adapter. */
export function createGovernanceController(options) {
  need(options&&Object.getPrototypeOf(options)===Object.prototype,'INVALID_OPTIONS');
  need(Reflect.ownKeys(options).length===2&&['store','lifecycle'].every(k=>Object.hasOwn(options,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(options,k),'value')),'INVALID_OPTIONS');
  const {store,lifecycle}=options;
  need(store&&['load','append','close','status','revoke'].every(k=>typeof store[k]==='function'),'INVALID_STORE');
  need(lifecycle&&Reflect.ownKeys(lifecycle).length===1&&Object.hasOwn(Object.getOwnPropertyDescriptor(lifecycle,'observe')??{},'value')&&typeof lifecycle.observe==='function','INVALID_LIFECYCLE');
  const observe=lifecycle.observe.bind(Object.freeze({...lifecycle})),actors=new WeakMap(),actorIds=new Set(),handles=new WeakMap(),pending=new Set(),reopened=new Set(),seenJobs=new Set();
  let stopped=false,epoch=0,closing;
  const owner=Object.freeze({observe});
  function active(){need(!stopped,'CONTROLLER_STOPPED');need(!store.status().poisoned,'STORE_POISONED');}
  function track(fn){active();const p=Promise.resolve().then(fn);pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));return p;}
  async function state(jobId){const saved=await store.load(jobId);const s=saved.latest?.payload??null;
    if(!seenJobs.has(jobId)){seenJobs.add(jobId);if(s)reopened.add(jobId);}return s;}
  async function commit(jobId,action,revision,e=epoch){active();const s=await state(jobId);active();need(e===epoch,'STALE_GENERATION');need(!reopened.has(jobId),'RECONCILIATION_REQUIRED');
    need((s?.revision??0)===revision,'REVISION_CONFLICT');const next=reduceState(s,action);need(next.jobId===jobId,'JOB_IDENTITY_CHANGED');
    // The store validator rechecks durable consistency; epoch is rechecked at acknowledgement.
    const result=await store.append(jobId,{type:action.type,payload:next},revision);
    active();need(e===epoch,'STALE_GENERATION');return result.payload;
  }
  const api={
    enroll(actor,metadata){active();need(actor&&typeof actor==='object'&&!actors.has(actor),'INVALID_ACTOR');const value=validateActor(metadata);need(!actorIds.has(value.id),'ACTOR_REUSED');actorIds.add(value.id);actors.set(actor,value);},
    propose(plan,revision){const p=validatePlan(plan);return track(()=>commit(p.jobId,{type:'PLAN_PROPOSED',plan:p},revision));},
    assign(jobId,actor,role,revision){id(jobId);enumeration(role,['plan-review','validator','reviewer']);const metadata=actors.get(actor);need(metadata,'UNKNOWN_ACTOR');
      return track(async()=>{const s=await state(jobId);need(s,'PLAN_REQUIRED');const assignment=validateAssignment({id:randomUUID(),actor:metadata,role,generation:s.generation,binding:bindingFor(s.plan,role==='plan-review'?null:s.candidate),provenance:PROVENANCE});
        await commit(jobId,{type:'ASSIGNMENT_CREATED',assignment},revision);const handle=Object.freeze(Object.create(null));handles.set(handle,{jobId,actor,assignment,epoch,used:false});return handle;});
    },
    submit(handle,actor,input){const submission=validateSubmission(input),h=handles.get(handle);need(h&&h.actor===actor&&!h.used,'UNKNOWN_ASSIGNMENT');h.used=true;
      return track(async()=>{
        need(h.epoch===epoch,'STALE_GENERATION');
        const execution=owner.observe(actor,handle);need(execution&&execution.result&&execution.disposed,'INVALID_LIFECYCLE');
        const [result,disposal]=await Promise.allSettled([execution.result,execution.disposed]);
        active();need(h.epoch===epoch,'STALE_GENERATION');const s=await state(h.jobId);active();
        let outcome='error';
        if(result.status==='fulfilled'&&disposal.status==='fulfilled'){
          enumeration(result.value,['completed','cancelled','error','inconclusive']);
          if(result.value==='completed'){outcome='completed-pass';try{criteriaPass(s.plan,submission);}catch{outcome='completed-fail';}}
          else outcome=result.value;
        }
        const record=validateResult({id:randomUUID(),assignmentId:h.assignment.id,actor:h.assignment.actor,role:h.assignment.role,
          generation:h.assignment.generation,binding:h.assignment.binding,outcome,submission,provenance:PROVENANCE});
        return commit(h.jobId,{type:'RESULT_RECORDED',result:record},s.revision,h.epoch);
      });
    },
    decide(jobId,decision,revision){const d=validateDecision(decision);return track(()=>commit(jobId,{type:'HUMAN_DECIDED',decision:d},revision));},
    async status(jobId){const s=await state(jobId);return ownedJson({readiness:'inactive',provenance:PROVENANCE,phase:stopped?'STOPPED':s?.phase??'EMPTY',revision:s?.revision??0,generation:s?.generation??0,attemptsUsed:s?.attempts.length??0,planDigest:s?digest(s.plan):null,reconciliationRequired:reopened.has(jobId)||!!s&&s.assignments.some(a=>!s.results.some(r=>r.assignmentId===a.id)),refusals:store.status().refusals??[]});},
    request(){need(false,'INACTIVE_PREREQUISITES');},
    close(){if(closing)return closing;stopped=true;epoch++;
      store.revoke();
      closing=(async()=>{await Promise.allSettled([...pending]);await store.close();})();return closing;
    },
  };
  return Object.freeze(api);
}

import {V2_PROVENANCE,validatePlanV2,validateStateV2,validateActorV2,validateAssignmentV2,validateDecisionV2,
  validateResultV2,validateEvidenceV2,validateCandidateDescriptorV2,planIdentityV2,bindingForV2,diagnosticFactsReadyV2} from './contracts.mjs';
function v2Options(input,required,optional=[]){need(input&&typeof input==='object'&&Object.getPrototypeOf(input)===Object.prototype,'CLOSED_SCHEMA');const keys=Reflect.ownKeys(input);need(keys.every(k=>typeof k==='string'&&[...required,...optional].includes(k))&&required.every(k=>keys.includes(k)),'CLOSED_SCHEMA');const o={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(input,key);need(d&&Object.hasOwn(d,'value')&&d.enumerable,'INVALID_DESCRIPTOR');o[key]=d.value;}return o;}
function v2Accepted(s){const review=s.results.findLast(r=>r.role==='plan-review'&&r.generation===s.planGeneration);need(review?.outcome==='completed-pass'&&s.decision?.decision==='authorize'&&s.decision.planDigest===digest(s.plan)&&s.decision.reviewResultId===review.id&&s.decision.generation===s.planGeneration,'PLAN_NOT_AUTHORIZED');}
export function assertModelMutationV2(value,request){
  const s=validateStateV2(value),r=ownedJson(request);exact(r,['assignmentId','actor','generation','planDigest','revision']);v2Accepted(s);
  need(s.phase==='AUTHORING'&&s.revision===r.revision&&s.generation===r.generation&&digest(s.plan)===r.planDigest,'STALE_AUTHORITY');
  const assignment=s.assignments.find(a=>a.id===r.assignmentId);need(assignment&&assignment.role==='author'&&assignment.generation===s.generation&&same(assignment.actor,r.actor)&&same(assignment.binding,bindingForV2(s.plan,null)),'ASSIGNMENT_MISMATCH');
  const attempt=s.attempts.at(-1);need(attempt&&attempt.assignmentId===assignment.id&&attempt.planDigest===r.planDigest&&!s.results.some(v=>v.assignmentId===assignment.id),'AUTHOR_RESERVATION_REQUIRED');return true;
}
const m4Requested=new WeakMap(),m4Bridges=new WeakMap(),m4Owners=new WeakMap(),m4bGrants=new WeakMap();
/** Owner-only pipeline. JSON schemas cannot authenticate a producer; captured ports own every fact. */
export async function createGovernanceControllerV2(input){
  const continuity=m4Requested.get(input);
  const o=v2Options(input,['store','host','humanPort','workspaceFactory','runnerFactory'],['failpoint']);
  for(const [name,methods] of [['store',['append','load','readArtifact','assertOwner','status','revoke','close']],['host',['prepareStage','start','observe','cancel','close']],['humanPort',['bind']]])need(o[name]&&methods.every(m=>typeof o[name][m]==='function'),'MISSING_OWNER_PORT');
  need(typeof o.workspaceFactory==='function'&&typeof o.runnerFactory==='function'&&(o.failpoint===undefined||typeof o.failpoint==='function'),'INVALID_OWNER_FACTORY');
  const loaded=await o.store.load();let state=loaded.latest?.payload??null;
  if(state)validateStateV2(state);
  let pending=false,stopped=loaded.reconciliationRequired||o.store.status().reconciliationRequired,epoch=0,queue=Promise.resolve(),closing=null,workspace=null,custody=null,activeRun=null,pendingAuthorResult=null;
  const activeRunners=new Set(),operations=new Set(),runtimeActors=new Map(),ownerReads=new Set();let runnerBusy=false;
  function stageRead(fn){if(!continuity)return fn();need(!continuity.qualificationBusy,'QUALIFICATION_BUSY');const result=fn();if(result&&typeof result.then==='function'){ownerReads.add(result);result.then(()=>ownerReads.delete(result),()=>ownerReads.delete(result));}return result;}
  const invalid=code=>Object.assign(new Error(code),{code});
  const readCurrent=()=>{if(stopped||pending||continuity?.denied)return null;try{continuity?.check();o.store.assertOwner();if(stopped||pending||continuity?.denied)return null;return state;}catch{return null;}};
  const authority=Object.freeze({readCurrent});
  function live(expected=epoch){need(!stopped&&expected===epoch,'CONTROLLER_STOPPED');continuity?.check();o.store.assertOwner();need(!stopped&&expected===epoch,'CONTROLLER_STOPPED');}
  const hit=async(name,context={})=>{if(o.failpoint)await o.failpoint(name,ownedJson(context));};
  function track(fn){const scheduledEpoch=epoch;const task=queue.then(()=>{if(continuity){need(!continuity.denied&&epoch===scheduledEpoch,'CONTINUITY_ADMISSION_CLOSED');continuity.check();}return fn();});queue=task.catch(()=>{});operations.add(task);task.then(()=>operations.delete(task),()=>operations.delete(task));return task;}
  async function commit(type,changes,artifacts=[],expected=epoch){
    live(expected);const revision=(state?.revision??0)+1,action=ownedJson({type});
    const next=validateStateV2({...state,...changes,revision,action});pending=true;
    try{await hit('controller.commit.before',{type,revision});live(expected);const event=await o.store.append({type,payload:next,artifacts},revision-1);need(event.eventDigest&&same(event.payload,next),'STORE_ACK_MISMATCH');live(expected);state=next;return next;}finally{pending=false;}
  }
  const newId=()=>randomUUID();
  function stageAssignment(role){
    const route=state.plan.executionPolicy.routes[role],assignmentId=newId();
    const actor=validateActorV2({id:assignmentId,...route});
    if(role==='plan-review')need(actor.provider!==state.plan.policy.planner.provider,'INDEPENDENCE_REQUIRED');
    if(role==='reviewer')need(actor.provider!==state.plan.policy.implementerProvider,'INDEPENDENCE_REQUIRED');
    if(role==='validator'||role==='reviewer')need(actor.id!==state.plan.policy.planner.id&&!state.authors.some(a=>a.id===actor.id)&&!state.assignments.some(a=>a.actor.id===actor.id),'INDEPENDENCE_REQUIRED');
    const generation=role==='author'?state.generation+1:role==='plan-review'?state.planGeneration:state.generation;
    return validateAssignmentV2({schemaVersion:2,provenance:V2_PROVENANCE,id:assignmentId,actor,role,generation,binding:bindingForV2(state.plan,role==='plan-review'||role==='author'?null:state.candidate)});
  }
  function currentAssignment(a){live();need(state&&!['STOPPED','REASSESS_REQUIRED','RECONCILIATION_REQUIRED','CORRECTION_REQUIRED'].includes(state.phase),'INVALID_STAGE');need(!pending&&state.assignments.some(v=>same(v,a)),'STALE_ASSIGNMENT');need(same(a.binding,bindingForV2(state.plan,a.binding.candidateDigest))&&a.generation===(a.role==='plan-review'?state.planGeneration:state.generation),'STALE_BINDING');}
  async function protectedArtifact(hash,expectedEpoch=epoch){
    live(expectedEpoch);const snapshot=await o.store.load();live(expectedEpoch);const event=snapshot.history.find(e=>e.artifacts.includes(hash));need(event,'ARTIFACT_MISSING');
    const value=await o.store.readArtifact({revision:event.revision,hash});live(expectedEpoch);need(digest(value)===hash,'ARTIFACT_DIGEST_MISMATCH');return value;
  }
  async function artifactFor(id){
    live();const e=epoch,identity=digest(state.plan),generation=state.generation,candidate=state.candidate;
    const evidence=state.evidence.find(e=>e.id===id);need(evidence&&evidence.generation===generation&&same(evidence.binding,bindingForV2(state.plan,candidate)),'FOREIGN_EVIDENCE');
    const value=await protectedArtifact(evidence.artifactHash,e);live(e);need(state.generation===generation&&state.candidate===candidate&&digest(state.plan)===identity,'STALE_BINDING');
    if(evidence.kind==='frozen'){const descriptor=validateCandidateDescriptorV2(value);need(descriptor.candidateDigest===candidate&&descriptor.assignmentId===evidence.assignmentId&&descriptor.planDigest===identity,'FREEZE_BINDING_MISMATCH');}
    else{need(value.assignmentId===evidence.assignmentId&&same(value.binding,evidence.binding)&&value.commandDigest===evidence.details.commandDigest,'TEST_ARTIFACT_MISMATCH');for(const hash of evidence.details.logArtifacts)await protectedArtifact(hash,e);}
    live(e);return value;
  }
  async function verifyProtectedStage(e){
    for(const evidence of state.evidence.filter(v=>v.generation===state.generation))await artifactFor(evidence.id);
    for(const result of state.results.filter(v=>v.generation===state.generation||v.role==='plan-review'))if(result.submission!==null){const submission=await protectedArtifact(result.submissionArtifactHash,e);need(same(submission,result.submission),'SUBMISSION_ARTIFACT_MISMATCH');}
    live(e);custody?.verify();
  }
  async function testCommand(a,lease,commandId){
    currentAssignment(a);need(a.role==='validator'&&typeof commandId==='string','RUNNER_ROLE_REQUIRED');const command=state.plan.commands.find(c=>c.id===commandId);need(command,'UNKNOWN_COMMAND');need(!state.evidence.some(e=>e.kind==='test'&&e.generation===state.generation&&e.details.commandId===commandId),'COMMAND_ALREADY_EXECUTED');
    const e=epoch,runner=await o.runnerFactory({plan:state.plan,assignment:Object.freeze({...a,actor:runtimeActors.get(a.id)}),custody,lease,authorize:()=>{currentAssignment(a);custody.verify();return true;}});need(runner&&['run','consume','stop','close'].every(k=>typeof runner[k]==='function'),'INVALID_RUNNER');activeRunners.add(runner);
    let facts;
    try{const receipt=await runner.run(commandId);facts=ownedJson(await runner.consume(receipt));}finally{await runner.close();activeRunners.delete(runner);}
    live(e);currentAssignment(a);exact(facts,['commandId','commandDigest','binding','assignmentId','actualExit','signal','timedOut','aborted','captureComplete','managedSettled','enforcement','settlementGraceMs','inventory','stdoutDigest','stderrDigest','stdoutChunks','stderrChunks','status','reason','limitations']);
    need(facts.commandId===commandId&&facts.commandDigest===digest(command)&&same(facts.binding,a.binding)&&facts.assignmentId===a.id&&facts.settlementGraceMs===state.plan.executionPolicy.settlementGraceMs,'RUNNER_FACT_MISMATCH');
    need(facts.status==='completed'||facts.status==='failed','RUNNER_FACT_MISMATCH');
    for(const k of ['timedOut','aborted','captureComplete','managedSettled'])need(typeof facts[k]==='boolean','RUNNER_FACT_MISMATCH');
    need(Array.isArray(facts.stdoutChunks)&&Array.isArray(facts.stderrChunks)&&facts.stdoutChunks.length+facts.stderrChunks.length<=128,'LOG_LIMIT');
    const logs=[];for(const stream of ['stdout','stderr']){let offset=0;for(const text of facts[stream+'Chunks']){need(typeof text==='string'&&text.length<=16384&&/^[\x00-\x7f]*$/.test(text),'INVALID_CAPTURE');logs.push(ownedJson({stream,offset,text}));offset+=text.length;}}
    const details={commandId,commandDigest:facts.commandDigest,expectedExit:command.expectedExit,actualExit:facts.actualExit,stdoutDigest:facts.stdoutDigest,stderrDigest:facts.stderrDigest,captureComplete:facts.captureComplete,inventory:facts.inventory,managedSettled:facts.managedSettled,enforcement:facts.enforcement,deadlineFired:facts.timedOut,signal:facts.signal,logArtifacts:logs.map(digest)};
    const evidence=validateEvidenceV2({schemaVersion:2,provenance:V2_PROVENANCE,id:newId(),kind:'test',assignmentId:a.id,generation:a.generation,binding:a.binding,status:facts.status,contentDigest:digest(details),artifactHash:digest(facts),details});
    await commit('EVIDENCE_REGISTERED',{evidence:[...state.evidence,evidence]},[facts,...logs],e);return ownedJson({id:evidence.id,status:evidence.status,commandId,candidateDigest:state.candidate});
  }
  function evaluateJudgment(a,observation){
    need(same(observation.actor,a.actor),'ACTUAL_ACTOR_CHANGED');const stop=observation.stopReason;need(['completed','error','cancelled','inconclusive'].includes(stop),'INVALID_HOST_OUTCOME');
    const submission=observation.submission===null?null:validateSubmission(observation.submission);
    if(submission){validateJudgments(state.plan,submission);for(const evidenceId of submission.evidenceIds)need(state.evidence.some(v=>v.id===evidenceId&&v.generation===state.generation&&same(v.binding,a.binding)),'FOREIGN_EVIDENCE');}
    let outcome=stop==='completed'?'completed-fail':stop;
    if(stop==='completed'&&submission){try{criteriaPass(state.plan,submission);outcome='completed-pass';}catch{}}
    return validateResultV2({schemaVersion:2,provenance:V2_PROVENANCE,id:newId(),assignmentId:a.id,actor:a.actor,role:a.role,generation:a.generation,binding:a.binding,outcome,submission,submissionArtifactHash:submission===null?null:digest(submission)});
  }
  async function executeStage(role){
    live();need(state,'PLAN_REQUIRED');const e=epoch;
    if(role==='plan-review')need(state.phase==='PLANNING'&&!state.assignments.some(a=>a.role==='plan-review'),'PLAN_REVIEW_ALREADY_STARTED');
    else if(role==='author'){v2Accepted(state);need(['PLAN_AUTHORIZED','CORRECTION_REQUIRED'].includes(state.phase),'AUTHOR_NOT_ALLOWED');need(state.attempts.length<3,'REASSESS_REQUIRED');}
    else{need(custody&&state.candidate&&['FROZEN','VALIDATING','REVIEWING'].includes(state.phase),'CANDIDATE_REQUIRED');v2Accepted(state);need(!state.assignments.some(a=>a.role===role&&a.generation===state.generation),'ROLE_ALREADY_ASSIGNED');custody.verify();}
    const a=stageAssignment(role),ticket=o.host.prepareStage({id:a.id,role,route:state.plan.executionPolicy.routes[role],binding:a.binding,plan:state.plan});
    if(role==='author'){
      if(workspace){workspace.revoke();await workspace.close();workspace=null;custody=null;}
      await commit('ATTEMPT_RESERVED',{phase:'AUTHORING',generation:a.generation,candidate:null,assignments:[...state.assignments,a],authors:[...state.authors,a.actor],attempts:[...state.attempts,{index:state.attempts.length,assignmentId:a.id,planDigest:digest(state.plan)}]},[],e);
    }else await commit('ASSIGNMENT_CREATED',{phase:role==='validator'?'VALIDATING':role==='reviewer'?'REVIEWING':state.phase,assignments:[...state.assignments,a]},[],e);
    try{
      activeRun=await o.host.start(ticket,{onActor:async actual=>{
        currentAssignment(a);need(actual&&same(actual.actor,a.actor),'ACTUAL_ACTOR_CHANGED');runtimeActors.set(a.id,actual.actor);
        if(role==='author'){
          workspace=await o.workspaceFactory({plan:state.plan,authority});need(workspace&&['beginAttempt','seal','transfer','revoke','close'].every(k=>typeof workspace[k]==='function'),'INVALID_WORKSPACE');
          const handle=await workspace.beginAttempt({actor:actual.actor,assignmentId:a.id,execution:actual.execution,disposed:actual.disposed});
          return {file:request=>workspace.file(handle,actual.actor,request),read:request=>workspace.file(handle,actual.actor,{...request,operation:'read'})};
        }
        if(role==='validator'||role==='reviewer'){
          const lease=custody.lease({actor:actual.actor,assignmentId:a.id,role});
          const handlers={read:request=>stageRead(()=>custody.read(lease,actual.actor,request)),evidence:request=>stageRead(()=>{currentAssignment(a);const owned=ownedJson(request);if(Object.hasOwn(owned,'operation')){exact(owned,['operation']);need(owned.operation==='list','INVALID_OPERATION');return ownedJson({evidence:state.evidence.filter(v=>v.generation===state.generation&&same(v.binding,a.binding)).map(v=>({id:v.id,kind:v.kind,status:v.status,binding:v.binding})),findings:unresolvedFindings(state.results.filter(r=>r.submission!==null))});}exact(owned,['evidenceId']);return artifactFor(owned.evidenceId);})};
          if(role==='validator')handlers.run=async commandId=>{need(!runnerBusy,'RUNNER_BUSY');runnerBusy=true;try{return await testCommand(a,lease,commandId);}finally{runnerBusy=false;}};return handlers;
        }
        return {};
      }});
      const observed=ownedJson(await o.host.observe(activeRun));activeRun=null;live(e);currentAssignment(a);const result=evaluateJudgment(a,observed);if(result.submission!==null)for(const evidenceId of result.submission.evidenceIds){await artifactFor(evidenceId);currentAssignment(a);}
      let phase=state.phase;
      if(role==='plan-review')phase=result.outcome==='completed-pass'?'AWAITING_HUMAN':'REASSESS_REQUIRED';
      else if(role==='author'&&observed.stopReason!=='completed')phase=state.attempts.length>=3?'REASSESS_REQUIRED':'CORRECTION_REQUIRED';
      if(role==='author'&&observed.stopReason==='completed')pendingAuthorResult=result;
      else await commit('RESULT_RECORDED',{phase,results:[...state.results,result]},result.submission===null?[]:[result.submission],e);
      if(role==='author'&&observed.stopReason!=='completed')workspace?.revoke();
      if(role==='validator'||role==='reviewer')await finalizeReadiness(e);
      return ownedJson({assignmentId:a.id,resultId:result.id,outcome:result.outcome,phase:state.phase});
    }catch(error){
      activeRun=null;if(!stopped&&epoch===e){if(role==='author'){workspace?.revoke();await commit('AUTHOR_FAILED',{phase:state.attempts.length>=3?'REASSESS_REQUIRED':'CORRECTION_REQUIRED'},[],e);}else await commit('STOPPED',{phase:'STOPPED'},[],e);}throw error;
    }
  }
  function evidenceReady(){
    if(!state?.candidate||!custody||!diagnosticFactsReadyV2(state))return false;
    try{v2Accepted(state);custody.verify();const current=state.results.filter(r=>r.generation===state.generation);const validator=current.find(r=>r.role==='validator'),reviewer=current.find(r=>r.role==='reviewer');need(validator?.outcome==='completed-pass'&&reviewer?.outcome==='completed-pass'&&validator.actor.id!==reviewer.actor.id,'INDEPENDENT_RESULTS_REQUIRED');
      need(!unresolvedFindings(state.results.filter(r=>r.submission!==null)).length,'OPEN_BLOCKER');const frozen=state.evidence.filter(e=>e.kind==='frozen'&&e.generation===state.generation&&same(e.binding,bindingForV2(state.plan,state.candidate)));need(frozen.length===1,'FROZEN_EVIDENCE_REQUIRED');
      for(const c of state.plan.commands){const evidence=state.evidence.filter(e=>e.kind==='test'&&e.generation===state.generation&&e.details.commandId===c.id&&same(e.binding,bindingForV2(state.plan,state.candidate)));need(evidence.length===1,'TEST_EVIDENCE_REQUIRED');const t=evidence[0],d=t.details;need(t.status==='completed'&&d.commandDigest===digest(c)&&d.actualExit===c.expectedExit&&d.captureComplete&&d.managedSettled&&!d.deadlineFired&&d.signal===null&&same(d.inventory,c.inventory.map(id=>({id,outcome:'pass'}))),'TEST_NOT_PASSED');}
      return true;
    }catch{return false;}
  }
  async function finalizeReadiness(e){if(!state.results.some(r=>r.role==='validator'&&r.generation===state.generation)||!state.results.some(r=>r.role==='reviewer'&&r.generation===state.generation))return;
    await verifyProtectedStage(e);const ready=evidenceReady();await commit(ready?'DIAGNOSTIC_READY':'RESULT_RECORDED',{phase:ready?'DIAGNOSTIC_READY':state.attempts.length>=3?'REASSESS_REQUIRED':'CORRECTION_REQUIRED'},[],e);
    if(!ready){workspace?.revoke();custody=null;}
  }
  const unbind=o.humanPort.bind(decision=>track(async()=>{
    live();need(state?.phase==='AWAITING_HUMAN','PLAN_REVIEW_REQUIRED');const d=ownedJson(decision);exact(d,['planDigest','reviewResultId','decision']);const review=state.results.findLast(r=>r.role==='plan-review');need(d.planDigest===digest(state.plan)&&d.reviewResultId===review?.id&&review.outcome==='completed-pass','STALE_HUMAN_DECISION');
    const record=validateDecisionV2({schemaVersion:2,provenance:V2_PROVENANCE,id:newId(),generation:state.planGeneration,...d});await commit('HUMAN_DECIDED',{phase:d.decision==='authorize'?'PLAN_AUTHORIZED':'STOPPED',decision:record});return ownedJson({phase:state.phase,planDigest:d.planDigest});
  }));need(typeof unbind==='function','INVALID_HUMAN_PORT');
  function close(){if(closing)return closing;stopped=true;epoch++;pending=true;unbind();workspace?.revoke();
    const startCleanup=fn=>{try{return Promise.resolve(fn());}catch(e){return Promise.reject(e);}};
    const cancellation=Promise.allSettled([startCleanup(()=>o.host.close()),...(activeRun?[startCleanup(()=>o.host.cancel(activeRun))]:[]),...[...activeRunners].map(r=>startCleanup(()=>r.stop()))]);
    closing=(async()=>{await Promise.allSettled([...operations,...ownerReads]);const cleanup=await Promise.allSettled([...activeRunners].map(r=>r.close()));const rest=await Promise.allSettled([workspace?.close()]);o.store.revoke();const storeClose=await Promise.allSettled([o.store.close()]);const errors=[...await cancellation,...cleanup,...rest,...storeClose].filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'V2_CLOSE_FAILED');})();return closing;}
  const api=Object.freeze({
    propose(plan){const p=validatePlanV2(plan);return track(async()=>{live();need(!state,'PLAN_ALREADY_EXISTS');need(p.projectId===o.store.status().projectId,'PROJECT_IDENTITY_MISMATCH');await commit('PLAN_PROPOSED',{schemaVersion:2,provenance:V2_PROVENANCE,jobId:p.jobId,projectId:p.projectId,generation:1,phase:'PLANNING',planGeneration:1,plan:p,attempts:[],authors:[],assignments:[],results:[],evidence:[],decision:null,candidate:null});return ownedJson({planDigest:digest(p),phase:state.phase});});},
    reviewPlan:()=>track(()=>executeStage('plan-review')),
    requestAuthor:()=>track(()=>executeStage('author')),
    seal:()=>track(async()=>{try{live();need(workspace&&state?.phase==='AUTHORING','AUTHOR_REQUIRED');const a=state.assignments.findLast(a=>a.role==='author');const r=pendingAuthorResult;need(r&&r.assignmentId===a.id&&['completed-pass','completed-fail'].includes(r.outcome),'AUTHOR_NOT_COMPLETED');const result=await workspace.seal();const descriptor=validateCandidateDescriptorV2(result.descriptor);need(descriptor.assignmentId===a.id&&descriptor.generation===state.generation&&descriptor.planDigest===digest(state.plan),'FREEZE_BINDING_MISMATCH');custody=await workspace.transfer(result.handle);need(same(custody.descriptor(),descriptor),'CUSTODY_MISMATCH');custody.verify();const evidence=validateEvidenceV2({schemaVersion:2,provenance:V2_PROVENANCE,id:newId(),kind:'frozen',assignmentId:a.id,generation:a.generation,binding:bindingForV2(state.plan,descriptor.candidateDigest),status:'completed',contentDigest:descriptor.candidateDigest,artifactHash:digest(descriptor),details:{descriptorArtifactHash:digest(descriptor),producerAssignmentId:a.id,stage:'frozen'}});await commit('CANDIDATE_SEALED',{phase:'FROZEN',candidate:descriptor.candidateDigest,evidence:[...state.evidence,evidence],results:[...state.results,r]},[descriptor,...(r.submission===null?[]:[r.submission])]);pendingAuthorResult=null;return ownedJson({candidateDigest:descriptor.candidateDigest,evidenceId:evidence.id});}catch(error){stopped=true;epoch++;pendingAuthorResult=null;workspace?.revoke();custody=null;o.store.revoke();throw error;}}),
    validate:()=>track(()=>executeStage('validator')),review:()=>track(()=>executeStage('reviewer')),
    diagnosticReadiness:()=>track(async()=>{live();const ready=evidenceReady();if(ready){for(const evidence of state.evidence.filter(e=>e.generation===state.generation))await artifactFor(evidence.id);}return ownedJson({schemaVersion:2,provenance:V2_PROVENANCE,diagnosticallyReady:ready&&state.phase==='DIAGNOSTIC_READY',accepted:false,gateActive:false,phase:state?.phase??'EMPTY',attemptsUsed:state?.attempts.length??0,planDigest:state?digest(state.plan):null,candidateDigest:state?.candidate??null});}),
    snapshot:()=>state===null?null:ownedJson(state),
    status:()=>ownedJson({schemaVersion:2,provenance:V2_PROVENANCE,phase:stopped?'STOPPED':state?.phase??'EMPTY',revision:state?.revision??0,attemptsUsed:state?.attempts.length??0,gateActive:false}),close,
  });
  if(continuity)m4Bridges.set(api,Object.freeze({
    view:()=>({state,pending,stopped,epoch,pendingCount:operations.size,active:!!activeRun||runnerBusy||activeRunners.size>0,pendingAuthor:pendingAuthorResult!==null}),
    fence(){continuity.denied=true;epoch++;workspace?.revoke();return epoch;},
    async drain(){await Promise.allSettled([...operations]);live();need(operations.size===0&&!pending&&!activeRun&&!runnerBusy&&activeRunners.size===0&&pendingAuthorResult===null,'UNCLEAN_DRAIN');if(workspace){workspace.revoke();await workspace.close();live();workspace=null;}custody=null;runtimeActors.clear();},
    async record(record){live();need(operations.size===0&&!pending&&!activeRun&&!runnerBusy&&activeRunners.size===0&&pendingAuthorResult===null&&!workspace&&!custody,'UNCLEAN_DRAIN');await commit('CONTROL_RECORDED',{},[record]);return state;},
    async stopIdle(){live();if(state&&!['STOPPED','REASSESS_REQUIRED','RECONCILIATION_REQUIRED'].includes(state.phase))await commit('STOPPED',{phase:'STOPPED'});return close();},
    async stopBusy(){
      const invoke=fn=>{try{return Promise.resolve(fn());}catch(error){return Promise.reject(error);}};
      const cancellation=Promise.allSettled([invoke(()=>o.host.close()),...(activeRun?[invoke(()=>o.host.cancel(activeRun))]:[]),...[...activeRunners].map(r=>invoke(()=>r.stop()))]);
      await Promise.allSettled([...operations]);const cleanup=await Promise.allSettled([...activeRunners].map(r=>r.close()));const outcomes=[...await cancellation,...cleanup];need(outcomes.every(r=>r.status==='fulfilled'),'UNCLEAN_DRAIN');
      if(workspace){workspace.revoke();await workspace.close();workspace=null;}custody=null;activeRunners.clear();activeRun=null;pendingAuthorResult=null;runtimeActors.clear();live();need(!pending&&operations.size===0&&!runnerBusy,'UNCLEAN_DRAIN');
      if(state&&!['STOPPED','REASSESS_REQUIRED','RECONCILIATION_REQUIRED'].includes(state.phase))await commit('STOPPED',{phase:'STOPPED'});return close();
    },
    release(){live();continuity.denied=false;},
    qualificationCheck(){live();need(!continuity.denied&&operations.size===0&&ownerReads.size===0&&!pending&&!activeRun&&!runnerBusy&&activeRunners.size===0&&pendingAuthorResult===null&&state?.phase==='DIAGNOSTIC_READY'&&custody,'QUALIFICATION_NOT_IDLE');for(const role of ['author','validator','reviewer']){const assignment=state.assignments.find(a=>a.role===role&&a.generation===state.generation),actual=assignment&&runtimeActors.get(assignment.id);need(actual&&same(actual,assignment.actor),'ACTUAL_ACTOR_CHANGED');}custody.verify();return state;},
    qualificationJournal(){live();const s=o.store.status();return s.admission===true&&s.poisoned===false&&s.reconciliationRequired===false;},
    async qualificationEvidence(){live();await verifyProtectedStage(epoch);need(evidenceReady(),'INCOMPLETE_DIAGNOSTIC_FACTS');live();return {state,custody,descriptor:custody.descriptor()};},
    async qualificationRecord(type,artifact){live();need(operations.size===0&&!pending&&!activeRun&&!runnerBusy&&activeRunners.size===0&&pendingAuthorResult===null,'QUALIFICATION_NOT_IDLE');await commit(type,{},[artifact]);const loaded=await o.store.load();live();need(same(loaded.latest.payload,state),'STATE_HEAD_MISMATCH');return loaded.latest;},
    qualificationPoison(){stopped=true;epoch++;continuity.denied=true;workspace?.revoke();o.store.revoke();},close,
  }));
  return api;
}

import {validateControlRecordM4,validateResumeRequestM4,boundedResponseM4} from './contracts.mjs';
import {readGovernanceM4,bindGovernanceAuthorityM4} from './store.mjs';
export async function createGovernanceControllerM4(input){
  const o=v2Options(input,['store','host','humanPort','workspaceFactory','runnerFactory','authorizeOwner'],['failpoint']);need(typeof o.authorizeOwner==='function','MISSING_OWNER_AUTHORITY');
  const check=()=>{need(o.authorizeOwner()===true,'OWNER_AUTHORITY_REFUSED');};check();bindGovernanceAuthorityM4(o.store,o.authorizeOwner);o.store.assertOwner();
  const continuity={denied:false,check},v2Input={store:o.store,host:o.host,humanPort:o.humanPort,workspaceFactory:o.workspaceFactory,runnerFactory:o.runnerFactory,...(o.failpoint?{failpoint:o.failpoint}:{})};m4Requested.set(v2Input,continuity);
  let core;try{core=await createGovernanceControllerV2(v2Input);}finally{m4Requested.delete(v2Input);}const bridge=m4Bridges.get(core);need(bridge,'CONTINUITY_BRIDGE_REQUIRED');check();
  const owner=Object.freeze({id:randomUUID()}),outstanding=new Set();let mode='active',checkpoint=null,permitted=null,controlQueue=Promise.resolve(),closing=null,qualificationBusy=false,qualificationStop=null;
  const hit=async(name,context)=>{if(o.failpoint)await o.failpoint(name,ownedJson(context));check();o.store.assertOwner();};
  const serialize=fn=>{const task=controlQueue.then(fn);controlQueue=task.catch(()=>{});return task;};
  const current=()=>{check();o.store.assertOwner();return bridge.view();};
  async function head(){const snapshot=await o.store.load();check();o.store.assertOwner();return snapshot.latest;}
  function launch(name,args){
    need(mode==='active'&&!qualificationBusy,'CONTINUITY_ADMISSION_CLOSED');check();if(permitted!==null){need(name==='requestAuthor'&&permitted==='author','NEXT_ACTION_REQUIRED');permitted=null;}
    const task=Promise.resolve().then(()=>{need(mode==='active','CONTINUITY_ADMISSION_CLOSED');check();return core[name](...args);});outstanding.add(task);task.then(()=>outstanding.delete(task),()=>outstanding.delete(task));return task;
  }
  async function status(request){
    check();const page=await readGovernanceM4(o.store,request);check();const view=current(),s=view.state;
    return boundedResponseM4({...page,status:{...page.status,admission:mode==='active'&&!continuity.denied,controlMode:mode,pauseEligible:mode==='active'&&outstanding.size===0&&view.pendingCount===0&&!view.active&&!view.pendingAuthor&&['PLAN_AUTHORIZED','CORRECTION_REQUIRED'].includes(s?.phase)&&s.attempts.length<3,resumeEligible:mode==='paused'&&checkpoint!==null&&!checkpoint.consumed,checkpointDigest:mode==='paused'?checkpoint?.digest??null:null,checkpointId:mode==='paused'?checkpoint?.id??null:null,nextAction:mode==='paused'?'author':permitted,pendingCount:outstanding.size+view.pendingCount,settledCount:s?.results.length??0,refusalReason:mode==='paused'?'PAUSED':mode==='active'?null:'RECONCILIATION_REQUIRED'}});
  }
  function control(kind,cp,prior){return validateControlRecordM4({schemaVersion:1,kind,id:randomUUID(),checkpointDigest:cp.digest,ownerId:owner.id,epoch:cp.epoch,priorHeadDigest:prior.eventDigest,planDigest:digest(prior.payload.plan),decisionDigest:digest(prior.payload.decision),attemptsDigest:digest(prior.payload.attempts),attemptsUsed:prior.payload.attempts.length,nextAction:'author'});}
  function stop(){if(closing)return closing;mode='stopped';if(checkpoint)checkpoint.consumed=true;checkpoint=null;const qualificationDrain=qualificationStop?Promise.resolve(qualificationStop()):Promise.resolve();bridge.fence();const controls=controlQueue;
    closing=(async()=>{let failure;try{await qualificationDrain;const view=bridge.view();if(qualificationStop&&view.stopped)await bridge.close();else if(outstanding.size===0&&view.pendingCount===0&&!view.active&&!view.pendingAuthor){await controls;await bridge.drain();await bridge.stopIdle();}else await bridge.stopBusy();}catch(error){failure=error;try{await core.close();}catch(cleanup){failure=new AggregateError([error,cleanup],'M4_STOP_FAILED');}}await controls;if(failure)throw failure;})();return closing;
  }
  function pause(){
    need(mode==='active'&&!qualificationBusy,'CONTINUITY_ADMISSION_CLOSED');const view=current(),eligible=outstanding.size===0&&view.pendingCount===0&&!view.active&&!view.pending&&!view.pendingAuthor&&['PLAN_AUTHORIZED','CORRECTION_REQUIRED'].includes(view.state?.phase)&&view.state.attempts.length<3;
    if(!eligible)return stop().then(()=>boundedResponseM4({schemaVersion:1,mode:'stopped',resumable:false,reason:'NONRESUMABLE_BOUNDARY',gateActive:false}));
    mode='pausing';const pauseEpoch=bridge.fence();
    return serialize(async()=>{try{
      await Promise.allSettled([...outstanding]);await bridge.drain();current();const prior=await head(),id=randomUUID();
      const description={id,ownerId:owner.id,epoch:pauseEpoch,headDigest:prior.eventDigest,planDigest:digest(prior.payload.plan),decisionDigest:digest(prior.payload.decision),attemptsDigest:digest(prior.payload.attempts),attemptsUsed:prior.payload.attempts.length,nextAction:'author'};
      const cp={id,digest:digest(description),owner,epoch:pauseEpoch,description,consumed:false,head:null};
      await hit('control.pause.beforeRecord',{checkpointDigest:cp.digest});need(mode==='pausing','CONTINUITY_ADMISSION_CLOSED');await bridge.record(control('pause',cp,prior));
      await hit('control.pause.afterRecord',{checkpointDigest:cp.digest});need(mode==='pausing','CONTINUITY_ADMISSION_CLOSED');cp.head=await head();need(mode==='pausing','CONTINUITY_ADMISSION_CLOSED');checkpoint=cp;mode='paused';return status();
    }catch(error){checkpoint=null;if(mode==='stopped')throw error;mode='blocked';bridge.fence();o.store.revoke();try{await core.close();}catch(cleanup){throw new AggregateError([error,cleanup],'M4_CONTROL_AND_CLEANUP_FAILED');}throw error;}});
  }
  function resume(request){const r=validateResumeRequestM4(request);return serialize(async()=>{
    const cp=checkpoint;need(mode==='paused'&&cp&&!cp.consumed&&cp.owner===owner&&cp.digest===r.checkpointDigest,'CHECKPOINT_UNAVAILABLE');current();
    try{await hit('control.resume.beforeConsume',{checkpointDigest:cp.digest});const now=await head();need(mode==='paused'&&checkpoint===cp&&!cp.consumed&&now.eventDigest===cp.head.eventDigest&&bridge.view().epoch===cp.epoch&&same(now.payload,cp.head.payload),'STALE_CHECKPOINT');
      check();o.store.assertOwner();need(mode==='paused'&&checkpoint===cp&&!cp.consumed&&bridge.view().epoch===cp.epoch,'STALE_CHECKPOINT');cp.consumed=true;checkpoint=null;mode='resuming';await hit('control.resume.afterConsume',{checkpointDigest:cp.digest});need(mode==='resuming','CONTINUITY_ADMISSION_CLOSED');await bridge.record(control('resume',cp,now));current();need(mode==='resuming','CONTINUITY_ADMISSION_CLOSED');bridge.release();need(mode==='resuming','CONTINUITY_ADMISSION_CLOSED');permitted='author';mode='active';return status();
    }catch(error){cp.consumed=true;checkpoint=null;if(mode==='stopped')throw error;mode='blocked';bridge.fence();o.store.revoke();try{await core.close();}catch(cleanup){throw new AggregateError([error,cleanup],'M4_CONTROL_AND_CLEANUP_FAILED');}throw error;}
  });}
  const api=Object.freeze({propose:p=>launch('propose',[p]),reviewPlan:()=>launch('reviewPlan',[]),requestAuthor:()=>launch('requestAuthor',[]),seal:()=>launch('seal',[]),validate:()=>launch('validate',[]),review:()=>launch('review',[]),diagnosticReadiness:()=>launch('diagnosticReadiness',[]),status,
    read:async request=>{const r=ownedJson(request);if(r.kind==='status')return status(r);check();const response=await readGovernanceM4(o.store,r);check();o.store.assertOwner();return response;},pause,resume,
    reassess:async headOrCheckpoint=>{need(typeof headOrCheckpoint==='string','INVALID_DIGEST');const page=await status();need(headOrCheckpoint===page.headDigest||headOrCheckpoint===page.status.checkpointDigest,'STALE_CURSOR');return boundedResponseM4({...page,reassessment:{remainingBudget:page.status.attemptsRemaining,mayChangePlan:false,mayResetBudget:false,mayResume:page.status.resumeEligible}});},stop,close:stop});
  m4Owners.set(api,{
    installStop(fn){need(!qualificationStop,'DELIVERY_OWNER_ALREADY_BOUND');qualificationStop=fn;},
    begin(){need(mode==='active'&&!qualificationBusy&&outstanding.size===0,'QUALIFICATION_NOT_IDLE');check();bridge.qualificationCheck();qualificationBusy=true;continuity.qualificationBusy=true;},
    end(){qualificationBusy=false;continuity.qualificationBusy=false;},
    check(){need(mode==='active'&&qualificationBusy,'QUALIFICATION_NOT_ACTIVE');check();bridge.qualificationCheck();return true;},
    evidence:()=>bridge.qualificationEvidence(),record:(type,record)=>bridge.qualificationRecord(type,record),head,poison:()=>bridge.qualificationPoison(),journal:()=>bridge.qualificationJournal(),
    state:()=>bridge.view().state,readArtifact:async hash=>{check();const loaded=await o.store.load(),event=loaded.history.find(e=>e.artifacts.includes(hash));need(event,'ARTIFACT_MISSING');const value=await o.store.readArtifact({revision:event.revision,hash});check();o.store.assertOwner();return value;},
  });return api;
}

import {createDeliveryCoordinatorM4B} from './delivery.mjs';
import {verifyDeliveryDestinationM4B} from './workspace.mjs';
export function claimGovernanceDeliveryOwnerM4B(token){const grant=m4bGrants.get(token);need(grant,'UNKNOWN_DELIVERY_OWNER');m4bGrants.delete(token);return grant;}
export async function createGovernanceControllerM4B(input){
  const options=v2Options(input,['store','host','humanPort','workspaceFactory','runnerFactory','authorizeOwner','delivery'],['failpoint']);verifyDeliveryDestinationM4B(options.delivery);
  const {delivery,...m4Options}=options,owner=await createGovernanceControllerM4(m4Options),bridge=m4Owners.get(owner),token=Object.freeze({});need(bridge,'UNKNOWN_DELIVERY_OWNER');
  m4bGrants.set(token,{owner,bridge,destination:delivery,failpoint:options.failpoint});try{return createDeliveryCoordinatorM4B(token);}catch(error){m4bGrants.delete(token);await owner.close();throw error;}
}

