import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {inspectBaseline,createWorkspace,workspaceFile,workspaceRead} from '../src/governance/workspace.mjs';
import {digest,ownedJson,planIdentity,PROVENANCE} from '../src/governance/contracts.mjs';
import {createGovernanceController,operationalAcceptance} from '../src/governance/controller.mjs';
import {openGovernanceStore} from '../src/governance/store.mjs';
import {m2GitFixture,m2AuthorityOwner,m2Deferred,m1Deferred,m1Marker,m1WaitMarker,m1Spawn,m2SpawnWorkspaceChild,M2_IMPORT_CHILD_SOURCE} from './helpers/governance.mjs';

const MiB=1024*1024,KiB=1024;
const raw=value=>createHash('sha256').update(value).digest('hex');
const actor=(id,provider='independent')=>Object.freeze({id,provider});
const copy=value=>JSON.parse(JSON.stringify(value));
const disk=(f,p)=>path.join(f.workspaceRoot,'working',...p.split('/'));
const sealed=(f,p)=>path.join(f.workspaceRoot,'sealed',...p.split('/'));
const read=(f,p='a.txt')=>fs.readFile(disk(f,p));
const replacement=(text='changed\r\n',expectedHash=raw('alpha\r\n'),p='a.txt')=>({operation:'replace',path:p,expectedHash,text});
const entry=(p,operation,bytes)=>({path:p,operation,expectedHash:operation==='create'?null:raw(bytes)});
const exists=async p=>{try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};

// Inventories are independently observed filesystem facts, not workspace receipts.
async function inventory(root){
  if(!await exists(root))return null;
  const out=[];
  async function visit(dir,relative=''){
    for(const name of (await fs.readdir(dir)).sort()){
      const p=path.join(dir,name),rel=relative?relative+'/'+name:name,st=await fs.lstat(p);
      if(st.isSymbolicLink())out.push({path:rel,kind:'link',target:await fs.readlink(p)});
      else if(st.isDirectory()){out.push({path:rel,kind:'directory'});await visit(p,rel);}
      else if(st.isFile())out.push({path:rel,kind:'file',bytes:st.size,hash:raw(await fs.readFile(p)),links:st.nlink,...(process.platform==='win32'?{}:{mode:st.mode&0o111})});
      else out.push({path:rel,kind:'special'});
    }
  }
  await visit(root);return out;
}
async function sentinels(f){
  return Promise.all([f.sourceRoot,f.governanceRoot,f.legacyRoot,f.configRoot,f.siblingRoot].map(inventory));
}
async function refuse(action){
  await assert.rejects(async()=>action(),error=>{
    assert.ok(error instanceof Error,'refusal must be an Error');
    assert.equal(typeof error.code,'string','refusal must carry an explicit code');
    return true;
  });
}
async function unchanged(f,action,{candidate=true}={}){
  const before=await sentinels(f),working=candidate?await inventory(path.join(f.workspaceRoot,'working')):null;
  await refuse(action);
  assert.deepEqual(await sentinels(f),before,'source, real store, configuration and sibling sentinels changed');
  if(candidate)assert.deepEqual(await inventory(path.join(f.workspaceRoot,'working')),working,'refused request changed candidate bytes');
}
function baselineOptions(f,extra={}){return {sourceRoot:f.sourceRoot,scratchRoot:f.scratchRoot,protectedRoots:[f.governanceRoot,f.legacyRoot,f.configRoot,...f.protectedRoots],git:f.git,...extra};}
function workspaceOptions(f,baseline,authority,extra={}){
  return {sourceRoot:f.sourceRoot,workspaceRoot:f.workspaceRoot,scratchRoot:f.scratchRoot,governanceRoot:f.governanceRoot,legacyRoot:f.legacyRoot,configRoot:f.configRoot,protectedRoots:f.protectedRoots,protectedFiles:[],git:f.git,baseline,authority,...extra};
}
async function setup(t,{files,modes,grants,protectedTests,protectedFiles=[],phase='AUTHORING',planPatch={},failpoint,authorityFailpoint,pending=false,begin=true}={}){
  const f=await m2GitFixture(t,{...(files?{files}:{}),...(modes?{modes}:{})});
  const baseline=await inspectBaseline(baselineOptions(f));
  const a=await m2AuthorityOwner(f,baseline,{...(grants?{files:grants}:{}),...(protectedTests?{protectedTests}:{}),phase,planPatch,...(authorityFailpoint?{failpoint:authorityFailpoint}:{})});
  if(!pending){a.execution.resolve('completed');a.disposed.resolve();}
  const options=workspaceOptions(f,baseline,a.authority,{protectedFiles,...(failpoint?{failpoint}:{})});
  const owner=createWorkspace(options);a.attach(owner);let expectedCloseFailure=false;
  f.own(async()=>{a.execution.resolve('cancelled');a.disposed.resolve();await owner.close();},{allowFailure:()=>expectedCloseFailure});
  const result={...f,baseline,authorityOwner:a,options,owner,actor:a.actor,assignmentId:a.assignmentId,
    expectCloseFailure(){expectedCloseFailure=true;},
    begin(extra={}){return owner.beginAttempt({actor:a.actor,assignmentId:a.assignmentId,execution:a.execution.promise,disposed:a.disposed.promise,...extra});}};
  if(begin)result.handle=await result.begin();
  return result;
}
function barrier(t,point){
  const entered=m2Deferred(),release=m2Deferred();let enabled=false,seen=0,timer;
  t.after(()=>{clearTimeout(timer);entered.resolve();release.resolve();});
  return {entered:entered.promise,release:()=>release.resolve(),arm:()=>{
    enabled=true;timer=setTimeout(()=>{entered.reject(new Error('Owned boundary not reached: '+point));release.resolve();},15000);
  },get seen(){return seen;},
    async hook(name,context){if(enabled&&name===point&&seen++===0){clearTimeout(timer);entered.resolve(context);await release.promise;}}};
}
async function successfulReplace(f,text='changed\r\n',hash=raw('alpha\r\n'),p='a.txt'){
  const receipt=await workspaceFile(f.handle,f.actor,replacement(text,hash,p));
  assert.equal(receipt.provenance,PROVENANCE);assert.equal(receipt.sha256,raw(text));
  assert.equal(receipt.bytes,Buffer.byteLength(text));assert.deepEqual(await read(f,p),Buffer.from(text));return receipt;
}

// M2-18 independent freeze/review and full inherited-suite evidence are parent-owned;
// these tests establish offline component facts, never their own acceptance verdict.
test('M2-01/M2-05/M2-18 real clean baseline and private materialization retain raw empty/CRLF bytes and fixture provenance',async t=>{
  const files={'a.txt':'alpha\r\n','empty.txt':'','.hidden':'hidden\r\n','test.mjs':'// test\n'};
  const f=await setup(t,{files}),before=await sentinels(f);
  assert.equal(f.baseline.provenance,PROVENANCE);assert.equal(f.baseline.schemaVersion,1);assert.equal(f.baseline.objectFormat,'sha1');
  assert.match(f.baseline.commit,/^[a-f0-9]{40}$/);assert.match(f.baseline.baselineDigest,/^[a-f0-9]{64}$/);
  const {baselineDigest,...body}=f.baseline;assert.equal(baselineDigest,digest(body));
  assert.ok(Object.isFrozen(f.baseline));assert.ok(Object.isFrozen(f.baseline.files));
  assert.deepEqual(f.baseline.files.map(r=>r.path),Object.keys(files).sort());
  for(const row of f.baseline.files){
    assert.equal(row.sha256,raw(files[row.path]));assert.equal(row.bytes,Buffer.byteLength(files[row.path]));
    assert.equal(row.kind,'file');assert.match(row.gitMode,/^100(?:644|755)$/);
    assert.deepEqual(await read(f,row.path),Buffer.from(files[row.path]));
    const source=await fs.stat(path.join(f.sourceRoot,row.path),{bigint:true}),candidate=await fs.stat(disk(f,row.path),{bigint:true});
    assert.equal(source.nlink,1n);assert.equal(candidate.nlink,1n);
    assert.ok(source.dev!==candidate.dev||source.ino!==candidate.ino,'materialization must not share inode');
  }
  await successfulReplace(f);assert.deepEqual(await sentinels(f),before);
  assert.notEqual(raw('alpha\r\n'),digest('alpha\r\n'),'raw file and canonical JSON hash are distinct');
  assert.equal(typeof f.owner.export,'undefined');assert.equal(typeof f.owner.enable,'undefined');assert.equal(typeof f.owner.apply,'undefined');
});

test('M2-01 closed constructor/baseline descriptors reject unknown flags and accessors without executing getters',async t=>{
  const f=await setup(t,{begin:false}),before=await sentinels(f);let accessed=0;
  const accessor={...f.options};Object.defineProperty(accessor,'sourceRoot',{enumerable:true,get(){accessed++;return f.sourceRoot;}});
  for(const opts of [accessor,...['enabled','trusted','accepted','export','shell','runner','pathMapper'].map(k=>({...f.options,[k]:true})),
    {...f.options,baseline:{...f.baseline,provenance:'trusted'}},{...f.options,baseline:{...f.baseline,baselineDigest:'0'.repeat(64)}},
    {...f.options,authority:{readCurrent:async()=>f.authorityOwner.state()}},{...f.options,authority:{readCurrent:()=>null}}]){
    await refuse(async()=>{const owner=createWorkspace(opts);await owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()});});
  }
  assert.equal(accessed,0);assert.deepEqual(await sentinels(f),before);assert.equal(await exists(f.workspaceRoot),false);
  const options={...f.options,protectedFiles:[]},owner=createWorkspace(options);f.own(()=>owner.close());
  options.protectedFiles.push('a.txt');options.sourceRoot=f.siblingRoot;options.authority={readCurrent:()=>null};
  const handle=await owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()});
  await workspaceFile(handle,f.actor,replacement());assert.deepEqual(await fs.readFile(path.join(f.sourceRoot,'a.txt')),Buffer.from('alpha\r\n'));
});

test('M2-01 closed operation descriptors reject accessors, widening metadata, NUL and unpaired surrogates unchanged',async t=>{
  const f=await setup(t);let accessed=0;
  const getter={...replacement()};Object.defineProperty(getter,'text',{enumerable:true,get(){accessed++;return 'bad';}});
  for(const request of [getter,...['trusted','accepted','state','role','actor','root','generation','authority','replaceAll'].map(k=>({...replacement(),[k]:true})),
    ...['bad\0text','\ud800','\udfff'].map(text=>replacement(text))])await unchanged(f,()=>workspaceFile(f.handle,f.actor,request));
  assert.equal(accessed,0);await successfulReplace(f,'');await successfulReplace(f,'line1\r\nline2\r\n',raw(''));
});

for(const [label,bytes] of [['NUL',Buffer.from([97,0,98])],['invalid UTF8',Buffer.from([0xc3,0x28])]]){
  test(`M2-01 real ${label} baseline refuses while preserving raw source/index/config bytes`,async t=>{
    const f=await m2GitFixture(t,{files:{'a.txt':bytes}});await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
  });
}

for(const [label,mutate] of [
  ['unstaged bytes',f=>fs.writeFile(path.join(f.sourceRoot,'a.txt'),'dirty')],
  ['staged bytes',async f=>{await fs.writeFile(path.join(f.sourceRoot,'a.txt'),'staged');await f.runGit(['add','--','a.txt']);}],
  ['untracked overlay',f=>fs.writeFile(path.join(f.sourceRoot,'overlay.txt'),'untracked')],
  ['ignored extra file',async f=>{await fs.writeFile(path.join(f.sourceRoot,'.git','info','exclude'),'ignored.txt\n');await fs.writeFile(path.join(f.sourceRoot,'ignored.txt'),'ignored');}],
  ['empty extra directory',f=>fs.mkdir(path.join(f.sourceRoot,'unused'))],
  ['dependency directory',async f=>{await fs.mkdir(path.join(f.sourceRoot,'node_modules'));await fs.writeFile(path.join(f.sourceRoot,'node_modules','dependency'),'dependency');}],
])test(`M2-02 ${label} is refused by real Git/disk admission without modifying sentinels`,async t=>{
  const f=await m2GitFixture(t);await mutate(f);await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});

test('M2-02 commit, index and source changes after inspection cannot publish author capability',async t=>{
  for(const kind of ['disk','index','commit'])await t.test(kind,async t=>{
    const f=await setup(t,{begin:false});
    await fs.writeFile(path.join(f.sourceRoot,'a.txt'),'replacement baseline');
    if(kind!=='disk')await f.runGit(['add','--','a.txt']);
    if(kind==='commit')await f.runGit(['-c','user.name=M2 Fixture','-c','user.email=m2@example.invalid','commit','-m','changed baseline']);
    await unchanged(f,()=>f.begin(),{candidate:false});
    assert.equal(await exists(path.join(f.workspaceRoot,'working')),false);
  });
});

for(const [label,file,content] of [
  ['shallow','.git/shallow','1'.repeat(40)+'\n'],['commondir','.git/commondir','../foreign\n'],
  ['grafts','.git/info/grafts','1'.repeat(40)+'\n'],['alternates','.git/objects/info/alternates','../outside\n'],
  ['http alternates','.git/objects/info/http-alternates','https://invalid.example/objects\n'],
  ['worktree config','.git/config.worktree','[core]\n bare=false\n'],
  ['replacement ref','.git/refs/replace/'+'1'.repeat(40),'2'.repeat(40)+'\n']
])test(`M2-03 unsupported ${label} metadata refuses without helper/network effects`,async t=>{
  const f=await m2GitFixture(t),target=path.join(f.sourceRoot,...file.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content);
  await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});

for(const extra of ['[include]\n path=../outside.config\n','[filter "evil"]\n clean=echo escaped\n','[remote "origin"]\n url=https://invalid.example/repo\n','[extensions]\n partialClone=origin\n','[core]\n fsmonitor=evil-command\n','[core]\n sparseCheckout=true\n']){
  test(`M2-03 config ${extra.split('\n')[0]} is rejected before executing helpers`,async t=>{
    const f=await m2GitFixture(t);await fs.appendFile(path.join(f.sourceRoot,'.git','config'),extra);
    await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
  });
}

test('M2-03 actual Git nonzero exit refuses admission and records settled exit rather than fallback',async t=>{
  const f=await m2GitFixture(t);await fs.writeFile(path.join(f.sourceRoot,'.git','HEAD'),'ref: refs/heads/missing\n');
  const exits=[];await unchanged(f,()=>inspectBaseline(baselineOptions(f,{failpoint:async(name,c)=>{if(name==='git.exit')exits.push(c);}})),{candidate:false});
  assert.ok(exits.some(c=>c.code!==0&&c.signal===null),'must observe a real nonzero Git exit');
});

test('M2-03 missing object, unavailable/pin-mismatched executable and unknown git options have no fallback',async t=>{
  const f=await m2GitFixture(t);
  for(const git of [{...f.git,executable:path.join(f.root,'missing-git.exe')},{...f.git,sha256:'0'.repeat(64)},{...f.git,version:'git version impossible'}, {...f.git,argv:['--help']}])
    await unchanged(f,()=>inspectBaseline(baselineOptions(f,{git})),{candidate:false});
  const good=await inspectBaseline(baselineOptions(f));
  const object=path.join(f.sourceRoot,'.git','objects',good.commit.slice(0,2),good.commit.slice(2));
  await fs.unlink(object);await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});

for(const count of [256,257])test(`M2-01 present-file bound ${count===256?'exact 256 passes':'257 refuses without truncation'}`,async t=>{
  const files=Object.fromEntries(Array.from({length:count},(_,i)=>[`f${String(i).padStart(3,'0')}.txt`,'x']));
  const f=await m2GitFixture(t,{files});
  if(count===256){const result=await inspectBaseline(baselineOptions(f));assert.equal(result.files.length,256);assert.equal(result.files.at(-1).path,'f255.txt');}
  else await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});
const longPath=length=>['a'.repeat(127),'b'.repeat(127),'c'.repeat(127),'d'.repeat(length-384)].join('/');
for(const [label,p,valid] of [
  ['depth16',Array(15).fill('d').concat('a.txt').join('/'),true],['depth17',Array(16).fill('d').concat('a.txt').join('/'),false],
  ['path512',longPath(512),true],['path513',longPath(513),false]
])test(`M2-01/M2-08 ${label} real filesystem bound ${valid?'passes':'refuses'}`,async t=>{
  const f=await m2GitFixture(t,{files:{[p]:'x'}});
  if(valid){const result=await inspectBaseline(baselineOptions(f));assert.equal(result.files[0].path,p);}
  else await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});
for(const bytes of [MiB,MiB+1])test(`M2-01 raw per-file baseline bound ${bytes} bytes`,async t=>{
  const f=await m2GitFixture(t,{files:{'a.txt':'x'.repeat(bytes)}});
  if(bytes===MiB){const result=await inspectBaseline(baselineOptions(f));assert.equal(result.files[0].bytes,MiB);}
  else await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});
for(const extra of [0,1])test(`M2-01 total baseline byte bound 16MiB${extra?'+1 refusal':' exact counterpart'}`,async t=>{
  const files=Object.fromEntries(Array.from({length:16},(_,i)=>[`f${i}.txt`,'x'.repeat(MiB)]));if(extra)files['extra.txt']='x';
  const f=await m2GitFixture(t,{files});
  if(!extra){const result=await inspectBaseline(baselineOptions(f));assert.equal(result.files.reduce((n,r)=>n+r.bytes,0),16*MiB);}
  else await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});

test('M2-01 create/replace use raw 1MiB text bounds separately from escaped metadata',async t=>{
  const f=await setup(t,{grants:[entry('a.txt','replace','alpha\r\n'),entry('new.txt','create')]});
  const text='\n'.repeat(MiB);
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,replacement(text+'x')));
  await successfulReplace(f,text);
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,{operation:'create',path:'new.txt',expectedHash:null,text:text+'x'}));
  const result=await workspaceFile(f.handle,f.actor,{operation:'create',path:'new.txt',expectedHash:null,text});
  assert.equal(result.bytes,MiB);assert.deepEqual(await read(f,'new.txt'),Buffer.from(text));
});

test('M2-01 bounded literal edit and read slices have exact16KiB and max+1 controls',async t=>{
  const old='x'.repeat(16*KiB),next='y'.repeat(16*KiB),f=await setup(t,{files:{'a.txt':old+'!','test.mjs':'// test\n'},grants:[entry('a.txt','edit',old+'!')]});
  const good={operation:'edit',path:'a.txt',expectedHash:raw(old+'!'),oldText:old,newText:next};
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,{...good,oldText:old+'x'}));
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,{...good,newText:next+'x'}));
  const result=await workspaceFile(f.handle,f.actor,good);assert.equal(result.sha256,raw(next+'!'));
  const slice=await workspaceFile(f.handle,f.actor,{operation:'read',path:'a.txt',offset:0,limit:16*KiB});assert.equal(slice.text,next);assert.equal(slice.nextOffset,16*KiB);
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,{operation:'read',path:'a.txt',offset:0,limit:16*KiB+1}));
});

test('M2-01 UTF8 byte-slice boundaries refuse loss rather than replacement characters',async t=>{
  const f=await setup(t,{files:{'a.txt':'é🙂z','test.mjs':'// test\n'}});
  const good=await workspaceFile(f.handle,f.actor,{operation:'read',path:'a.txt',offset:0,limit:2});assert.equal(good.text,'é');assert.equal(good.nextOffset,2);
  for(const request of [{offset:1,limit:2},{offset:2,limit:1},{offset:-1,limit:1},{offset:0,limit:1.5}])await unchanged(f,()=>workspaceFile(f.handle,f.actor,{operation:'read',path:'a.txt',...request}));
});

for(const phase of ['EMPTY','PLANNING','AWAITING_HUMAN','PLAN_AUTHORIZED','REJECTED'])test(`M2-06 ${phase} real store cannot materialize without accepted plan AND durable author reservation`,async t=>{
  const f=await setup(t,{phase,begin:false});
  await unchanged(f,()=>f.begin(),{candidate:false});assert.equal(await exists(f.workspaceRoot),false);
});

test('M2-06 wrong assignment/provider/actor and malformed settlement refuse before ownership',async t=>{
  const f=await setup(t,{begin:false});
  for(const extra of [{assignmentId:'foreign'},{assignmentId:f.authorityOwner.state().assignments[0].id},{actor:actor('foreign','author')},
    {actor:actor(f.actor.id,'wrong-provider')},{execution:null},{disposed:null},{accepted:true}]){
    const refusedOwner=createWorkspace(f.options);f.own(()=>refusedOwner.close());
    await unchanged(f,()=>refusedOwner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve(),...extra}),{candidate:false});assert.equal(await exists(f.workspaceRoot),false);
  }
  f.handle=await f.begin();await successfulReplace(f);assert.equal(f.authorityOwner.state().attempts.length,1);
});

test('M2-07 opaque author and exact actor identities exclude owner, copies, reviewer and foreign handles',async t=>{
  const f=await setup(t);
  for(const handle of [{},copy(f.handle),Object.assign({},f.handle),f.owner])await unchanged(f,()=>workspaceFile(handle,f.actor,replacement()));
  for(const who of [{...f.actor},actor('reviewer'),actor('validator')])await unchanged(f,()=>workspaceFile(f.handle,who,replacement()));
  await successfulReplace(f);
});

test('M2-01/M2-07 deeply frozen malformed authority over descriptor depth budget refuses before candidate allocation',async t=>{
  const f=await setup(t,{begin:false});let nested=Object.freeze({leaf:true});for(let i=0;i<32;i++)nested=Object.freeze({next:nested});
  const authority={readCurrent:()=>Object.freeze({...f.authorityOwner.state(),extra:nested})};
  const owner=createWorkspace({...f.options,authority});f.own(()=>owner.close());
  await unchanged(f,()=>owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()}),{candidate:false});assert.equal(await exists(f.workspaceRoot),false);
});

test('M2-07 final synchronous authority callback cannot reenter and revoke immediately before a write submission',async t=>{
  let owner,armed=false,checks=0;
  const f=await setup(t,{begin:false});
  const authority={readCurrent(){checks++;if(armed)owner.revoke();return f.authorityOwner.authority.readCurrent();}};
  const options={...f.options,authority,failpoint:async name=>{if(name==='mutation.open.before')armed=true;}};
  owner=createWorkspace(options);f.own(()=>owner.close());
  const handle=await owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()});
  const beforeChecks=checks;await unchanged(f,()=>workspaceFile(handle,f.actor,replacement()));assert.ok(checks>beforeChecks);assert.equal(armed,true);
  assert.deepEqual(await fs.readdir(path.join(f.workspaceRoot,'control')),[],'revocation must prevent staging-file open');
});

test('M2-07 delayed real request cannot inherit authority after synchronous adapter invalidation',async t=>{
  const f=await setup(t),release=m1Deferred();t.after(()=>release.resolve());
  const before=await inventory(path.join(f.workspaceRoot,'working'));
  const delayed=(async()=>{await release.promise;return workspaceFile(f.handle,f.actor,replacement());})();
  f.authorityOwner.invalidate();assert.equal(f.authorityOwner.authority.readCurrent(),null);release.resolve();await refuse(()=>delayed);
  assert.deepEqual(await inventory(path.join(f.workspaceRoot,'working')),before);f.owner.revoke();
});

test('M2-07 captured readCurrent rejects malformed/mutable/async snapshots and synchronous reentrant revoke',async t=>{
  for(const kind of ['mutable','async','throw','reentrant','revision','generation','plan','provenance'])await t.test(kind,async t=>{
    const f=await setup(t,{begin:false}),state=f.authorityOwner.state();let revoke=false,owner;
    const authority={readCurrent(){
      if(revoke){
        if(kind==='mutable')return copy(state);
        if(kind==='async')return Promise.resolve(state);
        if(kind==='throw')throw new Error('fixture read failure');
        if(kind==='reentrant'){owner.revoke();return state;}
        if(kind==='revision')return ownedJson({...state,revision:state.revision+1});
        if(kind==='generation')return ownedJson({...state,generation:state.generation+1});
        if(kind==='plan')return ownedJson({...state,plan:{...state.plan,objective:'different authority'}});
        if(kind==='provenance')return ownedJson({...state,provenance:'trusted'});
      }
      return f.authorityOwner.authority.readCurrent();
    }};
    owner=createWorkspace({...f.options,authority});f.own(()=>owner.close());
    const handle=await owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()});
    revoke=true;await unchanged(f,()=>workspaceFile(handle,f.actor,replacement()));
  });
});

for(const p of ['../control/manifest.json','../sealed/a.txt','../sibling/sentinel.txt','/absolute','C:/absolute','C:relative','//server/share','\\\\server\\share','a.txt:stream','CON','NUL.txt','COM1.txt','a\\b','a/../b','./a.txt','a//b','a./b','a /b','é.txt','A.txt','a.txt/child','.git/config','node_modules/x','control/x','sealed/x'])
  test(`M2-08 actual file entry refuses path ${JSON.stringify(p)} without touching sentinels`,async t=>{
    const f=await setup(t);await unchanged(f,()=>workspaceFile(f.handle,f.actor,replacement('escape',raw('alpha\r\n'),p)));await successfulReplace(f);
  });

test('M2-08 component-case collisions and directory/file prefix grants cannot create alternate namespaces',async t=>{
  for(const grants of [[entry('Dir/a','create'),entry('dir/b','create')],[entry('new','create'),entry('new/child','create')]])await t.test(grants.map(g=>g.path).join(','),async t=>{
    const f=await setup(t,{grants,begin:false});await unchanged(f,()=>f.begin(),{candidate:false});assert.equal(await exists(path.join(f.workspaceRoot,'working')),false);
  });
});

for(const alias of ['file symlink','directory junction','hardlink'])test(`M2-08 real ${alias} target refuses actual mutation; independent ordinary-file counterpart passes`,async t=>{
  const f=await setup(t,{files:{'dir/a.txt':'alpha\r\n','a.txt':'alpha\r\n','test.mjs':'// test\n'},grants:[entry('dir/a.txt','replace','alpha\r\n'),entry('a.txt','replace','alpha\r\n')]});
  await successfulReplace(f);
  const target=path.join(f.siblingRoot,'alias-sentinel.txt');await fs.writeFile(target,'outside untouched');
  if(alias==='directory junction'){
    await fs.rm(path.join(f.workspaceRoot,'working','dir'),{recursive:true});
    await fs.symlink(f.siblingRoot,path.join(f.workspaceRoot,'working','dir'),process.platform==='win32'?'junction':'dir');
  }else{
    await fs.unlink(disk(f,'dir/a.txt'));
    if(alias==='hardlink')await fs.link(target,disk(f,'dir/a.txt'));else await fs.symlink(target,disk(f,'dir/a.txt'),'file');
  }
  assert.equal(alias==='hardlink'?(await fs.stat(target)).nlink: (await fs.lstat(alias==='directory junction'?path.join(f.workspaceRoot,'working','dir'):disk(f,'dir/a.txt'))).isSymbolicLink(),alias==='hardlink'?2:true);
  f.expectCloseFailure();await unchanged(f,()=>workspaceFile(f.handle,f.actor,replacement('escape',raw('alpha\r\n'),'dir/a.txt')));
  assert.equal(await fs.readFile(target,'utf8'),'outside untouched');
  t.diagnostic(`actual ${alias} created and refused on ${process.platform}/${process.version}`);
});

for(const grant of [entry('a.txt','create'),entry('a.txt','replace','wrong baseline'),entry('missing.txt','delete','absent')])test(`M2-06/M2-09 approved ${grant.operation} ${grant.path} cannot override exact baseline presence/hash`,async t=>{
  const f=await setup(t,{grants:[grant],begin:false});await unchanged(f,()=>f.begin(),{candidate:false});assert.equal(await exists(path.join(f.workspaceRoot,'working')),false);
});

test('M2-09 exact create/replace/edit/delete grants and cursor receipts have real byte counterparts',async t=>{
  const files={'a.txt':'alpha\r\n','edit.txt':'left UNIQUE right','delete.txt':'remove me','test.mjs':'// test\n'};
  const grants=[entry('a.txt','replace',files['a.txt']),entry('edit.txt','edit',files['edit.txt']),entry('delete.txt','delete',files['delete.txt']),entry('new.txt','create')];
  const f=await setup(t,{files,grants}),before=await sentinels(f);
  const bad=[{operation:'delete',path:'edit.txt',expectedHash:raw(files['edit.txt'])},{operation:'replace',path:'new.txt',expectedHash:null,text:'bad'},
    {operation:'create',path:'a.txt',expectedHash:null,text:'overwrite'},replacement('bad','0'.repeat(64)),
    ...['rename','chmod','link','mkdir','directory','export'].map(operation=>({operation,path:'a.txt',expectedHash:raw(files['a.txt'])})),
    replacement('unlisted',raw(files['test.mjs']),'test.mjs')];
  for(const request of bad)await unchanged(f,()=>workspaceFile(f.handle,f.actor,request));
  const replaced=await successfulReplace(f);await successfulReplace(f,'next',replaced.sha256);
  let hash=raw(files['edit.txt']);
  for(const [oldText,newText] of [['UNIQUE','first'],['first','second']]){
    const receipt=await workspaceFile(f.handle,f.actor,{operation:'edit',path:'edit.txt',expectedHash:hash,oldText,newText});hash=receipt.sha256;
  }
  assert.equal(await fs.readFile(disk(f,'edit.txt'),'utf8'),'left second right');
  await workspaceFile(f.handle,f.actor,{operation:'create',path:'new.txt',expectedHash:null,text:''});assert.equal((await read(f,'new.txt')).length,0);
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,{operation:'create',path:'new.txt',expectedHash:null,text:'again'}));
  await workspaceFile(f.handle,f.actor,{operation:'delete',path:'delete.txt',expectedHash:raw(files['delete.txt'])});assert.equal(await exists(disk(f,'delete.txt')),false);
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,{operation:'delete',path:'delete.txt',expectedHash:raw(files['delete.txt'])}));
  assert.deepEqual(await sentinels(f),before);
});

test('M2-09 literal edit rejects absent/ambiguous/empty matches and stale hashes without moving cursor',async t=>{
  const f=await setup(t,{files:{'a.txt':'same same UNIQUE','test.mjs':'// test\n'},grants:[entry('a.txt','edit','same same UNIQUE')]});
  const good={operation:'edit',path:'a.txt',expectedHash:raw('same same UNIQUE'),oldText:'UNIQUE',newText:'new'};
  for(const patch of [{oldText:''},{oldText:'missing'},{oldText:'same'},{oldText:/UNIQUE/},{expectedHash:raw('stale')},{replaceAll:true}])await unchanged(f,()=>workspaceFile(f.handle,f.actor,{...good,...patch}));
  await workspaceFile(f.handle,f.actor,good);assert.equal(await fs.readFile(disk(f,'a.txt'),'utf8'),'same same new');
});

for(const kind of ['protectedTests','protectedFiles','.git','dependency'])test(`M2-10 ${kind} cannot be waived by plan.files`,async t=>{
  const p=kind==='protectedTests'?'test.mjs':kind==='protectedFiles'?'a.txt':kind==='.git'?'.git/config':'node_modules/a.txt';
  const grants=[entry(p,p==='test.mjs'||p==='a.txt'?'replace':'create',p==='test.mjs'?'// fixture test\n':'alpha\r\n')];
  const f=await setup(t,{grants,protectedFiles:kind==='protectedFiles'?['a.txt']:[],begin:false});
  await unchanged(f,()=>f.begin(),{candidate:false});assert.equal(await exists(path.join(f.workspaceRoot,'working')),false);
});

test('M2-10 explicitly granted nonprotected regression test can change while acceptance test/config remain unchanged',async t=>{
  const f=await setup(t,{files:{'a.txt':'alpha\r\n','test.mjs':'// acceptance\n','regression.test.mjs':'// old regression\n','project.json':'{}\n'},
    grants:[entry('regression.test.mjs','replace','// old regression\n')]});
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,replacement('// weakened',raw('// acceptance\n'),'test.mjs')));
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,replacement('{}',raw('{}\n'),'project.json')));
  await successfulReplace(f,'// stronger regression\n',raw('// old regression\n'),'regression.test.mjs');
});

test('M2-11 concurrent same-prehash replacements acknowledge exactly one and preserve source',async t=>{
  const f=await setup(t),before=await sentinels(f);
  const results=await Promise.allSettled([workspaceFile(f.handle,f.actor,replacement('first')),workspaceFile(f.handle,f.actor,replacement('second'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const successful=results.find(r=>r.status==='fulfilled').value;assert.equal(raw(await read(f)),successful.sha256);
  assert.deepEqual(await sentinels(f),before);
});

test('M2-11 queue admits exactly64 concurrent operations and refuses65 without hidden retry',async t=>{
  const gate=barrier(t,'mutation.write.before'),grants=Array.from({length:64},(_,i)=>entry(`new${i}.txt`,'create'));
  const f=await setup(t,{grants,failpoint:gate.hook});gate.arm();
  const pending=[workspaceFile(f.handle,f.actor,{operation:'create',path:'new0.txt',expectedHash:null,text:'0'})];pending[0].catch(()=>{});
  await gate.entered;
  for(let i=1;i<64;i++){const p=workspaceFile(f.handle,f.actor,{operation:'create',path:`new${i}.txt`,expectedHash:null,text:String(i)});p.catch(()=>{});pending.push(p);}
  await refuse(()=>workspaceFile(f.handle,f.actor,{operation:'read',path:'a.txt',offset:0,limit:1}));
  gate.release();const results=await Promise.all(pending);assert.equal(results.length,64);
  for(let i=0;i<64;i++)assert.equal(await fs.readFile(disk(f,`new${i}.txt`),'utf8'),String(i));
  assert.equal((await workspaceFile(f.handle,f.actor,{operation:'read',path:'a.txt',offset:0,limit:1})).text,'a');
});

test('M2-11 acknowledged-mutation bound permits4096 and refuses4097 with retained exact bytes',async t=>{
  const f=await setup(t,{files:{'a.txt':'0','test.mjs':'// test\n'}});let hash=raw('0');
  for(let i=0;i<4096;i++){
    const text=i%2?'0':'1',receipt=await workspaceFile(f.handle,f.actor,replacement(text,hash));
    assert.equal(receipt.sha256,raw(text));hash=receipt.sha256;
  }
  assert.equal(await fs.readFile(disk(f,'a.txt'),'utf8'),'0');
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,replacement('1',hash)));
  assert.equal((await f.owner.seal()).descriptor.provenance,PROVENANCE);
});

for(const [name,patch] of [
  ['workspace below source',f=>({workspaceRoot:path.join(f.sourceRoot,'candidate')})],
  ['workspace contains source',f=>({workspaceRoot:f.root})],
  ['scratch below workspace',f=>({scratchRoot:path.join(f.workspaceRoot,'scratch')})],
  ['protected root contains workspace',f=>({protectedRoots:[f.root]})],
  ['source is protected root',f=>({protectedRoots:[f.sourceRoot]})],
  ['governance same workspace',f=>({workspaceRoot:f.governanceRoot})],
  ['filesystem root',f=>({workspaceRoot:path.parse(f.root).root})],
  ['relative root',()=>({workspaceRoot:'candidate'})],
  ['sibling target',f=>({workspaceRoot:f.siblingRoot})]
])test(`M2-04 canonical root refusal: ${name}; no retained foreign bytes overwritten`,async t=>{
  const f=await setup(t,{begin:false});
  await unchanged(f,async()=>{
    const owner=createWorkspace({...f.options,...patch(f)});
    await owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()});
  },{candidate:false});
});

for(const placement of ['root','ancestor'])test(`M2-04 real junction/symlink ${placement} component cannot alias an owner root`,async t=>{
  const f=await setup(t,{begin:false}),alias=path.join(f.root,'alias');
  await fs.symlink(f.siblingRoot,alias,process.platform==='win32'?'junction':'dir');
  const options={...f.options,workspaceRoot:placement==='root'?alias:path.join(alias,'nested')};
  await unchanged(f,async()=>{const owner=createWorkspace(options);await owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()});},{candidate:false});
});

test('M2-04 preexisting empty designated root is diagnostic-only and never reclaimed as a new attempt',async t=>{
  const f=await setup(t,{begin:false});await fs.mkdir(f.workspaceRoot);
  await unchanged(f,()=>f.begin(),{candidate:false});assert.deepEqual(await fs.readdir(f.workspaceRoot),[]);
});

for(const lock of ['',JSON.stringify({pid:0,owner:'foreign',jobId:'dead'})])test(`M2-04 existing ${lock?'foreign/dead':'empty'} lock is never reclaimed`,async t=>{
  const f=await setup(t,{begin:false});await fs.mkdir(f.workspaceRoot);await fs.writeFile(path.join(f.workspaceRoot,'lock.json'),lock);
  const before=await inventory(f.workspaceRoot);await unchanged(f,()=>f.begin(),{candidate:false});assert.deepEqual(await inventory(f.workspaceRoot),before);
});

test('M2-04 two real Node processes contend on one designated workspace with exactly one owner',async t=>{
  const f=await m2GitFixture(t),markers=['left','right'].map(n=>path.join(f.root,n));
  const ready=markers.map(m=>m1WaitMarker(m+'.ready'));
  const children=await Promise.all(markers.map((marker,i)=>m2SpawnWorkspaceChild(f,{mode:'lock',marker,suffix:'owner'+i})));
  try{
    const outcomes=await Promise.all(ready);assert.equal(outcomes.filter(x=>x==='HELD').length,1);
    assert.equal(outcomes.filter(x=>/^REFUSED:(WORKSPACE_EXISTS|LOCKED|RECONCILIATION_REQUIRED|ROOT_NOT_EMPTY)$/.test(x)).length,1,outcomes.join(', '));
    const before=await fs.readFile(path.join(f.sourceRoot,'a.txt'));
    for(const marker of markers)await m1Marker(marker+'.release');
    for(const child of children){const result=await child.done;assert.equal(result.signal,null);assert.equal(result.code,0);}
    assert.deepEqual(await fs.readFile(path.join(f.sourceRoot,'a.txt')),before);
  }finally{await Promise.all(children.map(c=>c.dispose()));}
});

for(const point of ['materialize.open.before','materialize.write.after','materialize.sync.before','materialize.close.after'])test(`M2-05 materialization fault at ${point} retains unusable root and returns no author handle`,async t=>{
  let fired=false;const f=await setup(t,{begin:false,failpoint:async name=>{if(name===point&&!fired){fired=true;throw Object.assign(new Error('injected disk fault'),{code:'EIO'});}}});
  f.expectCloseFailure();await unchanged(f,()=>f.begin(),{candidate:false});assert.equal(fired,true);
  assert.equal(await exists(path.join(f.workspaceRoot,'lock.json')),true);
  const retained=await inventory(f.workspaceRoot);
  const next=createWorkspace({...f.options,failpoint:undefined});
  await refuse(()=>next.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()}));
  assert.deepEqual(await inventory(f.workspaceRoot),retained);await refuse(()=>f.owner.seal());
});

for(const point of ['mutation.open.after','mutation.write.after','mutation.sync.before','mutation.close.after','mutation.rename.before','mutation.rename.after','mutation.beforeAck'])test(`M2-11 mutation fault at ${point} never acknowledges uncertain work or silently retries`,async t=>{
  let armed=false,hits=0;const f=await setup(t,{failpoint:async name=>{if(armed&&name===point){hits++;throw Object.assign(new Error('injected disk fault'),{code:'EIO'});}}});
  armed=true;f.expectCloseFailure();const outside=await sentinels(f);
  await refuse(()=>workspaceFile(f.handle,f.actor,replacement()));assert.equal(hits,1,'failed syscall boundary must not retry');
  const retained=await inventory(f.workspaceRoot);await refuse(()=>workspaceFile(f.handle,f.actor,replacement('later')));await refuse(()=>f.owner.seal());
  assert.deepEqual(await inventory(f.workspaceRoot),retained);assert.deepEqual(await sentinels(f),outside);
});

test('M2-11 owner lock replacement after staging poisons mutation and retains evidence',async t=>{
  const gate=barrier(t,'mutation.write.after'),f=await setup(t,{failpoint:gate.hook});gate.arm();f.expectCloseFailure();
  const operation=workspaceFile(f.handle,f.actor,replacement());operation.catch(()=>{});await gate.entered;
  const lock=path.join(f.workspaceRoot,'lock.json');await fs.rename(lock,lock+'.old');await fs.writeFile(lock,'foreign owner');
  const source=await fs.readFile(path.join(f.sourceRoot,'a.txt'));gate.release();await refuse(()=>operation);
  await refuse(()=>workspaceFile(f.handle,f.actor,replacement()));await refuse(()=>f.owner.seal());
  assert.equal(await fs.readFile(lock,'utf8'),'foreign owner');assert.deepEqual(await fs.readFile(path.join(f.sourceRoot,'a.txt')),source);
});

for(const terminal of ['revoke','seal','close'])test(`M2-12 ${terminal} before write submission rejects held mutation and admits no new work`,async t=>{
  const gate=barrier(t,'mutation.open.before'),f=await setup(t,{failpoint:gate.hook});gate.arm();
  const operation=workspaceFile(f.handle,f.actor,replacement());operation.catch(()=>{});await gate.entered;
  let ending;if(terminal==='revoke')f.owner.revoke();else {ending=f.owner[terminal]();ending.catch(()=>{});}
  await refuse(()=>workspaceFile(f.handle,f.actor,replacement('late')));gate.release();await refuse(()=>operation);
  assert.equal(await fs.readFile(disk(f,'a.txt'),'utf8'),'alpha\r\n');
  if(ending)await ending;
});

for(const terminal of ['seal','close'])test(`M2-12 ${terminal} waits submitted I/O and assigned execution plus disposal before terminal acknowledgement`,async t=>{
  const gate=barrier(t,'mutation.write.after'),f=await setup(t,{failpoint:gate.hook,pending:true});gate.arm();f.expectCloseFailure();
  const operation=workspaceFile(f.handle,f.actor,replacement());operation.catch(()=>{});await gate.entered;
  let ended=false;const ending=f.owner[terminal]().finally(()=>{ended=true;});ending.catch(()=>{});
  await Promise.resolve();assert.equal(ended,false);await refuse(()=>workspaceFile(f.handle,f.actor,replacement('late')));
  gate.release();await refuse(()=>operation);assert.equal(ended,false,'execution is still owned');
  f.authorityOwner.execution.resolve('completed');await Promise.resolve();assert.equal(ended,false,'disposal is still owned');
  f.authorityOwner.disposed.resolve();await refuse(()=>ending);assert.equal(ended,true);
  const after=await inventory(f.workspaceRoot);await refuse(()=>workspaceFile(f.handle,f.actor,replacement('after close')));assert.deepEqual(await inventory(f.workspaceRoot),after);
});

test('M2-12 clean seal waits both assigned settlements and synchronously revokes author handle',async t=>{
  const f=await setup(t,{pending:true});await successfulReplace(f);let ended=false;
  const sealing=f.owner.seal().then(value=>{ended=true;return value;});sealing.catch(()=>{});
  await refuse(()=>workspaceFile(f.handle,f.actor,replacement('too late',raw('changed\r\n'))));
  assert.equal(ended,false);f.authorityOwner.execution.resolve('completed');await Promise.resolve();assert.equal(ended,false);
  f.authorityOwner.disposed.resolve();const result=await sealing;assert.equal(result.descriptor.provenance,PROVENANCE);assert.equal(ended,true);
});

test('M2-07/M2-12 real store transition invalidates cache and workspace before durable append begins',async t=>{
  const entered=m1Deferred(),release=m1Deferred();t.after(()=>{entered.resolve();release.resolve();});let armed=false;
  const f=await setup(t,{authorityFailpoint:async(name)=>{if(armed&&name==='event.open'){entered.resolve();await release.promise;}}});
  armed=true;const transition=f.authorityOwner.commit({type:'STOPPED'});transition.catch(()=>{});
  assert.equal(f.authorityOwner.authority.readCurrent(),null);
  await entered.promise;
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,replacement()));
  release.resolve();await transition;assert.equal(f.authorityOwner.state().phase,'STOPPED');
  assert.equal(f.authorityOwner.state().attempts.length,1);await refuse(()=>f.owner.seal());
});

for(const outcome of ['cancelled','error','inconclusive','rejected execution','rejected disposal'])test(`M2-14 author ${outcome} cannot produce successful seal`,async t=>{
  const f=await setup(t,{pending:true});f.expectCloseFailure();
  if(outcome==='rejected execution')f.authorityOwner.execution.reject(new Error('execution failed'));else f.authorityOwner.execution.resolve(outcome==='rejected disposal'?'completed':outcome);
  if(outcome==='rejected disposal')f.authorityOwner.disposed.reject(new Error('disposal failed'));else f.authorityOwner.disposed.resolve();
  await refuse(()=>f.owner.seal());assert.equal(await exists(path.join(f.workspaceRoot,'sealed')),false);
  await refuse(()=>workspaceRead({},actor('reviewer'),{operation:'list',offset:0,limit:128}));
});

for(const drift of ['unchanged bytes','hidden bytes','extra file','extra directory','missing file','file to directory','hardlink'])test(`M2-13 complete seal inventory detects ${drift}, not only scoped edits`,async t=>{
  const f=await setup(t,{files:{'a.txt':'alpha\r\n','unchanged.txt':'untouched','.hidden':'hidden','portable-manifest.json':'{}','test.mjs':'// test\n'}});await successfulReplace(f);
  if(drift==='unchanged bytes')await fs.writeFile(disk(f,'portable-manifest.json'),'changed manifest');
  if(drift==='hidden bytes')await fs.writeFile(disk(f,'.hidden'),'changed hidden');
  if(drift==='extra file')await fs.writeFile(disk(f,'extra.txt'),'unexpected');
  if(drift==='extra directory')await fs.mkdir(disk(f,'extra'));
  if(drift==='missing file')await fs.unlink(disk(f,'unchanged.txt'));
  if(drift==='file to directory'){await fs.unlink(disk(f,'unchanged.txt'));await fs.mkdir(disk(f,'unchanged.txt'));}
  if(drift==='hardlink'){await fs.unlink(disk(f,'unchanged.txt'));await fs.link(disk(f,'a.txt'),disk(f,'unchanged.txt'));}
  f.expectCloseFailure();const before=await sentinels(f);await refuse(()=>f.owner.seal());assert.deepEqual(await sentinels(f),before);
  await refuse(()=>workspaceRead({},actor('reviewer'),{operation:'list',offset:0,limit:128}));
});

test('M2-02 actual index mode change refuses even where native executable bits are not certified',async t=>{
  const f=await m2GitFixture(t);await f.runGit(['update-index','--chmod=+x','--','a.txt']);await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});

test('M2-13 declared Git100755 mode survives independent materialization and appears in identity',async t=>{
  const f=await setup(t,{files:{'a.txt':'alpha\r\n','run.sh':'echo fixture\n','test.mjs':'// test\n'},modes:{'run.sh':'100755'}});
  const result=await f.owner.seal();assert.equal(result.descriptor.files.find(row=>row.path==='run.sh').gitMode,'100755');
  if(process.platform!=='win32')assert.notEqual((await fs.stat(sealed(f,'run.sh'))).mode&0o111,0);
  else t.diagnostic('Windows mode assertion is declared Git identity, not POSIX executable permission certification');
});

for(const point of ['seal.open.before','seal.write.after','seal.sync.before','seal.close.after','seal.hash.before','manifest.write.after','manifest.sync.before','seal.beforeAck'])test(`M2-14 seal fault at ${point} retains nonsealed evidence without retry`,async t=>{
  let armed=false,hits=0;const f=await setup(t,{failpoint:async name=>{if(armed&&name===point){hits++;throw Object.assign(new Error('injected seal fault'),{code:'EIO'});}}});
  await successfulReplace(f);armed=true;f.expectCloseFailure();await refuse(()=>f.owner.seal());assert.equal(hits,1);
  const retained=await inventory(f.workspaceRoot);await refuse(()=>f.owner.seal());await refuse(()=>f.owner.view(actor('reviewer'),'reviewer'));
  assert.deepEqual(await inventory(f.workspaceRoot),retained);
});

test('M2-13/M2-14 full seal identity binds files, deletions, changes and exact plan digests using independent copies',async t=>{
  const files={'a.txt':'alpha\r\n','delete.txt':'deleted','unchanged.txt':'unchanged','.hidden':'hidden','test.mjs':'// test\n'};
  const f=await setup(t,{files,grants:[entry('a.txt','replace',files['a.txt']),entry('delete.txt','delete','deleted'),entry('new.txt','create')]});
  await successfulReplace(f);await workspaceFile(f.handle,f.actor,{operation:'delete',path:'delete.txt',expectedHash:raw('deleted')});
  await workspaceFile(f.handle,f.actor,{operation:'create',path:'new.txt',expectedHash:null,text:'new'});
  const before=await sentinels(f),result=await f.owner.seal(),d=result.descriptor;
  assert.equal(d.provenance,PROVENANCE);assert.equal(d.schemaVersion,1);assert.ok(Object.isFrozen(d));
  assert.deepEqual(d.files.map(r=>r.path),['.hidden','a.txt','new.txt','test.mjs','unchanged.txt']);
  assert.deepEqual(d.deletions.map(r=>r.path),['delete.txt']);assert.deepEqual(d.changes.map(r=>r.path),['a.txt','delete.txt','new.txt']);
  for(const row of d.files){assert.equal(row.sha256,raw(await read(f,row.path)));assert.deepEqual(await fs.readFile(sealed(f,row.path)),await read(f,row.path));
    const working=await fs.stat(disk(f,row.path),{bigint:true}),frozen=await fs.stat(sealed(f,row.path),{bigint:true});assert.equal(frozen.nlink,1n);assert.ok(working.ino!==frozen.ino||working.dev!==frozen.dev);}
  const identity=planIdentity(f.authorityOwner.plan);for(const [key,value]of Object.entries(identity))assert.equal(d[key],value);
  assert.equal(d.baselineDigest,f.baseline.baselineDigest);assert.equal(d.assignmentId,f.assignmentId);assert.equal(d.jobId,f.authorityOwner.plan.jobId);assert.equal(d.projectId,f.authorityOwner.plan.projectId);
  const {candidateDigest,...body}=d;assert.equal(candidateDigest,digest(body));
  assert.deepEqual(ownedJson(d),d);assert.deepEqual(await sentinels(f),before);
  assert.deepEqual(operationalAcceptance(d),{accepted:false,reason:'UNTRUSTED_PROVENANCE',readiness:'inactive'});
});

test('M2-13 exact256 deletion rows survive seal without truncation within unchanged M1 artifact limits',async t=>{
  const files=Object.fromEntries(Array.from({length:256},(_,i)=>[`f${String(i).padStart(3,'0')}.txt`,'x']));
  const grants=Object.keys(files).map(p=>entry(p,'delete','x')),f=await setup(t,{files,grants,protectedTests:[]});
  for(const grant of grants)await workspaceFile(f.handle,f.actor,{operation:'delete',path:grant.path,expectedHash:grant.expectedHash});
  const result=await f.owner.seal();assert.equal(result.descriptor.files.length,0);assert.equal(result.descriptor.deletions.length,256);assert.equal(result.descriptor.changes.length,256);
  assert.deepEqual(result.descriptor.deletions.map(r=>r.path),Object.keys(files).sort());assert.deepEqual(ownedJson(result.descriptor),result.descriptor);
});

test('M2-01/M2-13 worst-length512 paths retain all256 baseline/descriptor rows within unchanged ownedJson ceilings',async t=>{
  const prefix=['a'.repeat(127),'b'.repeat(127),'c'.repeat(127)].join('/');
  const files=Object.fromEntries(Array.from({length:256},(_,i)=>[prefix+'/'+String(i).padStart(3,'0')+'d'.repeat(125),'x']));
  assert.ok(Object.keys(files).every(p=>p.length===512));
  const f=await setup(t,{files,protectedTests:[],grants:[]}),result=await f.owner.seal();
  assert.equal(result.descriptor.files.length,256);assert.deepEqual(result.descriptor.files.map(r=>r.path),Object.keys(files).sort());assert.deepEqual(ownedJson(result.descriptor),result.descriptor);
  const reviewer=actor('reviewer'),view=f.owner.view(reviewer,'reviewer');
  const first=await workspaceRead(view,reviewer,{operation:'list',offset:0,limit:128}),second=await workspaceRead(view,reviewer,{operation:'list',offset:128,limit:128});
  assert.equal(first.rows.length,128);assert.equal(second.rows.length,128);assert.deepEqual([...first.rows,...second.rows],result.descriptor.files);
});

test('M2-15 role-bound views list/read complete seal and reject forged handles, actors, paths and writes',async t=>{
  const f=await setup(t);await successfulReplace(f);const result=await f.owner.seal(),reviewer=actor('reviewer'),validator=actor('validator','validator-provider');
  const rv=f.owner.view(reviewer,'reviewer'),vv=f.owner.view(validator,'validator');
  const rows=await workspaceRead(rv,reviewer,{operation:'list',offset:0,limit:128});
  assert.equal(rows.provenance,PROVENANCE);assert.deepEqual(rows.rows,result.descriptor.files);assert.equal(rows.total,result.descriptor.files.length);
  const r=await workspaceRead(vv,validator,{operation:'read',path:'a.txt',offset:0,limit:16*KiB});assert.equal(r.text,'changed\r\n');assert.equal(r.sha256,raw('changed\r\n'));
  const mutableRequest={operation:'read',path:'a.txt',offset:0,limit:16};
  const captured=workspaceRead(rv,reviewer,mutableRequest);mutableRequest.path='../control/manifest.json';mutableRequest.limit=MiB;
  assert.equal((await captured).text,'changed\r\n','view request must be owned before asynchronous execution');
  let getterCalls=0;const getter={operation:'read',offset:0,limit:16};Object.defineProperty(getter,'path',{enumerable:true,get(){getterCalls++;return 'a.txt';}});
  await unchanged(f,()=>workspaceRead(rv,reviewer,getter));assert.equal(getterCalls,0);
  assert.equal((await workspaceRead(rv,reviewer,{operation:'read',path:'a.txt',offset:0,limit:16})).text,'changed\r\n');
  for(const [handle,who] of [[{},reviewer],[copy(rv),reviewer],[result.handle,reviewer],[f.handle,reviewer],[rv,{...reviewer}],[rv,validator],[vv,reviewer]])await unchanged(f,()=>workspaceRead(handle,who,{operation:'read',path:'a.txt',offset:0,limit:10}));
  for(const request of [{operation:'list',offset:0,limit:129},{operation:'changes',offset:0,limit:129},{operation:'read',path:'../working/a.txt',offset:0,limit:10},{operation:'read',path:'a.txt',offset:0,limit:16*KiB+1},replacement('write through review'),{operation:'list',offset:0,limit:1,seal:result.handle}])await unchanged(f,()=>workspaceRead(rv,reviewer,request));
  await refuse(()=>f.owner.view(f.actor,'reviewer'));await refuse(()=>f.owner.view(reviewer,'validator'));await refuse(()=>f.owner.view(actor('other'),'author'));
  await unchanged(f,()=>workspaceFile(rv,reviewer,replacement()));
  f.owner.revoke();await refuse(()=>workspaceRead(rv,reviewer,{operation:'list',offset:0,limit:128}));
});

test('M2-15 sealed file tampering invalidates view without falling back to working/source bytes',async t=>{
  const f=await setup(t);await successfulReplace(f);await f.owner.seal();const reviewer=actor('reviewer'),view=f.owner.view(reviewer,'reviewer');
  await fs.writeFile(sealed(f,'a.txt'),'tampered');f.expectCloseFailure();const before=await sentinels(f);
  await refuse(()=>workspaceRead(view,reviewer,{operation:'read',path:'a.txt',offset:0,limit:16*KiB}));
  assert.equal(await fs.readFile(sealed(f,'a.txt'),'utf8'),'tampered');assert.equal(await fs.readFile(disk(f,'a.txt'),'utf8'),'changed\r\n');assert.deepEqual(await sentinels(f),before);
});

test('M2-16 clean close is idempotent; retained candidate cannot reopen or refund real M1 durable attempt',async t=>{
  const f=await setup(t);await successfulReplace(f);await f.owner.close();await f.owner.close();
  const retained=await inventory(f.workspaceRoot),next=createWorkspace(f.options);
  await refuse(()=>next.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()}));
  await refuse(()=>workspaceFile(f.handle,f.actor,replacement()));assert.deepEqual(await inventory(f.workspaceRoot),retained);
  const before=f.authorityOwner.state().attempts.length;await f.authorityOwner.close();
  const reopened=await openGovernanceStore(f.authorityOwner.storeOptions);f.own(()=>reopened.close());
  const controller=createGovernanceController({store:reopened,lifecycle:{observe(){throw new Error('M2 must not dispatch');}}});f.own(()=>controller.close());
  const status=await controller.status(f.authorityOwner.plan.jobId);assert.equal(status.attemptsUsed,before);assert.equal(status.attemptsUsed,1);assert.equal(status.readiness,'inactive');
  for(const operation of ['author','correction','export','accept'])assert.throws(()=>controller.request(operation),{code:'INACTIVE_PREREQUISITES'});
  assert.equal(f.authorityOwner.authority.readCurrent(),null);
});

for(const point of ['root.mkdir.after','materialize.write.after','mutation.write.after'])test(`M2-16 real child crash at ${point} retains partial root and refuses replacement handles`,async t=>{
  const f=await m2GitFixture(t),marker=path.join(f.root,'crash'),ready=m1WaitMarker(marker+'.ready');
  const child=await m2SpawnWorkspaceChild(f,{mode:'crash',marker,crashPoint:point});
  try{
    assert.equal(await ready,point);await m1Marker(marker+'.release');const result=await child.done;assert.equal(result.signal,null);assert.equal(result.code,73);
    const retained=await inventory(f.workspaceRoot);
    if(point==='root.mkdir.after'){assert.deepEqual(retained,[]);assert.equal(await exists(path.join(f.workspaceRoot,'lock.json')),false);}
    else assert.ok(retained.some(r=>r.path==='lock.json'));
    const baseline=await inspectBaseline(baselineOptions(f)),a=await m2AuthorityOwner(f,baseline);a.execution.resolve('completed');a.disposed.resolve();
    const owner=createWorkspace(workspaceOptions(f,baseline,a.authority));
    await refuse(()=>owner.beginAttempt({actor:a.actor,assignmentId:a.assignmentId,execution:a.execution.promise,disposed:a.disposed.promise}));
    assert.deepEqual(await inventory(f.workspaceRoot),retained);assert.equal(await fs.readFile(path.join(f.sourceRoot,'a.txt'),'utf8'),'alpha\r\n');
  }finally{await child.dispose();}
});

test('M2-02 source index mutation at final beforePublish barrier cannot mint author capability',async t=>{
  let fired=false;let sourceRoot;
  const f=await setup(t,{begin:false,failpoint:async name=>{if(name==='begin.beforePublish'){fired=true;await fs.appendFile(path.join(sourceRoot,'.git','index'),'drift');}}});sourceRoot=f.sourceRoot;f.expectCloseFailure();
  const source=await fs.readFile(path.join(f.sourceRoot,'a.txt'));await refuse(()=>f.begin());assert.equal(fired,true);
  assert.deepEqual(await fs.readFile(path.join(f.sourceRoot,'a.txt')),source);assert.equal((await fs.readFile(path.join(f.sourceRoot,'.git','index'))).subarray(-5).toString(),'drift');
  await refuse(()=>f.owner.seal());assert.equal(await exists(path.join(f.workspaceRoot,'lock.json')),true);
});

for(const alias of ['symlink','hardlink'])test(`M2-08 source ${alias} is refused during actual baseline admission without copying outside bytes`,async t=>{
  const f=await m2GitFixture(t),outside=path.join(f.siblingRoot,'linked-source');await fs.writeFile(outside,'alpha\r\n');
  await fs.unlink(path.join(f.sourceRoot,'a.txt'));
  if(alias==='symlink')await fs.symlink(outside,path.join(f.sourceRoot,'a.txt'),'file');else await fs.link(outside,path.join(f.sourceRoot,'a.txt'));
  await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});assert.equal(await fs.readFile(outside,'utf8'),'alpha\r\n');
});

test('M2-03 actual collector uses pinned executable, fixed plumbing, owned captures and constructed environment',async t=>{
  const f=await m2GitFixture(t),calls=[],exits=[];
  const baseline=await inspectBaseline(baselineOptions(f,{failpoint:async(name,context)=>{
    if(name==='git.spawn.before')calls.push(context);
    if(name==='git.exit')exits.push(context);
  }}));
  assert.ok(calls.length>=5);assert.equal(exits.length,calls.length);
  const commands=new Set();
  for(const c of calls){
    assert.equal(c.executable,f.git.executable);assert.equal(c.cwd,f.sourceRoot);assert.ok(Object.isFrozen(c));
    assert.deepEqual(c.argv.slice(0,3),['-c','core.fsmonitor=false','-c']);assert.match(c.argv[3],/^core\.hooksPath=/);
    assert.deepEqual(c.argv.slice(4,6),['-c','protocol.allow=never']);
    const args=c.argv.slice(6);commands.add(args.join(' '));
    assert.ok([
      '--version','rev-parse --show-object-format','rev-parse --verify HEAD^{commit}',
      'ls-tree -r -z -l --full-tree '+baseline.commit,'ls-files --stage -z'
    ].includes(args.join(' ')),args.join(' '));
    const keys=['HOME','USERPROFILE','TMP','TEMP','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','GIT_NO_REPLACE_OBJECTS','GIT_NO_LAZY_FETCH','GIT_OPTIONAL_LOCKS','GIT_TERMINAL_PROMPT',...(process.platform==='win32'?['SYSTEMROOT']:[])].sort();
    assert.deepEqual(Object.keys(c.environment).sort(),keys);assert.equal(c.environment.GIT_CONFIG_NOSYSTEM,'1');assert.equal(c.environment.GIT_OPTIONAL_LOCKS,'0');assert.equal(c.environment.GIT_NO_LAZY_FETCH,'1');
    assert.equal(await fs.readFile(c.environment.GIT_CONFIG_GLOBAL,'utf8'),'');assert.deepEqual(await fs.readdir(c.argv[3].slice('core.hooksPath='.length)),[]);
    for(const p of [c.stdoutPath,c.stderrPath]){assert.ok(path.relative(f.scratchRoot,p)&&!path.relative(f.scratchRoot,p).startsWith('..'));assert.equal((await fs.lstat(p)).isFile(),true);}
  }
  assert.equal(commands.size,5);
});

for(const fault of ['nonempty stderr','capture overflow','lossy capture'])test(`M2-03 actual post-exit capture ${fault} fault injection refuses admission without partial parsing`,async t=>{
  const f=await m2GitFixture(t);let fired=false;
  const failpoint=async(name,c)=>{if(name==='git.exit'&&!fired){fired=true;
    if(fault==='nonempty stderr')await fs.writeFile(c.stderrPath,'fixture unexpected stderr');
    if(fault==='capture overflow')await fs.writeFile(c.stdoutPath,Buffer.alloc(MiB+1,0x78));
    if(fault==='lossy capture')await fs.writeFile(c.stdoutPath,Buffer.from([0xff,0xfe]));
  }};
  await unchanged(f,()=>inspectBaseline(baselineOptions(f,{failpoint})),{candidate:false});assert.equal(fired,true);
});

test('M2-03 actual15s deadline remains fatal even after exit0 while collector lifecycle is held', {timeout:45000},async t=>{
  const f=await m2GitFixture(t);let held=false,deadlineSeen=false;
  let release;const waiting=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const failpoint=async(name,context)=>{
    if(name==='git.exit'&&!held){assert.equal(context.code,0);assert.equal(context.signal,null);held=true;await waiting;}
    if(name==='git.deadline'){deadlineSeen=true;release();}
  };
  await unchanged(f,()=>inspectBaseline(baselineOptions(f,{failpoint})),{candidate:false});assert.equal(held,true);assert.equal(deadlineSeen,true);
});

test('M2-03 executable hooks and .gitattributes filter declarations never execute during read-only admission',async t=>{
  const f=await m2GitFixture(t,{files:{'a.txt':'alpha\r\n','.gitattributes':'a.txt filter=owned-evil\n','test.mjs':'// test\n'}});
  const sentinel=path.join(f.siblingRoot,'hook-executed'),hook=path.join(f.sourceRoot,'.git','hooks','post-checkout');
  await fs.writeFile(hook,'#!/bin/sh\nprintf escaped > "'+sentinel.replaceAll('\\','/')+'"\n');
  if(process.platform!=='win32')await fs.chmod(hook,0o755);
  const before=await sentinels(f);const baseline=await inspectBaseline(baselineOptions(f));assert.equal(baseline.files.length,3);
  assert.equal(await exists(sentinel),false);assert.deepEqual(await sentinels(f),before);
  await fs.appendFile(path.join(f.sourceRoot,'.git','config'),'[filter "owned-evil"]\n clean=touch '+sentinel.replaceAll('\\','/')+'\n');
  await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});assert.equal(await exists(sentinel),false);
});

test('M2-02 actual conflicted index stages are refused with unchanged index bytes',async t=>{
  const f=await m2GitFixture(t),stages=await f.runGit(['ls-files','--stage','--','a.txt']);
  const blob=/^100644 ([a-f0-9]{40}) 0\t/.exec(stages)?.[1];assert.ok(blob,'fixture stage-zero blob required');
  // Fixed trusted setup may manipulate this private index; library admission never does.
  const info=path.join(f.root,'index-info');await fs.writeFile(info,`0 ${'0'.repeat(40)}\ta.txt\n100644 ${blob} 1\ta.txt\n100644 ${blob} 2\ta.txt\n100644 ${blob} 3\ta.txt\n`);
  // runGit has no caller-provided stdin; the helper supplies the fixed index-info operation.
  assert.equal(typeof f.indexConflict,'function','helper must provide file-backed conflict setup');
  await f.indexConflict(info);await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});

test('M2-01 candidate total-byte limit checks proposed mutation before writing the max+1 byte',async t=>{
  const files=Object.fromEntries(Array.from({length:16},(_,i)=>[`f${i}.txt`,'x'.repeat(MiB)]));files['new.txt']='';
  const f=await setup(t,{files,protectedTests:[],grants:[entry('new.txt','replace','')]});
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,replacement('x',raw(''),'new.txt')));
  const result=await workspaceFile(f.handle,f.actor,replacement('',raw(''),'new.txt'));assert.equal(result.bytes,0);
  assert.equal((await f.owner.seal()).descriptor.files.reduce((n,r)=>n+r.bytes,0),16*MiB);
});

test('M2-01 candidate present-file limit allows256 and refuses257 before exclusive creation',async t=>{
  const files=Object.fromEntries(Array.from({length:255},(_,i)=>[`f${i}.txt`,'x']));
  const f=await setup(t,{files,protectedTests:[],grants:[entry('last.txt','create'),entry('over.txt','create')]});
  await workspaceFile(f.handle,f.actor,{operation:'create',path:'last.txt',expectedHash:null,text:'last'});
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,{operation:'create',path:'over.txt',expectedHash:null,text:'over'}));
  assert.equal((await f.owner.seal()).descriptor.files.length,256);
});

test('M2-07 real poisoned store clears authority and cannot authorize subsequent filesystem calls',async t=>{
  let armed=false;const f=await setup(t,{authorityFailpoint:async name=>{if(armed&&name==='event.written')throw Object.assign(new Error('fixture durable write failure'),{code:'EIO'});}});
  armed=true;f.authorityOwner.expectCloseFailure();await refuse(()=>f.authorityOwner.commit({type:'STOPPED'}));
  assert.equal(f.authorityOwner.authority.readCurrent(),null);assert.ok(f.authorityOwner.store.status().poisoned);
  const retained=await inventory(path.join(f.workspaceRoot,'working'));await refuse(()=>workspaceFile(f.handle,f.actor,replacement()));await refuse(()=>f.owner.seal());
  assert.deepEqual(await inventory(path.join(f.workspaceRoot,'working')),retained);
});

test('M2-07 foreign durable store owner identity cannot authorize a delayed filesystem effect',async t=>{
  const f=await setup(t),lock=path.join(f.governanceRoot,'lock.json');await fs.rename(lock,lock+'.old');await fs.writeFile(lock,'foreign durable owner');
  f.authorityOwner.expectCloseFailure();
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,replacement()));await refuse(()=>f.owner.seal());
  assert.equal(await fs.readFile(lock,'utf8'),'foreign durable owner');assert.equal(await fs.readFile(disk(f,'a.txt'),'utf8'),'alpha\r\n');
});

test('M2-07 real store revoke and closure invalidate cached author authority synchronously',async t=>{
  const f=await setup(t);f.authorityOwner.store.revoke();assert.equal(f.authorityOwner.authority.readCurrent(),null);
  await unchanged(f,()=>workspaceFile(f.handle,f.actor,replacement()));await f.authorityOwner.close();assert.equal(f.authorityOwner.authority.readCurrent(),null);
  await refuse(()=>f.owner.seal());
});

test('M2-03 metadata entry bound accepts4096 actual entries and refuses4097 without unbounded inventory',async t=>{
  const f=await m2GitFixture(t),gitRoot=path.join(f.sourceRoot,'.git'),initial=await inventory(gitRoot),padding=path.join(gitRoot,'m2-metadata');
  await fs.mkdir(padding);
  for(let i=initial.length+1;i<4096;i++)await fs.writeFile(path.join(padding,String(i).padStart(4,'0')),'',{flag:'wx'});
  assert.equal((await inventory(gitRoot)).length,4096);
  assert.equal((await inspectBaseline(baselineOptions(f))).files.length,2);
  await fs.writeFile(path.join(padding,'overflow'),'');
  await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});

test('M2-03 metadata byte bound accepts64MiB and refuses64MiB+1 before content read',async t=>{
  const f=await m2GitFixture(t),gitRoot=path.join(f.sourceRoot,'.git'),initial=await inventory(gitRoot),used=initial.reduce((n,r)=>n+(r.bytes??0),0),padding=path.join(gitRoot,'m2-padding');
  await fs.writeFile(padding,Buffer.alloc(64*MiB-used,0x78),{flag:'wx'});
  assert.equal((await inventory(gitRoot)).reduce((n,r)=>n+(r.bytes??0),0),64*MiB);
  assert.equal((await inspectBaseline(baselineOptions(f))).files.length,2);
  await fs.appendFile(padding,'x');await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
});

test('M2-02 linked Git config and standalone gitfile metadata refuse without following outside configuration',async t=>{
  for(const kind of ['config symlink','gitfile'])await t.test(kind,async t=>{
    const f=await m2GitFixture(t);
    if(kind==='config symlink'){
      const outside=path.join(f.siblingRoot,'git-config');await fs.writeFile(outside,await fs.readFile(path.join(f.sourceRoot,'.git','config')));
      await fs.unlink(path.join(f.sourceRoot,'.git','config'));await fs.symlink(outside,path.join(f.sourceRoot,'.git','config'),'file');
    }else{await fs.rename(path.join(f.sourceRoot,'.git'),path.join(f.siblingRoot,'actual-git'));await fs.writeFile(path.join(f.sourceRoot,'.git'),'gitdir: '+path.join(f.siblingRoot,'actual-git')+'\n');}
    await unchanged(f,()=>inspectBaseline(baselineOptions(f)),{candidate:false});
  });
});

test('M2-09 nested last-file delete removes only newly empty owned ancestors and seals exact deletion',async t=>{
  const f=await setup(t,{files:{'a.txt':'alpha\r\n','one/two/delete.txt':'delete me','keep/neighbor.txt':'keep','test.mjs':'// test\n'},grants:[entry('one/two/delete.txt','delete','delete me')]});
  const outside=await sentinels(f);
  await workspaceFile(f.handle,f.actor,{operation:'delete',path:'one/two/delete.txt',expectedHash:raw('delete me')});
  assert.equal(await exists(disk(f,'one')),false);assert.equal(await fs.readFile(disk(f,'keep/neighbor.txt'),'utf8'),'keep');
  const result=await f.owner.seal();assert.deepEqual(result.descriptor.deletions.map(r=>r.path),['one/two/delete.txt']);assert.deepEqual(await sentinels(f),outside);
});

if(process.platform!=='win32')for(const location of ['source','working'])test(`M2-02/M2-13 actual POSIX executable-mode drift in ${location} refuses`,async t=>{
  const f=await setup(t,{begin:location==='working'}),target=location==='source'?path.join(f.sourceRoot,'a.txt'):disk(f,'a.txt');await fs.chmod(target,0o755);
  if(location==='source')await unchanged(f,()=>f.begin(),{candidate:false});
  else{f.expectCloseFailure();await refuse(()=>f.owner.seal());assert.notEqual((await fs.stat(target)).mode&0o111,0);}
});

for(const operation of ['create','replace'])test(`M2-08/M2-11 actual hardlink introduced after ${operation} open prevents next write and poisons retained attempt`,async t=>{
  let f,armed=false,fired=false;const aliasName='postopen-alias';
  const hook=async(name,c)=>{
    if(armed&&!fired&&name==='mutation.open.after'){
      fired=true;const target=operation==='create'?disk(f,'new.txt'):path.join(f.workspaceRoot,'control',c.stageName);
      await fs.link(target,path.join(f.siblingRoot,aliasName));assert.equal((await fs.stat(target)).size,0);
    }
  };
  f=await setup(t,{grants:[entry(operation==='create'?'new.txt':'a.txt',operation,operation==='create'?undefined:'alpha\r\n')],failpoint:hook});armed=true;f.expectCloseFailure();
  const source=await fs.readFile(path.join(f.sourceRoot,'a.txt'));
  await refuse(()=>workspaceFile(f.handle,f.actor,operation==='create'?{operation:'create',path:'new.txt',expectedHash:null,text:'must not appear'}:replacement('must not appear')));
  assert.equal(fired,true);assert.equal((await fs.readFile(path.join(f.siblingRoot,aliasName))).length,0);
  assert.deepEqual(await fs.readFile(path.join(f.sourceRoot,'a.txt')),source);await refuse(()=>f.owner.seal());
});

test('M2-03 same-byte replacement of real child capture inode at exit is refused as foreign capture',async t=>{
  const f=await m2GitFixture(t);let fired=false;
  await unchanged(f,()=>inspectBaseline(baselineOptions(f,{failpoint:async(name,c)=>{
    if(name==='git.exit'&&!fired){fired=true;const bytes=await fs.readFile(c.stdoutPath);await fs.rename(c.stdoutPath,c.stdoutPath+'.owned-original');await fs.writeFile(c.stdoutPath,bytes,{flag:'wx'});}
  }})),{candidate:false});assert.equal(fired,true);
});

test('M2-03 capture mutation after bounded read cannot turn stale captured bytes into accepted facts',async t=>{
  const f=await m2GitFixture(t);let fired=false;
  await unchanged(f,()=>inspectBaseline(baselineOptions(f,{failpoint:async(name,c)=>{
    if(name==='git.capture.after'&&!fired){fired=true;await fs.appendFile(c.stdoutPath,'changed after read');}
  }})),{candidate:false});assert.equal(fired,true);
});

test('M2-15 sealed tamper permanently invalidates old view even if external bytes are restored',async t=>{
  const f=await setup(t);await f.owner.seal();const reviewer=actor('reviewer'),view=f.owner.view(reviewer,'reviewer'),original=await fs.readFile(sealed(f,'a.txt'));
  await fs.writeFile(sealed(f,'a.txt'),'tampered');f.expectCloseFailure();
  await refuse(()=>workspaceRead(view,reviewer,{operation:'read',path:'a.txt',offset:0,limit:16*KiB}));
  await fs.writeFile(sealed(f,'a.txt'),original);
  await refuse(()=>workspaceRead(view,reviewer,{operation:'read',path:'a.txt',offset:0,limit:16*KiB}));
});

test('M2-12/M2-15 close drains a held owned view before acknowledging and no stale read succeeds',async t=>{
  const gate=barrier(t,'view.before'),f=await setup(t,{failpoint:gate.hook});await f.owner.seal();const reviewer=actor('reviewer'),view=f.owner.view(reviewer,'reviewer');gate.arm();
  const reading=workspaceRead(view,reviewer,{operation:'read',path:'a.txt',offset:0,limit:16*KiB});reading.catch(()=>{});await gate.entered;
  let closed=false;const closing=f.owner.close().then(()=>{closed=true;});closing.catch(()=>{});await Promise.resolve();assert.equal(closed,false);
  gate.release();await refuse(()=>reading);await closing;assert.equal(closed,true);await refuse(()=>workspaceRead(view,reviewer,{operation:'list',offset:0,limit:1}));
});

test('M2-12/M2-15 synchronous view hook reentrant close still owns and drains that same admitted read',async t=>{
  const entered=m2Deferred(),release=m2Deferred();t.after(()=>{entered.resolve();release.resolve();});let f,armed=false,closing,closed=false;
  f=await setup(t,{failpoint:async name=>{if(armed&&name==='view.before'){
    closing=f.owner.close().then(()=>{closed=true;});closing.catch(()=>{});entered.resolve();await release.promise;
  }}});
  await f.owner.seal();const reviewer=actor('reviewer'),view=f.owner.view(reviewer,'reviewer');armed=true;
  const reading=workspaceRead(view,reviewer,{operation:'read',path:'a.txt',offset:0,limit:16*KiB});reading.catch(()=>{});await entered.promise;
  // Owned disk observation yields beyond promise continuations without a sleep.
  assert.ok((await fs.readFile(path.join(f.workspaceRoot,'lock.json'))).length>0);assert.equal(closed,false);
  release.resolve();await refuse(()=>reading);await closing;assert.equal(closed,true);
});

test('M2-11/M2-15 sealed read queue permits64 held reads and refuses65 without invalidating valid counterparts',async t=>{
  const entered=m2Deferred(),release=m2Deferred();let held=0,armed=false;
  t.after(()=>{entered.resolve();release.resolve();});
  const f=await setup(t,{failpoint:async name=>{if(armed&&name==='view.before'){if(++held===64)entered.resolve();await release.promise;}}});
  await f.owner.seal();const reviewer=actor('reviewer'),view=f.owner.view(reviewer,'reviewer');armed=true;
  const watchdog=setTimeout(()=>{entered.reject(new Error('64 owned view barriers were not reached'));release.resolve();},15000);t.after(()=>clearTimeout(watchdog));
  const pending=Array.from({length:64},()=>workspaceRead(view,reviewer,{operation:'read',path:'a.txt',offset:0,limit:16*KiB}));pending.forEach(p=>p.catch(()=>{}));
  await entered.promise;clearTimeout(watchdog);await refuse(()=>workspaceRead(view,reviewer,{operation:'read',path:'a.txt',offset:0,limit:16*KiB}));
  assert.equal(held,64);release.resolve();const results=await Promise.all(pending);assert.equal(results.length,64);assert.ok(results.every(r=>r.text==='alpha\r\n'));
});

test('M2-15 read-only change beforeimages are exact baseline bytes and cannot select outside sources',async t=>{
  const f=await setup(t);await successfulReplace(f);await f.owner.seal();const reviewer=actor('reviewer'),view=f.owner.view(reviewer,'reviewer');
  const before=await workspaceRead(view,reviewer,{operation:'before',path:'a.txt',offset:0,limit:16*KiB});assert.equal(before.text,'alpha\r\n');assert.equal(before.sha256,raw('alpha\r\n'));
  const changes=await workspaceRead(view,reviewer,{operation:'changes',offset:0,limit:128});assert.equal(changes.rows.length,1);assert.equal(changes.rows[0].before.sha256,raw('alpha\r\n'));assert.equal(changes.rows[0].after.sha256,raw('changed\r\n'));
  await unchanged(f,()=>workspaceRead(view,reviewer,{operation:'before',path:'../control/manifest.json',offset:0,limit:16*KiB}));
});

for(const field of ['commands','testInventory','environmentDigest','baseline'])test(`M2-07/M2-13 changed authority plan ${field} invalidates existing file capability without effects`,async t=>{
  const f=await setup(t,{begin:false}),current=f.authorityOwner.state();let changed=false;
  const forged=copy(current);
  if(field==='commands')forged.plan.commands[0].argv.push('foreign-test');
  if(field==='testInventory'){forged.plan.testInventory=['different'];forged.plan.commands[0].inventory=['different'];}
  if(field==='environmentDigest')forged.plan.environmentDigest=raw('other environment');
  if(field==='baseline')forged.plan.baseline=raw('other baseline');
  const authority={readCurrent:()=>changed?ownedJson(forged):f.authorityOwner.authority.readCurrent()},owner=createWorkspace({...f.options,authority});f.own(()=>owner.close());
  const handle=await owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()});changed=true;
  await unchanged(f,()=>workspaceFile(handle,f.actor,replacement()));await refuse(()=>owner.seal());
});

test('M2-07 real owner adapter never restores cached authority between two already queued durable transitions',async t=>{
  const f=await m2GitFixture(t),baseline=await inspectBaseline(baselineOptions(f)),entered=m1Deferred(),release=m2Deferred();t.after(()=>{entered.resolve();release.resolve();});
  let writes=0,armed=false;
  const a=await m2AuthorityOwner(f,baseline,{phase:'EMPTY',failpoint:async name=>{if(armed&&name==='event.open'&&++writes===2){entered.resolve();await release.promise;}}});
  armed=true;
  const proposed=a.commit({type:'PLAN_PROPOSED',plan:a.plan});
  const stopped=a.commit({type:'STOPPED'});proposed.catch(()=>{});stopped.catch(()=>{});
  await entered.promise;await proposed;assert.equal(a.authority.readCurrent(),null,'first acknowledgement cannot restore authority while second append is pending');
  release.resolve();await stopped;assert.equal(a.state().phase,'STOPPED');assert.equal(a.state().revision,2);
});

test('M2-17 import in fresh real Node child produces no files, child resources, environment or cwd changes',async t=>{
  const f=await m2GitFixture(t),cwd=path.join(f.root,'import');await fs.mkdir(cwd);
  const child=m1Spawn(M2_IMPORT_CHILD_SOURCE,[pathToFileURL(path.resolve('src/governance/workspace.mjs')).href],{cwd});f.own(()=>child.dispose());
  try{const result=await child.done;assert.equal(result.signal,null);assert.equal(result.code,0);assert.deepEqual(await fs.readdir(cwd),[]);}finally{await child.dispose();}
});

// C1 retains the complete C0 suite above; scratch refusal includes empty-file/directory effects.
import * as c1fs from 'node:fs';
const c1ScratchBoundaries=Object.freeze(['scratch.mkdir.before','git.scratch.before','git.hooks.before','git.home.before','git.capture.open.before']);
async function c1ScratchFixture(t,entrypoint,makeHook){
  const f=await m2GitFixture(t),collectorParent=path.join(f.root,'collector-parent');
  await fs.mkdir(collectorParent);
  const scratchRoot=path.join(collectorParent,'scratch');
  let baseline,authorityOwner,owner,expectedCloseFailure=false;
  if(entrypoint==='beginAttempt'){
    baseline=await inspectBaseline(baselineOptions(f));
    authorityOwner=await m2AuthorityOwner(f,baseline);authorityOwner.execution.resolve('completed');authorityOwner.disposed.resolve();
  }
  const state={...f,collectorParent,scratchRoot,baseline,authorityOwner,owner:null,
    expectCloseFailure(){expectedCloseFailure=true;}};
  const failpoint=makeHook(state);
  if(entrypoint==='beginAttempt'){
    owner=createWorkspace(workspaceOptions(f,baseline,state.authority??authorityOwner.authority,{scratchRoot,failpoint}));state.owner=owner;authorityOwner.attach(owner);
    f.own(()=>owner.close(),{allowFailure:()=>expectedCloseFailure});
  }
  state.invoke=()=>entrypoint==='inspectBaseline'?inspectBaseline(baselineOptions(f,{scratchRoot,failpoint})):
    owner.beginAttempt({actor:authorityOwner.actor,assignmentId:authorityOwner.assignmentId,execution:authorityOwner.execution.promise,disposed:authorityOwner.disposed.promise});
  return state;
}
async function c1SwapScratchDirectory(f,target,mode){
  const before=await fs.lstat(target,{bigint:true});assert.equal(before.isDirectory(),true);assert.equal(before.isSymbolicLink(),false);
  const retained=path.join(f.root,'retained-scratch-parent');await fs.rename(target,retained);
  if(mode==='junction'){
    await fs.symlink(f.siblingRoot,target,process.platform==='win32'?'junction':'dir');
    assert.equal((await fs.lstat(target)).isSymbolicLink(),true);
  }else{
    await fs.mkdir(target);
    // Preserve the expected shallow scratch structure so missing children cannot explain refusal.
    for(const name of await fs.readdir(retained)){
      const source=path.join(retained,name),destination=path.join(target,name),st=await fs.lstat(source);
      assert.equal(st.isSymbolicLink(),false);
      if(st.isDirectory()){assert.deepEqual(await fs.readdir(source),[]);await fs.mkdir(destination);}
      else{assert.equal(st.isFile(),true);await fs.writeFile(destination,await fs.readFile(source),{flag:'wx'});}
    }
    const replacement=await fs.lstat(target,{bigint:true});assert.equal(replacement.isSymbolicLink(),false);
    assert.ok(before.dev!==replacement.dev||before.ino!==replacement.ino,'ordinary replacement must change captured directory identity');
    assert.deepEqual(await inventory(target),await inventory(retained),'ordinary replacement must retain the same bytes and names');
  }
  return {target,retained,afterInjection:await inventory(target)};
}
async function c1ScratchSwapCase(t,{entrypoint,point,mode='junction',collector=1}){
  let allocations=0,selected=null,swapped=null,hits=0,spawnedAfterSwap=0,workingBeforeSwap=null,injectionError=null;
  const priorNames=new Set();
  const f=await c1ScratchFixture(t,entrypoint,state=>async(name,context)=>{
    if(name==='git.scratch.after'){
      const names=await fs.readdir(state.scratchRoot),created=names.filter(n=>!priorNames.has(n));
      assert.equal(created.length,1,'each observed allocation must add exactly one actual collector directory');
      assert.match(created[0],/^git-/);selected=path.join(state.scratchRoot,created[0]);
      assert.equal((await fs.lstat(selected)).isDirectory(),true);names.forEach(n=>priorNames.add(n));allocations++;
    }
    if(name==='git.spawn.after'&&swapped)spawnedAfterSwap++;
    if(name!==point||swapped)return;
    const currentCollector=point==='scratch.mkdir.before'||point==='git.scratch.before'?allocations+1:allocations;
    if(currentCollector!==collector)return;
    hits++;
    const target=point==='scratch.mkdir.before'?state.collectorParent:point==='git.scratch.before'?state.scratchRoot:
      point.startsWith('git.capture.')?path.dirname(context.stdoutPath):selected;
    if(point==='git.capture.stderr.open.before'){
      assert.equal((await fs.lstat(context.stdoutPath)).isFile(),true,'stdout must already have been actually opened');
      assert.equal((await fs.stat(context.stdoutPath)).size,0);assert.equal(await exists(context.stderrPath),false);
    }
    assert.equal(typeof target,'string');
    if(point==='scratch.mkdir.before')assert.equal(context.path,state.scratchRoot);
    if(collector===2){workingBeforeSwap=await inventory(path.join(state.workspaceRoot,'working'));assert.ok(workingBeforeSwap?.some(r=>r.path==='a.txt'));}
    try{swapped=await c1SwapScratchDirectory(state,target,mode);}catch(error){injectionError=error;throw error;}
  });
  const outside=await sentinels(f);
  if(collector===2)f.expectCloseFailure();
  if(mode==='ordinary')await assert.rejects(()=>f.invoke(),error=>{
    assert.ok(error instanceof Error);assert.match(error.code??'',/^(SCRATCH_CHANGED|OWNER_DIRECTORY_CHANGED)$/,'ordinary identity substitution needs an ownership refusal, not missing-path fallout');return true;
  });else await refuse(()=>f.invoke());
  assert.equal(hits,1,'the selected actual boundary must be reached once');assert.ok(swapped,injectionError?.stack??'the completed scratch replacement was not observed');
  assert.equal(spawnedAfterSwap,0,'no Git child may spawn after the completed namespace replacement');
  assert.deepEqual(await sentinels(f),outside,'coded refusal cannot excuse new empty protected files or directories');
  assert.deepEqual(await inventory(swapped.target),swapped.afterInjection,'no files may be added after the completed swap');
  assert.equal(await exists(swapped.retained),true,'the owned original directory remains retained until teardown');
  if(collector===2){
    assert.equal(await exists(path.join(f.workspaceRoot,'lock.json')),true);
    assert.deepEqual(await inventory(path.join(f.workspaceRoot,'working')),workingBeforeSwap);
    await refuse(()=>f.owner.seal());await refuse(()=>f.owner.close());
  }else assert.equal(await exists(f.workspaceRoot),false,'first-collector refusal must precede candidate allocation');
  if(point==='git.capture.stderr.open.before'){
    const stdoutName=(await fs.readdir(swapped.retained)).find(n=>n.endsWith('.stdout'));assert.ok(stdoutName);
    const retainedStdout=path.join(swapped.retained,stdoutName),settledName=retainedStdout+'.settled';
    await fs.rename(retainedStdout,settledName);await fs.writeFile(settledName,'owned post-refusal cleanup witness');
    assert.equal(await fs.readFile(settledName,'utf8'),'owned post-refusal cleanup witness');
    assert.deepEqual(await inventory(f.siblingRoot),outside[4]);
  }
}
for(const entrypoint of ['inspectBaseline','beginAttempt'])for(const point of c1ScratchBoundaries)
  test(`M2-03/M2-04/M2-08 C1 scratch completed junction at ${point} refuses before ${entrypoint} effects`,async t=>{
    await c1ScratchSwapCase(t,{entrypoint,point});
  });

test('M2-03/M2-08 C1 scratch ordinary same-path collector replacement cannot inherit capture ownership',async t=>{
  await c1ScratchSwapCase(t,{entrypoint:'inspectBaseline',point:'git.capture.open.before',mode:'ordinary'});
});

test('M2-03/M2-05/M2-11 C1 scratch final collector junction refuses after materialization and retains poisoned evidence',async t=>{
  await c1ScratchSwapCase(t,{entrypoint:'beginAttempt',point:'git.capture.open.before',collector:2});
});

for(const entrypoint of ['inspectBaseline','beginAttempt'])test(`M2-03/M2-05 C1 scratch ordinary ${entrypoint} counterpart observes all protected boundaries and succeeds`,async t=>{
  const observed=new Set();const f=await c1ScratchFixture(t,entrypoint,()=>async name=>{if(c1ScratchBoundaries.includes(name))observed.add(name);});
  const outside=await sentinels(f),result=await f.invoke();assert.deepEqual([...observed].sort(),[...c1ScratchBoundaries].sort());
  if(entrypoint==='inspectBaseline'){
    assert.equal(result.provenance,PROVENANCE);assert.deepEqual(result.files.map(r=>r.path),['a.txt','test.mjs']);
    assert.equal(result.files.find(r=>r.path==='a.txt').sha256,raw('alpha\r\n'));
    assert.equal(await exists(f.workspaceRoot),false);
  }else{
    for(const row of f.baseline.files)assert.equal(raw(await read(f,row.path)),row.sha256);
    await successfulReplace({...f,handle:result,actor:f.authorityOwner.actor});
  }
  assert.deepEqual(await sentinels(f),outside,'ordinary counterpart must not mutate source or protected inventories');
});

for(const entrypoint of ['inspectBaseline','beginAttempt'])test(`M2-03/M2-08/M2-11 C1 scratch owned hooks junction after stdout open prevents stderr creation through ${entrypoint}`,async t=>{
  let injected=null,hits=0,spawnedAfterInjection=0;
  const f=await c1ScratchFixture(t,entrypoint,state=>async(name,context)=>{
    if(name==='git.spawn.after'&&injected)spawnedAfterInjection++;
    if(name!=='git.capture.stderr.open.before'||injected)return;
    assert.equal((await fs.lstat(context.stdoutPath)).isFile(),true);assert.equal((await fs.stat(context.stdoutPath)).size,0);
    assert.equal(await exists(context.stderrPath),false);
    const collector=path.dirname(context.stderrPath),hooks=path.join(collector,'hooks'),retained=path.join(state.root,'retained-open-capture-hooks');
    assert.equal((await fs.lstat(hooks)).isDirectory(),true);assert.deepEqual(await fs.readdir(hooks),[]);
    await fs.rename(hooks,retained);await fs.symlink(state.siblingRoot,hooks,process.platform==='win32'?'junction':'dir');
    assert.equal((await fs.lstat(hooks)).isSymbolicLink(),true);
    injected={stdoutPath:context.stdoutPath,stderrPath:context.stderrPath,hooks,retained,inventory:await inventory(collector)};hits++;
  });
  const outside=await sentinels(f);
  await assert.rejects(()=>f.invoke(),error=>{assert.ok(error instanceof Error);assert.match(error.code??'',/^(PATH_LINK|OWNER_DIRECTORY_CHANGED|SCRATCH_CHANGED)$/);return true;});
  assert.equal(hits,1,'the actual hooks junction replacement must complete');assert.ok(injected);assert.equal(spawnedAfterInjection,0);
  assert.deepEqual(await sentinels(f),outside);assert.deepEqual(await inventory(path.dirname(injected.stderrPath)),injected.inventory);
  assert.equal(await exists(injected.stderrPath),false,'stderr must not be opened before a later pre-spawn refusal');
  assert.equal((await fs.stat(injected.stdoutPath)).size,0);assert.equal(await exists(f.workspaceRoot),false);
  assert.equal((await fs.lstat(injected.hooks)).isSymbolicLink(),true);assert.equal(await exists(injected.retained),true);
  // This observes the settled call's owned file, not an OS-wide descriptor-closure guarantee.
  const settled=injected.stdoutPath+'.settled';await fs.rename(injected.stdoutPath,settled);await fs.writeFile(settled,'owned post-refusal witness');
  assert.equal(await fs.readFile(settled,'utf8'),'owned post-refusal witness');assert.deepEqual(await sentinels(f),outside);
});

test('M2-03/M2-08 C1 scratch allocation after-hook ordinary replacement cannot reset captured directory ownership',async t=>{
  await c1ScratchSwapCase(t,{entrypoint:'inspectBaseline',point:'git.scratch.after',mode:'ordinary'});
});

test('M2-03/M2-07/M2-08 C1 scratch final authority callback replacement is checked before stdout file creation',async t=>{
  let selected=null,swapped=null,hits=0,spawnedAfterSwap=0;
  const f=await c1ScratchFixture(t,'beginAttempt',state=>{
    state.authority=Object.freeze({readCurrent(){
      if(selected&&!swapped){
        const retained=path.join(state.root,'retained-authority-scratch');
        assert.equal(c1fs.lstatSync(selected.parent).isDirectory(),true);
        assert.equal(c1fs.existsSync(selected.stdoutPath),false);
        assert.equal(c1fs.existsSync(selected.stderrPath),false);
        c1fs.renameSync(selected.parent,retained);
        c1fs.symlinkSync(state.siblingRoot,selected.parent,process.platform==='win32'?'junction':'dir');
        assert.equal(c1fs.lstatSync(selected.parent).isSymbolicLink(),true);swapped={retained,parent:selected.parent};hits++;
      }
      return state.authorityOwner.authority.readCurrent();
    }});
    return async(name,context)=>{
      if(name==='git.spawn.after'&&swapped)spawnedAfterSwap++;
      if(name==='git.capture.stdout.open.before'&&!selected)selected={parent:path.dirname(context.stdoutPath),stdoutPath:context.stdoutPath,stderrPath:context.stderrPath};
    };
  });
  const outside=await sentinels(f);await refuse(()=>f.invoke());
  assert.equal(hits,1,'the synchronous captured authority callback must complete the actual swap');assert.ok(swapped);
  assert.equal(spawnedAfterSwap,0);assert.deepEqual(await sentinels(f),outside,'authority may not trigger even an empty stdout creation in protectedRoot');
  assert.equal(await exists(f.workspaceRoot),false);assert.equal(await exists(path.join(swapped.retained,'1.stdout')),false);
  assert.equal(await exists(path.join(swapped.retained,'1.stderr')),false);assert.equal((await fs.lstat(swapped.parent)).isSymbolicLink(),true);
});

test('M2-04/M2-11 C1 scratch shared directory helper preserves a competing root allocation at the final mkdir boundary',async t=>{
  let f,created=false,foreignInventory;
  f=await setup(t,{begin:false,failpoint:async(name,context)=>{
    if(name==='root.mkdir.before'&&context.path===f.workspaceRoot&&!created){
      await fs.mkdir(f.workspaceRoot);await fs.writeFile(path.join(f.workspaceRoot,'foreign-evidence.txt'),'owned competing allocation',{flag:'wx'});
      foreignInventory=await inventory(f.workspaceRoot);created=true;
    }
  }});
  f.expectCloseFailure();const outside=await sentinels(f);
  await assert.rejects(()=>f.begin(),error=>{assert.ok(error instanceof Error);assert.match(error.code??'',/^(LOCKED|RECONCILIATION_REQUIRED)$/);return true;});
  assert.equal(created,true);assert.deepEqual(await inventory(f.workspaceRoot),foreignInventory);assert.deepEqual(await sentinels(f),outside);
  assert.deepEqual(await fs.readdir(f.workspaceRoot),['foreign-evidence.txt']);assert.equal(await fs.readFile(path.join(f.workspaceRoot,'foreign-evidence.txt'),'utf8'),'owned competing allocation');
  await refuse(()=>f.owner.seal());
});

// A-M2-C1-01: completed synchronous authority callbacks cannot invalidate a prior namespace check.
async function c1CallbackOwner(t,{operation='create',targetPath='nested/new.txt',point='mutation.mkdir.before',replaceDirectory=null,mode=null}={}){
  const grants=[entry(targetPath,operation,operation==='replace'?'alpha\r\n':undefined)];
  const f=await setup(t,{begin:false,grants});
  let owner,armed=false,injected=false,callbackCount=0,injectionError=null,retained=null;
  const target=replaceDirectory?path.join(f.workspaceRoot,replaceDirectory):null;
  const authority=Object.freeze({readCurrent(){
    if(armed&&!injected){
      try{
        callbackCount++;
        if(target){
          const before=c1fs.lstatSync(target,{bigint:true});assert.equal(before.isDirectory(),true);assert.equal(before.isSymbolicLink(),false);
          retained=path.join(f.root,'callback-retained-'+replaceDirectory);c1fs.renameSync(target,retained);
          if(mode==='junction'){
            c1fs.symlinkSync(f.siblingRoot,target,process.platform==='win32'?'junction':'dir');assert.equal(c1fs.lstatSync(target).isSymbolicLink(),true);
          }else{
            c1fs.mkdirSync(target);
            for(const name of c1fs.readdirSync(retained)){
              const source=path.join(retained,name),destination=path.join(target,name);assert.equal(c1fs.lstatSync(source).isFile(),true);
              c1fs.writeFileSync(destination,c1fs.readFileSync(source),{flag:'wx'});
            }
            const after=c1fs.lstatSync(target,{bigint:true});assert.equal(after.isSymbolicLink(),false);
            assert.ok(before.dev!==after.dev||before.ino!==after.ino,'ordinary replacement must change actual retained-node identity');
          }
        }
        injected=true;
      }catch(error){injectionError=error;throw error;}
    }
    return f.authorityOwner.authority.readCurrent();
  }});
  owner=createWorkspace({...f.options,authority,failpoint:async name=>{if(name===point)armed=true;}});f.authorityOwner.attach(owner);
  f.own(()=>owner.close(),{allowFailure:()=>target!==null&&injected});
  const handle=await owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:f.authorityOwner.execution.promise,disposed:f.authorityOwner.disposed.promise});
  return {...f,owner,handle,target,request:operation==='create'?{operation,path:targetPath,expectedHash:null,text:'approved nested candidate'}:replacement('approved replacement'),
    observation:()=>({armed,injected,callbackCount,injectionError,retained})};
}

for(const spec of [
  {label:'working junction before nested mkdir',replaceDirectory:'working',mode:'junction'},
  {label:'working ordinary replacement before nested mkdir',replaceDirectory:'working',mode:'ordinary'},
  {label:'control junction before replacement staging',replaceDirectory:'control',mode:'junction',operation:'replace',targetPath:'a.txt',point:'mutation.open.before'},
  {label:'control ordinary replacement before replacement staging',replaceDirectory:'control',mode:'ordinary',operation:'replace',targetPath:'a.txt',point:'mutation.open.before'},
  {label:'working ordinary replacement before exclusive create',replaceDirectory:'working',mode:'ordinary',targetPath:'new.txt',point:'mutation.open.before'},
])test(`M2-07/M2-08/M2-11 C1 callback namespace ${spec.label} refuses before effects`,async t=>{
  const f=await c1CallbackOwner(t,spec),outside=await sentinels(f),working=await inventory(path.join(f.workspaceRoot,'working')),original=await inventory(f.target),lock=await fs.readFile(path.join(f.workspaceRoot,'lock.json'));
  await assert.rejects(()=>workspaceFile(f.handle,f.actor,f.request),error=>{
    assert.ok(error instanceof Error);assert.match(error.code??'',/^(PATH_LINK|OWNER_DIRECTORY_CHANGED|WORKSPACE_POISONED)$/);return true;
  });
  const observed=f.observation();assert.equal(observed.armed,true);assert.equal(observed.injected,true,observed.injectionError?.stack??'synchronous namespace replacement must complete');assert.equal(observed.callbackCount,1);
  assert.deepEqual(await sentinels(f),outside,'no empty directory or staging file may appear outside after a completed callback swap');
  assert.deepEqual(await inventory(observed.retained),original,'original candidate/control evidence must remain unchanged');
  if(spec.mode==='ordinary')assert.deepEqual(await inventory(f.target),original,'replacement namespace must receive no effect before refusal');
  else{assert.equal((await fs.lstat(f.target)).isSymbolicLink(),true);assert.deepEqual(await inventory(f.target),outside[4]);}
  if(spec.replaceDirectory==='control')assert.deepEqual(await inventory(path.join(f.workspaceRoot,'working')),working);
  assert.deepEqual(await fs.readFile(path.join(f.workspaceRoot,'lock.json')),lock);
  await refuse(()=>workspaceFile(f.handle,f.actor,f.request));await refuse(()=>f.owner.seal());await refuse(()=>f.owner.close());
  assert.deepEqual(await sentinels(f),outside);assert.deepEqual(await inventory(observed.retained),original);
});

for(const spec of [
  {label:'nested create',operation:'create',targetPath:'nested/new.txt',point:'mutation.mkdir.before'},
  {label:'replacement staging',operation:'replace',targetPath:'a.txt',point:'mutation.open.before'},
])test(`M2-07/M2-09 C1 callback namespace ordinary ${spec.label} counterpart acknowledges exact bytes`,async t=>{
  const f=await c1CallbackOwner(t,spec),outside=await sentinels(f),receipt=await workspaceFile(f.handle,f.actor,f.request),observed=f.observation();
  assert.equal(observed.armed,true);assert.equal(observed.injected,true);assert.equal(observed.callbackCount,1);
  assert.equal(receipt.provenance,PROVENANCE);assert.equal(receipt.sha256,raw(f.request.text));assert.equal(await fs.readFile(disk(f,spec.targetPath),'utf8'),f.request.text);
  assert.deepEqual(await sentinels(f),outside);assert.equal((await f.owner.seal()).descriptor.provenance,PROVENANCE);
});

for(const phase of ['mutation','seal'])test(`M2-07/M2-11/M2-14 C1 callback publication ${phase} same-inode byte drift cannot be acknowledged`,async t=>{
  const f=await setup(t,{begin:false});let armed=false,injected=false,injectionError=null,owner;
  const target=phase==='mutation'?disk(f,'a.txt'):sealed(f,'a.txt'),drift='callback drift before publication';
  const authority=Object.freeze({readCurrent(){
    if(armed&&!injected){
      try{
        const before=c1fs.lstatSync(target,{bigint:true});assert.equal(before.isFile(),true);assert.equal(before.isSymbolicLink(),false);
        c1fs.writeFileSync(target,drift);
        const after=c1fs.lstatSync(target,{bigint:true});assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);injected=true;
      }catch(error){injectionError=error;throw error;}
    }
    return f.authorityOwner.authority.readCurrent();
  }});
  owner=createWorkspace({...f.options,authority,failpoint:async name=>{if(name===phase+'.beforeAck')armed=true;}});f.authorityOwner.attach(owner);
  f.own(()=>owner.close(),{allowFailure:()=>injected});
  const handle=await owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:f.authorityOwner.execution.promise,disposed:f.authorityOwner.disposed.promise});
  const outside=await sentinels(f);
  await refuse(()=>phase==='mutation'?workspaceFile(handle,f.actor,replacement()):owner.seal());
  assert.equal(armed,true);assert.equal(injected,true,injectionError?.stack??'actual callback byte write must complete');
  assert.equal(await fs.readFile(target,'utf8'),drift);assert.deepEqual(await sentinels(f),outside);
  const retained=await inventory(f.workspaceRoot);
  await refuse(()=>workspaceFile(handle,f.actor,replacement('later')));await refuse(()=>owner.seal());await refuse(()=>owner.close());
  assert.deepEqual(await inventory(f.workspaceRoot),retained);assert.deepEqual(await sentinels(f),outside);
});

// C2 retains the entire frozen C1 test prefix; initial ownership binds actual allocated nodes.
const c2SameNode=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
async function c2EnrollmentReplacement(t,{kind,callback=false}){
  const f=await setup(t,{begin:false});let owner,armed=false,injected=false,injectionError=null,originalStat,replacementStat,originalBytes,retained;
  const root=f.workspaceRoot,lock=path.join(root,'lock.json'),point=kind==='root'?'lock.open.before':'lock.close.after';
  function inject(){
    if(injected)return;
    try{
      if(kind==='root'){
        originalStat=c1fs.lstatSync(root,{bigint:true});assert.equal(originalStat.isDirectory(),true);assert.deepEqual(c1fs.readdirSync(root),[]);
        retained=path.join(f.root,'c2-retained-root');c1fs.renameSync(root,retained);c1fs.mkdirSync(root);
        replacementStat=c1fs.lstatSync(root,{bigint:true});assert.equal(replacementStat.isDirectory(),true);assert.equal(replacementStat.isSymbolicLink(),false);
        assert.equal(c2SameNode(originalStat,replacementStat),false);assert.deepEqual(c1fs.readdirSync(root),[]);
      }else{
        originalStat=c1fs.lstatSync(lock,{bigint:true});originalBytes=c1fs.readFileSync(lock);assert.equal(originalStat.isFile(),true);
        if(kind==='lock inode'){
          retained=path.join(f.root,'c2-retained-lock.json');c1fs.renameSync(lock,retained);c1fs.writeFileSync(lock,originalBytes,{flag:'wx'});
          replacementStat=c1fs.lstatSync(lock,{bigint:true});assert.equal(c2SameNode(originalStat,replacementStat),false);
          assert.deepEqual(c1fs.readFileSync(lock),originalBytes,'different lock inode must retain exactly the original bytes');
        }else{
          c1fs.writeFileSync(lock,'foreign same-inode lock contents');replacementStat=c1fs.lstatSync(lock,{bigint:true});
          assert.equal(c2SameNode(originalStat,replacementStat),true);assert.notDeepEqual(c1fs.readFileSync(lock),originalBytes);
        }
      }
      injected=true;
    }catch(error){injectionError=error;throw error;}
  }
  const authority=Object.freeze({readCurrent(){if(callback&&armed&&!injected)inject();return f.authorityOwner.authority.readCurrent();}});
  owner=createWorkspace({...f.options,authority,failpoint:async name=>{if(name===point&&!injected){armed=true;if(!callback)inject();}}});f.authorityOwner.attach(owner);
  f.own(()=>owner.close(),{allowFailure:()=>injected});
  const outside=await sentinels(f);
  await refuse(()=>owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:f.authorityOwner.execution.promise,disposed:f.authorityOwner.disposed.promise}));
  assert.equal(armed,true);assert.equal(injected,true,injectionError?.stack??'initial ownership replacement must actually complete');
  assert.deepEqual(await sentinels(f),outside,'initial-owner refusal must not touch protected/source/state/config inventories');
  assert.deepEqual(await fs.readdir(root),kind==='root'?[]:['lock.json'],'foreign initial namespace must not receive materialization/control entries');
  const foreign=await inventory(root),stat=await fs.lstat(kind==='root'?root:lock,{bigint:true});assert.equal(c2SameNode(stat,replacementStat),true);
  if(kind==='root')assert.deepEqual(await inventory(retained),[]);
  if(kind==='lock inode')assert.deepEqual(await fs.readFile(retained),originalBytes);
  await refuse(()=>owner.seal());await refuse(()=>owner.close());await refuse(()=>owner.close());
  assert.deepEqual(await inventory(root),foreign,'poisoned cleanup must not unlink the foreign initial lock or reclaim the foreign root');
  assert.equal(c2SameNode(await fs.lstat(kind==='root'?root:lock,{bigint:true}),replacementStat),true);assert.deepEqual(await sentinels(f),outside);
}

test('M2-04/M2-05/M2-08 C2 ownership ordinary root replacement at lock.open.before is never adopted',async t=>{
  await c2EnrollmentReplacement(t,{kind:'root'});
});

test('M2-04/M2-07/M2-08 C2 ownership synchronous authority root replacement before lock open is never adopted',async t=>{
  await c2EnrollmentReplacement(t,{kind:'root',callback:true});
});

test('M2-04/M2-05/M2-11 C2 ownership byte-identical initial lock inode replacement survives refused enrollment and cleanup',async t=>{
  await c2EnrollmentReplacement(t,{kind:'lock inode'});
});

test('M2-04/M2-05/M2-11 C2 ownership same-inode initial lock content drift refuses without cleanup unlink',async t=>{
  await c2EnrollmentReplacement(t,{kind:'lock content'});
});

test('M2-04/M2-05/M2-09 C2 ownership legitimate initial root and lock remain bound through operation seal and close',async t=>{
  let f,rootStat,lockStat,lockBytes,opened=0,closed=0;
  f=await setup(t,{begin:false,failpoint:async name=>{
    if(name==='lock.open.before'){rootStat=await fs.lstat(f.workspaceRoot,{bigint:true});assert.deepEqual(await fs.readdir(f.workspaceRoot),[]);opened++;}
    if(name==='lock.close.after'){lockStat=await fs.lstat(path.join(f.workspaceRoot,'lock.json'),{bigint:true});lockBytes=await fs.readFile(path.join(f.workspaceRoot,'lock.json'));closed++;}
  }});
  const outside=await sentinels(f);f.handle=await f.begin();assert.equal(opened,1);assert.equal(closed,1);
  assert.equal(c2SameNode(await fs.lstat(f.workspaceRoot,{bigint:true}),rootStat),true);
  assert.equal(c2SameNode(await fs.lstat(path.join(f.workspaceRoot,'lock.json'),{bigint:true}),lockStat),true);
  assert.deepEqual(await fs.readFile(path.join(f.workspaceRoot,'lock.json')),lockBytes);
  await successfulReplace(f);const sealedResult=await f.owner.seal();assert.equal(sealedResult.descriptor.provenance,PROVENANCE);
  assert.deepEqual(await sentinels(f),outside);await f.owner.close();assert.equal(await exists(path.join(f.workspaceRoot,'lock.json')),false);
  assert.equal(c2SameNode(await fs.lstat(f.workspaceRoot,{bigint:true}),rootStat),true);assert.equal(await fs.readFile(sealed(f,'a.txt'),'utf8'),'changed\r\n');
  assert.deepEqual(await sentinels(f),outside);
});

test('M2-05/M2-09/M2-11 C2 ownership byte-identical mutation stage replacement after close cannot be renamed or acknowledged',async t=>{
  let f,armed=false,injected=false,injectionError=null,target,retained,originalBytes,foreignStat;
  f=await setup(t,{failpoint:async(name,context)=>{
    if(!armed||injected||name!=='mutation.close.after')return;
    try{
      assert.equal(typeof context.stageName,'string');target=path.join(f.workspaceRoot,'control',context.stageName);
      const original=await fs.lstat(target,{bigint:true});assert.equal(original.isFile(),true);originalBytes=await fs.readFile(target);
      assert.deepEqual(originalBytes,Buffer.from('changed\r\n'));retained=path.join(f.root,'c2-retained-stage');
      await fs.rename(target,retained);await fs.writeFile(target,originalBytes,{flag:'wx'});foreignStat=await fs.lstat(target,{bigint:true});
      assert.equal(c2SameNode(original,foreignStat),false);assert.deepEqual(await fs.readFile(target),originalBytes);injected=true;
    }catch(error){injectionError=error;throw error;}
  }});
  const outside=await sentinels(f),working=await inventory(path.join(f.workspaceRoot,'working'));armed=true;f.expectCloseFailure();
  await refuse(()=>workspaceFile(f.handle,f.actor,replacement()));assert.equal(injected,true,injectionError?.stack??'actual post-close stage substitution must complete');
  assert.deepEqual(await inventory(path.join(f.workspaceRoot,'working')),working,'foreign stage must not be committed over the working file');
  assert.deepEqual(await fs.readFile(target),originalBytes);assert.deepEqual(await fs.readFile(retained),originalBytes);
  assert.equal(c2SameNode(await fs.lstat(target,{bigint:true}),foreignStat),true);assert.deepEqual(await sentinels(f),outside);
  const evidence=await inventory(f.workspaceRoot);await refuse(()=>workspaceFile(f.handle,f.actor,replacement()));await refuse(()=>f.owner.seal());await refuse(()=>f.owner.close());
  assert.deepEqual(await inventory(f.workspaceRoot),evidence);assert.deepEqual(await sentinels(f),outside);
});

// M3 component authority is a fixture-owned real v2 journal, not a production gate claim.
import {createWorkspaceV2} from '../src/governance/workspace.mjs';
import {openGovernanceStoreV2} from '../src/governance/store.mjs';
import {V2_PROVENANCE,validatePlanV2,validateStateV2,validateAssignmentV2,validateResultV2,validateDecisionV2,
  validateCandidateDescriptorV2,bindingForV2,planIdentityV2} from '../src/governance/contracts.mjs';
const m3Header={schemaVersion:2,provenance:V2_PROVENANCE};
async function m3WorkspaceFixture(t,{begin=true,failpoint,files}={}){
  const f=await m2GitFixture(t,{...(files?{files}:{})}),baseline=await inspectBaseline(baselineOptions(f));
  const store=await openGovernanceStoreV2({root:f.governanceRoot,projectRoot:f.sourceRoot,protectedRoots:[f.workspaceRoot,f.scratchRoot,f.legacyRoot,f.configRoot,...f.protectedRoots]});
  f.own(()=>store.close());
  const routes={'plan-review':{provider:'independent',model:'fixture',effort:'default'},author:{provider:'author',model:'fixture',effort:'default'},validator:{provider:'validator',model:'fixture',effort:'default'},reviewer:{provider:'reviewer',model:'fixture',effort:'default'}};
  const node={executable:process.execPath,sha256:raw(await fs.readFile(process.execPath)),version:process.version,systemRoot:f.git.systemRoot};
  const policy={schemaVersion:1,routes,node,enforcement:'guarded-native-trusted-code',settlementGraceMs:15000,testFiles:[{path:'test.mjs',sha256:baseline.files.find(r=>r.path==='test.mjs').sha256}],environmentRecipe:'systemroot-owned-temp-v1'};
  const plan=validatePlanV2({schemaVersion:2,jobId:'m3-workspace',projectId:store.status().projectId,baseline:baseline.baselineDigest,objective:'Owned v2 workspace fixture',nonGoals:['No live host or acceptance claim'],files:[entry('a.txt','replace','alpha\r\n')],protectedTests:['test.mjs'],criteria:[{id:'M3',description:'Owned candidate custody',method:'test'}],commands:[{id:'unit',executable:process.execPath,argv:['--test','--test-isolation=none','--test-reporter=tap','test.mjs'],cwd:'frozen',environment:node.systemRoot===null?{}:{SYSTEMROOT:node.systemRoot},timeoutMs:15000,expectedExit:0,inventory:['fixture']}],policy:{planner:{id:'planner',provider:'author'},implementerProvider:'author',correctionLimit:2},testInventory:['fixture'],environmentDigest:digest({node,enforcement:policy.enforcement,environmentRecipe:policy.environmentRecipe}),executionPolicy:policy});
  let state=null,cache=null,expectedCloseFailure=false,authorityHook=null;
  const commit=async(type,changes,artifacts=[])=>{
    cache=null;const next=validateStateV2({...state,...changes,revision:(state?.revision??0)+1,action:{type}});
    const event=await store.append({type,payload:next,artifacts},state?.revision??0);state=event.payload;cache=state;return state;
  };
  const assignment=(role,id,generation=state.generation,candidate=state.candidate)=>validateAssignmentV2({...m3Header,id,actor:{id,...routes[role]},role,generation,binding:bindingForV2(plan,candidate)});
  await commit('PLAN_PROPOSED',{...m3Header,jobId:plan.jobId,projectId:plan.projectId,generation:1,phase:'PLANNING',planGeneration:1,plan,attempts:[],authors:[],assignments:[],results:[],evidence:[],decision:null,candidate:null},[plan]);
  const pr=assignment('plan-review','m3-plan-review');await commit('ASSIGNMENT_CREATED',{assignments:[pr]});
  const submission={criteria:[{id:'M3',outcome:'pass'}],findings:[],evidenceIds:[]};
  const review=validateResultV2({...m3Header,id:'m3-plan-result',assignmentId:pr.id,actor:pr.actor,role:pr.role,generation:1,binding:pr.binding,outcome:'completed-pass',submission,submissionArtifactHash:digest(submission)});
  await commit('RESULT_RECORDED',{phase:'AWAITING_HUMAN',results:[review]},[submission]);
  const decision=validateDecisionV2({...m3Header,id:'m3-human',planDigest:digest(plan),reviewResultId:review.id,generation:1,decision:'authorize'});
  await commit('HUMAN_DECIDED',{phase:'PLAN_AUTHORIZED',decision},[decision]);
  const author=assignment('author','m3-author',2);await commit('ATTEMPT_RESERVED',{phase:'AUTHORING',generation:2,assignments:[pr,author],authors:[author.actor],attempts:[{index:0,assignmentId:author.id,planDigest:digest(plan)}]});
  const authority=Object.freeze({readCurrent(){store.assertOwner();return authorityHook?authorityHook(cache):cache;}});
  const options=workspaceOptions(f,baseline,authority,{...(failpoint?{failpoint}:{})}),owner=createWorkspaceV2(options);
  f.own(()=>owner.close(),{allowFailure:()=>expectedCloseFailure});
  const result={...f,baseline,store,plan,options,owner,actor:author.actor,assignmentId:author.id,commit,state:()=>state,
    authorityHook(fn){authorityHook=fn;},expectCloseFailure(){expectedCloseFailure=true;},
    begin(){return owner.beginAttempt({actor:author.actor,assignmentId:author.id,execution:Promise.resolve('completed'),disposed:Promise.resolve()});},
    async commitFreeze(custody){
      const descriptor=custody.descriptor();
      const evidence={...m3Header,id:'m3-freeze',kind:'frozen',assignmentId:author.id,generation:state.generation,binding:bindingForV2(plan,descriptor.candidateDigest),status:'completed',contentDigest:descriptor.candidateDigest,artifactHash:digest(descriptor),details:{descriptorArtifactHash:digest(descriptor),producerAssignmentId:author.id,stage:'frozen'}};
      const authorResult=validateResultV2({...m3Header,id:'m3-author-result',assignmentId:author.id,actor:author.actor,role:author.role,generation:author.generation,binding:author.binding,outcome:'completed-pass',submission,submissionArtifactHash:digest(submission)});
      await commit('CANDIDATE_SEALED',{phase:'FROZEN',candidate:descriptor.candidateDigest,evidence:[evidence],results:[...state.results,authorResult]},[descriptor,submission]);
    },
    async freeze(){const seal=await owner.seal(),custody=await owner.transfer(seal.handle);await result.commitFreeze(custody);return {seal,custody};},
    async assign(custody,role='validator'){
      const a=assignment(role,'m3-'+role);await commit('ASSIGNMENT_CREATED',{phase:role==='validator'?'VALIDATING':'REVIEWING',assignments:[...state.assignments,a]});
      return {assignment:a,actor:a.actor,lease:custody.lease({actor:a.actor,assignmentId:a.id,role})};
    }};
  if(begin)result.handle=await result.begin();return result;
}
const m3Read={operation:'read',path:'a.txt',offset:0,limit:16384};

test('M3 workspace v2 real journal transfer preserves distinct descriptor and current-stage read/replica authority',async t=>{
  const f=await m3WorkspaceFixture(t),before=await sentinels(f),rootStat=await fs.lstat(f.workspaceRoot,{bigint:true});
  const receipt=await workspaceFile(f.handle,f.actor,replacement());assert.equal(receipt.provenance,V2_PROVENANCE);
  const result=await f.owner.seal(),oldActor=ownedJson({id:'old-reviewer',provider:'reviewer',model:'fixture',effort:'default'}),view=f.owner.view(oldActor,'reviewer');
  const custody=await f.owner.transfer(result.handle);assert.equal(Object.isFrozen(custody),true);assert.deepEqual(Object.keys(custody).sort(),['descriptor','lease','read','replica','verify']);
  assert.equal(custody.verify(),true);const d=custody.descriptor();assert.deepEqual(validateCandidateDescriptorV2(d),d);
  const {candidateDigest,...body}=d;assert.equal(candidateDigest,digest(body));assert.equal(d.schemaVersion,2);assert.equal(d.provenance,V2_PROVENANCE);
  for(const [key,value]of Object.entries(planIdentityV2(f.plan)))assert.equal(d[key],value);
  assert.notEqual(candidateDigest,digest({...body,schemaVersion:1,provenance:PROVENANCE}));assert.notEqual(candidateDigest,digest(d.files));
  await refuse(()=>workspaceFile(f.handle,f.actor,replacement()));await refuse(()=>workspaceRead(view,oldActor,m3Read));
  await refuse(()=>custody.lease({actor:oldActor,assignmentId:'unassigned',role:'reviewer'}));
  await f.commitFreeze(custody);assert.equal(custody.verify(),true);
  const validator=await f.assign(custody);const response=await custody.read(validator.lease,validator.actor,m3Read);
  assert.equal(response.text,'changed\r\n');assert.equal(response.provenance,V2_PROVENANCE);assert.equal(JSON.stringify(response).includes(f.root),false);
  assert.equal((await custody.read(validator.lease,validator.actor,{...m3Read,operation:'before'})).text,'alpha\r\n');
  for(const [token,who]of [[{},validator.actor],[copy(validator.lease),validator.actor],[validator.lease,ownedJson({...validator.actor})]])await refuse(()=>custody.read(token,who,m3Read));
  const replica=await custody.replica(validator.lease,validator.actor,{replicaRoot:path.join(f.root,'replica'),scratchRoot:path.join(f.root,'runner-scratch')});
  assert.equal(replica.verify(),true);assert.deepEqual(await inventory(replica.root),await inventory(path.join(f.workspaceRoot,'sealed')));
  for(const row of d.files){const candidate=await fs.lstat(sealed(f,row.path),{bigint:true}),replicated=await fs.lstat(path.join(replica.root,row.path),{bigint:true});assert.equal(replicated.nlink,1n);assert.equal(c2SameNode(candidate,replicated),false);}
  await fs.writeFile(path.join(replica.scratchRoot,'allowed-temp'),'scratch');assert.equal(replica.verify(),true);replica.close();await refuse(()=>replica.verify());
  const reviewer=await f.assign(custody,'reviewer');assert.equal((await custody.read(reviewer.lease,reviewer.actor,m3Read)).text,'changed\r\n');
  assert.equal((await custody.read(validator.lease,validator.actor,{operation:'changes',offset:0,limit:128})).rows.length,1);
  assert.equal(f.state().phase,'REVIEWING');assert.equal(custody.verify(),true);
  assert.equal(c2SameNode(await fs.lstat(f.workspaceRoot,{bigint:true}),rootStat),true);
  const after=await sentinels(f);assert.deepEqual(after.filter((_,i)=>i!==1),before.filter((_,i)=>i!==1));
  const retained=await inventory(f.workspaceRoot);f.owner.revoke();await refuse(()=>custody.read(validator.lease,validator.actor,m3Read));await refuse(()=>custody.verify());
  await f.owner.close();assert.deepEqual((await inventory(f.workspaceRoot)).filter(row=>row.path!=='lock.json'),retained.filter(row=>row.path!=='lock.json'));
});

test('M3 workspace v2 rejects v1 downgraded policy-stripped and wrong-policy states before allocation',async t=>{
  const f=await m3WorkspaceFixture(t,{begin:false}),before=await sentinels(f);
  const states=[ownedJson({...f.state(),schemaVersion:1,provenance:PROVENANCE}),ownedJson({...f.state(),plan:{...f.plan,schemaVersion:1}}),
    ownedJson({...f.state(),plan:Object.fromEntries(Object.entries(f.plan).filter(([key])=>key!=='executionPolicy'))}),
    ownedJson({...f.state(),assignments:f.state().assignments.map(a=>({...a,binding:{...a.binding,executionPolicyDigest:'0'.repeat(64)}}))})];
  for(const state of states){const owner=createWorkspaceV2({...f.options,authority:{readCurrent:()=>state}});f.own(()=>owner.close());await refuse(()=>owner.beginAttempt({actor:f.actor,assignmentId:f.assignmentId,execution:Promise.resolve('completed'),disposed:Promise.resolve()}));assert.equal(await exists(f.workspaceRoot),false);}
  assert.deepEqual(await sentinels(f),before);const handle=await f.begin();assert.equal((await workspaceFile(handle,f.actor,m3Read)).text,'alpha\r\n');
});

for(const phase of ['mutation','seal'])test(`M3 workspace v2 policy removal at ${phase} acknowledgment boundary never publishes`,async t=>{
  let f,injected=false;
  f=await m3WorkspaceFixture(t,{failpoint:async name=>{if(name===phase+'.beforeAck'&&!injected){injected=true;f.authorityHook(s=>ownedJson({...s,plan:Object.fromEntries(Object.entries(s.plan).filter(([key])=>key!=='executionPolicy'))}));}}});
  const before=await sentinels(f);f.expectCloseFailure();await refuse(()=>phase==='mutation'?workspaceFile(f.handle,f.actor,replacement()):f.owner.seal());
  assert.equal(injected,true);const retained=await inventory(f.workspaceRoot);await refuse(()=>f.owner.close());assert.deepEqual(await inventory(f.workspaceRoot),retained);assert.deepEqual(await sentinels(f),before);
});

for(const kind of ['forged','reused'])test(`M3 workspace v2 ${kind} transfer handle poisons and retains ownership evidence`,async t=>{
  const f=await m3WorkspaceFixture(t),result=await f.owner.seal();let custody;
  if(kind==='reused')custody=await f.owner.transfer(result.handle);
  const before=await sentinels(f),retained=await inventory(f.workspaceRoot);f.expectCloseFailure();
  await refuse(()=>f.owner.transfer(kind==='forged'?copy(result.handle):result.handle));await refuse(()=>f.owner.transfer(result.handle));
  if(custody)await refuse(()=>custody.verify());await refuse(()=>f.owner.close());
  assert.deepEqual(await inventory(f.workspaceRoot),retained);assert.deepEqual(await sentinels(f),before);
});

test('M3 workspace v2 transfer revokes and drains a real in-flight old view before returning custody',async t=>{
  const b=barrier(t,'view.before'),f=await m3WorkspaceFixture(t,{failpoint:b.hook}),result=await f.owner.seal(),reviewer=ownedJson({id:'pending-reviewer',provider:'reviewer',model:'fixture',effort:'default'}),view=f.owner.view(reviewer,'reviewer');
  b.arm();const pending=workspaceRead(view,reviewer,m3Read);pending.catch(()=>{});await b.entered;
  let finished=false;const transfer=f.owner.transfer(result.handle);transfer.then(()=>{finished=true;},()=>{finished=true;});await Promise.resolve();assert.equal(finished,false);
  await refuse(()=>workspaceFile(f.handle,f.actor,replacement()));b.release();await refuse(()=>pending);const custody=await transfer;assert.equal(custody.verify(),true);assert.equal(b.seen,1);
});

test('M3 workspace v2 transfer rejects completed byte-identical sealed inode replacement',async t=>{
  const f=await m3WorkspaceFixture(t),result=await f.owner.seal(),target=sealed(f,'a.txt'),retained=path.join(f.root,'original-sealed');
  const before=await sentinels(f),bytes=await fs.readFile(target),original=await fs.lstat(target,{bigint:true});
  await fs.rename(target,retained);await fs.writeFile(target,bytes,{flag:'wx'});const foreign=await fs.lstat(target,{bigint:true});assert.equal(c2SameNode(original,foreign),false);assert.deepEqual(await fs.readFile(target),bytes);
  f.expectCloseFailure();await refuse(()=>f.owner.transfer(result.handle));const evidence=await inventory(f.workspaceRoot);await refuse(()=>f.owner.close());
  assert.equal(c2SameNode(await fs.lstat(target,{bigint:true}),foreign),true);assert.deepEqual(await inventory(f.workspaceRoot),evidence);assert.deepEqual(await sentinels(f),before);
});

test('M3 workspace v2 postfreeze authority callback stop prevents read acknowledgment and permanently kills custody',async t=>{
  const f=await m3WorkspaceFixture(t),{custody}=await f.freeze(),validator=await f.assign(custody),before=await sentinels(f);let injected=false;
  f.authorityHook(s=>{if(!injected){injected=true;return ownedJson({...s,phase:'STOPPED'});}return s;});
  f.expectCloseFailure();await refuse(()=>custody.read(validator.lease,validator.actor,m3Read));assert.equal(injected,true);f.authorityHook(null);
  await refuse(()=>custody.verify());await refuse(()=>f.owner.close());assert.deepEqual(await sentinels(f),before);
});

test('M3 workspace v2 missing pending authority cannot read but legitimate committed authority remains usable',async t=>{
  const f=await m3WorkspaceFixture(t),{custody}=await f.freeze(),validator=await f.assign(custody),before=await sentinels(f);
  f.authorityHook(()=>null);await refuse(()=>custody.read(validator.lease,validator.actor,m3Read));f.authorityHook(null);
  assert.equal((await custody.read(validator.lease,validator.actor,m3Read)).text,'alpha\r\n');assert.deepEqual(await sentinels(f),before);
});

for(const stage of ['replica.mkdir.after','replica.file.close.after'])test(`M3 workspace v2 ${stage} ordinary node replacement refuses replica publication untouched`,async t=>{
  let f,armed=false,injected=false,foreignPath,foreignStat;
  f=await m3WorkspaceFixture(t,{failpoint:async(name,context)=>{
    if(!armed||injected||name!==stage)return;
    foreignPath=stage==='replica.mkdir.after'?context.targetPath:path.join(f.root,'replica',context.path);
    const original=await fs.lstat(foreignPath,{bigint:true}),saved=path.join(f.root,'retained-replica-node'),bytes=original.isFile()?await fs.readFile(foreignPath):null;
    await fs.rename(foreignPath,saved);if(bytes===null)await fs.mkdir(foreignPath);else await fs.writeFile(foreignPath,bytes,{flag:'wx'});
    foreignStat=await fs.lstat(foreignPath,{bigint:true});assert.equal(c2SameNode(original,foreignStat),false);if(bytes)assert.deepEqual(await fs.readFile(foreignPath),bytes);injected=true;
  }});
  const {custody}=await f.freeze(),validator=await f.assign(custody),before=await sentinels(f);armed=true;
  await refuse(()=>custody.replica(validator.lease,validator.actor,{replicaRoot:path.join(f.root,'replica'),scratchRoot:path.join(f.root,'runner-scratch')}));assert.equal(injected,true);
  const foreign=await inventory(path.join(f.root,'replica'));assert.equal(c2SameNode(await fs.lstat(foreignPath,{bigint:true}),foreignStat),true);
  assert.deepEqual(await sentinels(f),before);assert.equal(custody.verify(),true);await f.owner.close();assert.deepEqual(await inventory(path.join(f.root,'replica')),foreign);
});

test('M3 workspace v2 replica full journal verification fails on an actual extra empty entry without deleting it',async t=>{
  const f=await m3WorkspaceFixture(t),{custody}=await f.freeze(),validator=await f.assign(custody);
  const replica=await custody.replica(validator.lease,validator.actor,{replicaRoot:path.join(f.root,'replica'),scratchRoot:path.join(f.root,'runner-scratch')});
  assert.equal(replica.verify(),true);const target=path.join(f.governanceRoot,'foreign-empty');await fs.writeFile(target,'',{flag:'wx'});
  const candidate=await inventory(f.workspaceRoot),replicaBefore=await inventory(replica.root);await refuse(()=>replica.verify());await refuse(()=>replica.verify());replica.close();
  assert.equal((await fs.lstat(target)).size,0);assert.deepEqual(await inventory(f.workspaceRoot),candidate);assert.deepEqual(await inventory(replica.root),replicaBefore);
});
