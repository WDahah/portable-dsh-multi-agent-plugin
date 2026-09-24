import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {prepareSetup, resolveToolsModule, parseArgs, assertNode} from '../scripts/setup.mjs';
import {doctor} from '../scripts/doctor.mjs';
import {verify} from '../scripts/verify.mjs';
import {createHash} from 'node:crypto';
import {makeTempRoot} from './helpers/tmp.mjs';

// Explicit synthetic host/factory fixtures: no real host application or provider calls.
async function fixture(t) {
  const temporary = await makeTempRoot('portable-agent-setup-');
  t.after(() => fs.rm(temporary, {recursive: true, force: true})); // Only this test-created temporary tree.
  const bundle = path.join(temporary, "bundle spaces ü ' quote"), host = path.join(temporary, 'synthetic host');
  await fs.mkdir(path.join(bundle, 'src'), {recursive: true}); await fs.mkdir(host);
  await fs.writeFile(path.join(bundle, 'package.json'), JSON.stringify({name: 'synthetic-portable-fixture', type: 'module'}));
  await fs.writeFile(path.join(bundle, 'src', 'plugin.mjs'), `export function createPlugin(defineTool) { if (typeof defineTool !== 'function') throw new Error('defineTool missing'); return {inject:['tools'],apply(){throw new Error('Doctor must never apply this plugin');}}; }`);
  const toolsModule = path.join(host, 'tools.mjs');
  await fs.writeFile(toolsModule, 'export const defineTool = value => value;');
  return {temporary, bundle, host, toolsModule, stateRoot: path.join(temporary, 'private state')};
}

test('setup generates local imports and quoted patch for spaces/unicode, without applying or creating state', async t => {
  const f = await fixture(t);
  const result = await prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: f.stateRoot});
  const entry = await fs.readFile(result.entryPath, 'utf8'), patch = await fs.readFile(result.patchPath, 'utf8');
  assert.ok(entry.includes(JSON.stringify(pathToFileURL(f.toolsModule).href)));
  assert.ok(entry.includes("import { createPlugin } from '../src/plugin.mjs';"));
  assert.ok(entry.includes('export default createPlugin(defineTool);'));
  assert.ok(patch.includes(pathToFileURL(result.entryPath).href.replaceAll("'", "''")));
  assert.ok(patch.includes('enabled: true'));
  assert.equal(result.hostModified, false); assert.equal(result.providerCalls, 0);
  await assert.rejects(fs.stat(f.stateRoot), {code: 'ENOENT'});
  assert.deepEqual((await fs.readdir(path.join(f.bundle, '.local'))).sort(), ['entry.mjs', 'host-patch.yml']);
  const report = await doctor({bundleRoot: f.bundle});
  assert.equal(report.status, 'OK');
  assert.equal(report.startupPerformed, false); assert.equal(report.credentialsChecked, false); assert.equal(report.routesQualified, false);
});

test('same configuration is idempotent; moving requires regenerated local URLs', async t => {
  const f = await fixture(t), args = {bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: f.stateRoot};
  const first = await prepareSetup(args), before = await fs.readFile(first.patchPath, 'utf8');
  await prepareSetup(args); assert.equal(await fs.readFile(first.patchPath, 'utf8'), before);
  const moved = path.join(f.temporary, 'moved bundle'); await fs.rename(f.bundle, moved);
  const next = await prepareSetup({...args, bundleRoot: moved});
  const after = await fs.readFile(next.patchPath, 'utf8');
  assert.notEqual(after, before); assert.ok(after.includes(pathToFileURL(next.entryPath).href));
  assert.equal((await doctor({bundleRoot: moved})).status, 'OK');
});

test('invalid options and in-bundle state fail before creating local output', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: ''}), /absolute path/);
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: 'relative.mjs'}), /absolute path/);
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: path.join(f.host, 'missing.mjs')}), {code: 'ENOENT'});
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: path.join(f.bundle, 'history')}), /outside the portable bundle/);
  for (const control of ['\n', '\r', '\t', '\u0000', '\u007f']) {
    await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: f.stateRoot + control + 'unsafe'}), /control characters/);
  }
  await assert.rejects(fs.stat(path.join(f.bundle, '.local')), {code: 'ENOENT'});
  assert.throws(() => parseArgs(['--apply'], ['--tools-module']), /Unknown/);
  assert.throws(() => parseArgs(['--tools-module'], ['--tools-module']), /Missing/);
  assert.deepEqual(parseArgs(['--help'], ['--tools-module']), {help: true});
  assert.throws(() => assertNode('20.0.0'), /22/); assert.doesNotThrow(() => assertNode('22.0.0'));
});

test('harness-root resolves host-owned package without installing or vendoring it', async t => {
  const f = await fixture(t), packageRoot = path.join(f.host, 'node_modules', '@deepseek-ai', 'dsh-tools');
  await fs.mkdir(path.join(packageRoot, 'lib'), {recursive: true});
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({name: '@deepseek-ai/dsh-tools', type: 'module', exports: './lib/index.js'}));
  await fs.writeFile(path.join(packageRoot, 'lib', 'index.js'), 'export const defineTool = value => value;');
  const resolved = await resolveToolsModule({harnessRoot: f.host});
  assert.equal(resolved, await fs.realpath(path.join(packageRoot, 'lib', 'index.js')));
  await prepareSetup({bundleRoot: f.bundle, harnessRoot: f.host, stateRoot: f.stateRoot});
  assert.equal((await doctor({bundleRoot: f.bundle, toolsModule: resolved})).status, 'OK');
  await assert.rejects(fs.stat(path.join(f.bundle, 'node_modules')), {code: 'ENOENT'});
  await assert.rejects(resolveToolsModule({harnessRoot: f.host, toolsModule: f.toolsModule}), /exactly one/);
});

test('existing generated links and non-files cannot overwrite external data', async t => {
  const f = await fixture(t), local = path.join(f.bundle, '.local'), protectedFile = path.join(f.temporary, 'protected.mjs');
  await fs.mkdir(local); await fs.writeFile(protectedFile, 'protected');
  await fs.link(protectedFile, path.join(local, 'entry.mjs'));
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: f.stateRoot}), /Refusing linked/);
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'protected');
  await fs.unlink(path.join(local, 'entry.mjs')); // Test-owned link only.
  await fs.mkdir(path.join(local, 'host-patch.yml'));
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: f.stateRoot}), /non-regular/);
  await assert.rejects(fs.stat(path.join(local, 'entry.mjs')), {code: 'ENOENT'});
});

test('doctor explains fresh setup and detects missing defineTool without starting plugin', async t => {
  const f = await fixture(t);
  let report = await doctor({bundleRoot: f.bundle});
  assert.equal(report.status, 'NEEDS_SETUP');
  assert.match(report.checks.at(-1).detail, /setup.mjs/);
  const invalidTools = path.join(f.host, 'not-tools.mjs'); await fs.writeFile(invalidTools, 'export const unrelated = 1;');
  await prepareSetup({bundleRoot: f.bundle, toolsModule: invalidTools, stateRoot: f.stateRoot});
  report = await doctor({bundleRoot: f.bundle});
  assert.equal(report.status, 'INVALID'); assert.match(report.checks.at(-1).detail, /defineTool/);
  assert.equal(report.startupPerformed, false); assert.equal(report.hostServicesChecked, false);
});

test('integrity verifies listed files and refuses tampering, traversal and duplicate entries', async t => {
  const f = await fixture(t), filename = path.join(f.bundle, 'src', 'plugin.mjs');
  const entry = {path: 'src/plugin.mjs', sha256: createHash('sha256').update(await fs.readFile(filename)).digest('hex')};
  const manifestPath = path.join(f.bundle, 'portable-manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, files: [entry]}));
  assert.equal((await verify(f.bundle)).ok, true);
  await fs.appendFile(filename, '\n// Synthetic tamper');
  assert.deepEqual((await verify(f.bundle)).failures, ['src/plugin.mjs']);
  await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, files: [entry, entry]}));
  await assert.rejects(verify(f.bundle), /duplicate/);
  await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, files: [{...entry, path: '../outside'}]}));
  await assert.rejects(verify(f.bundle), /Unsafe/);
});

test('default state path is host-home based, never created by setup', async t => {
  const f = await fixture(t);
  const result = await prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule});
  assert.equal(result.stateRoot, path.join(os.homedir(), '.dsh', 'portable-multi-agent-state'));
  assert.equal(result.entryPath.startsWith(path.join(f.bundle, '.local') + path.sep), true);
});

import * as m4fs from 'node:fs';
import {spawn as m4spawn} from 'node:child_process';
import {prepareGovernanceSetup,readGovernanceConfigM4,governanceSetupMain} from '../scripts/setup-governance.mjs';
import {diagnoseGovernanceM4,diagnoseM0} from '../scripts/doctor-governance.mjs';
import {digest as m4Digest} from '../src/governance/contracts.mjs';
import {openGovernanceStoreV2} from '../src/governance/store.mjs';
const m4Hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const m4Deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function m4Fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'m4-setup-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const bundle=path.join(root,"bundle space ü '"),install=path.join(root,'installed host'),outputRoot=path.join(root,'candidate output');
  await fs.mkdir(path.join(bundle,'src','governance'),{recursive:true});await fs.mkdir(install);
  const plugin="export function createGovernancePluginM4(defineTool){if(typeof defineTool!=='function')throw Error('missing tool');return {name:'synthetic-governance',apply(_ctx,config){if(config.role==='preset')return;throw Error('fixture never starts host');}};}\n";
  await fs.writeFile(path.join(bundle,'src','governance','plugin.mjs'),plugin);
  await fs.writeFile(path.join(bundle,'portable-manifest.json'),JSON.stringify({schemaVersion:1,files:[{path:'src/governance/plugin.mjs',sha256:m4Hash(plugin)}]}));
  await fs.writeFile(path.join(install,'package.json'),JSON.stringify({name:'m4-synthetic-install',type:'module'}));
  const tools=path.join(install,'node_modules','@deepseek-ai','dsh-tools');await fs.mkdir(tools,{recursive:true});
  await fs.writeFile(path.join(tools,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-tools',type:'module',exports:'./index.js'}));
  await fs.writeFile(path.join(tools,'index.js'),'export const defineTool=value=>value;\n');
  const host=path.join(install,'host.mjs');await fs.writeFile(host,'export const hostFixture=true;\n');
  const git=path.join(install,'git-fixture');await fs.writeFile(git,'inert git pin');
  const roots=Object.fromEntries(['project','governance','workspace','scratch','legacy','config'].map(key=>[key,path.join(root,'runtime-'+key)]));
  const route=provider=>({provider,model:'scripted',effort:'none'}),node={executable:process.execPath,sha256:'a'.repeat(64),version:'26.9.0',systemRoot:process.env.SYSTEMROOT??root};
  const policy={schemaVersion:1,routes:{'plan-review':route('review'),author:route('author'),validator:route('validation'),reviewer:route('review')},node,
    enforcement:'guarded-native-trusted-code',settlementGraceMs:1000,testFiles:[{path:'owned.test.mjs',sha256:'b'.repeat(64)}],environmentRecipe:'systemroot-owned-temp-v1'};
  const plan={schemaVersion:2,jobId:'m4-job',projectId:m4Digest(roots.project.toLowerCase()),baseline:'d'.repeat(64),objective:'Inert M4 setup fixture',nonGoals:[],files:[],protectedTests:['owned.test.mjs'],
    criteria:[{id:'m4-test',description:'Bounded setup proof',method:'test'}],commands:[{id:'unit',executable:process.execPath,argv:['--test','--test-isolation=none','--test-reporter=tap','owned.test.mjs'],cwd:'frozen',environment:{SYSTEMROOT:node.systemRoot},timeoutMs:30000,expectedExit:0,inventory:['owned-case']}],
    policy:{planner:{id:'planner',provider:'planner'},implementerProvider:'author',correctionLimit:2},testInventory:['owned-case'],executionPolicy:policy,
    environmentDigest:m4Digest({node,enforcement:policy.enforcement,environmentRecipe:policy.environmentRecipe})};
  const config={role:'host',schemaVersion:1,mode:'diagnostic',roots,presetId:'governed-preset',receiverId:'b0e8c157-41bd-4cb4-a489-5794b7f9d9b4',
    toolchain:{git:{executable:git,sha256:m4Hash('inert git pin'),version:'git version 2.55.0.windows.5'},host:{executable:host,sha256:m4Hash(await fs.readFile(host))}},plan};
  const configPath=path.join(root,'reviewed-config.json');
  const args={bundleRoot:bundle,bundleSha256:m4Hash(await fs.readFile(path.join(bundle,'portable-manifest.json'))),installRoot:install,
    installSha256:m4Hash(await fs.readFile(path.join(install,'package.json'))),configPath,configSha256:'',outputRoot};
  async function saveConfig(){await fs.writeFile(configPath,JSON.stringify(config,null,2)+'\n');args.configSha256=m4Hash(await fs.readFile(configPath));}
  await saveConfig();return {root,bundle,install,outputRoot,tools,host,roots,config,configPath,args,saveConfig};
}
async function m4Tree(root){
  const rows=[];async function walk(dir,prefix=''){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const relative=prefix+entry.name,file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file,relative+'/');else rows.push({path:relative,sha256:m4Hash(await fs.readFile(file))});}}
  await walk(root);return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
async function m4Cli(t,argv){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'m4-doctor-cli-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const out=path.join(root,'stdout'),err=path.join(root,'stderr'),stdout=m4fs.openSync(out,'wx'),stderr=m4fs.openSync(err,'wx');let child,timedOut=false;
  try{
    child=m4spawn(process.execPath,argv,{stdio:['ignore',stdout,stderr],windowsHide:true});
    const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    const timer=setTimeout(()=>{timedOut=true;child.kill();},30000);
    let result;try{result=await done;}finally{clearTimeout(timer);}assert.equal(timedOut,false,'owned CLI completion deadline');assert.equal(result.signal,null);
    return {...result,stdout:await fs.readFile(out,'utf8'),stderr:await fs.readFile(err,'utf8')};
  }finally{m4fs.closeSync(stdout);m4fs.closeSync(stderr);}
}

test('M4 setup writes exactly five inert files with escaped file URLs and complete preset-root replacement',async t=>{
  const f=await m4Fixture(t),before=await m4Tree(f.install),result=await prepareGovernanceSetup(f.args);
  const rows=await m4Tree(f.outputRoot);assert.deepEqual(rows.map(v=>v.path).sort(),['entry.mjs','generation-report.json','governed-preset/agent.cordis.yml','governed-preset/preset.yml','host-patch.yml'].sort());
  const report=JSON.parse(await fs.readFile(result.reportPath,'utf8'));assert.equal(report.status,'complete');assert.equal(report.mode,'diagnostic');assert.equal(report.hostModified,false);
  assert.equal(result.reportSha256,m4Hash(await fs.readFile(result.reportPath)));assert.equal(report.files.length,4);
  for(const record of report.files)assert.equal(m4Hash(await fs.readFile(path.join(f.outputRoot,...record.path.split('/')))),record.sha256);
  const patch=JSON.parse(await fs.readFile(path.join(f.outputRoot,'host-patch.yml'),'utf8')),preset=JSON.parse(await fs.readFile(path.join(f.outputRoot,'governed-preset','agent.cordis.yml'),'utf8'));
  assert.deepEqual(patch[0].config,{default:'governed-preset',roots:[{path:f.outputRoot,trust:'user'}],includeShippedRoot:false,includeUserRoot:false});
  assert.equal(patch[1].insert[0].config.mode,'diagnostic');assert.equal(patch[1].insert[0].config.role,'host');assert.deepEqual(preset[0].config,{role:'preset'});
  assert.equal(patch[1].insert[0].name,pathToFileURL(path.join(f.outputRoot,'entry.mjs')).href);assert.equal(preset[0].name,patch[1].insert[0].name);
  const entry=await import(patch[1].insert[0].name);assert.equal(entry.default.name,'synthetic-governance');entry.default.apply({},preset[0].config);
  assert.equal(patch.length,2);assert.equal(patch[0].id,'agent-presets');assert.equal(patch[0].name,'@deepseek-ai/dsh-agent-presets');assert.equal(patch[0].insert,undefined);
  assert.deepEqual(Object.keys(patch[1]),['insert']);assert.equal(patch[1].insert.length,1);assert.equal(patch[1].insert[0].id,'governance-m4');
  for(const root of Object.values(f.roots))await assert.rejects(fs.stat(root),{code:'ENOENT'});
  assert.deepEqual(await m4Tree(f.install),before);assert.equal(result.hostModified,false);assert.equal(result.providerCalls,0);
});

test('M4 setup pins manifest install and config before creating any output',async t=>{
  const f=await m4Fixture(t);
  for(const key of ['bundleSha256','installSha256','configSha256']){await assert.rejects(prepareGovernanceSetup({...f.args,[key]:'0'.repeat(64)}),{code:'M4_SETUP_PIN_MISMATCH'});await assert.rejects(fs.stat(f.outputRoot),{code:'ENOENT'});}
  await fs.appendFile(path.join(f.bundle,'src','governance','plugin.mjs'),'// changed');
  await assert.rejects(prepareGovernanceSetup(f.args),{code:'M4_SETUP_BUNDLE_FILE_CHANGED'});await assert.rejects(fs.stat(f.outputRoot),{code:'ENOENT'});
});

test('M4 setup rejects same-owner sample placeholders unknown fields and nonfixed preset ID',async t=>{
  const f=await m4Fixture(t);
  for(const mutate of [()=>f.config.mode='same-owner',()=>f.config.presetId='other',()=>f.config.extra=true]){
    const saved=structuredClone(f.config);mutate();await f.saveConfig();await assert.rejects(prepareGovernanceSetup(f.args));
    for(const key of Object.keys(f.config))delete f.config[key];Object.assign(f.config,saved);
  }
  const sample=JSON.parse(await fs.readFile(new URL('../examples/governance-policy.json',import.meta.url),'utf8'));
  await fs.writeFile(f.configPath,JSON.stringify(sample));f.args.configSha256=m4Hash(await fs.readFile(f.configPath));
  await assert.rejects(prepareGovernanceSetup(f.args));await assert.rejects(fs.stat(f.outputRoot),{code:'ENOENT'});
  await assert.rejects(prepareGovernanceSetup({...f.args,overwrite:true}));
});

test('M4 absent output excludes every runtime root bundle install and configuration source',async t=>{
  const f=await m4Fixture(t);
  for(const outputRoot of [...Object.values(f.roots),path.join(f.bundle,'candidate'),path.join(f.install,'candidate'),f.configPath]){
    await assert.rejects(prepareGovernanceSetup({...f.args,outputRoot}));
  }
  await fs.mkdir(f.outputRoot);await fs.writeFile(path.join(f.outputRoot,'foreign'),'untouched');
  await assert.rejects(prepareGovernanceSetup(f.args),{code:'M4_SETUP_OUTPUT_EXISTS'});assert.equal(await fs.readFile(path.join(f.outputRoot,'foreign'),'utf8'),'untouched');
});

test('M4 traversal aliases links and hard-linked inputs cannot redirect generation',async t=>{
  const f=await m4Fixture(t);
  await assert.rejects(prepareGovernanceSetup({...f.args,outputRoot:path.dirname(f.outputRoot)+path.sep+'x'+path.sep+'..'+path.sep+'candidate'}));
  const linked=path.join(f.root,'linked-config.json');await fs.link(f.configPath,linked);
  await assert.rejects(prepareGovernanceSetup({...f.args,configPath:linked}),{code:'M4_SETUP_REGULAR_FILE'});await fs.unlink(linked);
  const alias=path.join(f.root,'bundle-alias');await fs.symlink(f.bundle,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(prepareGovernanceSetup({...f.args,bundleRoot:alias}),{code:'M4_SETUP_LINK'});await fs.unlink(alias);
  const names=path.join(f.root,'CasedRoot');await fs.mkdir(names);
  await assert.rejects(prepareGovernanceSetup({...f.args,outputRoot:path.join(f.root,'casedroot','new')}),{code:'M4_SETUP_PATH_ALIAS'});
  await assert.rejects(fs.stat(f.outputRoot),{code:'ENOENT'});
});

test('M4 exclusive concurrent generation has one winner and never overwrites output',async t=>{
  const f=await m4Fixture(t),reached=m4Deferred(),release=m4Deferred();
  const first=prepareGovernanceSetup({...f.args,failpoint:async stage=>{if(stage==='report-created'){reached.resolve();await release.promise;}}});
  await Promise.race([reached.promise,first.then(()=>{throw Error('setup completed before barrier');})]);
  await assert.rejects(prepareGovernanceSetup(f.args),{code:'M4_SETUP_OUTPUT_EXISTS'});release.resolve();assert.equal((await first).status,'complete');
});

test('M4 generation failure retains incomplete indexed report and never deletes foreign replacement',async t=>{
  const f=await m4Fixture(t);let original;
  await assert.rejects(prepareGovernanceSetup({...f.args,failpoint:async stage=>{if(stage==='after:entry.mjs'){
    original=await fs.readFile(path.join(f.outputRoot,'entry.mjs'),'utf8');await fs.unlink(path.join(f.outputRoot,'entry.mjs'));await fs.writeFile(path.join(f.outputRoot,'entry.mjs'),'FOREIGN');
  }}}));
  const report=JSON.parse(await fs.readFile(path.join(f.outputRoot,'generation-report.json'),'utf8'));assert.equal(report.status,'incomplete');assert.equal(report.files[0].sha256,m4Hash(original));
  assert.equal(await fs.readFile(path.join(f.outputRoot,'entry.mjs'),'utf8'),'FOREIGN');await assert.rejects(fs.stat(path.join(f.outputRoot,'host-patch.yml')),{code:'ENOENT'});
});

test('M4 late pin mutation is rechecked after callback before the next file effect',async t=>{
  const f=await m4Fixture(t);
  await assert.rejects(prepareGovernanceSetup({...f.args,failpoint:stage=>{if(stage==='report-created')m4fs.appendFileSync(f.configPath,' ');}}),{code:'M4_SETUP_FILE_CHANGED'});
  const report=JSON.parse(await fs.readFile(path.join(f.outputRoot,'generation-report.json'),'utf8'));assert.equal(report.status,'incomplete');assert.equal(report.files.length,0);
  await assert.rejects(fs.stat(path.join(f.outputRoot,'entry.mjs')),{code:'ENOENT'});
});

test('M4 setup never unlinks replaced output root or report identities',async t=>{
  const f=await m4Fixture(t),retained=path.join(f.root,'retained-candidate');
  await assert.rejects(prepareGovernanceSetup({...f.args,failpoint:async stage=>{if(stage==='report-created'){
    await fs.rename(f.outputRoot,retained);await fs.mkdir(f.outputRoot);await fs.writeFile(path.join(f.outputRoot,'generation-report.json'),'FOREIGN');
  }}}));
  assert.equal(await fs.readFile(path.join(f.outputRoot,'generation-report.json'),'utf8'),'FOREIGN');
  assert.equal(JSON.parse(await fs.readFile(path.join(retained,'generation-report.json'),'utf8')).status,'incomplete');
});

test('M4 generation report replacement is retained without foreign overwrite',async t=>{
  const f=await m4Fixture(t),retained=path.join(f.root,'retained-report.json');
  await assert.rejects(prepareGovernanceSetup({...f.args,failpoint:async stage=>{if(stage==='report-created'){
    await fs.rename(path.join(f.outputRoot,'generation-report.json'),retained);await fs.writeFile(path.join(f.outputRoot,'generation-report.json'),'FOREIGN REPORT');
  }}}));
  assert.equal(await fs.readFile(path.join(f.outputRoot,'generation-report.json'),'utf8'),'FOREIGN REPORT');
  assert.equal(JSON.parse(await fs.readFile(retained,'utf8')).status,'incomplete');
});

test('M4 final callback failure rewrites only the original complete report to incomplete',async t=>{
  const f=await m4Fixture(t);await assert.rejects(prepareGovernanceSetup({...f.args,failpoint:stage=>{if(stage==='report-complete')throw Error('injected final failure');}}));
  const report=JSON.parse(await fs.readFile(path.join(f.outputRoot,'generation-report.json'),'utf8'));assert.equal(report.status,'incomplete');assert.equal(report.files.length,4);
});

test('M4 changed runtime-root presence and extra output files never produce completion',async t=>{
  const f=await m4Fixture(t);await assert.rejects(prepareGovernanceSetup({...f.args,failpoint:stage=>{if(stage==='report-created')m4fs.mkdirSync(f.roots.workspace);}}),{code:'M4_SETUP_RUNTIME_ROOT_CHANGED'});
  assert.equal(JSON.parse(await fs.readFile(path.join(f.outputRoot,'generation-report.json'),'utf8')).status,'incomplete');
  const g=await m4Fixture(t);await assert.rejects(prepareGovernanceSetup({...g.args,failpoint:stage=>{if(stage==='after:governed-preset/preset.yml')m4fs.writeFileSync(path.join(g.outputRoot,'extra'),'foreign extra');}}),{code:'M4_SETUP_EXTRA_OUTPUT'});
  assert.equal(await fs.readFile(path.join(g.outputRoot,'extra'),'utf8'),'foreign extra');assert.equal(JSON.parse(await fs.readFile(path.join(g.outputRoot,'generation-report.json'),'utf8')).status,'incomplete');
});

test('M4 manifest traversal alias duplicate and unpinned plugin refuse before generation',async t=>{
  const f=await m4Fixture(t),manifestPath=path.join(f.bundle,'portable-manifest.json'),base=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  for(const files of [[{...base.files[0],path:'../outside'}],[base.files[0],base.files[0]],[{...base.files[0],path:'.local/entry.mjs'}],[]]){
    await fs.writeFile(manifestPath,JSON.stringify({...base,files}));f.args.bundleSha256=m4Hash(await fs.readFile(manifestPath));
    await assert.rejects(prepareGovernanceSetup(f.args));await assert.rejects(fs.stat(f.outputRoot),{code:'ENOENT'});
  }
});

test('M4 closed setup CLI generates only candidate files and rejects duplicate options',async t=>{
  const f=await m4Fixture(t),argv=['scripts/setup-governance.mjs'];
  for(const [flag,key]of [['--bundle-root','bundleRoot'],['--bundle-sha256','bundleSha256'],['--install-root','installRoot'],['--install-sha256','installSha256'],['--config','configPath'],['--config-sha256','configSha256'],['--output-root','outputRoot']])argv.push(flag,f.args[key]);
  const result=await m4Cli(t,argv);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'complete');
  for(const root of Object.values(f.roots))await assert.rejects(fs.stat(root),{code:'ENOENT'});
  const duplicate=await m4Cli(t,[...argv,'--output-root',f.outputRoot]);assert.equal(duplicate.code,1);assert.match(duplicate.stderr,/M4_SETUP_CLI/);
});

test('M4 doctor config inspection is closed read-only and does not validate live startup authority',async t=>{
  const f=await m4Fixture(t),before=await m4Tree(f.root),report=await diagnoseGovernanceM4({kind:'config',configPath:f.configPath});
  assert.equal(report.consistent,true);assert.equal(report.executionEligible,false);assert.equal(report.origin,'unauthenticated-diagnostic');assert.equal(report.headAuthenticity,'unproven');
  assert.equal(report.hostStarted,false);assert.equal(report.locksCreated,0);assert.equal(report.reason,'STARTUP_NOT_PROBED');assert.ok(!JSON.stringify(report).includes(f.root));
  assert.deepEqual(await m4Tree(f.root),before);assert.equal(readGovernanceConfigM4(f.configPath).sha256,f.args.configSha256);
  await assert.rejects(diagnoseGovernanceM4({kind:'config',configPath:f.configPath,repair:true}));await assert.rejects(diagnoseGovernanceM4({kind:'activate',configPath:f.configPath}));
});

test('M4 doctor cold state diagnosis never creates an absent store or lock',async t=>{
  const f=await m4Fixture(t),before=await m4Tree(f.root);
  const report=await diagnoseGovernanceM4({kind:'state',configPath:f.configPath});assert.equal(report.headAuthenticity,'unproven');
  assert.equal(report.consistent,false);assert.ok(!JSON.stringify(report).includes(f.root));
  assert.deepEqual(await m4Tree(f.root),before);await assert.rejects(fs.stat(f.roots.governance),{code:'ENOENT'});
});

test('M4 doctor diagnoses a closed v2 store without reconstructing authority',async t=>{
  const f=await m4Fixture(t);await fs.mkdir(f.roots.project);
  const store=await openGovernanceStoreV2({root:f.roots.governance,projectRoot:f.roots.project,protectedRoots:[f.roots.workspace,f.roots.scratch,f.roots.legacy,f.roots.config]});
  await store.close();const before=await m4Tree(f.root),report=await diagnoseGovernanceM4({kind:'state',configPath:f.configPath});
  assert.equal(report.origin,'cold-diagnostic');assert.equal(report.headAuthenticity,'unproven');assert.equal(report.status.admission,false);assert.equal(report.status.attemptsRemaining,null);
  assert.equal(report.status.accepted,false);assert.equal(report.status.refusalReason,'RECONCILIATION_REQUIRED');assert.deepEqual(await m4Tree(f.root),before);
});

test('M4 doctor preserves M0 report API and closed CLI while rejecting repairs',async t=>{
  const f=await m4Fixture(t),reportFile=path.join(f.root,'m0.json');await fs.writeFile(reportFile,JSON.stringify({kind:'m0-live-report',checks:[]}));
  assert.equal((await diagnoseM0(reportFile)).decision,'NO_GO');
  const old=await m4Cli(t,['scripts/doctor-governance.mjs','--report',reportFile]);assert.equal(old.code,2);assert.equal(JSON.parse(old.stdout).implementationAuthorized,false);
  const diagnostic=await m4Cli(t,['scripts/doctor-governance.mjs','--config',f.configPath]);assert.equal(diagnostic.code,0);assert.equal(JSON.parse(diagnostic.stdout).hostStarted,false);
  const unknown=await m4Cli(t,['scripts/doctor-governance.mjs','--config',f.configPath,'--repair']);assert.equal(unknown.code,1);assert.match(unknown.stderr,/Usage:/);
  await assert.rejects(governanceSetupMain(['--output-root',f.outputRoot,'--apply','yes']));
});
