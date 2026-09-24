import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';

export const RUNNER_LIMITATIONS = Object.freeze([
  'Windows enforcement is partial; Everyone-granted objects can remain writable.',
  'Hard links alias one file object; path scope is not malicious-code isolation.',
  'Reads, networking and process visibility are not confined.',
  'Only trusted fixture code is executed; no hostile-code or confidentiality claim.',
  'Only disposable scratch receives a standing workspace-write grant.',
]);
const digest = value => createHash('sha256').update(value).digest('hex');
const need = (value, code) => {if (!value) throw Object.assign(new Error(code), {code});};

/** M0 fixtures only: accept a complete flat TAP inventory, never a model's test summary. */
export function checkProbeTap(text, expectedNames, exitCode) {
  if (exitCode !== 0 || typeof text !== 'string' || !Array.isArray(expectedNames) || !expectedNames.length ||
      new Set(expectedNames).size !== expectedNames.length) return false;
  if (/^\s*not ok\b|^\s*Bail out!|^\s*ok .*#\s*(?:SKIP|TODO)\b/im.test(text)) return false;
  const plans = [...text.matchAll(/^1\.\.(\d+)\s*$/gm)];
  const results = [...text.matchAll(/^ok (\d+) - ([^\r\n]+)$/gm)];
  if(plans.length!==1||Number(plans[0][1])!==expectedNames.length||results.length!==expectedNames.length||
    !results.every((m,i)=>Number(m[1])===i+1&&m[2]===expectedNames[i]&&m.index<plans[0].index))return false;
  const expected={tests:expectedNames.length,suites:0,pass:expectedNames.length,fail:0,cancelled:0,skipped:0,todo:0};
  for(const [key,value] of Object.entries(expected)){
    const matches=[...text.matchAll(new RegExp('^# '+key+' (\\d+)\\s*$','gm'))];
    if(matches.length!==1||Number(matches[0][1])!==value||matches[0].index<plans[0].index)return false;
  }
  const tail=text.slice(plans[0].index).split(/\r?\n/).filter(Boolean);
  return tail.every(line=>/^1\.\.\d+$|^# (?:tests|suites|pass|fail|cancelled|skipped|todo) \d+$|^# duration_ms \d+(?:\.\d+)?$/.test(line));
}

/** Only this owned fixture template is accepted; this is not a general command registry. */
export function probeTestArgv(node, fixture) {
  need(path.isAbsolute(node) && path.isAbsolute(fixture) && path.basename(fixture) === 'probe.test.mjs', 'M0_INVALID_TEST_PATH');
  return [node, '--test', '--test-isolation=none', '--test-reporter=tap', fixture];
}

/** Use the host's real confinement and subprocess seams; never retry unconfined. */
export async function confinedProbe({sandbox, subprocess, argv, frozen, scratch, systemRoot, signal, timeoutMs = 15000}) {
  need(sandbox && typeof sandbox.confine === 'function' && subprocess && typeof subprocess.spawn === 'function', 'M0_CONFINEMENT_UNAVAILABLE');
  const disjoint = (a, b) => {const rel = path.relative(a, b);return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);};
  need(path.isAbsolute(frozen) && path.isAbsolute(scratch) && disjoint(frozen, scratch) && disjoint(scratch, frozen) &&
    typeof systemRoot === 'string' && path.isAbsolute(systemRoot), 'M0_INVALID_ROOTS');
  need(Array.isArray(argv) && argv.length > 0 && path.isAbsolute(argv[0]), 'M0_ABSOLUTE_EXECUTABLE_REQUIRED');
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'M0_INVALID_TIMEOUT');
  signal.throwIfAborted();
  const wrapped = sandbox.confine(argv, {mode: 'workspace-write', workspaceRoot: scratch});
  need(wrapped && Array.isArray(wrapped.argv) && wrapped.argv.length > argv.length &&
    ['partial', 'full'].includes(wrapped.enforcement), 'M0_INVALID_CONFINEMENT');
  const scope = new AbortController();
  const abort = () => scope.abort(signal.reason);
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  const timer = setTimeout(() => scope.abort(new Error('M0_TIMEOUT')), timeoutMs);
  let handle,primaryError;
  try {
    // Public subprocess env is an overlay: tombstone every ambient key first.
    const env = Object.fromEntries(Object.keys(process.env).map(k => [k, undefined]));
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'systemroot') delete env[k];
    env.SYSTEMROOT = systemRoot;
    handle = subprocess.spawn({argv: wrapped.argv, cwd: frozen,
      env, signal: scope.signal, graceMs: 1000,
      stdio: {stdin: 'ignore', stdout: {maxBytes: 262144}, stderr: {maxBytes: 262144}}});
    const outcome = await handle.done;
    const stdout = handle.collected.stdout.readFrom(0), stderr = handle.collected.stderr.readFrom(0);
    const invalidRunner = (wrapped.runnerFailureRules ?? []).some(rule =>
      (!rule.allowedExitCodes || rule.allowedExitCodes.includes(outcome.exitCode)) &&
      (rule.fatalSignatures ?? []).some(s => stderr.text.includes(s)));
    return {exitCode: outcome.exitCode, signal: outcome.signal, cancelled: scope.signal.aborted,
      enforcement: wrapped.enforcement, workspaceRoot: scratch, cwd: frozen,
      requestedEnvironmentKeys: ['SYSTEMROOT'], stdout: stdout.text, stderr: stderr.text,
      lossy: stdout.lossy || stderr.lossy, invalidRunner,
      subprocessOutcomeObserved: true, descendantQuiescenceProven: false};
  } catch(error){primaryError=error;throw error;}
  finally {
    clearTimeout(timer);signal.removeEventListener('abort', abort);
    if (handle) try {handle.terminate();need(await handle.waitForExit(AbortSignal.timeout(10000)), 'M0_PROCESS_RANGE_NOT_EMPTY');}
    catch(cleanupError){if(primaryError)throw new AggregateError([primaryError,cleanupError],'M0 execution and cleanup both failed');throw cleanupError;}
  }
}

/** Watch before spawn; deadline bounds readiness but never stands in for readiness. */
async function cancelAfterReady(options,file){
  const controller=new AbortController();let ready=false,checking=false,watcher;
  const inspect=async()=>{if(checking||ready)return;checking=true;try{await fs.stat(file);ready=true;controller.abort(new Error('M0_READY_CANCEL'));}catch(e){if(e.code!=='ENOENT')controller.abort(e);}finally{checking=false;}};
  const onAbort=()=>controller.abort(options.signal.reason);options.signal.addEventListener('abort',onAbort,{once:true});
  if(options.signal.aborted)onAbort();
  try{
    watcher=watch(path.dirname(file),()=>{void inspect();});
    const receipt=await confinedProbe({...options,signal:controller.signal,timeoutMs:15000});
    return {...receipt,fixtureReady:ready};
  }finally{watcher?.close();options.signal.removeEventListener('abort',onAbort);}
}

/** Allocate only under the caller-owned disposable root. Keep evidence after settlement. */
export async function runRunnerProbes({sandbox, subprocess, root, node = process.execPath,
  systemRoot = process.env.SYSTEMROOT, signal, inspectAcl, workspaceSid}) {
  need(process.platform === 'win32', 'M0_WINDOWS_ONLY');
  need(path.isAbsolute(root), 'M0_ABSOLUTE_ROOT_REQUIRED');
  await fs.mkdir(root, {recursive: true});
  const base = await fs.mkdtemp(path.join(await fs.realpath(root), 'runner-'));
  const frozen = path.join(base, 'frozen'), scratch = path.join(base, 'scratch'), source = path.join(base, 'source');
  for (const p of [frozen, scratch, source]) await fs.mkdir(p);
  const frozenFile = path.join(frozen, 'sentinel.txt'), sourceFile = path.join(source, 'sentinel.txt');
  await fs.writeFile(frozenFile, 'FROZEN');await fs.writeFile(sourceFile, 'SOURCE');
  const checks = [], receipts = [];
  const aclPaths=[source,frozen,scratch,sourceFile,frozenFile];
  const aclBefore=inspectAcl ? await inspectAcl(aclPaths) : null;
  const record = (id, pass, detail) => checks.push({id, state: pass ? 'PASS' : 'FAIL', detail});
  async function run(id, argv) {
    const receipt = await confinedProbe({sandbox, subprocess, argv, frozen, scratch, systemRoot, signal});
    await fs.writeFile(path.join(base, `${id}.stdout.txt`), receipt.stdout);
    await fs.writeFile(path.join(base, `${id}.stderr.txt`), receipt.stderr);
    const summary = {...receipt, stdout: undefined, stderr: undefined,
      stdoutHash: digest(receipt.stdout), stderrHash: digest(receipt.stderr)};
    receipts.push({id, ...summary});
    return receipt;
  }
  const fixture = path.join(frozen, 'probe.test.mjs');
  await fs.writeFile(fixture, "import test from 'node:test';import assert from 'node:assert/strict';test('m0-owned-fixture',()=>assert.equal(2+2,4));\n");
  const argv = probeTestArgv(node, fixture);
  const result = await run('tap', argv);
  record('runner.tap', !result.lossy && !result.cancelled && !result.invalidRunner &&
    checkProbeTap(result.stdout, ['m0-owned-fixture'], result.exitCode), 'Exact pinned Node template and complete flat TAP inventory.');
  const code = `const fs=require('node:fs');let out={};for(const [key,file] of ${JSON.stringify([['frozen', frozenFile], ['source', sourceFile], ['scratch', path.join(scratch,'allowed.txt')]])}){try{fs.writeFileSync(file,'MUTATED');out[key]='wrote'}catch(e){out[key]=e.code}}out.envKeys=Object.keys(process.env).sort();out.temp=process.env.TEMP;console.log(JSON.stringify(out));`;
  const writes = await run('writes', [node, '-e', code]);
  let facts;try {facts = JSON.parse(writes.stdout.trim());} catch {}
  record('runner.write-boundary', writes.exitCode === 0 && !writes.lossy && !writes.cancelled && !writes.invalidRunner &&
    facts && ['EACCES','EPERM'].includes(facts.frozen) && ['EACCES','EPERM'].includes(facts.source) && facts.scratch === 'wrote' &&
    await fs.readFile(frozenFile,'utf8') === 'FROZEN' && await fs.readFile(sourceFile,'utf8') === 'SOURCE',
    'Ordinary writes attempted only on disposable source/frozen/scratch sentinels.');
  record('runner.environment', !!facts && facts.envKeys.every(k => ['systemroot','tmp','temp'].includes(k.toLowerCase())) &&
    typeof facts.temp === 'string' && path.isAbsolute(facts.temp), 'No inherited PATH/Node options/credentials; backend private temp is explicit.');
  const failedTarget=path.join(source,'must-not-execute.txt');
  await fs.writeFile(failedTarget,'HOST-WRITABLE');await fs.unlink(failedTarget);
  let failureSpawns=0;
  const observedSubprocess={spawn(spec){failureSpawns++;return subprocess.spawn(spec);}};
  const failure=await confinedProbe({sandbox,subprocess:observedSubprocess,argv:[node,'-e',`require('node:fs').writeFileSync(${JSON.stringify(failedTarget)},'ESCAPED')`],
    frozen,scratch:path.join(base,'intentionally-missing-scratch'),systemRoot,signal});
  const targetAbsent=await fs.stat(failedTarget).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e;});
  receipts.push({id:'confinement-failure',...failure,targetAbsent,spawnCount:failureSpawns,destinationWritable:true});
  record('runner.confinement-failure',failureSpawns===1 && failure.exitCode===127 && failure.invalidRunner && !failure.cancelled && !failure.lossy && targetAbsent,
    'Real Windows ACL launcher rejected missing private workspace before target start; existing destination sentinel absent; no unrestricted retry path exists.');
  const unknown = await run('unknown-option', [node, '--m0-unknown-option', fixture]);
  record('runner.unknown-option', unknown.exitCode === 9 && !unknown.cancelled && !unknown.invalidRunner && !unknown.lossy &&
    unknown.stderr.includes('bad option: --m0-unknown-option'), 'Exact Node unknown-option failure, distinct from runner infrastructure failure.');
  const early = await run('early-exit', [node, '-e', "console.log('TAP version 13\\nok 1 - m0-owned-fixture');process.exit(0)"]);
  record('runner.partial-tap', !checkProbeTap(early.stdout, ['m0-owned-fixture'], early.exitCode), 'Zero exit without complete inventory does not pass.');
  const cancelFile=path.join(scratch,'cancel-ready.txt');
  const cancelled=await cancelAfterReady({sandbox,subprocess,argv:[node,'-e',`require('node:fs').writeFileSync(${JSON.stringify(cancelFile)},'READY');setInterval(()=>{},1000)`],frozen,scratch,systemRoot,signal},cancelFile);
  receipts.push({id:'cancel',...cancelled});
  record('runner.cancellation',cancelled.fixtureReady && cancelled.cancelled && cancelled.subprocessOutcomeObserved && cancelled.exitCode!==0,
    'Actual pinned Node readiness marker precedes cancellation; managed-range wait settles before return.');
  // Fixture grandchildren inherit descriptors (no Windows named-pipe creation).
  const descendantFile=path.join(scratch,'descendant.json');
  const childScript=`require('node:fs').writeFileSync(${JSON.stringify(descendantFile)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`;
  const parentScript=`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit',env:process.env});c.on('error',e=>{console.error(e.message);process.exit(9)});setInterval(()=>{},1000)`;
  const descendant=await cancelAfterReady({sandbox,subprocess,argv:[node,'-e',parentScript],frozen,scratch,systemRoot,signal},descendantFile);
  let descendantPid,absent=false;try{descendantPid=JSON.parse(await fs.readFile(descendantFile,'utf8')).pid;process.kill(descendantPid,0);}catch(error){absent=error.code==='ESRCH';}
  receipts.push({id:'descendants',...descendant,descendantPid:descendantPid??null,descendantAbsent:absent});
  record('runner.descendant-settlement',descendant.fixtureReady && descendant.cancelled && Number.isSafeInteger(descendantPid) && absent,
    'Owned grandchild announced its real PID before cancellation; managed range settled and PID was absent.');
  let aclEvidence=null;
  if(inspectAcl && workspaceSid){
    const aclAfter=await inspectAcl(aclPaths),sid=workspaceSid(scratch);
    const pairs=aclPaths.map(p=>({path:p,before:aclBefore.find(a=>a.path===p)?.sddl,after:aclAfter.find(a=>a.path===p)?.sddl}));
    aclEvidence={sid,paths:pairs};
    record('runner.acl-grants',pairs.every(p=>typeof p.before==='string' && typeof p.after==='string') &&
      pairs.filter(p=>p.path!==scratch).every(p=>p.before===p.after && !p.after.includes(sid)) &&
      pairs.find(p=>p.path===scratch).after.includes(sid),'Host read-only SDDL inspection before/after: only disposable scratch acquired this workspace SID. Ambient inherited ACLs remain an explicit residual.');
  }
  const linkObject=path.join(scratch,'link-object.txt'),externalAlias=path.join(source,'alias.txt');
  await fs.writeFile(linkObject,'LINK-ORIGINAL');await fs.link(linkObject,externalAlias);
  const linkRun=await run('hardlink-residual',[node,'-e',`require('node:fs').writeFileSync(${JSON.stringify(externalAlias)},'ALIAS-WROTE');console.log('alias-wrote')`]);
  record('runner.hardlink-limit',linkRun.exitCode===0 && await fs.readFile(linkObject,'utf8')==='ALIAS-WROTE' && (await fs.stat(linkObject)).nlink===2,
    'Disposable negative control reproduced documented hard-link alias write outside scratch. This confirms a limitation, NOT path isolation. No real source file was linked.');
  const report = {kind: 'm0-runner-probes', root: base, checks, receipts, aclEvidence,
    node: {path: node, version: process.versions.node, sha256: digest(await fs.readFile(node))},
    observedEnvironment: facts ? {keys: facts.envKeys, privateTemp: facts.temp} : null,
    limitations: RUNNER_LIMITATIONS,
    unprobed: ['runner.acl-grants', 'runner.hardlink-limit'].filter(id=>!checks.some(c=>c.id===id)),
    decision: 'NO_GO'};
  await fs.writeFile(path.join(base, 'report.json'), JSON.stringify(report,null,2)+'\n');
  return report;
}

import * as runnerFs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {types as runnerTypes} from 'node:util';
import {validatePlanV2, validateAssignmentV2, bindingForV2, digest as recordDigest,
  same as sameRecord} from './contracts.mjs';

const RUNNER_CAPTURE_BYTES = 1048576, RUNNER_CHUNK_BYTES = 16384;
const RUNNER_FLAGS = Object.freeze(['--test','--test-isolation=none','--test-reporter=tap']);
const RUNNER_SCOPE = Object.freeze([...RUNNER_LIMITATIONS,
  'Managed-range completion is provider-specific; detached or hostile descendants are not proven isolated.',
  'Only reviewed fixed flat-TAP programs without child-spawning behavior qualify; candidate imports are trusted code.']);
const runnerError = code => Object.assign(new Error(code), {code});
const runnerOpaque = () => Object.freeze(Object.create(null));

function runnerOptions(value, required, optional = []) {
  need(value && typeof value === 'object' && !runnerTypes.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype, 'M3_RUNNER_OPTIONS');
  const keys = Reflect.ownKeys(value);
  need(keys.every(k => typeof k === 'string' && [...required,...optional].includes(k)) &&
    required.every(k => keys.includes(k)), 'M3_RUNNER_OPTIONS');
  for (const k of keys) need(Object.hasOwn(Object.getOwnPropertyDescriptor(value,k), 'value'), 'M3_RUNNER_OPTIONS');
  return value;
}
function runnerAbsolute(value) {
  need(typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) &&
    path.normalize(value) === value && value !== path.parse(value).root, 'M3_RUNNER_PATH');
  return value;
}
function runnerDisjoint(a,b) {
  const rel = path.relative(a,b);
  return rel === '..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel);
}
function runnerIdentity(st) {
  need(st.ino > 0n && st.nlink > 0n, 'M3_RUNNER_IDENTITY');
  return [st.dev,st.ino,st.nlink,st.mode,st.size,st.mtimeNs,st.ctimeNs].join(':');
}
function runnerFile(file, expectedHash, retained) {
  runnerAbsolute(file);
  const parents = [];
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const st = runnerFs.lstatSync(dir,{bigint:true});
    need(st.isDirectory() && !st.isSymbolicLink(), 'M3_RUNNER_PATH_LINK');
    parents.push([dir,[st.dev,st.ino,st.mode].join(':')]);
    if (dir === path.dirname(dir)) break;
  }
  const st = runnerFs.lstatSync(file,{bigint:true});
  need(st.isFile() && !st.isSymbolicLink() && st.nlink === 1n, 'M3_RUNNER_LINKED_FILE');
  need(st.size <= 536870912n, 'M3_RUNNER_FILE_LIMIT');
  const identity = runnerIdentity(st);
  if (retained) need(identity === retained.identity && sameRecord(parents,retained.parents), 'M3_RUNNER_FILE_CHANGED');
  const fd = runnerFs.openSync(file,'r'); let bytes;
  try {
    need(runnerIdentity(runnerFs.fstatSync(fd,{bigint:true})) === identity, 'M3_RUNNER_FILE_CHANGED');
    bytes = runnerFs.readFileSync(fd);
    need(runnerIdentity(runnerFs.fstatSync(fd,{bigint:true})) === identity, 'M3_RUNNER_FILE_CHANGED');
  } finally { runnerFs.closeSync(fd); }
  need(runnerIdentity(runnerFs.lstatSync(file,{bigint:true})) === identity && digest(bytes) === expectedHash,
    'M3_RUNNER_FILE_CHANGED');
  for (const [dir,id] of parents) {
    const current = runnerFs.lstatSync(dir,{bigint:true});
    need(current.isDirectory() && !current.isSymbolicLink() && [current.dev,current.ino,current.mode].join(':') === id,
      'M3_RUNNER_PATH_CHANGED');
  }
  return {identity,parents};
}
function runnerUnchanged(file, retained) {
  const st = runnerFs.lstatSync(file,{bigint:true});
  need(st.isFile() && !st.isSymbolicLink() && runnerIdentity(st) === retained.identity, 'M3_RUNNER_FILE_CHANGED');
  for (const [dir,id] of retained.parents) {
    const current = runnerFs.lstatSync(dir,{bigint:true});
    need(current.isDirectory() && !current.isSymbolicLink() && [current.dev,current.ino,current.mode].join(':') === id,
      'M3_RUNNER_PATH_CHANGED');
  }
}
function runnerVerify(call, receiver) {
  const value = call.call(receiver);
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    throw runnerError('M3_RUNNER_SYNCHRONOUS_VERIFY_REQUIRED');
  }
  need(value !== false, 'M3_RUNNER_SYNCHRONOUS_VERIFY_REQUIRED');
}

/** Closed Node flat-TAP grammar, including all ordered summaries and per-case diagnostics. */
export function checkPinnedTapV2(text, inventory) {
  if (typeof text !== 'string' || /[^\x09\x0a\x0d\x20-\x7e]/.test(text) || !Array.isArray(inventory) ||
    !inventory.length || new Set(inventory).size !== inventory.length || !text.endsWith('\n')) return false;
  const lines = text.split(/\r?\n/); lines.pop(); let at = 0;
  const take = value => lines[at++] === value;
  const duration = line => typeof line === 'string' && /^\d+(?:\.\d+)?$/.test(line);
  if (!take('TAP version 13')) return false;
  for (let i = 0; i < inventory.length; i++) {
    if (!take('# Subtest: '+inventory[i]) || !take('ok '+(i+1)+' - '+inventory[i]) || !take('  ---')) return false;
    const timing = lines[at++];
    if (!timing?.startsWith('  duration_ms: ') || !duration(timing.slice(15))) return false;
    if (lines[at] === "  type: 'test'") at++;
    if (!take('  ...')) return false;
  }
  if (!take('1..'+inventory.length)) return false;
  for (const [key,value] of Object.entries({tests:inventory.length,suites:0,pass:inventory.length,fail:0,cancelled:0,skipped:0,todo:0}))
    if (!take('# '+key+' '+value)) return false;
  const tail = lines[at++];
  return tail?.startsWith('# duration_ms ') && duration(tail.slice(14)) && at === lines.length;
}
function runnerCapture(reader) {
  need(reader && typeof reader.readFrom === 'function', 'M3_CAPTURE_INVALID');
  const read = reader.readFrom(0);
  need(read && typeof read.text === 'string' && read.lossy === false && read.spillPath === undefined &&
    Number.isSafeInteger(read.nextOffset) && read.nextOffset >= 0 && read.nextOffset <= RUNNER_CAPTURE_BYTES &&
    read.nextOffset === Buffer.byteLength(read.text,'utf8') && !/[^\x09\x0a\x0d\x20-\x7e]/.test(read.text), 'M3_CAPTURE_INVALID');
  const text = read.text, chunks = [];
  for (let offset = 0; offset < text.length; offset += RUNNER_CHUNK_BYTES) chunks.push(text.slice(offset,offset+RUNNER_CHUNK_BYTES));
  return {text,chunks,sha256:digest(Buffer.from(text,'ascii'))};
}
function runnerWait(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve,reject) => {
    const abort = () => {signal.removeEventListener('abort',abort); reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
  });
}

/** Owner-only facade. Neither the facade, custody lease nor receipt consumer is a model tool. */
export function createPinnedRunnerV2(input) {
  const options = runnerOptions(input,['plan','assignment','sandbox','subprocess','custody','lease','replicaRoot','scratchRoot','authorize'],['signal']);
  const plan = validatePlanV2(options.plan), assignment = validateAssignmentV2(options.assignment), policy = plan.executionPolicy;
  const {sandbox,subprocess,custody,lease,authorize,signal} = options;
  // Custody leases bind the owner's exact actor object, not a validated JSON copy.
  const exactActor = options.assignment.actor;
  need(assignment.role === 'validator' && assignment.binding.candidateDigest !== null &&
    sameRecord(assignment.binding,bindingForV2(plan,assignment.binding.candidateDigest)), 'M3_RUNNER_ASSIGNMENT');
  need(sandbox && typeof sandbox.confine === 'function' && subprocess && typeof subprocess.spawn === 'function' &&
    custody && ['replica','verify'].every(k => typeof custody[k] === 'function') && typeof authorize === 'function', 'M3_RUNNER_DEPENDENCIES');
  need(signal === undefined || signal instanceof AbortSignal, 'M3_RUNNER_SIGNAL');
  const replicaRoot = runnerAbsolute(options.replicaRoot), scratchRoot = runnerAbsolute(options.scratchRoot);
  need(runnerDisjoint(replicaRoot,scratchRoot) && runnerDisjoint(scratchRoot,replicaRoot), 'M3_RUNNER_ROOT_OVERLAP');
  need(policy.enforcement === 'guarded-native-trusted-code' && policy.environmentRecipe === 'systemroot-owned-temp-v1' &&
    policy.node.executable === process.execPath && policy.node.version === process.versions.node, 'M3_RUNNER_TOOLCHAIN');
  runnerAbsolute(policy.node.executable); runnerAbsolute(policy.node.systemRoot);
  need(plan.environmentDigest === recordDigest({node:policy.node,enforcement:policy.enforcement,
    environmentRecipe:policy.environmentRecipe}), 'M3_RUNNER_ENVIRONMENT_DIGEST');
  need(sameRecord({provider:assignment.actor.provider,model:assignment.actor.model,effort:assignment.actor.effort},
    policy.routes.validator), 'M3_RUNNER_ROUTE');
  const commands = new Map();
  for (const command of plan.commands) {
    need(command.executable === policy.node.executable && command.cwd === 'frozen' && command.expectedExit === 0 &&
      sameRecord(command.environment,{SYSTEMROOT:policy.node.systemRoot}) && command.argv.length > RUNNER_FLAGS.length &&
      RUNNER_FLAGS.every((flag,i) => command.argv[i] === flag), 'M3_RUNNER_COMMAND_GRAMMAR');
    const files = command.argv.slice(RUNNER_FLAGS.length);
    need(new Set(files.map(f => f.toLowerCase())).size === files.length && files.every(file =>
      plan.protectedTests.includes(file) && policy.testFiles.some(f => f.path === file) &&
      /^[A-Za-z0-9._/-]+$/.test(file) && file.split('/').every(p => p && p !== '.' && p !== '..')),
    'M3_RUNNER_PROTECTED_TEST');
    commands.set(command.id,command);
  }
  const receipts = new WeakMap(), admitted = new Set();
  let replica, active, scope, stopped = false, closing, nodeIdentity, drainFailure;
  const verify = () => {
    runnerVerify(custody.verify,custody);
    if (replica) runnerVerify(replica.verify,replica);
    if (nodeIdentity) runnerUnchanged(policy.node.executable,nodeIdentity);
  };
  const live = () => {need(!stopped,'M3_RUNNER_STOPPED'); signal?.throwIfAborted();};
  async function execute(command, admittedAt) {
    const deadlineAt = admittedAt+command.timeoutMs;
    const control = new AbortController(); scope = control;
    let timedOut = false, aborted = false, handle, done, doneSettled = false, managedSettled = false;
    let outcome = null, failure, stdout, stderr, files = [], enforcement = null, terminationRequested = false, terminationError;
    let settledAfterTermination = false, cleanupAttempted = false;
    const terminate = () => {
      if (!handle || terminationRequested) return;
      terminationRequested = true;
      try {handle.terminate();} catch (error) {terminationError = error;}
    };
    control.signal.addEventListener('abort',terminate,{once:true});
    const timeout = () => {timedOut = true; control.abort(runnerError('M3_RUNNER_TIMEOUT'));};
    const cancel = () => {aborted = true; control.abort(signal.reason);};
    const timer = setTimeout(timeout,command.timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    if (signal?.aborted) cancel();
    const deadline = () => {if (performance.now() >= deadlineAt) timeout();};
    const authority = () => {
      need(!stopped,'M3_RUNNER_STOPPED'); runnerVerify(authorize,undefined);
      need(!stopped,'M3_RUNNER_STOPPED'); verify();
    };
    const check = () => {deadline(); control.signal.throwIfAborted(); authority(); deadline(); control.signal.throwIfAborted();};
    const settle = async terminating => {
      if (terminating) {cleanupAttempted = true; terminate();}
      const grace = AbortSignal.timeout(policy.settlementGraceMs);
      managedSettled = await runnerWait(handle.waitForExit(grace),grace) === true;
      need(managedSettled,'M3_RUNNER_MANAGED_UNSETTLED');
      deadline();
      if (!doneSettled) await runnerWait(done,grace).catch(error => {if (!doneSettled) throw error;});
      need(doneSettled,'M3_RUNNER_DONE_UNSETTLED');
      settledAfterTermination = terminationRequested;
      if (terminationError) throw terminationError;
      verify(); deadline();
    };
    try {
      try {
        check(); nodeIdentity = runnerFile(policy.node.executable,policy.node.sha256,nodeIdentity); check();
        if (!replica) {
          replica = await custody.replica(lease,exactActor,{replicaRoot,scratchRoot});
          need(replica && replica.root === replicaRoot && replica.scratchRoot === scratchRoot &&
            ['verify','close'].every(k => typeof replica[k] === 'function'), 'M3_RUNNER_REPLICA');
          check();
        }
        files = command.argv.slice(RUNNER_FLAGS.length).map(file => {
          const location = path.join(replica.root,...file.split('/')), sha256 = policy.testFiles.find(f => f.path === file).sha256;
          return {location,sha256,identity:runnerFile(location,sha256)};
        });
        check();
        const argv = [policy.node.executable,...RUNNER_FLAGS,...files.map(f => f.location)];
        const wrapped = sandbox.confine(argv,{mode:'workspace-write',workspaceRoot:replica.scratchRoot});
        check();
        need(wrapped && ['partial','full'].includes(wrapped.enforcement) && Array.isArray(wrapped.argv) &&
          wrapped.argv.length > argv.length && wrapped.argv.every(a => typeof a === 'string') && path.isAbsolute(wrapped.argv[0]),
        'M3_RUNNER_CONFINEMENT');
        enforcement = wrapped.enforcement;
        // The public subprocess environment is an overlay; erase every inherited key first.
        const env = Object.fromEntries(Object.keys(process.env).map(k => [k,undefined]));
        for (const key of Object.keys(env)) if (['systemroot','temp','tmp'].includes(key.toLowerCase())) delete env[key];
        Object.assign(env,{SYSTEMROOT:policy.node.systemRoot,TEMP:replica.scratchRoot,TMP:replica.scratchRoot});
        check(); for (const f of files) runnerUnchanged(f.location,f.identity); deadline(); control.signal.throwIfAborted();
        handle = subprocess.spawn({argv:wrapped.argv,cwd:replica.root,env,signal:control.signal,
          graceMs:policy.settlementGraceMs,stdio:{stdin:'ignore',stdout:{maxBytes:RUNNER_CAPTURE_BYTES},stderr:{maxBytes:RUNNER_CAPTURE_BYTES}}});
        need(handle && typeof handle.terminate === 'function' && typeof handle.waitForExit === 'function' &&
          handle.done && typeof handle.done.then === 'function', 'M3_RUNNER_PROCESS_HANDLE');
        done = Promise.resolve(handle.done).then(value => {doneSettled = true; outcome = value;},error => {doneSettled = true; throw error;});
        done.catch(() => {}); check();
        await runnerWait(done,control.signal); check();
        await settle(false); check();
      } catch (error) {failure = error;}
      if (!handle) throw failure ?? runnerError('M3_RUNNER_NO_PROCESS');
      if (failure || control.signal.aborted || stopped) {
        try {await settle(true);} catch (cleanup) {
          throw failure ? new AggregateError([failure,cleanup],'M3 runner execution and settlement failed') : cleanup;
        }
      }
      authority();
      // Both offset-zero reads occur exactly once, only after done and managed quiescence.
      try {stdout = runnerCapture(handle.collected?.stdout);} catch (error) {failure ??= error;}
      authority(); deadline();
      try {stderr = runnerCapture(handle.collected?.stderr);} catch (error) {failure ??= error;}
      authority(); deadline();
      if (!failure) {
        if (!outcome || outcome.exitCode !== 0 || outcome.signal !== null) failure = runnerError('M3_RUNNER_EXIT');
        else if (stderr.text.length) failure = runnerError('M3_RUNNER_STDERR');
        else if (!checkPinnedTapV2(stdout.text,command.inventory)) failure = runnerError('M3_RUNNER_TAP');
      }
      for (const f of files) runnerFile(f.location,f.sha256,f.identity);
      nodeIdentity = runnerFile(policy.node.executable,policy.node.sha256,nodeIdentity);
      authority(); deadline();
      if (control.signal.aborted) failure ??= control.signal.reason;
      if (terminationRequested && !settledAfterTermination) {await settle(true); authority(); deadline();}
      need(managedSettled && doneSettled,'M3_RUNNER_MANAGED_UNSETTLED');
      const captureComplete = !!stdout && !!stderr;
      const fact = Object.freeze({commandId:command.id,commandDigest:recordDigest(command),assignmentId:assignment.id,binding:assignment.binding,
        actualExit:Number.isSafeInteger(outcome?.exitCode) ? outcome.exitCode : null,signal:typeof outcome?.signal === 'string' ? outcome.signal : null,
        timedOut,aborted:aborted || (control.signal.aborted && !timedOut),captureComplete,managedSettled,
        enforcement,settlementGraceMs:policy.settlementGraceMs,
        inventory:Object.freeze(command.inventory.map(id => Object.freeze({id,outcome:failure ? 'unknown' : 'pass'}))),
        stdoutDigest:captureComplete ? stdout.sha256 : null,stderrDigest:captureComplete ? stderr.sha256 : null,
        stdoutChunks:Object.freeze(captureComplete ? stdout.chunks : []),stderrChunks:Object.freeze(captureComplete ? stderr.chunks : []),
        status:failure ? 'failed' : 'completed',reason:failure ? failure.code ?? 'M3_RUNNER_ERROR' : null,limitations:RUNNER_SCOPE});
      deadline();
      if (timedOut && !fact.timedOut) throw runnerError('M3_RUNNER_TIMEOUT');
      const receipt = runnerOpaque(); receipts.set(receipt,fact); return receipt;
    } catch (error) {
      if (handle && !cleanupAttempted && (!managedSettled || terminationRequested && !settledAfterTermination)) {
        try {await settle(true);} catch (cleanup) {
          if (!managedSettled || !doneSettled) drainFailure = cleanup;
          throw new AggregateError([error,cleanup],'M3 runner failed to settle');
        }
      }
      if (handle && (!managedSettled || !doneSettled)) drainFailure = error;
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort',cancel); if (scope === control) scope = undefined;
    }
  }
  const api = {
    run(commandId) {
      live(); need(arguments.length === 1 && typeof commandId === 'string' && commands.has(commandId), 'M3_RUNNER_COMMAND_ID');
      need(!active,'M3_RUNNER_BUSY'); need(!admitted.has(commandId),'M3_RUNNER_COMMAND_REUSED'); admitted.add(commandId);
      const admittedAt = performance.now();
      const operation = Promise.resolve().then(() => execute(commands.get(commandId),admittedAt)); active = operation;
      operation.then(() => {if (active === operation) active = undefined;},() => {if (active === operation) active = undefined;});
      return operation;
    },
    async consume(receipt) {
      need(!stopped,'M3_RUNNER_STOPPED'); need(arguments.length === 1 && receipts.has(receipt),'M3_RUNNER_RECEIPT');
      const fact = receipts.get(receipt); receipts.delete(receipt);
      runnerVerify(authorize,undefined); need(!stopped,'M3_RUNNER_STOPPED'); verify(); return fact;
    },
    stop() {
      stopped = true; scope?.abort(runnerError('M3_RUNNER_STOPPED'));
      const drained = active ? active.then(() => undefined,() => undefined) : Promise.resolve();
      return drained.then(() => {if (drainFailure) throw drainFailure;});
    },
    close() {
      if (!closing) closing = (async () => {await api.stop(); if (replica) {await replica.close(); runnerVerify(custody.verify,custody);}})();
      return closing;
    },
  };
  return Object.freeze(api);
}
