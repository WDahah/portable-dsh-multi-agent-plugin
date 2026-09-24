import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PROVENANCE,digest,ownedJson,bindingFor,validateResult} from '../src/governance/contracts.mjs';
import {reduceState,validateTransition,structuralAcceptance,operationalAcceptance,assertModelMutation,createGovernanceController} from '../src/governance/controller.mjs';
import {openGovernanceStore,inspectGovernanceStore} from '../src/governance/store.mjs';

const clone=x=>JSON.parse(JSON.stringify(x));
const actor=(id,provider='other')=>({id,provider});
const plan=()=>({schemaVersion:1,jobId:'job',projectId:digest('project'),baseline:digest('base'),objective:'Build only approved files',nonGoals:['No deployment'],
  files:[{path:'src/a.mjs',operation:'edit',expectedHash:digest('old')}],protectedTests:['tests/a.test.mjs'],
  criteria:[{id:'C1',description:'Required behavior',method:'test'}],
  commands:[{id:'test',executable:process.execPath,argv:['--test','test.mjs'],cwd:'frozen',environment:{SYSTEMROOT:'fixture'},timeoutMs:1000,expectedExit:0,inventory:['t1']}],
  policy:{planner:actor('planner','author-provider'),implementerProvider:'author-provider',correctionLimit:2},testInventory:['t1'],environmentDigest:digest('environment')});
const sub=(outcome='pass',evidenceIds=[])=>({criteria:[{id:'C1',outcome}],findings:[],evidenceIds});
const assignment=(s,role,name=role,generation=s.generation)=>({id:name,actor:actor(name,role==='author'?'author-provider':'other'),role,generation,binding:bindingFor(s.plan,role==='plan-review'||role==='author'?null:s.candidate),provenance:PROVENANCE});
function result(s,a,outcome='completed-pass',submission=sub()) {return {id:'result-'+a.id,assignmentId:a.id,actor:a.actor,role:a.role,generation:a.generation,binding:a.binding,outcome,submission,provenance:PROVENANCE};}
const step=(s,type,fields={})=>reduceState(s,{type,...fields});
function authorized(p=plan()) {
  let s=step(null,'PLAN_PROPOSED',{plan:p});const a=assignment(s,'plan-review');s=step(s,'ASSIGNMENT_CREATED',{assignment:a});
  s=step(s,'RESULT_RECORDED',{result:result(s,a)});
  return step(s,'HUMAN_DECIDED',{decision:{id:'human',planDigest:digest(p),reviewResultId:'result-plan-review',generation:s.generation,decision:'authorize',provenance:PROVENANCE}});
}
function authoring(s=authorized()) {const a=assignment(s,'author','author-'+s.attempts.length,s.generation+1);return step(s,'ATTEMPT_RESERVED',{assignment:a});}
function frozen(s=authoring()) {
  const manifest=[{path:'src/a.mjs',sha256:digest('new'),operation:'present',mode:420}],candidate=digest(manifest);
  const e={id:'frozen-'+s.attempts.length,kind:'frozen',assignmentId:s.attempts.at(-1).assignmentId,binding:bindingFor(s.plan,candidate),contentDigest:candidate,status:'completed',details:{manifest,inventory:s.plan.testInventory},provenance:PROVENANCE};
  return step(s,'CANDIDATE_SEALED',{evidence:e});
}
function evaluated(initial=undefined,suffix='') {
  let s=initial??frozen();const v=assignment(s,'validator','validator'+suffix),r=assignment(s,'reviewer','reviewer'+suffix);
  s=step(s,'ASSIGNMENT_CREATED',{assignment:v});s=step(s,'ASSIGNMENT_CREATED',{assignment:r});
  const c=s.plan.commands[0],details={commandId:c.id,commandDigest:digest(c),expectedExit:0,actualExit:0,stdoutDigest:digest('tap'),stderrDigest:digest(''),captureComplete:true,inventory:[{id:'t1',outcome:'pass'}],managedSettled:true};
  const e={id:'test-evidence'+suffix,kind:'test',assignmentId:v.id,binding:v.binding,contentDigest:digest(details),status:'completed',details,provenance:PROVENANCE};
  return step(s,'EVIDENCE_REGISTERED',{evidence:e});
}
function complete(s=evaluated(),order=['validator','reviewer']) {
  for(const role of order){const a=s.assignments.find(x=>x.role===role);s=step(s,'RESULT_RECORDED',{result:result(s,a,'completed-pass',sub('pass',s.evidence.map(e=>e.id)))});}return s;
}
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});
  const timer=setTimeout(()=>reject(new Error('Fixture barrier timeout')),15000);promise.then(()=>clearTimeout(timer),()=>clearTimeout(timer));return {promise,resolve,reject};}
async function fixture(t,{failpoint}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'m1-controller-')),owned=[];
  const expectedCloseFailures=new Set();
  t.after(async()=>{try{for(const resource of owned.reverse())try{await resource.close();}catch(error){if(!expectedCloseFailures.has(resource))throw error;}}finally{await fs.rm(root,{recursive:true,force:true});}});
  const projectRoot=path.join(root,'project');await fs.mkdir(projectRoot);
  const options={root:path.join(root,'state'),legacyRoot:path.join(root,'legacy'),projectRoots:[projectRoot],candidateRoots:[path.join(root,'candidate')],validateTransition,...(failpoint?{failpoint}:{})};
  const store=await openGovernanceStore(options);owned.push(store);
  const p=plan();p.projectId=await store.registerJob({jobId:p.jobId,projectRoot});return {root,options,store,plan:p,expectCloseFailure:resource=>expectedCloseFailures.add(resource),own:resource=>{owned.push(resource);return resource;}};
}

// M1-03,07: the pure counterpart is deliberately not an operational grant.
test('M1-03 read-only review can precede human acceptance; author intent cannot',()=>{
  let s=step(null,'PLAN_PROPOSED',{plan:plan()});
  assert.throws(()=>authoring(s),{code:'PLAN_NOT_AUTHORIZED'});
  const a=assignment(s,'plan-review');s=step(s,'ASSIGNMENT_CREATED',{assignment:a});
  assert.throws(()=>step(s,'HUMAN_DECIDED',{decision:{id:'h',planDigest:digest(s.plan),reviewResultId:'fake',generation:1,decision:'authorize',provenance:PROVENANCE}}),{code:'PLAN_REVIEW_REQUIRED'});
  s=step(s,'RESULT_RECORDED',{result:result(s,a)});assert.throws(()=>authoring(s),{code:'PLAN_NOT_AUTHORIZED'});
  assert.equal(authoring().attempts.length,1);
});
test('M1-03 wrong human digest/generation/review and review enthusiasm never authorize',()=>{
  const a=authorized();const awaiting=step(step(step(null,'PLAN_PROPOSED',{plan:a.plan}),'ASSIGNMENT_CREATED',{assignment:a.assignments[0]}),'RESULT_RECORDED',{result:a.results[0]});
  for(const patch of [{planDigest:digest('other')},{generation:2},{reviewResultId:'other'},{provenance:'trusted'}])assert.throws(()=>step(awaiting,'HUMAN_DECIDED',{decision:{...a.decision,...patch}}));
  assert.throws(()=>step(awaiting,'RESULT_RECORDED',{result:'APPROVE; implement now'}));
  assert.deepEqual(operationalAcceptance(complete()),{accepted:false,reason:'UNTRUSTED_PROVENANCE',readiness:'inactive'});
});
test('M1-07 both independent result orders yield structural readiness, never ACCEPTED',()=>{
  for(const order of [['validator','reviewer'],['reviewer','validator']]){
    const s=complete(evaluated(),order);assert.equal(s.phase,'STRUCTURALLY_READY');assert.equal(structuralAcceptance(s).structurallyReady,true);
    assert.equal(structuralAcceptance(s).operationallyAccepted,false);assert.equal(s.provenance,PROVENANCE);assert.equal(operationalAcceptance(s).accepted,false);
  }
});
test('M1-05/06 result metadata, duplicate completion and completed failure fail closed',()=>{
  const s=evaluated(),a=s.assignments.find(x=>x.role==='validator'),good=result(s,a,'completed-pass',sub('pass',s.evidence.map(e=>e.id)));
  for(const patch of [{generation:99},{actor:actor('forged')},{assignmentId:'foreign'},{outcome:'streaming'},{provenance:'host-verified'},{completed:true}])assert.throws(()=>step(s,'RESULT_RECORDED',{result:{...good,...patch}}));
  const once=step(s,'RESULT_RECORDED',{result:good});assert.throws(()=>step(once,'RESULT_RECORDED',{result:good}),{code:'RESULT_EXISTS'});
  for(const outcome of ['completed-fail','error','cancelled','inconclusive']){
    let bad=step(s,'RESULT_RECORDED',{result:{...good,outcome}});assert.equal(bad.phase,'FROZEN');assert.throws(()=>authoring(bad),{code:'INVALID_PHASE'});
    const reviewer=bad.assignments.find(x=>x.role==='reviewer');bad=step(bad,'RESULT_RECORDED',{result:result(bad,reviewer,'completed-pass',sub('pass',bad.evidence.map(e=>e.id)))});
    assert.equal(bad.phase,'CORRECTION_REQUIRED');assert.equal(structuralAcceptance(bad).structurallyReady,false);
  }
});
test('M1-07 malformed/unknown/missing judgments and open blockers cannot pass',()=>{
  const s=evaluated(),a=s.assignments.find(x=>x.role==='validator');
  for(const submission of [sub('skip'),sub('unknown'),{...sub(),criteria:[]},{...sub(),criteria:[{id:'foreign',outcome:'pass'}]},
    {...sub(),evidenceIds:['unknown']},{...sub(),findings:[{id:'finding',criterionId:'C1',detail:'bad',severity:'blocker',status:'open'}]}])
    assert.throws(()=>step(s,'RESULT_RECORDED',{result:result(s,a,'completed-pass',submission)}));
  const noEvidence=step(s,'RESULT_RECORDED',{result:result(s,a)});assert.equal(structuralAcceptance(noEvidence).structurallyReady,false);
});
test('M1-07 every test failure fact prevents structural success with unchanged evidence identity',()=>{
  const base=complete();
  const patches=[{actualExit:1},{actualExit:null},{expectedExit:9},{commandDigest:digest('different')},{captureComplete:false},{managedSettled:false},
    {inventory:[]},...[ 'fail','skip','todo','unknown'].map(outcome=>({inventory:[{id:'t1',outcome}]}))];
  for(const patch of patches){const s=clone(base),e=s.evidence.find(x=>x.kind==='test');Object.assign(e.details,patch);e.contentDigest=digest(e.details);assert.equal(structuralAcceptance(s).structurallyReady,false,JSON.stringify(patch));}
  for(const field of ['planDigest','criteriaDigest','commandsDigest','candidateDigest','environmentDigest','inventoryDigest']){
    const s=clone(base);s.evidence.find(x=>x.kind==='test').binding[field]=digest('different');assert.equal(structuralAcceptance(s).structurallyReady,false,field);
  }
  for(const kind of ['test','frozen']){const s=clone(base);s.evidence=s.evidence.filter(e=>e.kind!==kind);assert.equal(structuralAcceptance(s).structurallyReady,false);}
});
test('M1-08 role independence rejects planner/provider, authors and reused actor identities',()=>{
  let s=step(null,'PLAN_PROPOSED',{plan:plan()});
  for(const who of [s.plan.policy.planner,actor('other','author-provider')])assert.throws(()=>step(s,'ASSIGNMENT_CREATED',{assignment:{...assignment(s,'plan-review'),actor:who}}),{code:'INDEPENDENCE_REQUIRED'});
  s=frozen();
  assert.throws(()=>step(s,'ASSIGNMENT_CREATED',{assignment:{...assignment(s,'validator'),actor:s.authors[0]}}),{code:'INDEPENDENCE_REQUIRED'});
  assert.throws(()=>step(s,'ASSIGNMENT_CREATED',{assignment:{...assignment(s,'reviewer'),actor:actor('reviewer','author-provider')}}),{code:'INDEPENDENCE_REQUIRED'});
  s=step(s,'ASSIGNMENT_CREATED',{assignment:assignment(s,'validator')});
  assert.throws(()=>step(s,'ASSIGNMENT_CREATED',{assignment:{...assignment(s,'reviewer'),actor:actor('validator')}}),{code:'ACTOR_REUSED'});
  assert.throws(()=>step(authorized(),'ATTEMPT_RESERVED',{assignment:{...assignment(authorized(),'author','author',2),actor:actor('wrong','alternate')}}),{code:'AUTHOR_ROUTE_CHANGED'});
});
test('M1-09 corrections consume exactly C0/C1/C2; same bytes still require fresh validation',()=>{
  let s=authorized();let priorResult;
  for(let i=0;i<3;i++){
    s=frozen(authoring(s));assert.equal(s.attempts.length,i+1);
    assert.equal(structuralAcceptance(s).structurallyReady,false);
    const a=assignment(s,'validator','v-'+i);s=step(s,'ASSIGNMENT_CREATED',{assignment:a});
    if(priorResult)assert.throws(()=>step(s,'RESULT_RECORDED',{result:priorResult}),{code:'STALE_GENERATION'});
    priorResult=result(s,a,'completed-fail',sub('fail'));s=step(s,'RESULT_RECORDED',{result:priorResult});
  }
  assert.equal(s.phase,'REASSESS_REQUIRED');assert.throws(()=>authoring(s),{code:'TERMINAL_STATE'});
  assert.equal(new Set(s.attempts.map(a=>a.assignmentId)).size,3);
});
test('M1-09 plan amendment invalidates authority but retains consumed budget and prior authors',()=>{
  let s=frozen();const v=assignment(s,'validator');s=step(s,'ASSIGNMENT_CREATED',{assignment:v});s=step(s,'RESULT_RECORDED',{result:result(s,v,'cancelled')});
  const amended={...s.plan,objective:'Amended approved work'};s=step(s,'PLAN_PROPOSED',{plan:amended});
  assert.equal(s.attempts.length,1);assert.equal(s.authors.length,1);assert.equal(s.candidate,null);assert.throws(()=>authoring(s),{code:'PLAN_NOT_AUTHORIZED'});
  assert.throws(()=>step(s,'HUMAN_DECIDED',{decision:authorized().decision}),{code:'PLAN_REVIEW_REQUIRED'});
});
test('M1-03/14 delayed model operation rechecks exact revision and revoked generation',async()=>{
  const initial=authoring(),a=initial.assignments.at(-1);let current=initial,count=0;
  const admission={assignmentId:a.id,actor:a.actor,generation:initial.generation,planDigest:digest(initial.plan),revision:initial.revision};
  assertModelMutation(current,admission);count++;assert.equal(count,1);
  const barrier=deferred();const delayed=(async()=>{await barrier.promise;assertModelMutation(current,admission);count++;})();
  current=step(current,'STOPPED');barrier.resolve();await assert.rejects(delayed);assert.equal(count,1);
  for(const patch of [{revision:0},{generation:99},{actor:actor('forged')},{planDigest:digest('old')},{assignmentId:'foreign'}])assert.throws(()=>assertModelMutation(initial,{...admission,...patch}));
});
test('M1-07 prior candidate blocking findings require explicit independent-role resolution',()=>{
  const s=complete(),prior={...s.results.find(x=>x.role==='reviewer'),id:'prior-result',generation:1,
    submission:{...sub('fail'),findings:[{id:'block',criterionId:'C1',detail:'prior defect',severity:'blocker',status:'open'}]}};
  const changed=clone(s);changed.results.splice(0,0,prior);assert.equal(structuralAcceptance(changed).reason,'OPEN_BLOCKER');
  const current=changed.results.findLast(x=>x.role==='reviewer');current.submission.findings=[{id:'block',criterionId:'C1',detail:'independently resolved',severity:'blocker',status:'resolved'}];
  assert.equal(structuralAcceptance(changed).structurallyReady,true);
});
test('M1-07 C1 cross-role same-ID blockers persist; fresh same-role actors resolve only their own',()=>{
  const finding=(criterionId,status)=>({id:'shared',criterionId,detail:'Independent obligation',severity:'blocker',status});
  const roundResults=(s,findings,outcomes,order=['validator','reviewer'])=>{
    for(const role of order){const a=s.assignments.findLast(x=>x.role===role&&x.generation===s.generation);
      const submission={...sub(outcomes[role]==='completed-fail'?'fail':'pass',s.evidence.filter(e=>e.binding.candidateDigest===s.candidate&&s.assignments.some(a=>a.id===e.assignmentId&&a.generation===s.generation)).map(e=>e.id)),findings:findings[role]??[]};
      s=step(s,'RESULT_RECORDED',{result:result(s,a,outcomes[role],submission)});
    }return s;
  };
  for(const order of [['validator','reviewer'],['reviewer','validator']]){
    const failed=roundResults(evaluated(),{validator:[finding('C1','open')],reviewer:[finding('C1','open')]},{validator:'completed-fail',reviewer:'completed-fail'},order);
    assert.equal(failed.phase,'CORRECTION_REQUIRED');
    const next=evaluated(frozen(authoring(failed)),'-c1');
    const omitted=roundResults(next,{reviewer:[finding('C1','resolved')]},{validator:'completed-pass',reviewer:'completed-pass'},order);
    assert.equal(structuralAcceptance(omitted).reason,'OPEN_BLOCKER');assert.equal(omitted.phase,'CORRECTION_REQUIRED');
    assert.notEqual(omitted.results.findLast(r=>r.role==='validator').actor.id,failed.results.findLast(r=>r.role==='validator').actor.id);
    const good=roundResults(next,{validator:[finding('C1','resolved')],reviewer:[finding('C1','resolved')]},{validator:'completed-pass',reviewer:'completed-pass'},order);
    assert.equal(good.phase,'STRUCTURALLY_READY');assert.equal(structuralAcceptance(good).structurallyReady,true);assert.equal(operationalAcceptance(good).accepted,false);
    const last=evaluated(frozen(authoring(omitted)),'-c2');
    const unresolved=roundResults(last,{}, {validator:'completed-pass',reviewer:'completed-pass'},order);
    assert.equal(unresolved.phase,'REASSESS_REQUIRED');assert.throws(()=>authoring(unresolved),{code:'TERMINAL_STATE'});
    const resolved=roundResults(last,{validator:[finding('C1','resolved')]},{validator:'completed-pass',reviewer:'completed-pass'},order);
    assert.equal(resolved.phase,'STRUCTURALLY_READY');
  }
});
test('M1-07 persistent same-role finding cannot rebind criterion; removed criterion requires reassessment',()=>{
  const p=plan();p.criteria.push({id:'C2',description:'Second requirement',method:'review'});
  const submission=(state,outcome,findings=[])=>({criteria:p.criteria.map(c=>({id:c.id,outcome})),findings,evidenceIds:state.evidence.filter(e=>state.assignments.some(a=>a.id===e.assignmentId&&a.generation===state.generation)).map(e=>e.id)});
  let s=step(null,'PLAN_PROPOSED',{plan:p}),pr=assignment(s,'plan-review');s=step(s,'ASSIGNMENT_CREATED',{assignment:pr});s=step(s,'RESULT_RECORDED',{result:result(s,pr,'completed-pass',submission(s,'pass'))});
  s=step(s,'HUMAN_DECIDED',{decision:{id:'human',planDigest:digest(p),reviewResultId:'result-plan-review',generation:s.generation,decision:'authorize',provenance:PROVENANCE}});
  const finding=(criterionId,status)=>({id:'persistent',criterionId,detail:'Persistent finding',severity:'blocker',status});
  s=evaluated(frozen(authoring(s)));let v=s.assignments.findLast(x=>x.role==='validator'),r=s.assignments.findLast(x=>x.role==='reviewer');
  s=step(s,'RESULT_RECORDED',{result:result(s,v,'completed-fail',submission(s,'fail',[finding('C1','open')]))});s=step(s,'RESULT_RECORDED',{result:result(s,r,'completed-pass',submission(s,'pass'))});
  const failed=s,changedPlan={...p,criteria:p.criteria.filter(c=>c.id!=='C1')};
  const amended=step(failed,'PLAN_PROPOSED',{plan:changedPlan});assert.equal(amended.phase,'REASSESS_REQUIRED');assert.equal(amended.attempts.length,1);assert.equal(amended.results.length,failed.results.length);assert.throws(()=>authoring(amended),{code:'TERMINAL_STATE'});
  s=evaluated(frozen(authoring(s)),'-next');v=s.assignments.findLast(x=>x.role==='validator');r=s.assignments.findLast(x=>x.role==='reviewer');const before=clone(s);
  for(const status of ['open','resolved'])assert.throws(()=>step(s,'RESULT_RECORDED',{result:result(s,v,'completed-fail',submission(s,'fail',[finding('C2',status)]))}),{code:'FINDING_ID_CONFLICT'});
  assert.deepEqual(s,before);
  let omitted=step(s,'RESULT_RECORDED',{result:result(s,v,'completed-pass',submission(s,'pass'))});omitted=step(omitted,'RESULT_RECORDED',{result:result(omitted,r,'completed-pass',submission(omitted,'pass'))});assert.equal(omitted.phase,'CORRECTION_REQUIRED');assert.equal(structuralAcceptance(omitted).reason,'OPEN_BLOCKER');
  s=step(s,'RESULT_RECORDED',{result:result(s,v,'completed-pass',submission(s,'pass',[finding('C1','resolved')]))});s=step(s,'RESULT_RECORDED',{result:result(s,r,'completed-pass',submission(s,'pass'))});assert.equal(s.phase,'STRUCTURALLY_READY');
});
test('M1-05/07 C2 only completed fresh-role results may resolve earlier blockers',()=>{
  const finding=status=>({id:'completion-required',criterionId:'C1',detail:'Resolution needs completed execution',severity:'blocker',status});
  const finish=(s,role,outcome,findings=[])=>{
    const a=s.assignments.findLast(x=>x.role===role&&x.generation===s.generation);
    const evidenceIds=s.evidence.filter(e=>s.assignments.some(x=>x.id===e.assignmentId&&x.generation===s.generation)).map(e=>e.id);
    return step(s,'RESULT_RECORDED',{result:result(s,a,outcome,{...sub(outcome==='completed-fail'?'fail':'pass',evidenceIds),findings})});
  };
  for(const role of ['validator','reviewer'])for(const outcome of ['cancelled','error','inconclusive']){
    const other=role==='validator'?'reviewer':'validator';
    let first=evaluated();first=finish(first,role,'completed-fail',[finding('open')]);first=finish(first,other,'completed-pass');assert.equal(first.phase,'CORRECTION_REQUIRED');
    let second=evaluated(frozen(authoring(first)),'-c1');second=finish(second,role,outcome,[finding('resolved')]);second=finish(second,other,'completed-pass');assert.equal(second.phase,'CORRECTION_REQUIRED');
    const third=evaluated(frozen(authoring(second)),'-c2');
    let omitted=finish(third,role,'completed-pass');omitted=finish(omitted,other,'completed-pass');
    assert.equal(omitted.phase,'REASSESS_REQUIRED',role+outcome);assert.equal(structuralAcceptance(omitted).structurallyReady,false);
    assert.equal(omitted.results.filter(r=>r.role===role&&r.outcome.startsWith('completed-')).flatMap(r=>r.submission.findings).filter(f=>f.status==='resolved').length,0);
    assert.throws(()=>authoring(omitted),{code:'TERMINAL_STATE'});
    let completed=finish(third,role,'completed-pass',[finding('resolved')]);completed=finish(completed,other,'completed-pass');
    assert.equal(completed.phase,'STRUCTURALLY_READY');assert.equal(structuralAcceptance(completed).structurallyReady,true);assert.equal(operationalAcceptance(completed).accepted,false);
    assert.notEqual(completed.results.findLast(r=>r.role===role).actor.id,first.results.findLast(r=>r.role===role).actor.id);
    // A completed-fail result may resolve an old finding while failing another check;
    // that candidate still fails, but the next complete candidate need not re-resolve it.
    let completedFailure=evaluated(frozen(authoring(first)),'-completed-fail');completedFailure=finish(completedFailure,role,'completed-fail',[finding('resolved')]);completedFailure=finish(completedFailure,other,'completed-pass');assert.equal(completedFailure.phase,'CORRECTION_REQUIRED');
    let last=evaluated(frozen(authoring(completedFailure)),'-after-fail');last=finish(last,role,'completed-pass');last=finish(last,other,'completed-pass');assert.equal(last.phase,'STRUCTURALLY_READY');assert.equal(operationalAcceptance(last).accepted,false);
  }
});
test('M1-11 reducer validation rejects full-state tampering, wrong event and extra fields',()=>{
  const s=step(null,'PLAN_PROPOSED',{plan:plan()});validateTransition(null,s,'PLAN_PROPOSED');
  for(const patch of [{revision:9},{phase:'PLAN_AUTHORIZED'},{provenance:'trusted'},{extra:true}])assert.throws(()=>validateTransition(null,{...s,...patch},'PLAN_PROPOSED'));
  assert.throws(()=>validateTransition(null,s,'STOPPED'));assert.throws(()=>step(null,'PLAN_PROPOSED',{plan:plan(),enabled:true}));
});

test('M1-04 actual controller stays inactive and rejects enable/dispatch options',async t=>{
  const f=await fixture(t),calls=[];const lifecycle={observe(){calls.push('observe');throw Error('unexpected');}};
  for(const extra of [{enabled:true},{trusted:true},{skipProofs:true},{resume:true},{dispatcher:()=>calls.push('dispatch')},{runner:()=>{}}])assert.throws(()=>createGovernanceController({store:f.store,lifecycle,...extra}),{code:'INVALID_OPTIONS'});
  const c=createGovernanceController({store:f.store,lifecycle});f.own(c);
  await c.propose(f.plan,0);const before=await c.status('job');
  for(const operation of ['author','correction','test','export','accept','review'])assert.throws(()=>c.request(operation),{code:'INACTIVE_PREREQUISITES'});
  assert.deepEqual(await c.status('job'),before);assert.deepEqual(calls,[]);assert.equal(before.readiness,'inactive');
});
test('M1-05/06 owned submission waits result AND teardown, copies input, commits once',async t=>{
  const f=await fixture(t),r=deferred(),d=deferred(),observed=deferred(),actorHandle={};
  const lifecycle={observe(){observed.resolve();return {result:r.promise,disposed:d.promise};}};
  const c=createGovernanceController({store:f.store,lifecycle});f.own(c);
  c.enroll(actorHandle,actor('independent'));await c.propose(f.plan,0);const handle=await c.assign('job',actorHandle,'plan-review',1);
  for(const foreign of [{},Object.assign({},handle)])assert.throws(()=>c.submit(foreign,actorHandle,sub()),{code:'UNKNOWN_ASSIGNMENT'});
  assert.throws(()=>c.submit(handle,{},sub()),{code:'UNKNOWN_ASSIGNMENT'});
  assert.throws(()=>c.submit(handle,actorHandle,{...sub(),completed:true}),{code:'CLOSED_SCHEMA'});
  let settled=false;const input=sub(),p=c.submit(handle,actorHandle,input).then(x=>{settled=true;return x;});
  input.criteria[0].outcome='fail';await observed.promise;r.resolve('completed');
  await Promise.resolve();assert.equal(settled,false);assert.equal((await f.store.load('job')).latest.payload.results.length,0);
  // Replacement after construction is not used by the captured adapter.
  lifecycle.observe=()=>{throw Error('replacement must not run');};
  d.resolve();const s=await p;assert.equal(s.results[0].outcome,'completed-pass');assert.equal(s.results[0].submission.criteria[0].outcome,'pass');
  assert.throws(()=>c.submit(handle,actorHandle,sub()),{code:'UNKNOWN_ASSIGNMENT'});
  const decision={id:'human',planDigest:digest(f.plan),reviewResultId:s.results[0].id,generation:s.generation,decision:'authorize',provenance:PROVENANCE};
  await c.decide('job',decision,s.revision);assert.equal((await c.status('job')).phase,'PLAN_AUTHORIZED');assert.throws(()=>c.request('author'),{code:'INACTIVE_PREREQUISITES'});
});
test('M1-05/06 lifecycle failure/cancellation cannot create passing completion',async t=>{
  for(const outcome of ['cancelled','error','inconclusive','disposal-failed']){
    await t.test(outcome,async t=>{const f=await fixture(t),h={};const c=createGovernanceController({store:f.store,lifecycle:{observe(){return {result:Promise.resolve(outcome==='disposal-failed'?'completed':outcome),disposed:outcome==='disposal-failed'?Promise.reject(Error('cleanup')):Promise.resolve()};}}});f.own(c);
      c.enroll(h,actor('reviewer'));await c.propose(f.plan,0);const handle=await c.assign('job',h,'plan-review',1);const s=await c.submit(handle,h,sub());assert.notEqual(s.results[0].outcome,'completed-pass');assert.equal(s.phase,'PLANNING');
    });
  }
});
test('M1-14 close revokes held submissions and waits disposal before settling',async t=>{
  const f=await fixture(t),r=deferred(),d=deferred(),seen=deferred(),h={};const c=createGovernanceController({store:f.store,lifecycle:{observe(){seen.resolve();return {result:r.promise,disposed:d.promise};}}});
  c.enroll(h,actor('reviewer'));await c.propose(f.plan,0);const handle=await c.assign('job',h,'plan-review',1);const p=c.submit(handle,h,sub());p.catch(()=>{});await seen.promise;
  let closed=false;const close=c.close().then(()=>{closed=true;});r.resolve('completed');await Promise.resolve();assert.equal(closed,false);
  await assert.rejects(openGovernanceStore(f.options),{code:'LOCKED'});d.resolve();await assert.rejects(p,{code:'CONTROLLER_STOPPED'});await close;
  const snapshot=await inspectGovernanceStore(f.options);assert.equal(snapshot.jobs[0].latest.payload.results.length,0);assert.equal(snapshot.readiness,'inactive');
});
test('M1-14 stop during a held durable result write cannot commit a late pass',async t=>{
  const entered=deferred(),release=deferred();let hold=false;
  const f=await fixture(t,{failpoint:async(name,context)=>{if(hold&&name==='event.open'&&context.revision===3){entered.resolve();await release.promise;}}});
  const h={},c=createGovernanceController({store:f.store,lifecycle:{observe(){return {result:Promise.resolve('completed'),disposed:Promise.resolve()};}}});
  c.enroll(h,actor('reviewer'));await c.propose(f.plan,0);const handle=await c.assign('job',h,'plan-review',1);hold=true;
  const p=c.submit(handle,h,sub());p.catch(()=>{});await entered.promise;const closing=c.close();closing.catch(()=>{});release.resolve();
  await assert.rejects(p,{code:'STORE_CLOSED'});await assert.rejects(closing,{code:'STORE_POISONED'});
  const {failpoint,...inspectOptions}=f.options;const snapshot=await inspectGovernanceStore(inspectOptions);
  assert.equal(snapshot.locked,true);assert.equal(snapshot.jobs[0].latest.payload.results.length,0);
  // Poisoned store intentionally retains its lock; test cleanup may remove its owned root after all work settled.
  f.expectCloseFailure(f.store);
});
test('M1-09/11 competing durable reservations have one winner and survive clean reopen',async t=>{
  const f=await fixture(t);let s=authorized(f.plan);
  // Replay valid actions, never import the final state as an authorization.
  let state=null;for(const action of [{type:'PLAN_PROPOSED',plan:f.plan},{type:'ASSIGNMENT_CREATED',assignment:s.assignments[0]},{type:'RESULT_RECORDED',result:s.results[0]},{type:'HUMAN_DECIDED',decision:s.decision}]){const next=reduceState(state,action);await f.store.append('job',{type:action.type,payload:next},state?.revision??0);state=next;}
  const next=authoring(state),writes=await Promise.allSettled([f.store.append('job',{type:'ATTEMPT_RESERVED',payload:next},state.revision),f.store.append('job',{type:'ATTEMPT_RESERVED',payload:next},state.revision)]);
  assert.equal(writes.filter(x=>x.status==='fulfilled').length,1);assert.equal(writes.find(x=>x.status==='rejected').reason.code,'REVISION_CONFLICT');await f.store.close();
  const reopened=await openGovernanceStore(f.options);f.own(reopened);const c=createGovernanceController({store:reopened,lifecycle:{observe(){throw Error('must not replay');}}});f.own(c);
  const status=await c.status('job');assert.equal(status.attemptsUsed,1);assert.equal(status.reconciliationRequired,true);assert.equal(status.readiness,'inactive');assert.throws(()=>c.request('resume'),{code:'INACTIVE_PREREQUISITES'});
  await assert.rejects(c.propose({...f.plan,objective:'Do not replay'},status.revision),{code:'RECONCILIATION_REQUIRED'});
});

import {createGovernanceControllerV2,assertModelMutationV2} from '../src/governance/controller.mjs';
import {openGovernanceStoreV2} from '../src/governance/store.mjs';
import {V2_PROVENANCE,validatePlanV2} from '../src/governance/contracts.mjs';
async function m3ControllerFixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'m3-controller-')),projectRoot=path.join(root,'project');await fs.mkdir(projectRoot);const store=await openGovernanceStoreV2({root:path.join(root,'journal'),projectRoot,protectedRoots:[]});let decisionHandler;const humanPort={bind(fn){decisionHandler=fn;return()=>{decisionHandler=null;};}},stats={prepared:0,started:0,workspace:0};
  const route=provider=>({provider,model:'test',effort:'low'}),executionPolicy={schemaVersion:1,routes:{'plan-review':route('other'),author:route('author'),validator:route('validator'),reviewer:route('other')},node:{executable:process.execPath,sha256:digest('node'),version:process.version,systemRoot:null},enforcement:'guarded-native-trusted-code',settlementGraceMs:1000,testFiles:[{path:'test.mjs',sha256:digest('test')}],environmentRecipe:'systemroot-owned-temp-v1'};
  const plan=validatePlanV2({schemaVersion:2,jobId:'m3-job',projectId:store.status().projectId,baseline:digest('base'),objective:'Controlled stages only',nonGoals:['No activation'],files:[{path:'a.txt',operation:'create',expectedHash:null}],protectedTests:['test.mjs'],criteria:[{id:'C',description:'criterion',method:'test'}],commands:[{id:'unit',executable:process.execPath,argv:['--test','--test-isolation=none','--test-reporter=tap','test.mjs'],cwd:'frozen',environment:{},timeoutMs:1000,expectedExit:0,inventory:['T']}],policy:{planner:{id:'planner',provider:'author'},implementerProvider:'author',correctionLimit:2},testInventory:['T'],environmentDigest:digest({node:executionPolicy.node,enforcement:executionPolicy.enforcement,environmentRecipe:executionPolicy.environmentRecipe}),executionPolicy});
  const prepared=new WeakMap(),runs=new WeakMap();let authorStop='error';const host={prepareStage(spec){stats.prepared++;const ticket={};prepared.set(ticket,spec);return ticket;},async start(ticket,{onActor}){stats.started++;const spec=prepared.get(ticket);assert.ok(spec);if(spec.role==='author'){const disk=await store.load();assert.equal(disk.latest.payload.attempts.at(-1).assignmentId,spec.id);assert.equal(disk.latest.payload.phase,'AUTHORING');}const actor=Object.freeze({id:spec.id,...spec.route});await onActor({actor,execution:Promise.resolve(spec.role==='author'?authorStop:'completed'),disposed:Promise.resolve()});const run={};runs.set(run,{actor,stopReason:spec.role==='author'?authorStop:'completed',submission:spec.role==='plan-review'?{criteria:[{id:'C',outcome:'pass'}],findings:[],evidenceIds:[]}:null});return run;},async observe(run){assert.ok(runs.has(run));return runs.get(run);},cancel(){},async close(){}};
  const workspaceFactory=async({authority})=>{stats.workspace++;return {async beginAttempt({actor,assignmentId}){const state=authority.readCurrent();assert.equal(assertModelMutationV2(state,{actor,assignmentId,generation:state.generation,revision:state.revision,planDigest:digest(state.plan)}),true);return {};},file(){},seal(){throw Error('not expected');},transfer(){throw Error('not expected');},revoke(){},async close(){}};};
  const controller=await createGovernanceControllerV2({store,host,humanPort,workspaceFactory,runnerFactory:()=>{throw Error('no runner');}});t.after(async()=>{try{await controller.close();}finally{await fs.rm(root,{recursive:true,force:true});}});return {controller,store,plan,stats,decide:input=>decisionHandler(input),setStop:v=>{authorStop=v;}};}
test('M3-03 review never authorizes author factory and exact human port commits authorization',async t=>{const f=await m3ControllerFixture(t);await f.controller.propose(f.plan);await assert.rejects(f.controller.requestAuthor(),{code:'PLAN_NOT_AUTHORIZED'});assert.equal(f.stats.started,0);const review=await f.controller.reviewPlan();assert.equal(f.stats.workspace,0);await assert.rejects(f.controller.requestAuthor(),{code:'PLAN_NOT_AUTHORIZED'});await assert.rejects(f.decide({planDigest:digest('foreign'),reviewResultId:review.resultId,decision:'authorize'}),{code:'STALE_HUMAN_DECISION'});await f.decide({planDigest:digest(f.plan),reviewResultId:review.resultId,decision:'authorize'});assert.equal(f.controller.snapshot().phase,'PLAN_AUTHORIZED');assert.equal(f.stats.workspace,0);});
test('M3-07 actual author factory failure consumes durable budget without silent reset',async t=>{const f=await m3ControllerFixture(t);await f.controller.propose(f.plan);const review=await f.controller.reviewPlan();await f.decide({planDigest:digest(f.plan),reviewResultId:review.resultId,decision:'authorize'});for(let i=0;i<3;i++){const result=await f.controller.requestAuthor();assert.equal(result.outcome,'error');assert.equal(f.controller.snapshot().attempts.length,i+1);}assert.equal(f.controller.snapshot().phase,'REASSESS_REQUIRED');await assert.rejects(f.controller.requestAuthor());assert.equal(f.stats.workspace,3);assert.equal((await f.controller.diagnosticReadiness()).gateActive,false);});
test('M3-03 model-like direct decisions and fixture records expose no authority import method',async t=>{const f=await m3ControllerFixture(t);assert.equal(f.controller.authorize,undefined);assert.equal(f.controller.decide,undefined);assert.equal(f.controller.submit,undefined);assert.equal(f.controller.registerEvidence,undefined);assert.throws(()=>f.controller.propose({...f.plan,schemaVersion:1}),{code:'SCHEMA_VERSION'});assert.equal(f.stats.started,0);});

import {createGovernanceControllerM4} from '../src/governance/controller.mjs';
async function m4ControllerFixture(t,{failpoint,authorizeOwner=()=>true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'m4-controller-')),projectRoot=path.join(root,'project');await fs.mkdir(projectRoot);const options={root:path.join(root,'journal'),projectRoot,protectedRoots:[]},store=await openGovernanceStoreV2(options);let handler,controller;const stats={starts:0,workspaces:0,workspaceCloses:0,revokes:0,hostCloses:0};
  t.after(async()=>{try{if(controller)try{await controller.close();}catch(e){if(!store.status().revoked&&!store.status().poisoned)throw e;}else await store.close();}finally{await fs.rm(root,{recursive:true,force:true});}});
  const route=provider=>({provider,model:'test',effort:'low'}),ep={schemaVersion:1,routes:{'plan-review':route('other'),author:route('author-provider'),validator:route('validator'),reviewer:route('other')},node:{executable:process.execPath,sha256:digest('node'),version:process.version,systemRoot:null},enforcement:'guarded-native-trusted-code',settlementGraceMs:1000,testFiles:[{path:'test.mjs',sha256:digest('test')}],environmentRecipe:'systemroot-owned-temp-v1'};
  const p=validatePlanV2({...plan(),schemaVersion:2,projectId:store.status().projectId,protectedTests:['test.mjs'],commands:[{id:'test',executable:process.execPath,argv:['--test','--test-isolation=none','--test-reporter=tap','test.mjs'],cwd:'frozen',environment:{},timeoutMs:1000,expectedExit:0,inventory:['t1']}],executionPolicy:ep,environmentDigest:digest({node:ep.node,enforcement:ep.enforcement,environmentRecipe:ep.environmentRecipe})});
  const tickets=new WeakMap(),runs=new WeakMap(),host={prepareStage(spec){const ticket={};tickets.set(ticket,spec);return ticket;},async start(ticket,{onActor}){const spec=tickets.get(ticket);stats.starts++;const actor={id:spec.id,...spec.route};await onActor({actor,execution:Promise.resolve(spec.role==='author'?'error':'completed'),disposed:Promise.resolve()});const run={};runs.set(run,{actor,stopReason:spec.role==='author'?'error':'completed',submission:spec.role==='plan-review'?sub():null});return run;},async observe(run){return runs.get(run);},cancel(){},async close(){stats.hostCloses++;}};
  const workspaceFactory=async()=>{stats.workspaces++;return {async beginAttempt(){return {};},file(){},seal(){throw Error('unexpected seal');},transfer(){throw Error('unexpected transfer');},revoke(){stats.revokes++;},async close(){stats.workspaceCloses++;}};};
  controller=await createGovernanceControllerM4({store,host,humanPort:{bind(fn){handler=fn;return()=>{handler=null;};}},workspaceFactory,runnerFactory:()=>{throw Error('unexpected runner');},authorizeOwner,...(failpoint?{failpoint}:{})});
  return {controller,store,options,plan:p,stats,async authorize(){await controller.propose(p);const review=await controller.reviewPlan();await handler({planDigest:digest(p),reviewResultId:review.resultId,decision:'authorize'});}};
}
test('M4 clean pause retains owner and business state; resume is one-use and never dispatches',async t=>{
  const f=await m4ControllerFixture(t);await f.authorize();const before=await f.store.load(),lock=await fs.lstat(path.join(f.options.root,'lock.json'),{bigint:true}),paused=await f.controller.pause();assert.equal(paused.status.controlMode,'paused');assert.equal(paused.status.resumeEligible,true);assert.equal(f.stats.starts,1);assert.equal(f.stats.hostCloses,0);const after=await f.store.load();assert.equal(after.latest.type,'CONTROL_RECORDED');assert.equal(after.latest.artifacts.length,1);const business=s=>{const {revision,action,...rest}=s;return rest;};assert.deepEqual(business(after.latest.payload),business(before.latest.payload));assert.throws(()=>f.controller.requestAuthor(),{code:'CONTINUITY_ADMISSION_CLOSED'});const now=await fs.lstat(path.join(f.options.root,'lock.json'),{bigint:true});assert.equal(now.ino,lock.ino);const request={checkpointDigest:paused.status.checkpointDigest,nextAction:'author'},resumed=await f.controller.resume(request);assert.equal(resumed.status.nextAction,'author');assert.equal(f.stats.starts,1);await assert.rejects(f.controller.resume(request),{code:'CHECKPOINT_UNAVAILABLE'});assert.throws(()=>f.controller.review(),{code:'NEXT_ACTION_REQUIRED'});await f.controller.requestAuthor();assert.equal(f.stats.workspaces,1);assert.equal((await f.controller.status()).status.attemptsUsed,1);
});
test('M4 correction pause closes prior workspace and preserves original three-attempt budget',async t=>{
  const f=await m4ControllerFixture(t);await f.authorize();for(let i=0;i<3;i++){await f.controller.requestAuthor();assert.equal((await f.controller.status()).status.attemptsUsed,i+1);if(i<2){const paused=await f.controller.pause();assert.equal(f.stats.workspaceCloses,i+1);await f.controller.resume({checkpointDigest:paused.status.checkpointDigest,nextAction:'author'});}}const last=await f.controller.pause();assert.equal(last.resumable,false);assert.equal(f.stats.workspaces,3);assert.throws(()=>f.controller.requestAuthor(),{code:'CONTINUITY_ADMISSION_CLOSED'});
});
test('M4 concurrent resume consumes only once and stale copied checkpoints have zero dispatch',async t=>{
  const f=await m4ControllerFixture(t);await f.authorize();const paused=await f.controller.pause(),r={checkpointDigest:paused.status.checkpointDigest,nextAction:'author'};const results=await Promise.allSettled([f.controller.resume(r),f.controller.resume({...r})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.stats.starts,1);await f.controller.stop();await assert.rejects(f.controller.resume(r),{code:'CHECKPOINT_UNAVAILABLE'});
});
test('M4 resume failure after one-use consumption cannot restore admission',async t=>{
  let fired=false;const f=await m4ControllerFixture(t,{failpoint(name){if(name==='control.resume.afterConsume'){fired=true;throw Object.assign(new Error('injected'),{code:'M4_INJECTED'});}}});await f.authorize();const paused=await f.controller.pause(),request={checkpointDigest:paused.status.checkpointDigest,nextAction:'author'};await assert.rejects(f.controller.resume(request),{code:'M4_INJECTED'});assert.equal(fired,true);await assert.rejects(f.controller.resume(request),{code:'CHECKPOINT_UNAVAILABLE'});assert.equal(f.stats.starts,1);assert.equal(f.store.status().revoked,true);
});
test('M4 queued author is fenced before dispatch by a nonresumable busy pause',async t=>{
  const f=await m4ControllerFixture(t);await f.authorize();const author=f.controller.requestAuthor();const observed=author.catch(e=>e);const paused=await f.controller.pause();assert.equal(paused.resumable,false);assert.equal((await observed).code,'CONTINUITY_ADMISSION_CLOSED');assert.equal(f.stats.workspaces,0);assert.equal(f.stats.starts,1);
});
test('M4 checkpoint copied to another live owner is rejected without stage effects',async t=>{
  const first=await m4ControllerFixture(t),second=await m4ControllerFixture(t);await first.authorize();await second.authorize();const a=await first.controller.pause(),b=await second.controller.pause();await assert.rejects(second.controller.resume({checkpointDigest:a.status.checkpointDigest,nextAction:'author'}),{code:'CHECKPOINT_UNAVAILABLE'});assert.equal(second.stats.starts,1);assert.equal((await second.controller.status()).status.checkpointDigest,b.status.checkpointDigest);await second.controller.resume({checkpointDigest:b.status.checkpointDigest,nextAction:'author'});assert.equal(second.stats.starts,1);
});
test('M4 pause failure after control persistence retains record and denies continuation',async t=>{
  let fired=false;const f=await m4ControllerFixture(t,{failpoint(name){if(name==='control.pause.afterRecord'){fired=true;throw Object.assign(new Error('injected'),{code:'M4_INJECTED'});}}});await f.authorize();await assert.rejects(f.controller.pause(),{code:'M4_INJECTED'});assert.equal(fired,true);assert.throws(()=>f.controller.requestAuthor(),{code:'CONTINUITY_ADMISSION_CLOSED'});assert.equal(f.stats.starts,1);const inspected=await import('../src/governance/store.mjs').then(m=>m.inspectGovernanceM4(f.options,{kind:'history',id:null,offset:0,limit:64,cursor:null}));assert.equal(inspected.rows.at(-1).type,'CONTROL_RECORDED');assert.equal(inspected.headAuthenticity,'unproven');
});
test('M4 public control artifact pages expose bounded hashes, not opaque owner capability',async t=>{
  const f=await m4ControllerFixture(t);await f.authorize();await f.controller.pause();const history=await f.controller.read({kind:'history',id:null,offset:0,limit:64,cursor:null}),hash=history.rows.at(-1).artifacts[0];let offset=0,cursor=null,text='';do{const page=await f.controller.read({kind:'artifact',id:hash,offset,limit:128,cursor});assert.ok(Buffer.byteLength(JSON.stringify(page))<=16384);text+=page.text;cursor=page.cursor;offset=page.nextOffset;}while(offset!==null);const publicRecord=JSON.parse(text);assert.equal(publicRecord.kind,'control');assert.equal(publicRecord.nextAction,'author');assert.equal(publicRecord.ownerId,undefined);assert.equal(publicRecord.id,undefined);assert.equal(text.includes(f.options.root),false);
});
test('M4 stop waits for a suspended control operation and cannot acknowledge a late pause',async t=>{
  let enteredResolve,releaseResolve;const entered=new Promise(r=>{enteredResolve=r;}),release=new Promise(r=>{releaseResolve=r;});const f=await m4ControllerFixture(t,{async failpoint(name){if(name==='control.pause.beforeRecord'){enteredResolve();await release;}}});await f.authorize();const pause=f.controller.pause(),observedPause=pause.catch(e=>e);await entered;let settled=false;const stop=f.controller.stop().then(()=>{settled=true;},e=>{settled=true;return e;});await Promise.resolve();assert.equal(settled,false);releaseResolve();await stop;const failure=await observedPause;assert.ok(failure instanceof Error);assert.equal(f.stats.starts,1);const inspect=await import('../src/governance/store.mjs').then(m=>m.inspectGovernanceM4(f.options,{kind:'history',id:null,offset:0,limit:64,cursor:null}));assert.equal(inspect.rows.some(r=>r.type==='CONTROL_RECORDED'),false);assert.equal(inspect.rows.at(-1).type,'STOPPED');
});
