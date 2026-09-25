import test from 'node:test';
import {nativeTmpdir} from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createPinnedRunnerV2,checkPinnedTapV2,checkProbeTap} from '../src/governance/runner.mjs';
import {digest,bindingForV2} from '../src/governance/contracts.mjs';
// The pinned runner passes --test-isolation=none, which Node 22 accepts only as --experimental-test-isolation.
const realRunnerNode={skip:spawnSync(process.execPath,['--test-isolation=none','-e','0'],{stdio:'ignore'}).status===0?false:'this Node does not accept --test-isolation'};

const rawHash = value => createHash('sha256').update(value).digest('hex');
const nodeHash = rawHash(await fs.readFile(process.execPath));
const flags = ['--test','--test-isolation=none','--test-reporter=tap'];
const program = "import test from 'node:test';import assert from 'node:assert/strict';test('owned-case',()=>assert.equal(2+2,4));\n";
const tap = (names = ['owned-case']) => 'TAP version 13\n'+names.map((name,i) =>
  `# Subtest: ${name}\nok ${i+1} - ${name}\n  ---\n  duration_ms: 1.25\n  type: 'test'\n  ...\n`).join('')+
  `1..${names.length}\n# tests ${names.length}\n# suites 0\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 2.5\n`;
const deferred = () => {let resolve,reject;const promise = new Promise((yes,no) => {resolve=yes;reject=no;});return {promise,resolve,reject};};
const readiness = (ready,operation) => Promise.race([ready,operation.then(() => {throw new Error('operation completed before readiness');})]);
function snapshot(root) {
  const rows = [];
  const walk = file => {
    const st = syncFs.lstatSync(file,{bigint:true});
    assert.equal(st.isSymbolicLink(),false); assert.ok(st.isDirectory() || st.isFile());
    if (st.isFile()) assert.equal(st.nlink,1n);
    rows.push([path.relative(root,file),[st.dev,st.ino,st.nlink,st.mode,st.size,st.mtimeNs,st.ctimeNs].join(':'),
      st.isFile() ? rawHash(syncFs.readFileSync(file)) : null]);
    if (st.isDirectory()) for (const name of syncFs.readdirSync(file).sort()) walk(path.join(file,name));
  };
  walk(root);return rows;
}
async function fixture(t,settings = {}) {
  const root = await fs.mkdtemp(path.join(nativeTmpdir(),'m3-runner-')), runners = [], cleanup = [];
  t.after(async () => {
    for (const runner of runners) await runner.stop().catch(() => {});
    for (const dispose of cleanup) await dispose();
    // Deliberate identity-poisoning cases retain directories; fixture owner alone removes them.
    for (const runner of runners) await runner.close().catch(() => {});
    await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  });
  const source = path.join(root,'custody'), protectedRoot = path.join(root,'protected');
  const replicaRoot = path.join(root,'replica'), scratchRoot = path.join(root,'scratch');
  await fs.mkdir(source); await fs.mkdir(protectedRoot);
  await fs.writeFile(path.join(source,'owned.test.mjs'),settings.program ?? program);
  await fs.writeFile(path.join(source,'candidate.mjs'),'export const value = 4;\n');
  await fs.writeFile(path.join(protectedRoot,'journal'),'protected journal\n');
  const sourceSnapshot = snapshot(source), protectedSnapshot = snapshot(protectedRoot);
  const systemRoot = process.env.SYSTEMROOT ?? root;
  const route = provider => ({provider,model:'scripted-model',effort:'none'});
  const executionPolicy = {schemaVersion:1,routes:{'plan-review':route('review'),author:route('author'),validator:route('validation'),reviewer:route('review')},
    node:{executable:process.execPath,sha256:nodeHash,version:process.versions.node,systemRoot},
    enforcement:'guarded-native-trusted-code',settlementGraceMs:1000,
    testFiles:[{path:'owned.test.mjs',sha256:rawHash(settings.program ?? program)}],environmentRecipe:'systemroot-owned-temp-v1'};
  const plan = {schemaVersion:2,jobId:'owned-job',projectId:'a'.repeat(64),baseline:'b'.repeat(64),objective:'Run one protected fixed test',nonGoals:[],files:[],
    protectedTests:['owned.test.mjs'],criteria:[{id:'criterion',description:'Fixed test succeeds',method:'test'}],
    commands:[{id:'unit',executable:process.execPath,argv:[...flags,'owned.test.mjs'],cwd:'frozen',environment:{SYSTEMROOT:systemRoot},
      timeoutMs:30000,expectedExit:0,inventory:['owned-case']}],policy:{planner:{id:'planner',provider:'planner'},implementerProvider:'author',correctionLimit:2},
    testInventory:['owned-case'],environmentDigest:digest({node:executionPolicy.node,enforcement:executionPolicy.enforcement,environmentRecipe:executionPolicy.environmentRecipe}),executionPolicy};
  const assignment = () => ({schemaVersion:2,provenance:'gate-owned-diagnostic',id:'validation-assignment',actor:{id:'validator',...route('validation')},
    role:'validator',generation:2,binding:bindingForV2(plan,'c'.repeat(64))});
  const events = [], calls = [], stats = {spawned:0,terminated:0,waited:0,reads:[],replicas:0,closed:0};
  const lease = Object.freeze({}), abort = new AbortController(); let authorized = true, replicaSnapshot, runner, ownerActor;
  const custody = {
    verify() {assert.deepEqual(snapshot(source),sourceSnapshot);assert.deepEqual(snapshot(protectedRoot),protectedSnapshot);settings.onVerify?.();},
    async replica(actualLease,actor,locations) {
      assert.equal(actualLease,lease); assert.equal(actor,ownerActor); assert.deepEqual(actor,assignment().actor); assert.deepEqual(locations,{replicaRoot,scratchRoot});
      stats.replicas++; await fs.mkdir(scratchRoot); await fs.cp(source,replicaRoot,{recursive:true,errorOnExist:true,force:false});
      replicaSnapshot = snapshot(replicaRoot); await settings.onReplica?.();
      return {root:replicaRoot,scratchRoot,
        verify() {custody.verify();assert.deepEqual(snapshot(replicaRoot),replicaSnapshot);},
        close() {stats.closed++;custody.verify();assert.deepEqual(snapshot(replicaRoot),replicaSnapshot);}};
    },
  };
  const sandbox = {confine(argv,policy) {
    events.push('confine');calls.push({argv,policy});settings.onConfine?.();
    return {argv:[process.execPath,'unit-test-wrapper',...argv],enforcement:'partial',denialSignatures:[],runnerFailureRules:[]};
  }};
  const subprocess = {spawn(spec) {
    stats.spawned++;calls.push(spec);events.push('spawn');settings.onSpawn?.(spec);
    const done = settings.doneError ? Promise.reject(settings.doneError) : settings.done ?? Promise.resolve(settings.outcome ?? {exitCode:0,signal:null});
    return {done:done.then(value => {events.push('done');return value;}),
      terminate() {stats.terminated++;events.push('terminate');settings.onTerminate?.();},
      async waitForExit(signal) {stats.waited++;events.push('wait');const value = await (settings.wait?.(signal) ?? true);events.push('settled');return value;},
      collected:Object.fromEntries(['stdout','stderr'].map(stream => [stream,{readFrom(offset) {
        stats.reads.push([stream,offset]);events.push('read-'+stream);settings.onRead?.(stream);
        const text = stream === 'stdout' ? settings.stdout ?? tap() : settings.stderr ?? '';
        return {text,nextOffset:Buffer.byteLength(text),lossy:false,...settings.capture?.[stream]};
      }}]))};
  }};
  const make = (overrides = {}) => {
    const currentAssignment = overrides.assignment ?? assignment(); ownerActor = currentAssignment.actor;
    runner = createPinnedRunnerV2({plan,assignment:currentAssignment,sandbox,subprocess,custody,lease,replicaRoot,scratchRoot,
      authorize() {settings.onAuthorize?.();assert.equal(authorized,true,'current controller authorization');},signal:abort.signal,...overrides});
    runners.push(runner);return runner;
  };
  return {root,source,protectedRoot,replicaRoot,scratchRoot,plan,assignment,custody,lease,sandbox,subprocess,abort,events,calls,stats,make,cleanup,
    revoke() {authorized=false;},async facts(runner = make()) {return runner.consume(await runner.run('unit'));}};
}

test('M3 flat TAP accepts only complete exact ordered reviewed inventory',() => {
  assert.equal(checkPinnedTapV2(tap(),['owned-case']),true);
  assert.equal(checkProbeTap(tap(),['owned-case'],0),true);
  assert.equal(checkPinnedTapV2(tap().replace("  type: 'test'\n",''),['owned-case']),true);
  assert.equal(checkPinnedTapV2(tap().replaceAll('\n','\r\n'),['owned-case']),true);
  const failures = ['',tap().trimEnd(),tap()+'# tests 1\n',tap().replace('1..1','1..2'),tap().replace('ok 1','not ok 1'),
    tap().replace(' - owned-case',' - owned-case # SKIP'),tap().replace(' - owned-case',' - owned-case # TODO'),
    tap().replace('# fail 0','# fail 1'),tap().replace('# cancelled 0','# cancelled 1'),tap().replace('# pass 1\n',''),
    tap().replace('# suites 0','# suites 1'),tap().replace('# tests 1','# tests 2'),tap().replace('# skipped 0','# skipped 1'),
    tap().replace('# todo 0','# todo 1'),tap().replace('# Subtest: owned-case','# Subtest: other'),tap().replace('ok 1','    ok 1'),
    tap().replace('TAP version 13','TAP version 14'),tap().replace('1.25','NaN'),tap()+'unhandled rejection\n',
    tap().replace('  ...','  unexpected: true\n  ...'),tap(['second','owned-case']),tap(['owned-case','extra']),tap().replace('  ...','  ...\n1..1')];
  for (const text of failures) assert.equal(checkPinnedTapV2(text,['owned-case']),false,text);
});

test('M3 pinned runner produces an opaque one-use owner receipt only after managed settlement',async t => {
  const f = await fixture(t), runner = f.make(), receipt = await runner.run('unit');
  assert.deepEqual(Object.keys(receipt),[]);assert.equal(Object.isFrozen(receipt),true);
  await assert.rejects(runner.consume(JSON.parse(JSON.stringify(receipt))),{code:'M3_RUNNER_RECEIPT'});
  const fact = await runner.consume(receipt);
  assert.equal(fact.status,'completed');assert.equal(fact.captureComplete,true);assert.equal(fact.managedSettled,true);
  assert.equal(fact.enforcement,'partial');assert.equal(fact.actualExit,0);assert.equal(fact.timedOut,false);assert.equal(fact.aborted,false);
  assert.equal(fact.stdoutChunks.join(''),tap());assert.equal(fact.stdoutDigest,rawHash(tap()));assert.equal(fact.stderrDigest,rawHash(''));
  assert.deepEqual(fact.inventory,[{id:'owned-case',outcome:'pass'}]);assert.equal(Object.isFrozen(fact),true);
  assert.deepEqual(f.stats.reads,[['stdout',0],['stderr',0]]);
  assert.ok(f.events.indexOf('done') < f.events.indexOf('read-stdout'));assert.ok(f.events.indexOf('settled') < f.events.indexOf('read-stdout'));
  assert.equal(f.calls[0].policy.workspaceRoot,f.scratchRoot);assert.equal(f.calls[1].cwd,f.replicaRoot);
  assert.deepEqual(f.calls[1].stdio,{stdin:'ignore',stdout:{maxBytes:1048576},stderr:{maxBytes:1048576}});
  assert.deepEqual(f.calls[0].argv,[process.execPath,...flags,path.join(f.replicaRoot,'owned.test.mjs')]);
  for (const [key,value] of Object.entries(f.calls[1].env)) assert.ok(value === undefined || ['SYSTEMROOT','TEMP','TMP'].includes(key));
  assert.equal(f.calls[1].env.TEMP,f.scratchRoot);assert.equal(f.calls[1].env.TMP,f.scratchRoot);
  await assert.rejects(runner.consume(receipt),{code:'M3_RUNNER_RECEIPT'});assert.throws(() => runner.run('unit'),{code:'M3_RUNNER_COMMAND_REUSED'});
  await runner.close();assert.equal(f.stats.closed,1);
});

test('M3 all caller command/env/timeout/terminal-fact overrides refuse before spawn',async t => {
  const f = await fixture(t), runner = f.make();
  for (const value of [undefined,null,{},['unit'],{commandId:'unit',argv:[]},'missing']) assert.throws(() => runner.run(value),{code:'M3_RUNNER_COMMAND_ID'});
  assert.throws(() => runner.run('unit',{timeoutMs:1,completed:true}),{code:'M3_RUNNER_COMMAND_ID'});assert.equal(f.stats.spawned,0);
  assert.equal((await f.facts(runner)).status,'completed');
});

test('M3 constructor refuses changed plan pins, route, role, schema and unknown options',async t => {
  const f = await fixture(t);
  const mutations = [p => p.schemaVersion=1,p => p.commands[0].argv=['-e','console.log(1)'],p => p.commands[0].executable='node',
    p => p.commands[0].argv.push('--test-name-pattern=owned'),p => p.commands[0].cwd='scratch',p => p.commands[0].expectedExit=1,
    p => p.commands[0].environment.NODE_OPTIONS='--require=evil',p => p.executionPolicy.node.version='0.0.0',p => p.environmentDigest='0'.repeat(64),
    p => p.executionPolicy.testFiles=[],p => p.protectedTests=[],p => p.commands[0].argv[3]='../owned.test.mjs'];
  for (const mutate of mutations) {
    const plan = structuredClone(f.plan);mutate(plan);
    assert.throws(() => f.make({plan}));
  }
  assert.throws(() => f.make({assignment:{...f.assignment(),role:'reviewer'}}));
  assert.throws(() => f.make({assignment:{...f.assignment(),actor:{...f.assignment().actor,model:'other'}}}));
  assert.throws(() => f.make({trusted:true}));assert.equal(f.stats.spawned,0);
});

test('M3 one active command admission survives reentrant callbacks and command IDs are never refunded',async t => {
  const ready = deferred(), release = deferred();let runner;
  const f = await fixture(t,{onReplica() {ready.resolve();return release.promise;},onConfine() {assert.throws(() => runner.run('unit'),{code:'M3_RUNNER_BUSY'});}});
  runner = f.make();const operation = runner.run('unit');await readiness(ready.promise,operation);
  assert.throws(() => runner.run('unit'),{code:'M3_RUNNER_BUSY'});release.resolve();assert.equal((await runner.consume(await operation)).status,'completed');
  assert.equal(f.stats.replicas,1);assert.equal(f.stats.spawned,1);
});

test('M3 each separately approved command executes once through one replica',async t => {
  const f = await fixture(t,{stdout:tap(['another'])});
  f.plan.commands.push({...f.plan.commands[0],id:'second',inventory:['another']});f.plan.testInventory.push('another');
  const runner = f.make(), first = await runner.consume(await runner.run('unit'));
  assert.equal(first.status,'failed');const second = await runner.consume(await runner.run('second'));
  assert.equal(second.status,'completed');assert.equal(f.stats.replicas,1);assert.equal(f.stats.spawned,2);
  assert.throws(() => runner.run('second'),{code:'M3_RUNNER_COMMAND_REUSED'});
});

for (const [label,settings,reason] of [
  ['nonzero exit',{outcome:{exitCode:1,signal:null}},'M3_RUNNER_EXIT'],['signal',{outcome:{exitCode:0,signal:'SIGTERM'}},'M3_RUNNER_EXIT'],
  ['stderr',{stderr:'warning\n'},'M3_RUNNER_STDERR'],['early exit',{stdout:'TAP version 13\nok 1 - owned-case\n'},'M3_RUNNER_TAP'],
  ['skipped',{stdout:tap().replace('ok 1 - owned-case','ok 1 - owned-case # SKIP')},'M3_RUNNER_TAP'],
  ['lossy',{capture:{stdout:{lossy:true}}},'M3_CAPTURE_INVALID'],['offset mismatch',{capture:{stdout:{nextOffset:0}}},'M3_CAPTURE_INVALID'],
  ['fractional offset',{capture:{stdout:{nextOffset:0.5}}},'M3_CAPTURE_INVALID'],['oversize offset',{capture:{stdout:{nextOffset:1048577}}},'M3_CAPTURE_INVALID'],
  ['spill',{capture:{stdout:{spillPath:'forbidden-spill'}}},'M3_CAPTURE_INVALID'],['non ASCII',{stdout:tap()+'é\n'},'M3_CAPTURE_INVALID'],
  ['replacement character',{stderr:'\ufffd'},'M3_CAPTURE_INVALID'],['NUL',{stdout:tap()+'\0'},'M3_CAPTURE_INVALID'],
]) test('M3 rejects '+label+' without truncation or receipt forgery',async t => {
  const f = await fixture(t,settings), fact = await f.facts();assert.equal(fact.status,'failed');assert.equal(fact.reason,reason);
  assert.deepEqual(f.stats.reads,[['stdout',0],['stderr',0]]);assert.equal(fact.managedSettled,true);
  if (reason === 'M3_CAPTURE_INVALID') {assert.equal(fact.captureComplete,false);assert.equal(fact.stdoutDigest,null);assert.equal(fact.stderrDigest,null);assert.deepEqual(fact.stdoutChunks,[]);}
});

test('M3 ASCII capture preserves exact 1 MiB in bounded chunks even when TAP fails',async t => {
  const text = 'A'.repeat(1048576), f = await fixture(t,{stdout:text}), fact = await f.facts();
  assert.equal(fact.captureComplete,true);assert.equal(fact.status,'failed');assert.equal(fact.stdoutChunks.length,64);
  assert.ok(fact.stdoutChunks.every(chunk => chunk.length === 16384));assert.equal(fact.stdoutChunks.join(''),text);assert.equal(fact.stdoutDigest,rawHash(text));
});

test('M3 unknown enforcement and confinement failures never spawn or fall back',async t => {
  const f = await fixture(t);
  for (const confine of [argv => ({argv,enforcement:'partial'}),argv => ({argv:[process.execPath,'wrapper',...argv],enforcement:'unknown'}),() => {throw new Error('confinement refused');}]) {
    const runner = f.make({sandbox:{confine}});await assert.rejects(runner.run('unit'));assert.equal(f.stats.spawned,0);await runner.close();
    await fs.rm(f.replicaRoot,{recursive:true,force:true});await fs.rm(f.scratchRoot,{recursive:true,force:true});
  }
});

test('M3 authority is checked after replica await and before confinement',async t => {
  const ready = deferred(), release = deferred();
  const f = await fixture(t,{onReplica() {ready.resolve();return release.promise;}}), runner = f.make(), operation = runner.run('unit');
  await readiness(ready.promise,operation);f.revoke();release.resolve();await assert.rejects(operation,/current controller authorization/);
  assert.equal(f.stats.spawned,0);assert.equal(f.events.includes('confine'),false);
});

test('M3 synchronous authority is mandatory before allocation',async t => {
  const f = await fixture(t), runner = f.make({authorize:async () => {}});
  await assert.rejects(runner.run('unit'),{code:'M3_RUNNER_SYNCHRONOUS_VERIFY_REQUIRED'});assert.equal(f.stats.replicas,0);assert.equal(f.stats.spawned,0);
});

test('M3 protected program and executable digest changes refuse before spawn',async t => {
  const f = await fixture(t);f.plan.executionPolicy.testFiles[0].sha256='0'.repeat(64);
  await assert.rejects(f.make().run('unit'),{code:'M3_RUNNER_FILE_CHANGED'});assert.equal(f.stats.spawned,0);
  const g = await fixture(t);g.plan.executionPolicy.node.sha256='0'.repeat(64);
  g.plan.environmentDigest=digest({node:g.plan.executionPolicy.node,enforcement:g.plan.executionPolicy.enforcement,environmentRecipe:g.plan.executionPolicy.environmentRecipe});
  await assert.rejects(g.make().run('unit'),{code:'M3_RUNNER_FILE_CHANGED'});assert.equal(g.stats.replicas,0);assert.equal(g.stats.spawned,0);
});

test('M3 pre-abort and revoked replica/source verification prevent allocation',async t => {
  const f = await fixture(t);f.abort.abort(new Error('pre-abort'));assert.throws(() => f.make().run('unit'),/pre-abort/);assert.equal(f.stats.replicas,0);
  const g = await fixture(t), runner = g.make({custody:{...g.custody,verify:() => Promise.resolve()}});
  await assert.rejects(runner.run('unit'),{code:'M3_RUNNER_SYNCHRONOUS_VERIFY_REQUIRED'});assert.equal(g.stats.replicas,0);
});

test('M3 source and protected content checks follow confine callback before spawn',async t => {
  const f = await fixture(t,{onConfine() {syncFs.writeFileSync(path.join(f.protectedRoot,'journal'),'changed');}}), runner = f.make();
  await assert.rejects(runner.run('unit'));assert.equal(f.stats.spawned,0);
});

test('M3 replica test hash mismatch and hardlink alias refuse before spawn',async t => {
  const f = await fixture(t,{onReplica:async () => {
    await fs.unlink(path.join(f.replicaRoot,'owned.test.mjs'));await fs.link(path.join(f.source,'owned.test.mjs'),path.join(f.replicaRoot,'owned.test.mjs'));
  }}), runner = f.make();await assert.rejects(runner.run('unit'));assert.equal(f.stats.spawned,0);
});

test('M3 capture callback mutation and revoked consumption cannot acknowledge evidence',async t => {
  const f = await fixture(t,{onRead(stream) {if (stream === 'stdout') syncFs.writeFileSync(path.join(f.source,'candidate.mjs'),'changed');}});
  await assert.rejects(f.make().run('unit'));assert.equal(f.stats.waited,1);
  const g = await fixture(t), runner = g.make(), receipt = await runner.run('unit');g.revoke();await assert.rejects(runner.consume(receipt));
});

test('M3 deadline remains fatal during managed settlement after a zero exit',async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t,{wait() {entered.resolve();return release.promise;}});f.plan.commands[0].timeoutMs=1000;
  t.mock.timers.enable({apis:['setTimeout']});t.after(() => t.mock.timers.reset());
  const runner = f.make(), operation = runner.run('unit');await readiness(entered.promise,operation);
  assert.ok(f.events.includes('done'));assert.equal(f.stats.reads.length,0);
  t.mock.timers.tick(1000);assert.equal(f.stats.terminated,1);release.resolve(true);
  const fact = await runner.consume(await operation);assert.equal(fact.status,'failed');assert.equal(fact.timedOut,true);assert.equal(fact.actualExit,0);
});

test('M3 deadline remains fatal through capture callback and post-exit hashing',async t => {
  const f = await fixture(t,{onRead(stream) {if (stream === 'stdout') t.mock.timers.tick(1000);}});f.plan.commands[0].timeoutMs=1000;
  t.mock.timers.enable({apis:['setTimeout']});t.after(() => t.mock.timers.reset());
  const fact = await f.facts();assert.equal(fact.status,'failed');assert.equal(fact.timedOut,true);assert.equal(f.stats.terminated,1);
});

test('M3 stop revokes first and waits for managed range before returning',async t => {
  const spawned = deferred(), done = deferred(), exited = deferred();
  const f = await fixture(t,{done:done.promise,onSpawn() {spawned.resolve();},onTerminate() {done.resolve({exitCode:0,signal:null});},wait() {return exited.promise;}});
  const runner = f.make(), operation = runner.run('unit');operation.catch(() => {});await readiness(spawned.promise,operation);
  let stopDone = false;const stopping = runner.stop().then(() => {stopDone=true;});
  assert.equal(f.stats.terminated,1);await Promise.resolve();assert.equal(stopDone,false);assert.throws(() => runner.run('unit'),{code:'M3_RUNNER_STOPPED'});
  exited.resolve(true);await stopping;await assert.rejects(operation);assert.equal(f.stats.reads.length,0);assert.equal(stopDone,true);
});

test('M3 cancellation produces only a failed receipt after managed teardown',async t => {
  const spawned = deferred(), done = deferred();
  const f = await fixture(t,{done:done.promise,onSpawn() {spawned.resolve();},onTerminate() {done.resolve({exitCode:0,signal:null});}});
  const runner = f.make(), operation = runner.run('unit');await readiness(spawned.promise,operation);f.abort.abort(new Error('cancelled by owner'));
  const fact = await runner.consume(await operation);assert.equal(fact.status,'failed');assert.equal(fact.aborted,true);assert.equal(f.stats.terminated,1);assert.ok(f.stats.waited>=1);
});

test('M3 unknown managed completion and provider rejection never mint completed receipts',async t => {
  const f = await fixture(t,{wait:() => false}), runner = f.make();await assert.rejects(runner.run('unit'));
  await assert.rejects(runner.stop());await assert.rejects(runner.close());assert.equal(f.stats.terminated,1);assert.equal(f.stats.reads.length,0);
  const g = await fixture(t,{doneError:new Error('provider failure')});
  const fact = await g.facts();assert.equal(fact.status,'failed');assert.equal(fact.reason,'M3_RUNNER_ERROR');assert.equal(g.stats.terminated,1);
});

// This adapter exercises real Node/TAP and file-backed ownership, not OS confinement or hostile descendants.
async function realSubprocessFixture(t,f) {
  const children = new Set();
  f.cleanup.push(async () => {for (const child of children) {const closed = once(child,'close');child.kill();await closed;}});
  return {spawn(spec) {
    const argv = spec.argv.slice(2), env = Object.fromEntries(Object.entries(spec.env).filter(([,v]) => v !== undefined));
    const child = spawn(argv[0],argv.slice(1),{cwd:spec.cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});children.add(child);
    const output = {stdout:[],stderr:[]};for (const stream of ['stdout','stderr']) child[stream].on('data',bytes => output[stream].push(bytes));
    const closed = deferred();let spawnError;
    child.once('error',error => {spawnError=error;});
    child.once('close',(exitCode,signal) => {children.delete(child);closed.resolve({exitCode,signal});});
    const abort = () => child.kill();spec.signal.addEventListener('abort',abort,{once:true});
    const done = closed.promise.then(outcome => {spec.signal.removeEventListener('abort',abort);if (spawnError) throw spawnError;return outcome;});
    return {done,terminate:abort,waitForExit:() => closed.promise.then(() => true),collected:Object.fromEntries(['stdout','stderr'].map(stream =>
      [stream,{readFrom(offset) {assert.equal(offset,0);const bytes=Buffer.concat(output[stream]);return {text:bytes.toString('utf8'),nextOffset:bytes.length,lossy:bytes.length>spec.stdio[stream].maxBytes};}}]))};
  }};
}

test('M3 real fixed Node flat-TAP program qualifies only after actual close',realRunnerNode,async t => {
  const f = await fixture(t), subprocess = await realSubprocessFixture(t,f), runner = f.make({subprocess});
  const fact = await f.facts(runner);assert.equal(fact.timedOut,false);assert.equal(fact.aborted,false);assert.equal(fact.signal,null);
  assert.equal(fact.actualExit,0);assert.equal(fact.status,'completed');assert.equal(checkPinnedTapV2(fact.stdoutChunks.join(''),['owned-case']),true);
});

test('M3 real imported trusted candidate and reviewed protected test bind the replica',realRunnerNode,async t => {
  const imported = "import test from 'node:test';import assert from 'node:assert/strict';import {value} from './candidate.mjs';test('owned-case',()=>assert.equal(value,4));\n";
  const f = await fixture(t,{program:imported}), subprocess = await realSubprocessFixture(t,f), fact = await f.facts(f.make({subprocess}));
  assert.equal(fact.timedOut,false);assert.equal(fact.aborted,false);assert.equal(fact.status,'completed');
});

test('M3 real Node assertion failure records complete ASCII failure, never a pass',realRunnerNode,async t => {
  const f = await fixture(t,{program:program.replace('2+2,4','2+2,5')}), subprocess = await realSubprocessFixture(t,f), fact = await f.facts(f.make({subprocess}));
  assert.equal(fact.timedOut,false);assert.equal(fact.aborted,false);assert.notEqual(fact.actualExit,0);assert.equal(fact.status,'failed');
  assert.match(fact.stdoutChunks.join(''),/not ok 1 - owned-case/);
});

test('M3 real early exit program cannot invent complete TAP inventory',realRunnerNode,async t => {
  const f = await fixture(t,{program:"process.stdout.write('TAP version 13\\nok 1 - owned-case\\n');process.exit(0);\n"});
  const subprocess = await realSubprocessFixture(t,f), fact = await f.facts(f.make({subprocess}));
  assert.equal(fact.timedOut,false);assert.equal(fact.aborted,false);assert.equal(fact.actualExit,0);assert.equal(fact.status,'failed');
});

test('M3 real non-ASCII output is diagnostic-only rather than alleged raw UTF-8 evidence',realRunnerNode,async t => {
  const f = await fixture(t,{program:program+"console.log('é');\n"}), subprocess = await realSubprocessFixture(t,f), fact = await f.facts(f.make({subprocess}));
  assert.equal(fact.timedOut,false);assert.equal(fact.aborted,false);assert.equal(fact.status,'failed');assert.equal(fact.captureComplete,false);assert.equal(fact.stdoutDigest,null);
});
