import path from 'node:path';
import os from 'node:os';

/** Only offline seam fakes; live acceptance never consumes these receipts. */
export function runnerFixture({exitCode=0,stdout='',stderr='',lossy=false,quiescent=true}={}) {
  const calls=[];let terminated=0,waited=0;
  const sandbox={confine(argv,policy){calls.push({kind:'confine',argv,policy});return {argv:[process.execPath,'runner-fixture',...argv],enforcement:'partial',runnerFailureRules:[{fatalSignatures:['windows-acl-run:']} ]};}};
  const subprocess={spawn(spec){calls.push({kind:'spawn',spec});return {
    done:Promise.resolve({exitCode,signal:null}),
    collected:{stdout:{readFrom:()=>({text:stdout,lossy})},stderr:{readFrom:()=>({text:stderr,lossy:false})}},
    terminate(){terminated++;},async waitForExit(){waited++;return quiescent;},
  };}};
  return {sandbox,subprocess,calls,stats:()=>({terminated,waited}),options:{
    frozen:path.join(os.tmpdir(),'m0-frozen'),scratch:path.join(os.tmpdir(),'m0-scratch'),
    systemRoot:path.parse(process.execPath).root,argv:[process.execPath,'-e','0'],signal:new AbortController().signal,
  }};
}
export const GOOD_TAP='TAP version 13\n# Subtest: fixture\nok 1 - fixture\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';

// M1 resources are confined to each test's mkdtemp root.
import * as m1fs from 'node:fs/promises';
import {watch as m1watch} from 'node:fs';
import {spawn as m1spawn} from 'node:child_process';

export function m1Deferred(){
  let resolve,reject,timer;const promise=new Promise((yes,no)=>{
    resolve=value=>{clearTimeout(timer);yes(value);};reject=reason=>{clearTimeout(timer);no(reason);};
    timer=setTimeout(()=>reject(new Error('Fixture barrier timeout')),15000);
  });
  promise.catch(()=>{});return {promise,resolve,reject};
}
export function m1FixtureValidator(previous,next,type){
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  if(!next||Object.keys(next).sort().join(',')!=='budget,count,phase,provenance')fail('FIXTURE_SCHEMA');
  if(next.provenance!=='fixture-untrusted')fail('UNTRUSTED_PROVENANCE');
  if(!Number.isSafeInteger(next.count)||next.count<0||!Number.isSafeInteger(next.budget)||next.budget<0||next.budget>3||!['PLANNING','AUTHORING','STOPPED'].includes(next.phase))fail('FIXTURE_SCHEMA');
  if(previous===null){if(type!=='PLAN_PROPOSED'||next.count!==0||next.budget!==1||next.phase!=='PLANNING')fail('FIXTURE_TRANSITION');}
  else if(next.count!==previous.count+1||next.budget!==previous.budget+(type==='ATTEMPT_RESERVED'?1:0)||!['ATTEMPT_RESERVED','RESULT_RECORDED','STOPPED'].includes(type))fail('FIXTURE_TRANSITION');
}
export const m1Payload=(count=0,budget=1,phase='PLANNING')=>({count,budget,phase,provenance:'fixture-untrusted'});
export async function m1Marker(file,value='ready'){
  await m1fs.writeFile(file+'.tmp',value,{flag:'wx'});await m1fs.rename(file+'.tmp',file);
}
/** Watch is installed before checking; callers construct the wait before starting the action. */
export function m1WaitMarker(file,timeoutMs=15000){
  let watcher,timer,settled=false;
  const promise=new Promise((resolve,reject)=>{
    const finish=(e,value)=>{if(settled)return;settled=true;clearTimeout(timer);watcher?.close();e?reject(e):resolve(value);};
    const check=async()=>{try{finish(null,await m1fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')finish(e);}};
    watcher=m1watch(path.dirname(file),()=>{void check();});watcher.on('error',finish);
    timer=setTimeout(()=>finish(new Error('Marker timeout: '+file)),timeoutMs);void check();
  });
  // A pending marker has its own bound even when the triggering action rejects.
  promise.catch(()=>{});return promise;
}
export function m1Spawn(source,args,{cwd}={}){
  const child=m1spawn(process.execPath,['--input-type=module','-e',source,'--',...args],{stdio:'inherit',shell:false,cwd});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  done.catch(()=>{});
  const dispose=async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    let timer;try{await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Child did not settle after termination')),15000);})]);}finally{clearTimeout(timer);}
  };
  return {child,done,dispose};
}

// Constant source; only owned fixture paths/scenario identifiers cross argv, never generated code.
export const M1_STORE_CHILD_SOURCE=String.raw`
import * as fs from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
const [url,root,legacyRoot,projectRoot,candidateRoot,marker,mode,crashPoint]=process.argv.slice(1);
const {openGovernanceStore}=await import(url);
function validator(previous,next,type){
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  if(!next||Object.keys(next).sort().join(',')!=='budget,count,phase,provenance')fail('FIXTURE_SCHEMA');
  if(next.provenance!=='fixture-untrusted')fail('UNTRUSTED_PROVENANCE');
  if(!Number.isSafeInteger(next.count)||next.count<0||!Number.isSafeInteger(next.budget)||next.budget<0||next.budget>3||!['PLANNING','AUTHORING','STOPPED'].includes(next.phase))fail('FIXTURE_SCHEMA');
  if(previous===null){if(type!=='PLAN_PROPOSED'||next.count!==0||next.budget!==1||next.phase!=='PLANNING')fail('FIXTURE_TRANSITION');}
  else if(next.count!==previous.count+1||next.budget!==previous.budget+(type==='ATTEMPT_RESERVED'?1:0)||!['ATTEMPT_RESERVED','RESULT_RECORDED','STOPPED'].includes(type))fail('FIXTURE_TRANSITION');
}
async function signal(file,value){await fs.writeFile(file+'.tmp',value,{flag:'wx'});await fs.rename(file+'.tmp',file);}
function wait(file){return new Promise((resolve,reject)=>{
  let watcher,timer,settled=false;
  const finish=e=>{if(settled)return;settled=true;clearTimeout(timer);watcher?.close();e?reject(e):resolve();};
  const check=async()=>{try{await fs.stat(file);finish();}catch(e){if(e.code!=='ENOENT')finish(e);}};
  watcher=watch(path.dirname(file),()=>{void check();});watcher.on('error',finish);
  timer=setTimeout(()=>finish(new Error('Child marker timeout')),15000);void check();
});}
const options={root,legacyRoot,projectRoots:[projectRoot],candidateRoots:[candidateRoot],validateTransition:validator};
if(mode==='lock'){
  let store;
  try{store=await openGovernanceStore(options);}
  catch(e){if(e.code!=='LOCKED')throw e;await signal(marker+'.ready','LOCKED');process.exit(0);}
  const released=wait(marker+'.release');await signal(marker+'.ready','HELD');await released;await store.close();process.exit(0);
}else if(mode==='crash'){
  options.failpoint=async(name,context)=>{
    if(name===crashPoint&&context.revision===2){const continued=wait(marker+'.crash');await signal(marker+'.ready',name);await continued;process.exit(73);}
  };
  const store=await openGovernanceStore(options);await store.registerJob({jobId:'job',projectRoot});
  await store.append('job',{type:'PLAN_PROPOSED',payload:{count:0,budget:1,phase:'PLANNING',provenance:'fixture-untrusted'}},0);
  await store.append('job',{type:'ATTEMPT_RESERVED',payload:{count:1,budget:2,phase:'AUTHORING',provenance:'fixture-untrusted'},artifacts:[{fixture:'crash-owned'}]},1);
  throw new Error('Crash failpoint was not reached');
}else throw new Error('Unknown child scenario');
`;

export const M1_IMPORT_CHILD_SOURCE=String.raw`
import * as fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const [storeURL]=process.argv.slice(1);
const before=await fs.readdir(process.cwd());
const environment={...process.env};
const handles=process.getActiveResourcesInfo().filter(x=>x!=='FSReqPromise');
await import(new URL('./contracts.mjs',storeURL));
await import(storeURL);
await import(new URL('./controller.mjs',storeURL));
assert.deepEqual(await fs.readdir(process.cwd()),before);
assert.deepEqual({...process.env},environment);
assert.deepEqual(process.getActiveResourcesInfo().filter(x=>x!=='FSReqPromise'),handles);
`;

// M2 setup runs only in owned temporary repositories; it is not a model command API.
import {createHash as m2CreateHash} from 'node:crypto';
import {PROVENANCE as M2_PROVENANCE, digest as m2Digest, bindingFor as m2Binding, ownedJson as m2Owned} from '../../src/governance/contracts.mjs';
import {reduceState as m2Reduce, validateTransition as m2ValidateTransition} from '../../src/governance/controller.mjs';
import {openGovernanceStore as m2OpenStore} from '../../src/governance/store.mjs';

export const m2RawHash=value=>m2CreateHash('sha256').update(value).digest('hex');
export function m2Deferred(){
  let resolve,reject,settled=false;
  const promise=new Promise((yes,no)=>{resolve=value=>{if(!settled){settled=true;yes(value);}};reject=error=>{if(!settled){settled=true;no(error);}};});
  promise.catch(()=>{});return {promise,resolve,reject,get settled(){return settled;}};
}
async function m2GitPath(){
  const candidates=process.platform==='win32'?[path.join(process.env.ProgramFiles??'C:\\Program Files','Git','cmd','git.exe')]:['/usr/bin/git','/usr/local/bin/git'];
  for(const candidate of candidates){try{const st=await m1fs.stat(candidate);if(st.isFile())return await m1fs.realpath(candidate);}catch(e){if(e.code!=='ENOENT')throw e;}}
  throw new Error('M2 fixture requires an absolute installed Git executable');
}
export async function m2GitFixture(t,{files={'a.txt':'alpha\r\n','test.mjs':'// fixture test\n'},modes={}}={}){
  const root=await m1fs.realpath(await m1fs.mkdtemp(path.join(os.tmpdir(),'m2-workspace-'))),resources=[];
  let disposed=false,sequence=0;
  const paths=Object.fromEntries(['sourceRoot','workspaceRoot','scratchRoot','governanceRoot','legacyRoot','configRoot','siblingRoot'].map(name=>[name,path.join(root,name.replace('Root',''))]));
  const setupRoot=path.join(root,'setup'),home=path.join(setupRoot,'home'),hooks=path.join(setupRoot,'hooks'),captures=path.join(setupRoot,'captures');
  const fixture={root,...paths,protectedRoots:[paths.siblingRoot],protectedFiles:[],own(disposer,{allowFailure=()=>false}={}){resources.push({disposer,allowFailure});return disposer;}};
  fixture.dispose=async()=>{
    if(disposed)return;disposed=true;const errors=[];
    for(const resource of resources.reverse()){try{await resource.disposer();}catch(e){if(!resource.allowFailure(e))errors.push(e);}}
    try{await m1fs.rm(root,{recursive:true,force:true});}catch(e){errors.push(e);}
    if(errors.length)throw new AggregateError(errors,'M2 fixture cleanup failed');
  };
  t?.after(()=>fixture.dispose());
  try{
    for(const dir of [paths.sourceRoot,paths.configRoot,paths.siblingRoot,home,hooks,captures])await m1fs.mkdir(dir,{recursive:true});
    await m1fs.writeFile(path.join(paths.configRoot,'sentinel'),'config sentinel\n',{flag:'wx'});
    await m1fs.writeFile(path.join(paths.siblingRoot,'sentinel'),'sibling sentinel\n',{flag:'wx'});
    const emptyConfig=path.join(home,'empty-config');await m1fs.writeFile(emptyConfig,'',{flag:'wx'});
    const executable=await m2GitPath(),systemRoot=process.platform==='win32'?await m1fs.realpath(process.env.SYSTEMROOT):null;
    const env={HOME:home,USERPROFILE:home,TMP:home,TEMP:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:emptyConfig,GIT_CONFIG_SYSTEM:emptyConfig,GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};
    if(systemRoot!==null)env.SYSTEMROOT=systemRoot;
    const runSetupGit=async(args,indexInfoPath=null)=>{
      const n=++sequence,outPath=path.join(captures,n+'.out'),errPath=path.join(captures,n+'.err');
      if(indexInfoPath!==null){const relative=path.relative(root,path.resolve(indexInfoPath));if(relative.startsWith('..')||path.isAbsolute(relative)||(await m1fs.lstat(indexInfoPath)).isSymbolicLink())throw new Error('Index fixture input must be an owned regular file');}
      const input=indexInfoPath===null?null:await m1fs.open(indexInfoPath,'r');
      const out=await m1fs.open(outPath,'wx'),err=await m1fs.open(errPath,'wx');let child,timer,deadline=false,result,done;
      try{
        child=m1spawn(executable,['-c','core.autocrlf=false',...(process.platform==='win32'?['-c','core.longpaths=true']:[]),'-c','core.fsmonitor=false','-c','core.hooksPath='+hooks,'-c','protocol.allow=never',...args],{cwd:paths.sourceRoot,env,shell:false,stdio:[input?.fd??'ignore',out.fd,err.fd]});
        done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});done.catch(()=>{});
        timer=setTimeout(()=>{deadline=true;child.kill();},15000);result=await done;
      }finally{
        clearTimeout(timer);if(child&&child.exitCode===null&&child.signalCode===null){child.kill();if(done)await done.catch(()=>{});}
        await out.close();await err.close();if(input)await input.close();
      }
      const stdout=await m1fs.readFile(outPath),stderr=await m1fs.readFile(errPath,'utf8');
      if(deadline||result?.code!==0||result?.signal)throw Object.assign(new Error('M2 Git fixture failed: '+args.join(' ')+'\n'+stderr),{code:'FIXTURE_GIT_FAILED',result,deadline});
      return stdout.toString('utf8');
    };
    fixture.runGit=args=>runSetupGit(args);
    fixture.indexConflict=infoPath=>runSetupGit(['update-index','--index-info'],infoPath);
    const version=(await fixture.runGit(['--version'])).trim();
    fixture.git=Object.freeze({executable,sha256:m2RawHash(await m1fs.readFile(executable)),version,systemRoot});
    await fixture.runGit(['init','--initial-branch=main','.']);
    for(const [relative,content] of Object.entries(files)){
      const target=path.join(paths.sourceRoot,...relative.split('/'));await m1fs.mkdir(path.dirname(target),{recursive:true});await m1fs.writeFile(target,content,{flag:'wx'});
      if(modes[relative]==='100755'&&process.platform!=='win32')await m1fs.chmod(target,0o755);
    }
    if(Object.keys(files).length){await fixture.runGit(['add','--','.']);for(const [relative,mode]of Object.entries(modes))await fixture.runGit(['update-index',mode==='100755'?'--chmod=+x':'--chmod=-x','--',relative]);}
    await fixture.runGit(['-c','user.name=M2 Fixture','-c','user.email=m2@example.invalid','commit','--allow-empty','--no-gpg-sign','-m','owned M2 fixture baseline']);
    return fixture;
  }catch(e){await fixture.dispose();throw e;}
}

/** Cache invalidates before every transition; the real M1 store owns validation and acknowledgement. */
export async function m2AuthorityOwner(fixture,baseline,{files,protectedTests=['test.mjs'],phase='AUTHORING',planPatch={},failpoint}={}){
  const storeOptions={root:fixture.governanceRoot,legacyRoot:fixture.legacyRoot,projectRoots:[fixture.sourceRoot],candidateRoots:[fixture.workspaceRoot],validateTransition:m2ValidateTransition};
  if(failpoint)storeOptions.failpoint=failpoint;
  const store=await m2OpenStore(storeOptions),jobId='m2-job',projectId=await store.registerJob({jobId,projectRoot:fixture.sourceRoot});
  const actor=Object.freeze({id:'m2-author',provider:'author'}),execution=m2Deferred(),disposed=m2Deferred();
  let cache=null,last=null,serial=Promise.resolve(),pending=0,closed=false,invalid=false,sequence=0,expectedCloseFailure=false;const revokers=new Set();
  const authority=Object.freeze({readCurrent(){const status=store.status();return !invalid&&!closed&&status.admission&&!status.revoked&&!status.closed&&!status.poisoned?cache:null;}});
  const defaultFile=baseline.files.find(row=>row.path==='a.txt')??baseline.files.find(row=>!protectedTests.includes(row.path));
  const plan=m2Owned({schemaVersion:1,jobId,projectId,baseline:baseline.baselineDigest,objective:'M2 owned offline candidate fixture',nonGoals:['No operational dispatch or activation'],files:files??(defaultFile?[{path:defaultFile.path,operation:'replace',expectedHash:defaultFile.sha256}]:[]),protectedTests:protectedTests.filter(p=>baseline.files.some(row=>row.path===p)),criteria:[{id:'M2',description:'Fixture requirement',method:'test'}],commands:[{id:'unit',executable:process.execPath,argv:['--test','test.mjs'],cwd:'frozen',environment:process.platform==='win32'?{SYSTEMROOT:fixture.git.systemRoot}:{},timeoutMs:15000,expectedExit:0,inventory:['fixture']}],policy:{planner:{id:'planner',provider:'author'},implementerProvider:'author',correctionLimit:2},testInventory:['fixture'],environmentDigest:m2Digest({node:process.version,git:fixture.git.sha256}),...planPatch});
  const api={store,storeOptions,plan,actor,authority,execution,disposed,assignmentId:null,state:()=>last,
    attach(workspace){revokers.add(()=>workspace.revoke());},
    expectCloseFailure(){expectedCloseFailure=true;},
    invalidate(){cache=null;invalid=true;for(const revoke of revokers)revoke();},
    commit(action){
      cache=null;pending++;for(const revoke of revokers)revoke();
      const task=serial.then(async()=>{
        cache=null;
        try{
          if(invalid||closed)throw new Error('M2 fixture authority is closed');
          const next=m2Reduce(last,action),event=await store.append(jobId,{type:action.type,payload:next},last?.revision??0);
          last=event.payload;return last;
        }catch(e){invalid=true;throw e;}
        finally{pending--;cache=!invalid&&!closed&&pending===0?last:null;}
      });
      serial=task.catch(()=>{});return task;
    },
    async close(){if(closed)return;closed=true;cache=null;for(const revoke of revokers)revoke();execution.resolve('cancelled');disposed.resolve();await serial;await store.close();}
  };
  fixture.own(()=>api.close(),{allowFailure:()=>expectedCloseFailure});
  if(phase==='EMPTY')return api;
  await api.commit({type:'PLAN_PROPOSED',plan});
  if(phase==='PLANNING')return api;
  const pr={id:'plan-review',actor:{id:'review-plan',provider:'other'},role:'plan-review',generation:last.generation,binding:m2Binding(plan),provenance:M2_PROVENANCE};
  await api.commit({type:'ASSIGNMENT_CREATED',assignment:pr});
  await api.commit({type:'RESULT_RECORDED',result:{id:'plan-result',assignmentId:pr.id,actor:pr.actor,role:pr.role,generation:pr.generation,binding:pr.binding,outcome:'completed-pass',submission:{criteria:plan.criteria.map(c=>({id:c.id,outcome:'pass'})),findings:[],evidenceIds:[]},provenance:M2_PROVENANCE}});
  if(phase==='AWAITING_HUMAN')return api;
  await api.commit({type:'HUMAN_DECIDED',decision:{id:'human',planDigest:m2Digest(plan),reviewResultId:'plan-result',generation:last.generation,decision:phase==='REJECTED'?'reject':'authorize',provenance:M2_PROVENANCE}});
  if(phase==='PLAN_AUTHORIZED'||phase==='REJECTED')return api;
  if(phase!=='AUTHORING')throw new Error('Unknown M2 fixture phase '+phase);
  const assignment={id:'author-'+(++sequence),actor,role:'author',generation:last.generation+1,binding:m2Binding(plan),provenance:M2_PROVENANCE};
  await api.commit({type:'ATTEMPT_RESERVED',assignment});api.assignmentId=assignment.id;
  return api;
}

export async function m2Setup(t,{files,modes,planFiles,protectedTests,protectedFiles=[],phase='AUTHORING',planPatch={},failpoint,authorityFailpoint,pendingExecution=false,begin=true}={}){
  const fixture=await m2GitFixture(t,{files,modes});
  const {inspectBaseline,createWorkspace}=await import('../../src/governance/workspace.mjs');
  const baseline=await inspectBaseline({sourceRoot:fixture.sourceRoot,scratchRoot:fixture.scratchRoot,protectedRoots:[fixture.workspaceRoot,fixture.governanceRoot,fixture.legacyRoot,fixture.configRoot,...fixture.protectedRoots],git:fixture.git});
  const authorityOwner=await m2AuthorityOwner(fixture,baseline,{files:planFiles,protectedTests,phase,planPatch,failpoint:authorityFailpoint});
  const options={sourceRoot:fixture.sourceRoot,workspaceRoot:fixture.workspaceRoot,scratchRoot:fixture.scratchRoot,governanceRoot:fixture.governanceRoot,legacyRoot:fixture.legacyRoot,configRoot:fixture.configRoot,protectedRoots:fixture.protectedRoots,protectedFiles,git:fixture.git,baseline,authority:authorityOwner.authority};if(failpoint)options.failpoint=failpoint;
  const owner=createWorkspace(options);authorityOwner.attach(owner);let expectedCloseFailure=false;
  fixture.own(async()=>{authorityOwner.execution.resolve('cancelled');authorityOwner.disposed.resolve();await owner.close();},{allowFailure:()=>expectedCloseFailure});
  if(!pendingExecution){authorityOwner.execution.resolve('completed');authorityOwner.disposed.resolve();}
  const handle=begin?await owner.beginAttempt({actor:authorityOwner.actor,assignmentId:authorityOwner.assignmentId,execution:authorityOwner.execution.promise,disposed:authorityOwner.disposed.promise}):null;
  return {...fixture,baseline,options,authorityOwner,owner,handle,actor:authorityOwner.actor,assignmentId:authorityOwner.assignmentId,expectCloseFailure(){expectedCloseFailure=true;}};
}

export const M2_IMPORT_CHILD_SOURCE=String.raw`
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const [url]=process.argv.slice(1),before=await fs.readdir(process.cwd()),env={...process.env};
const resources=process.getActiveResourcesInfo().filter(x=>x!=='FSReqPromise');
await import(url);
assert.deepEqual(await fs.readdir(process.cwd()),before);assert.deepEqual({...process.env},env);
assert.deepEqual(process.getActiveResourcesInfo().filter(x=>x!=='FSReqPromise'),resources);
`;

export const M2_WORKSPACE_CHILD_SOURCE=String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
const [helperURL,workspaceURL,configPath,marker,mode,point]=process.argv.slice(1);
const {m2AuthorityOwner,m1Marker,m1WaitMarker}=await import(helperURL);
const {inspectBaseline,createWorkspace,workspaceFile}=await import(workspaceURL);
const config=JSON.parse(await fs.readFile(configPath,'utf8'));
const resources=[];const fixture={...config,own(disposer,options){resources.push({disposer,options});}};
const baseline=await inspectBaseline({sourceRoot:config.sourceRoot,scratchRoot:config.scratchRoot,protectedRoots:[config.workspaceRoot,config.governanceRoot,config.legacyRoot,config.configRoot,...config.protectedRoots],git:config.git});
const authority=await m2AuthorityOwner(fixture,baseline);
authority.execution.resolve('completed');authority.disposed.resolve();
const release=m1WaitMarker(marker+'.release',30000);
const failpoint=async(name,context)=>{
  if(mode==='crash'&&name===point){await m1Marker(marker+'.ready',name);await release;process.exit(73);}
};
const options={sourceRoot:config.sourceRoot,workspaceRoot:config.workspaceRoot,scratchRoot:config.scratchRoot,governanceRoot:config.governanceRoot,legacyRoot:config.legacyRoot,configRoot:config.configRoot,protectedRoots:config.protectedRoots,protectedFiles:[],git:config.git,baseline,authority:authority.authority,failpoint};
const owner=createWorkspace(options);authority.attach(owner);
try{
  let handle;
  try{handle=await owner.beginAttempt({actor:authority.actor,assignmentId:authority.assignmentId,execution:authority.execution.promise,disposed:authority.disposed.promise});}
  catch(error){if(mode!=='lock')throw error;await m1Marker(marker+'.ready','REFUSED:'+String(error.code??error.message));await release;await authority.close();process.exit(0);}
  if(mode==='lock'){await m1Marker(marker+'.ready','HELD');await release;await owner.close();await authority.close();process.exit(0);}
  if(mode==='crash'){
    const row=baseline.files.find(x=>x.path==='a.txt');
    await workspaceFile(handle,authority.actor,{operation:'replace',path:'a.txt',expectedHash:row.sha256,text:'crash fixture candidate\n'});
    throw new Error('Requested crash boundary was not reached');
  }
  throw new Error('Unknown child mode');
}catch(error){console.error(error);process.exitCode=1;}
`;

export async function m2SpawnWorkspaceChild(fixture,{mode,marker,crashPoint='',suffix='child'}={}){
  const roots=Object.fromEntries(['scratchRoot','governanceRoot','legacyRoot'].map(name=>[name,path.join(fixture.root,suffix+'-'+name.replace('Root',''))]));
  const config={sourceRoot:fixture.sourceRoot,workspaceRoot:fixture.workspaceRoot,...roots,configRoot:fixture.configRoot,protectedRoots:fixture.protectedRoots,git:fixture.git};
  const configPath=path.join(fixture.root,suffix+'-child.json');await m1fs.writeFile(configPath,JSON.stringify(config),{flag:'wx'});
  const helperURL=import.meta.url,workspaceURL=new URL('../../src/governance/workspace.mjs',import.meta.url).href;
  const child=m1Spawn(M2_WORKSPACE_CHILD_SOURCE,[helperURL,workspaceURL,configPath,marker,mode,crashPoint]);
  fixture.own(()=>child.dispose());return {...child,config,configPath};
}

