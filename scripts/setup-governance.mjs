import * as fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateGovernanceConfigM4} from '../src/governance/host.mjs';
import {ownedJson,relativePath} from '../src/governance/contracts.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code),{code});
const need = (value,code) => {if (!value) throw fail(code);};
const HASH = /^[a-f0-9]{64}$/;
const OUTPUTS = Object.freeze(['entry.mjs','host-patch.yml','governed-preset/agent.cordis.yml','governed-preset/preset.yml']);
const REPORT = 'generation-report.json';
const rootIdentity = st => [st.dev,st.ino,st.mode].join(':');
const fileIdentity = st => [st.dev,st.ino,st.nlink,st.mode,st.size,st.mtimeNs,st.ctimeNs].join(':');
const stat = p => fs.lstatSync(p,{bigint:true});
const samePath = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function absolute(value) {
  need(typeof value === 'string' && path.isAbsolute(value) && value === path.normalize(value) &&
    value !== path.parse(value).root && !/[\x00-\x1f\x7f]/.test(value), 'M4_SETUP_ABSOLUTE_CANONICAL_PATH');
  need(!value.split(/[\\/]/).some(p => p === '.' || p === '..' || /[ .]$/.test(p)), 'M4_SETUP_PATH_ALIAS');
  if (process.platform === 'win32') need(/^[A-Za-z]:[\\/]/.test(value) && !/[<>"|?*]/.test(value) && !value.slice(2).includes(':'), 'M4_SETUP_PATH_ALIAS');
  return value;
}
function disjoint(a,b) {
  const rel = path.relative(a,b);
  return rel === '..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel);
}
function separate(a,b) {need(disjoint(a,b) && disjoint(b,a),'M4_SETUP_PROTECTED_OVERLAP');}
function ordinaryPath(value,{missing=false,directory=false} = {}) {
  const target = absolute(value), root = path.parse(target).root, parts = target.slice(root.length).split(path.sep), parents = [];
  let current = root;
  for (let index = 0; index <= parts.length; index++) {
    let st;
    try {st=stat(current);} catch (error) {
      if (error.code === 'ENOENT' && missing) return {path:target,parents,exists:false};
      throw error;
    }
    need(!st.isSymbolicLink(),'M4_SETUP_LINK');
    const leaf = index === parts.length;
    if (!leaf || directory) need(st.isDirectory(),'M4_SETUP_DIRECTORY');
    else need(st.isFile() && st.nlink === 1n,'M4_SETUP_REGULAR_FILE');
    need(st.ino > 0n,'M4_SETUP_IDENTITY');
    need(samePath(fs.realpathSync.native(current),current),'M4_SETUP_PATH_ALIAS');
    if (!leaf || directory) parents.push([current,rootIdentity(st)]);
    if (leaf) {
      const real = fs.realpathSync.native(current);
      need(samePath(real,current),'M4_SETUP_PATH_ALIAS');
      return {path:target,parents,exists:true};
    }
    const names = fs.readdirSync(current), part = parts[index];
    need(!names.some(name => name !== part && name.toLowerCase() === part.toLowerCase()),'M4_SETUP_PATH_ALIAS');
    current=path.join(current,part);
  }
}
function verifyParents(parents) {
  for (const [p,identity] of parents) {const st=stat(p);need(st.isDirectory() && !st.isSymbolicLink() && rootIdentity(st)===identity&&samePath(fs.realpathSync.native(p),p),'M4_SETUP_PARENT_CHANGED');}
}
function fileSnapshot(file,maxBytes=1048576) {
  const location=ordinaryPath(file), before=stat(file);
  need(before.size>=0n && before.size<=BigInt(maxBytes),'M4_SETUP_INPUT_LIMIT');
  const identity=fileIdentity(before),fd=fs.openSync(file,'r');let bytes;
  try {
    need(fileIdentity(fs.fstatSync(fd,{bigint:true}))===identity,'M4_SETUP_FILE_CHANGED');
    bytes=fs.readFileSync(fd);need(fileIdentity(fs.fstatSync(fd,{bigint:true}))===identity,'M4_SETUP_FILE_CHANGED');
  } finally {fs.closeSync(fd);}
  verifyParents(location.parents);need(fileIdentity(stat(file))===identity,'M4_SETUP_FILE_CHANGED');
  return {file,identity,parents:location.parents,bytes,sha256:hash(bytes)};
}
function verifyFile(record) {
  verifyParents(record.parents);
  need(fileIdentity(stat(record.file))===record.identity,'M4_SETUP_FILE_CHANGED');
  const next=fileSnapshot(record.file,Math.max(record.bytes.length,1));
  need(next.identity===record.identity && next.sha256===record.sha256,'M4_SETUP_FILE_CHANGED');
}
function readJson(record) {
  const text=record.bytes.toString('utf8');need(Buffer.from(text,'utf8').equals(record.bytes),'M4_SETUP_INVALID_UTF8');
  return ownedJson(JSON.parse(text));
}
function options(input) {
  need(input && Object.getPrototypeOf(input)===Object.prototype,'M4_SETUP_OPTIONS');
  const required=['bundleRoot','bundleSha256','installRoot','installSha256','configPath','configSha256','outputRoot'];
  const keys=Reflect.ownKeys(input);need(required.every(k=>keys.includes(k)) && keys.every(k=>[...required,'failpoint'].includes(k)),'M4_SETUP_OPTIONS');
  for(const key of keys) need(Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value'),'M4_SETUP_OPTIONS');
  for(const key of ['bundleSha256','installSha256','configSha256']) need(HASH.test(input[key]),'M4_SETUP_PIN');
  need(input.failpoint===undefined || typeof input.failpoint==='function','M4_SETUP_OPTIONS');return input;
}

/** Read-only config inspection: no imports of generated entries, host startup or root allocation. */
export function readGovernanceConfigM4(configPath) {
  const snapshot=fileSnapshot(configPath),config=validateGovernanceConfigM4(readJson(snapshot));
  const roots=Object.values(config.roots);roots.forEach(root=>ordinaryPath(root,{missing:true,directory:true}));
  for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)separate(roots[i],roots[j]);
  verifyFile(snapshot);return {config,sha256:snapshot.sha256};
}

/** Generate an inert candidate only. All inputs are explicit owner selections; no installed profile is changed. */
export async function prepareGovernanceSetup(input) {
  const o=options(input),bundle=ordinaryPath(o.bundleRoot,{directory:true}),install=ordinaryPath(o.installRoot,{directory:true});
  const outputRoot=absolute(o.outputRoot),candidate=ordinaryPath(outputRoot,{missing:true,directory:true});
  need(!candidate.exists,'M4_SETUP_OUTPUT_EXISTS');
  ordinaryPath(path.dirname(outputRoot),{directory:true});
  const manifest=fileSnapshot(path.join(bundle.path,'portable-manifest.json'));
  const installed=fileSnapshot(path.join(install.path,'package.json'));
  const supplied=fileSnapshot(o.configPath);
  need(manifest.sha256===o.bundleSha256 && installed.sha256===o.installSha256 && supplied.sha256===o.configSha256,'M4_SETUP_PIN_MISMATCH');
  const config=validateGovernanceConfigM4(readJson(supplied));
  need(config.mode==='diagnostic','M4_SETUP_DIAGNOSTIC_ONLY');
  need(config.presetId==='governed-preset','M4_SETUP_PRESET_ID');
  const roots=Object.values(config.roots),runtimePaths=roots.map(root=>ordinaryPath(root,{missing:true,directory:true}));
  for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)separate(roots[i],roots[j]);
  for(const protectedPath of [...roots,bundle.path,install.path,supplied.file])separate(outputRoot,protectedPath);
  const inputs=[manifest,installed,supplied],parsed=readJson(manifest);
  need(parsed.schemaVersion===1 && Array.isArray(parsed.files) && parsed.files.length>0 && parsed.files.length<=10000,'M4_SETUP_MANIFEST');
  const seen=new Set();let totalInputBytes=0;
  for(const row of parsed.files) {
    need(row && Object.keys(row).length===2 && typeof row.path==='string' && HASH.test(row.sha256),'M4_SETUP_MANIFEST');relativePath(row.path);
    need(!seen.has(row.path.toLowerCase()) && !/^(?:\.local|node_modules|state)(?:\/|$)/i.test(row.path) && row.path!=='portable-manifest.json','M4_SETUP_MANIFEST');
    seen.add(row.path.toLowerCase());const record=fileSnapshot(path.join(bundle.path,...row.path.split('/')),67108864);
    need(record.sha256===row.sha256,'M4_SETUP_BUNDLE_FILE_CHANGED');totalInputBytes+=record.bytes.length;
    need(totalInputBytes<=67108864,'M4_SETUP_BUNDLE_LIMIT');inputs.push(record);
  }
  need(seen.has('src/governance/plugin.mjs'),'M4_SETUP_PLUGIN_NOT_PINNED');
  const toolsSelected=createRequire(path.join(install.path,'package.json')).resolve('@deepseek-ai/dsh-tools');
  // Package-manager links select installed modules only; all retained I/O uses their exact canonical targets.
  const toolsPath=fs.realpathSync.native(toolsSelected);
  const tools=fileSnapshot(toolsPath,16777216),host=fileSnapshot(config.toolchain.host.executable,16777216);
  need(host.sha256===config.toolchain.host.sha256,'M4_SETUP_HOST_PIN');inputs.push(tools,host);
  for(const record of inputs)separate(outputRoot,record.file);
  const verifyInputs=()=>{
    verifyParents(bundle.parents);verifyParents(install.parents);
    for(const record of runtimePaths){verifyParents(record.parents);const current=ordinaryPath(record.path,{missing:true,directory:true});need(current.exists===record.exists,'M4_SETUP_RUNTIME_ROOT_CHANGED');}
    for(const record of inputs)verifyFile(record);
  };
  verifyInputs();verifyParents(candidate.parents);
  fs.mkdirSync(outputRoot,{mode:0o700});
  const output=ordinaryPath(outputRoot,{directory:true}),created=new Map(),dirs=new Map([[outputRoot,rootIdentity(stat(outputRoot))]]);
  let reportFd,reportIdentity,reportHash,complete=false,primaryError;
  const report={kind:'m4-inert-generation',schemaVersion:1,status:'incomplete',mode:'diagnostic',hostModified:false,hostStarted:false,
    providerCalls:0,operationallyAccepted:false,pins:{bundleSha256:manifest.sha256,installSha256:installed.sha256,configSha256:supplied.sha256,
      toolsSha256:tools.sha256,hostSha256:host.sha256},expectedFiles:[...OUTPUTS,REPORT],files:[],reason:null};
  const verifyOutput=(contents=true)=>{
    verifyParents(output.parents);
    for(const [p,identity] of dirs){const st=stat(p);need(st.isDirectory()&&!st.isSymbolicLink()&&rootIdentity(st)===identity,'M4_SETUP_OUTPUT_CHANGED');}
    if(contents)for(const record of created.values())verifyFile(record);
    if(reportIdentity!==undefined){const current=stat(path.join(outputRoot,REPORT));
      need(current.isFile()&&!current.isSymbolicLink()&&current.nlink===1n&&rootIdentity(current)===reportIdentity,'M4_SETUP_REPORT_CHANGED');
      if(reportFd!==undefined)need(rootIdentity(fs.fstatSync(reportFd,{bigint:true}))===reportIdentity,'M4_SETUP_REPORT_CHANGED');}
  };
  const saveReport=(contents=true)=>{
    verifyOutput(contents);const file=path.join(outputRoot,REPORT),bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
    if(reportHash!==undefined)need(fileSnapshot(file).sha256===reportHash,'M4_SETUP_REPORT_CHANGED');
    if(reportFd===undefined)reportFd=fs.openSync(file,'r+');
    try {
      verifyOutput(contents);fs.ftruncateSync(reportFd,0);let offset=0;while(offset<bytes.length)offset+=fs.writeSync(reportFd,bytes,offset,bytes.length-offset,offset);
      fs.fsyncSync(reportFd);reportHash=hash(bytes);verifyOutput(contents);
    } finally {fs.closeSync(reportFd);reportFd=undefined;}
    const final=fileSnapshot(file);need(rootIdentity(stat(file))===reportIdentity&&final.sha256===reportHash,'M4_SETUP_REPORT_CHANGED');
  };
  const hit=async stage=>{if(o.failpoint)await o.failpoint(stage);verifyInputs();verifyOutput();};
  try {
    reportFd=fs.openSync(path.join(outputRoot,REPORT),'wx',0o600);reportIdentity=rootIdentity(fs.fstatSync(reportFd,{bigint:true}));saveReport();
    await hit('report-created');
    const entryPath=path.join(outputRoot,'entry.mjs'),pluginPath=path.join(bundle.path,'src','governance','plugin.mjs');
    const entry=`// Inert generated candidate. Setup never mounts or activates this entry.\nimport {defineTool} from ${JSON.stringify(pathToFileURL(toolsPath).href)};\nimport {createGovernancePluginM4} from ${JSON.stringify(pathToFileURL(pluginPath).href)};\nexport default createGovernancePluginM4(defineTool);\n`;
    const patch=[{id:'agent-presets',name:'@deepseek-ai/dsh-agent-presets',config:{default:'governed-preset',
      roots:[{path:outputRoot,trust:'user'}],includeShippedRoot:false,includeUserRoot:false}},
      {insert:[{id:'governance-m4',name:pathToFileURL(entryPath).href,config}]}];
    const contents=new Map([['entry.mjs',entry],['host-patch.yml',JSON.stringify(patch,null,2)+'\n'],
      ['governed-preset/agent.cordis.yml',JSON.stringify([{id:'governed-preset',name:pathToFileURL(entryPath).href,config:{role:'preset'}}],null,2)+'\n'],
      ['governed-preset/preset.yml',JSON.stringify({name:'Inert governed M4 candidate',description:'No raw tools; diagnostic host prerequisite. Setup does not install or activate.'},null,2)+'\n']]);
    for(const relative of OUTPUTS) {
      await hit('before:'+relative);
      const file=path.join(outputRoot,...relative.split('/')),dir=path.dirname(file);
      if(!dirs.has(dir)){fs.mkdirSync(dir,{mode:0o700});dirs.set(dir,rootIdentity(stat(dir)));}
      verifyOutput();const fd=fs.openSync(file,'wx',0o600),identity=rootIdentity(fs.fstatSync(fd,{bigint:true}));
      try {fs.writeFileSync(fd,contents.get(relative),'utf8');fs.fsyncSync(fd);need(rootIdentity(fs.fstatSync(fd,{bigint:true}))===identity,'M4_SETUP_OUTPUT_CHANGED');}
      finally {fs.closeSync(fd);}
      const record=fileSnapshot(file);need(rootIdentity(stat(file))===identity,'M4_SETUP_OUTPUT_CHANGED');created.set(relative,record);
      report.files.push({path:relative,bytes:record.bytes.length,sha256:record.sha256});saveReport();await hit('after:'+relative);
    }
    verifyInputs();verifyOutput();
    need(fs.readdirSync(outputRoot).sort().join('\n')===['entry.mjs','generation-report.json','governed-preset','host-patch.yml'].sort().join('\n') &&
      fs.readdirSync(path.join(outputRoot,'governed-preset')).sort().join('\n')==='agent.cordis.yml\npreset.yml','M4_SETUP_EXTRA_OUTPUT');
    report.status='complete';saveReport();await hit('report-complete');complete=true;
  } catch(error) {
    primaryError=error;report.status='incomplete';report.reason=typeof error.code==='string'?error.code:'M4_SETUP_GENERATION_FAILED';
    try {if(reportIdentity!==undefined)saveReport(false);}catch(retentionError){primaryError=new AggregateError([error,retentionError],'M4 setup failed; retained report cannot be rewritten safely');}
  } finally {
    if(reportFd!==undefined){fs.closeSync(reportFd);reportFd=undefined;}
    if(reportIdentity!==undefined)try{const final=fileSnapshot(path.join(outputRoot,REPORT));need(rootIdentity(stat(final.file))===reportIdentity&&final.sha256===reportHash,'M4_SETUP_REPORT_CHANGED');}
    catch(error){primaryError??=error;complete=false;}
  }
  if(primaryError){primaryError.generationRoot=outputRoot;throw primaryError;}
  need(complete,'M4_SETUP_INCOMPLETE');verifyInputs();verifyOutput();
  return ownedJson({outputRoot,reportPath:path.join(outputRoot,REPORT),reportSha256:reportHash,status:'complete',mode:'diagnostic',hostModified:false,providerCalls:0});
}

export const GOVERNANCE_SETUP_HELP='Usage: node scripts/setup-governance.mjs --bundle-root <absolute> --bundle-sha256 <manifest-hash> --install-root <absolute> --install-sha256 <package-hash> --config <absolute-json> --config-sha256 <hash> --output-root <absent-absolute>\nGenerates only an inert candidate directory. Does not install, mount, start a host, or create runtime roots.';
export async function governanceSetupMain(argv=process.argv.slice(2)) {
  if(argv.length===1&&['--help','-h'].includes(argv[0])){console.log(GOVERNANCE_SETUP_HELP);return;}
  const keys={'--bundle-root':'bundleRoot','--bundle-sha256':'bundleSha256','--install-root':'installRoot','--install-sha256':'installSha256','--config':'configPath','--config-sha256':'configSha256','--output-root':'outputRoot'},input={};
  for(let i=0;i<argv.length;i+=2){const key=keys[argv[i]];need(key&&!Object.hasOwn(input,key)&&typeof argv[i+1]==='string'&&!argv[i+1].startsWith('--'),'M4_SETUP_CLI');input[key]=argv[i+1];}
  const result=await prepareGovernanceSetup(input);console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))governanceSetupMain().catch(error=>{console.error(error.code??error.message);process.exitCode=1;});
