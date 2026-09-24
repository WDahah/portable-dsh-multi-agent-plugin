import path from 'node:path';
import * as fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {types} from 'node:util';
import {AsyncLocalStorage} from 'node:async_hooks';
import {PROVENANCE, LIMITS, ownedJson, canonicalize, digest, same, need, exact, id, hash, integer,
  relativePath, validateActor, validatePlan, validateAssignment, validateDecision, validateResult,
  planIdentity, bindingFor} from './contracts.mjs';
import {assertModelMutation, assertModelMutationV2} from './controller.mjs';
import {V2_PROVENANCE, validateStateV2, validatePlanV2, validateActorV2, validateAssignmentV2,
  validateDecisionV2, validateResultV2, validateCandidateDescriptorV2, planIdentityV2, bindingForV2,
  validateDeliveryReceiptM4B,validateDeliveryMarkerM4B} from './contracts.mjs';

// Offline fixture capabilities only. Importing this module performs no I/O.
export const WORKSPACE_LIMITS = Object.freeze({files:256,deletions:256,depth:16,path:512,
  fileBytes:1048576,totalBytes:16777216,readBytes:16384,editBytes:16384,queue:64,
  mutations:4096,metadataEntries:4096,metadataBytes:67108864,captureBytes:1048576,gitDeadlineMs:15000});
const authors = new WeakMap(), views = new WeakMap(), custodians = new WeakMap(), custodyLeases = new WeakMap();
// Caches only exact spelling facts under unchanged, freshly observed parent identities.
const pathScope = new AsyncLocalStorage();
const newPathCache = () => ({parents:new Map(),entries:0});
// Reuse is restricted to a single synchronous read-only walk, never a callback or await.
const withPaths = fn => pathScope.run(newPathCache(),fn);
const WIN = process.platform === 'win32';
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MODES = new Set(['100644','100755']);
const error = (code,cause) => Object.assign(new Error(code,cause === undefined ? undefined : {cause}),{code});
const rawHash = bytes => createHash('sha256').update(bytes).digest('hex');
const blobHash = bytes => createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const fold = p => WIN ? p.toLowerCase() : p;
const sortRows = rows => rows.sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const opaque = () => Object.freeze(Object.create(null));

function closed(value,required,optional=[]) {
  need(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,'CLOSED_SCHEMA');
  const keys = Reflect.ownKeys(value), allowed = [...required,...optional];
  need(keys.every(k=>typeof k === 'string' && allowed.includes(k)) && required.every(k=>keys.includes(k)),'CLOSED_SCHEMA');
  const out = {};
  for(const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value,key);
    need(d && Object.hasOwn(d,'value') && d.enumerable,'INVALID_DESCRIPTOR');
    Object.defineProperty(out,key,{value:d.value,enumerable:true});
  }
  return out;
}
function deepFrozen(value) {
  const seen=new Set(); let nodes=0;
  function visit(item,depth) {
    need(depth <= LIMITS.depth && ++nodes <= LIMITS.nodes,'STRUCTURE_LIMIT');
    if(item === null || typeof item !== 'object') return;
    need(!types.isProxy(item) && Object.isFrozen(item) && !seen.has(item),'MUTABLE_AUTHORITY'); seen.add(item);
    const array=Array.isArray(item),keys=Reflect.ownKeys(item);
    need(keys.length <= LIMITS.nodes+(array?1:0),'STRUCTURE_LIMIT');
    for(const key of keys) {
      const d=Object.getOwnPropertyDescriptor(item,key); need(d && Object.hasOwn(d,'value'),'INVALID_DESCRIPTOR');
      if(array && key === 'length') continue;
      visit(d.value,depth+1);
    }
    seen.delete(item);
  }
  visit(value,0);
}
function portable(p) {
  relativePath(p);
  need(p.length <= WORKSPACE_LIMITS.path && p.split('/').length <= WORKSPACE_LIMITS.depth &&
    p.split('/').every(s=>/^[A-Za-z0-9._-]+$/.test(s)),'INVALID_PATH');
  return p;
}
function forbidden(p) {
  return p.split('/').some(s=>['.git','node_modules','.local'].includes(s.toLowerCase()));
}
function pathSet(paths) {
  const names = new Map(), files = new Set();
  for(const p of paths) {
    portable(p); const parts = p.split('/'); let prefix = '';
    for(let i=0;i<parts.length;i++) {
      prefix += (i ? '/' : '')+parts[i]; const key = prefix.toLowerCase();
      need(!names.has(key) || names.get(key) === prefix,'PATH_ALIAS'); names.set(key,prefix);
      if(i < parts.length-1) need(!files.has(key),'PATH_PREFIX_CONFLICT');
    }
    const key = p.toLowerCase(); need(!files.has(key),'DUPLICATE_PATH');
    need(![...names.keys()].some(n=>n.startsWith(key+'/')),'PATH_PREFIX_CONFLICT'); files.add(key);
  }
}
function rawText(value,max) {
  need(typeof value === 'string','INVALID_TEXT');
  need(!value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),'INVALID_TEXT');
  need(Buffer.byteLength(value,'utf8') <= max,'TEXT_TOO_LARGE'); return value;
}
function textBytes(bytes) {
  const text = bytes.toString('utf8'); need(Buffer.from(text,'utf8').equals(bytes),'INVALID_UTF8');
  need(!text.includes('\0'),'INVALID_TEXT'); return text;
}
function maybeStat(file) { try { return lstat(file); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } }
// NTFS inode values routinely exceed 2^53. Never compare rounded Number identities.
function statValue(raw) {
  need(raw.size >= 0n && raw.size <= BigInt(Number.MAX_SAFE_INTEGER),'UNSUPPORTED_SIZE');
  return {dev:raw.dev.toString(),ino:raw.ino.toString(),nlink:raw.nlink.toString(),size:Number(raw.size),mode:Number(raw.mode),
    mtime:raw.mtimeNs.toString(),ctime:raw.ctimeNs.toString(),
    isFile:()=>raw.isFile(),isDirectory:()=>raw.isDirectory(),isSymbolicLink:()=>raw.isSymbolicLink()};
}
const lstat = file => statValue(fs.lstatSync(file,{bigint:true}));
const fstat = fd => statValue(fs.fstatSync(fd,{bigint:true}));
function identity(st) {
  need(/^[0-9]+$/.test(st.dev) && /^[1-9][0-9]*$/.test(st.ino) && /^[1-9][0-9]*$/.test(st.nlink),'UNSUPPORTED_IDENTITY');
  return [st.dev,st.ino,st.nlink,st.size,st.mode,st.mtime,st.ctime].join(':');
}
function regular(st,allowHardlinks=false) {
  need(st && st.isFile() && !st.isSymbolicLink(),'UNSUPPORTED_FILE_TYPE');
  identity(st); need(allowHardlinks || st.nlink === '1','LINKED_FILE');
}
function ordinaryDirectory(st) { need(st && st.isDirectory() && !st.isSymbolicLink(),'UNSUPPORTED_DIRECTORY'); identity(st); }
function nonemptyDirectory(dir) {
  ordinaryDirectory(lstat(dir)); const handle=fs.opendirSync(dir);
  try { return handle.readSync() !== null; } finally { handle.closeSync(); }
}
function boundedNames(dir,max=WORKSPACE_LIMITS.metadataEntries) {
  const result = [], handle = fs.opendirSync(dir);
  try { for(let e;(e=handle.readSync()) !== null;) { need(result.length < max,'ENTRY_LIMIT'); result.push(e.name); } }
  finally { handle.closeSync(); }
  return result.sort();
}
function absolute(input) {
  need(typeof input === 'string' && input.length > 0 && input.length <= 4096 && path.isAbsolute(input) && !/[\x00-\x1f\x7f]/.test(input),'INVALID_ROOT');
  if(WIN) need(/^[A-Za-z]:[\\/]/.test(input) && !/[<>"|?*]/.test(input) && !input.slice(2).includes(':'),'INVALID_ROOT');
  else need(!input.startsWith('//'),'INVALID_ROOT');
  const parsed = path.parse(input), rest = input.slice(parsed.root.length).split(WIN ? /[\\/]/ : /\//);
  need(rest.every((s,i)=>s !== '.' && s !== '..' && (s !== '' || i === rest.length-1) && (!WIN || !s ||
    (!/[ .]$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))),'INVALID_ROOT');
  const normalized = path.normalize(input); need(normalized !== path.parse(normalized).root,'ROOT_TOO_BROAD');
  return normalized.endsWith(path.sep) ? normalized.slice(0,-1) : normalized;
}
// Every existing ancestor is checked, not just the final realpath. No openat sandbox is claimed.
function checkedPath(input,{missing=false,file=false,tool=false}={}) {
  const target = absolute(input), root = path.parse(target).root;
  let current = root, lastExisting=root, absent = false;
  const parts = target.slice(root.length).split(path.sep);
  ordinaryDirectory(lstat(root));
  for(let i=0;i<parts.length;i++) {
    const part = parts[i], next = path.join(current,part);
    if(!absent) {
      const cache=pathScope.getStore(), parent=lstat(current); ordinaryDirectory(parent);
      const parentIdentity=identity(parent),cached=cache?.parents.get(current);
      let names=cached?.parentIdentity === parentIdentity ? cached.names : null;
      // Windows directory timestamps may lag an open create. Never cache absence.
      if(!names || !names.has(part)) {
        names=new Set(boundedNames(current,65536));
        if(cache && names.size <= 8192) {
          if(cached) { cache.entries-=cached.names.size; cache.parents.delete(current); }
          if(cache.entries+names.size > 8192 || cache.parents.size >= 8192) { cache.parents.clear();cache.entries=0; }
          cache.parents.set(current,{parentIdentity,names}); cache.entries+=names.size;
        }
      }
      if(!names.has(part)) {
        need(![...names].some(n=>n.toLowerCase() === part.toLowerCase()),'PATH_ALIAS');
        need(missing,'PATH_MISSING'); absent=true;
      } else {
        const st = lstat(next); need(!st.isSymbolicLink(),'PATH_LINK');
        if(i !== parts.length-1 || !file) ordinaryDirectory(st); else regular(st,tool);
        lastExisting=next;
      }
    }
    current = next;
  }
  // One complete-prefix resolution verifies the whole already-lstatted chain.
  const resolved=fs.realpathSync.native(lastExisting);
  const spelling=p=>WIN ? p[0].toUpperCase()+p.slice(1) : p;
  need(spelling(resolved) === spelling(lastExisting),'PATH_ALIAS');
  return current;
}
function overlap(a,b) {
  const rel = path.relative(fold(a),fold(b));
  return rel === '' || (!rel.startsWith('..'+path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function checkedRoots(roots) { return withPaths(()=>checkedRootsNow(roots)); }
function checkedRootsNow(roots) {
  const values = roots.map((r,i)=>checkedPath(r,{missing:i !== 0}));
  for(let i=0;i<values.length;i++) for(let j=i+1;j<values.length;j++)
    need(!overlap(values[i],values[j]) && !overlap(values[j],values[i]),'ROOT_OVERLAP');
  return values;
}
function readRegular(file,max,{text=true,tool=false}={}) {
  // A pinned executable may have installation-owned hard links; it is never a write target.
  checkedPath(file,{file:true,tool}); const before = lstat(file); regular(before,tool);
  need(before.size <= max,'FILE_TOO_LARGE'); let fd;
  try {
    fd = fs.openSync(file,'r'); const opened = fstat(fd); regular(opened,tool);
    need(identity(before) === identity(opened),'FILE_CHANGED'); need(opened.size <= max,'FILE_TOO_LARGE');
    const bytes = Buffer.alloc(opened.size+1); let length = 0;
    while(length < bytes.length) { const n = fs.readSync(fd,bytes,length,bytes.length-length,null); if(!n) break; length += n; }
    const after = fstat(fd); regular(after,tool);
    need(length === opened.size && identity(opened) === identity(after) && identity(lstat(file)) === identity(after),'FILE_CHANGED');
    const result = bytes.subarray(0,length); if(text) textBytes(result);
    return {bytes:result,stat:after,identity:identity(after)};
  } finally { if(fd !== undefined) fs.closeSync(fd); }
}
function gitOptions(input) {
  const o = ownedJson(closed(input,['executable','sha256','version','systemRoot']));
  absolute(o.executable); hash(o.sha256);
  need(typeof o.version === 'string' && /^git version 2\.[0-9]+\.[0-9]+(?:[A-Za-z0-9.-]*)$/.test(o.version),'UNSUPPORTED_GIT_VERSION');
  if(WIN) { need(typeof o.systemRoot === 'string','INVALID_SYSTEM_ROOT'); absolute(o.systemRoot); }
  else need(o.systemRoot === null,'INVALID_SYSTEM_ROOT');
  return o;
}
function baselineRecord(value) {
  const o = ownedJson(value);
  exact(o,['schemaVersion','provenance','commit','objectFormat','git','files','baselineDigest']);
  need(o.schemaVersion === 1 && o.provenance === PROVENANCE && o.objectFormat === 'sha1' && SHA1.test(o.commit),'INVALID_BASELINE');
  exact(o.git,['sha256','version']); hash(o.git.sha256); need(typeof o.git.version === 'string','INVALID_BASELINE');
  validateRows(o.files); const {baselineDigest,...body} = o; hash(baselineDigest);
  need(digest(body) === baselineDigest,'BASELINE_DIGEST_MISMATCH'); return o;
}
function validateRows(rows) {
  need(Array.isArray(rows) && rows.length <= WORKSPACE_LIMITS.files,'FILE_LIMIT'); let total = 0, last = '';
  for(const r of rows) {
    exact(r,['path','kind','bytes','sha256','gitMode']); portable(r.path);
    need(!forbidden(r.path) && r.kind === 'file' && MODES.has(r.gitMode),'UNSUPPORTED_PROJECT');
    integer(r.bytes,0,WORKSPACE_LIMITS.fileBytes); hash(r.sha256); total += r.bytes;
    need(r.path > last,'UNSORTED_FILES'); last = r.path;
  }
  need(total <= WORKSPACE_LIMITS.totalBytes,'TOTAL_BYTES_LIMIT'); pathSet(rows.map(r=>r.path));
}
function configCheck(bytes) {
  const lines = textBytes(bytes).split(/\r?\n/); let section = null; const keys = new Set();
  for(const raw of lines) {
    const line = raw.trim(); if(!line || /^[#;]/.test(line)) continue;
    const heading = /^\[([A-Za-z]+)\]$/.exec(line);
    if(heading) { section = heading[1].toLowerCase(); need(['core','user'].includes(section),'UNSUPPORTED_GIT_CONFIG'); continue; }
    const entry = /^([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(line); need(section && entry,'UNSUPPORTED_GIT_CONFIG');
    const key = section+'.'+entry[1].toLowerCase(), value = entry[2]; need(!keys.has(key),'UNSUPPORTED_GIT_CONFIG'); keys.add(key);
    if(key === 'core.repositoryformatversion') need(value === '0','UNSUPPORTED_GIT_CONFIG');
    else if(key === 'core.bare') need(value === 'false','UNSUPPORTED_GIT_CONFIG');
    else if(['core.filemode','core.logallrefupdates','core.ignorecase','core.symlinks'].includes(key)) need(/^(true|false)$/.test(value),'UNSUPPORTED_GIT_CONFIG');
    else if(['user.name','user.email'].includes(key)) need(value.length > 0 && value.length <= 512 && !/["\\#;\x00-\x1f]/.test(value),'UNSUPPORTED_GIT_CONFIG');
    else need(false,'UNSUPPORTED_GIT_CONFIG');
  }
  need(keys.has('core.repositoryformatversion') && keys.has('core.bare'),'UNSUPPORTED_GIT_CONFIG');
}
function metadata(root) { return withPaths(()=>metadataNow(root)); }
function metadataNow(root) {
  const git = path.join(root,'.git'); checkedPath(git); let entries = 0, total = 0;
  const facts = [];
  const banned = new Set(['commondir','shallow','config.worktree','info/grafts','info/sparse-checkout','objects/info/alternates','objects/info/http-alternates','refs/replace']);
  function walk(dir,rel,depth) {
    need(depth <= 32,'METADATA_LIMIT'); ordinaryDirectory(lstat(dir));
    for(const name of boundedNames(dir)) {
      need(++entries <= WORKSPACE_LIMITS.metadataEntries,'METADATA_LIMIT');
      const p = rel ? rel+'/'+name : name, full = path.join(dir,name), st = lstat(full);
      need(!banned.has(p.toLowerCase()) && !/\.promisor$/i.test(p) && !st.isSymbolicLink(),'UNSUPPORTED_GIT_METADATA');
      if(st.isDirectory()) { identity(st); facts.push([p,'directory',st.dev,st.ino]); walk(full,p,depth+1); }
      else {
        regular(st); total += st.size; need(total <= WORKSPACE_LIMITS.metadataBytes,'METADATA_LIMIT');
        const r = readRegular(full,WORKSPACE_LIMITS.metadataBytes,{text:false});
        facts.push([p,'file',r.identity,rawHash(r.bytes)]);
        if(p === 'packed-refs') need(!r.bytes.toString('utf8').includes('refs/replace/'),'UNSUPPORTED_GIT_METADATA');
      }
    }
  }
  walk(git,'',0); configCheck(readRegular(path.join(git,'config'),65536).bytes);
  const fingerprint=createHash('sha256');
  for(const fact of facts) { const row=Buffer.from(canonicalize(fact)); fingerprint.update(String(row.length)+':').update(row); }
  return fingerprint.digest('hex');
}
function scanTree(root,expected,options={}) { return withPaths(()=>scanTreeNow(root,expected,options)); }
function scanTreeNow(root,expected,{source=false,retain=false}={}) {
  checkedPath(root); validateRows(expected); const expectedMap = new Map(expected.map(r=>[r.path,r]));
  const allowedDirs = new Set();
  for(const r of expected) { const parts = r.path.split('/'); for(let i=1;i<parts.length;i++) allowedDirs.add(parts.slice(0,i).join('/')); }
  const rows = [], contents = new Map(); let total = 0;
  function walk(dir,rel) {
    ordinaryDirectory(lstat(dir));
    for(const name of boundedNames(dir,WORKSPACE_LIMITS.files*WORKSPACE_LIMITS.depth+2)) {
      if(source && rel === '' && name === '.git') { ordinaryDirectory(lstat(path.join(dir,name))); continue; }
      const p = rel ? rel+'/'+name : name, full = path.join(dir,name); portable(p);
      need(!forbidden(p),'UNSUPPORTED_PROJECT'); const st = lstat(full);
      need(!st.isSymbolicLink(),'PATH_LINK');
      if(st.isDirectory()) { need(allowedDirs.has(p),'UNEXPECTED_DIRECTORY'); walk(full,p); }
      else {
        need(expectedMap.has(p),'UNEXPECTED_FILE'); const e = expectedMap.get(p);
        const r = readRegular(full,WORKSPACE_LIMITS.fileBytes); total += r.bytes.length;
        need(total <= WORKSPACE_LIMITS.totalBytes,'TOTAL_BYTES_LIMIT');
        if(!WIN) need(!!(r.stat.mode & 0o111) === (e.gitMode === '100755'),'MODE_CHANGED');
        const row = {path:p,kind:'file',bytes:r.bytes.length,sha256:rawHash(r.bytes),gitMode:e.gitMode};
        need(same(row,e),'FILE_CHANGED'); rows.push(row); if(retain) contents.set(p,r.bytes);
      }
    }
  }
  walk(root,''); sortRows(rows); need(same(rows,expected),'TREE_CHANGED');
  return {rows:ownedJson(rows),contents};
}
const makeHook = fn => async (name,context={}) => {
  if(fn) { try { await fn(name,ownedJson(context)); } catch(cause) { throw typeof cause?.code === 'string' ? cause : error('FAILPOINT_FAILED',cause); } }
};
// A before hook may suspend. The guard and syscall after it deliberately share one continuation.
async function effect(hit,name,context,guard,call) {
  await hit(name+'.before',context); guard(); const result = call();
  await hit(name+'.after',context); guard(); return result;
}
function simpleGuard() {}
function retainedDirectories(target) {
  checkedPath(target,{missing:true});
  const nodes=new Map(),root=path.parse(target).root; let dir=root;
  nodes.set(root,lstat(root));
  for(const part of target.slice(root.length).split(path.sep)) {
    dir=path.join(dir,part); const st=maybeStat(dir); if(!st) break;
    ordinaryDirectory(st); nodes.set(dir,st);
  }
  return nodes;
}
function checkDirectories(nodes) {
  return withPaths(()=>{
    for(const [dir,expected] of nodes) {
      if(dir !== path.parse(dir).root) checkedPath(dir);
      const current=lstat(dir); ordinaryDirectory(current);
      need(sameNode(expected,current),'OWNER_DIRECTORY_CHANGED');
    }
  });
}
function ownedTarget(nodes,target,{file=false,existsCode='TARGET_EXISTS'}={}) {
  checkDirectories(nodes);
  const parent=path.dirname(target); checkedPath(parent);
  need(nodes.has(parent) && sameNode(nodes.get(parent),lstat(parent)),'OWNER_DIRECTORY_CHANGED');
  checkedPath(target,{missing:true,file});
  if(maybeStat(target)) throw existsCode === 'TARGET_EXISTS' ? error('TARGET_EXISTS') : error(existsCode,error('TARGET_EXISTS'));
}
async function makeDirectories(target,hit,guard,stage='root',context={},nodes,localCheck=simpleGuard,requireAbsent=false) {
  function vacant(code) {
    if(requireAbsent && maybeStat(target)) throw error(code,error('TARGET_EXISTS'));
  }
  vacant('RECONCILIATION_REQUIRED');
  nodes ??= retainedDirectories(target);
  checkedPath(target,{missing:true}); const missing = []; let p = target,createdTarget=false;
  while(!maybeStat(p)) { missing.push(p); p = path.dirname(p); }
  vacant('RECONCILIATION_REQUIRED');
  for(const dir of missing.reverse()) {
    const detail={...context,path:dir,parentPath:path.dirname(dir),targetPath:dir};
    await hit(stage+'.mkdir.before',detail); guard(); vacant('LOCKED');
    ownedTarget(nodes,dir,{existsCode:requireAbsent ? 'LOCKED' : 'TARGET_EXISTS'}); localCheck();
    vacant('LOCKED'); fs.mkdirSync(dir,{mode:0o700}); nodes.set(dir,lstat(dir));
    if(dir === target) createdTarget=true;
    await hit(stage+'.mkdir.after',detail); guard();
    if(!createdTarget) vacant('LOCKED');
    checkDirectories(nodes); localCheck();
  }
  need(!requireAbsent || createdTarget,'RECONCILIATION_REQUIRED');
  checkedPath(target); checkDirectories(nodes); return nodes;
}
async function exclusiveWrite(file,bytes,mode,hit,guard,stage,context={},onSubmit=()=>{},onOpened=()=>{}) {
  let fd, original, opened, verifiedIdentity;
  const writeGuard=()=>{
    guard(); checkedPath(file,{file:true}); const now=fstat(fd), named=lstat(file); regular(now); regular(named);
    need(opened.dev === now.dev && opened.ino === now.ino && now.dev === named.dev && now.ino === named.ino,'WRITE_TARGET_CHANGED');
  };
  try {
    await hit(stage+'.open.before',context); guard(); checkedPath(file,{missing:true,file:true});
    onSubmit(); fd = fs.openSync(file,'wx',mode); opened=fstat(fd); regular(opened); onOpened(opened);
    await hit(stage+'.open.after',context); writeGuard();
    let offset = 0;
    do {
      await hit(stage+'.write.before',{...context,offset}); writeGuard();
      const n = fs.writeSync(fd,bytes,offset,bytes.length-offset,null);
      need(n > 0 || bytes.length === 0,'INCOMPLETE_WRITE'); offset += n;
      await hit(stage+'.write.after',{...context,offset}); writeGuard();
    } while(offset < bytes.length);
    await effect(hit,stage+'.sync',context,writeGuard,()=>fs.fsyncSync(fd));
    await hit(stage+'.close.before',context); writeGuard(); fs.closeSync(fd); fd = undefined;
    await hit(stage+'.close.after',context); guard();
    const read = readRegular(file,WORKSPACE_LIMITS.fileBytes);
    need(sameNode(opened,read.stat),'WRITE_TARGET_CHANGED');
    need(read.bytes.equals(bytes),'WRITE_VERIFICATION_FAILED');
    if(!WIN) need(!!(read.stat.mode & 0o111) === !!(mode & 0o111),'MODE_CHANGED');
    verifiedIdentity=read.identity;
  } catch(e) { original = e; }
  if(fd !== undefined) {
    const cleanup = [];
    try { await hit('cleanup.close.before',{stage,...context}); } catch(e) { cleanup.push(e); }
    try { fs.closeSync(fd); } catch(e) { cleanup.push(e); }
    try { await hit('cleanup.close.after',{stage,...context}); } catch(e) { cleanup.push(e); }
    if(cleanup.length) original = error('WRITE_AND_CLEANUP_FAILED',new AggregateError([original,...cleanup].filter(Boolean)));
  }
  if(original) throw original;
  return verifiedIdentity;
}

async function gitCollector(config,authorityGuard=simpleGuard,localCheck=simpleGuard) {
  const hit = makeHook(config.failpoint), source = config.sourceRoot;
  checkedPath(source); const meta = metadata(source);
  const sourceNodes=retainedDirectories(source),scratchNodes=retainedDirectories(config.scratchRoot);
  const executable = readRegular(config.git.executable,WORKSPACE_LIMITS.metadataBytes,{text:false,tool:true});
  need(rawHash(executable.bytes) === config.git.sha256,'GIT_IDENTITY_MISMATCH');
  if(WIN) checkedPath(config.git.systemRoot);
  let empty=null,emptyIdentity=null,hooks=null,home=null;
  function scratchCheck() {
    checkDirectories(scratchNodes);
    if(emptyIdentity !== null) need(readRegular(empty,0).identity === emptyIdentity,'SCRATCH_CHANGED');
    if(hooks !== null) need(!nonemptyDirectory(hooks),'SCRATCH_CHANGED');
    if(home !== null) need(!nonemptyDirectory(home),'SCRATCH_CHANGED');
  }
  // This guard is unconditional for inspection and both author baseline collectors.
  // The final callback precedes fresh namespace checks, never follows them.
  function guard() {
    authorityGuard(); checkDirectories(sourceNodes); scratchCheck(); localCheck();
  }
  await makeDirectories(config.scratchRoot,hit,guard,'scratch',{scratchRoot:config.scratchRoot},scratchNodes,localCheck);
  const scratchContext={scratchRoot:config.scratchRoot,parentPath:config.scratchRoot};
  await hit('git.scratch.before',scratchContext); guard(); checkedPath(config.scratchRoot); localCheck();
  const scratch=fs.mkdtempSync(path.join(config.scratchRoot,'git-')); scratchNodes.set(scratch,lstat(scratch));
  await hit('git.scratch.after',{...scratchContext,scratchPath:scratch,targetPath:scratch}); guard();
  empty=path.join(scratch,'empty.config'); const hooksPath=path.join(scratch,'hooks'),homePath=path.join(scratch,'home');
  const detail=target=>({scratchRoot:config.scratchRoot,scratchPath:scratch,parentPath:scratch,targetPath:target});
  let emptyNode;
  await exclusiveWrite(empty,Buffer.alloc(0),0o600,hit,guard,'git.config',detail(empty),()=>{},node=>{emptyNode=node;});
  const emptyRecord=readRegular(empty,0); need(sameNode(emptyNode,emptyRecord.stat),'SCRATCH_CHANGED'); emptyIdentity=emptyRecord.identity;
  for(const [stage,target] of [['git.hooks',hooksPath],['git.home',homePath]]) {
    await hit(stage+'.before',detail(target)); guard(); ownedTarget(scratchNodes,target); localCheck();
    fs.mkdirSync(target,{mode:0o700}); scratchNodes.set(target,lstat(target));
    if(stage === 'git.hooks') hooks=target; else home=target;
    await hit(stage+'.after',detail(target)); guard();
  }
  const env = {HOME:home,USERPROFILE:home,TMP:home,TEMP:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:empty,
    GIT_CONFIG_SYSTEM:empty,GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};
  if(WIN) env.SYSTEMROOT = config.git.systemRoot;
  const prefix = ['-c','core.fsmonitor=false','-c','core.hooksPath='+hooks,'-c','protocol.allow=never'];
  let sequence = 0;
  async function command(label,args) {
    guard(); need(identity(lstat(config.git.executable)) === executable.identity,'GIT_IDENTITY_MISMATCH');
    const stdoutPath = path.join(scratch,String(++sequence)+'.stdout'), stderrPath = path.join(scratch,String(sequence)+'.stderr');
    const context = {command:label,stdoutPath,stderrPath,scratchRoot:config.scratchRoot,scratchPath:scratch,
      executable:config.git.executable,argv:[...prefix,...args],environment:{...env},cwd:source};
    let out,err,outNode,errNode,child,timer,deadlineFired=false,deadlineTask=null,spawnError=null,exit,original;
    function capturesCheck() {
      for(const [fd,name,node] of [[out,stdoutPath,outNode],[err,stderrPath,errNode]]) {
        if(fd === undefined) continue;
        checkedPath(name,{file:true}); const opened=fstat(fd),named=lstat(name); regular(opened);regular(named);
        need(sameNode(node,opened) && sameNode(opened,named) && opened.size === 0,'CAPTURE_CHANGED');
      }
    }
    try {
      await hit('git.capture.open.before',context); guard();
      for(const stream of ['stdout','stderr']) {
        const target=stream === 'stdout' ? stdoutPath : stderrPath;
        const streamContext={...context,stream,parentPath:scratch,targetPath:target};
        await hit('git.capture.'+stream+'.open.before',streamContext);
        guard(); capturesCheck(); ownedTarget(scratchNodes,target,{file:true}); localCheck();
        if(stream === 'stdout') { out=fs.openSync(target,'wx',0o600); outNode=fstat(out); regular(outNode); }
        else { err=fs.openSync(target,'wx',0o600); errNode=fstat(err); regular(errNode); }
        await hit('git.capture.'+stream+'.open.after',streamContext); guard(); capturesCheck(); localCheck();
      }
      await hit('git.capture.open.after',context); guard(); capturesCheck();
      await hit('git.spawn.before',context); guard();
      const pinned=readRegular(config.git.executable,WORKSPACE_LIMITS.metadataBytes,{text:false,tool:true});
      need(pinned.identity === executable.identity && rawHash(pinned.bytes) === config.git.sha256,'GIT_IDENTITY_MISMATCH');
      if(WIN) checkedPath(config.git.systemRoot);
      need(metadata(source) === meta,'GIT_METADATA_CHANGED'); scratchCheck(); capturesCheck(); localCheck();
      child = spawn(config.git.executable,[...prefix,...args],{cwd:source,env,shell:false,windowsHide:true,stdio:['ignore',out,err]});
      const settled = new Promise(resolve=>{
        child.once('error',e=>{spawnError=e;});
        child.once('close',(code,signal)=>resolve({code,signal}));
      });
      timer = setTimeout(()=>{
        deadlineFired = true;
        try { child.kill(); } catch(e) { spawnError ??= e; }
        deadlineTask = hit('git.deadline',{command:label,pid:child.pid??null,deadlineFired:true});
        deadlineTask.catch(()=>{});
      },WORKSPACE_LIMITS.gitDeadlineMs);
      // The deadline also covers owned observation barriers, even if exit already occurred.
      try { await hit('git.spawn.after',{...context,pid:child.pid??null}); } catch(e) { original=e; try { child.kill(); } catch(k) { spawnError??=k; } }
      exit = await settled;
      try { await hit('git.exit',{...context,pid:child.pid??null,code:exit.code,signal:exit.signal,deadlineFired}); } catch(e) { original??=e; }
      clearTimeout(timer); timer=undefined;
      if(deadlineTask) { try { await deadlineTask; } catch(e) { original??=e; } }
      // File-backed capture handles close before any acceptance read.
      const closeErrors=[];
      for(const [fd,which] of [[out,'out'],[err,'err']]) {
        if(which === 'out') out=undefined; else err=undefined;
        try { fs.closeSync(fd); } catch(e) { closeErrors.push(e); }
      }
      if(closeErrors.length) throw error('CAPTURE_CLOSE_FAILED',new AggregateError(closeErrors));
      await hit('git.capture.before',{...context,code:exit.code,signal:exit.signal,deadlineFired}); guard();
      const stdoutRecord=readRegular(stdoutPath,WORKSPACE_LIMITS.captureBytes,{text:false});
      const stderrRecord=readRegular(stderrPath,WORKSPACE_LIMITS.captureBytes,{text:false});
      need(sameNode(outNode,stdoutRecord.stat) && sameNode(errNode,stderrRecord.stat),'CAPTURE_CHANGED');
      const stdout=stdoutRecord.bytes,stderr=stderrRecord.bytes;
      await hit('git.capture.after',{...context,stdoutBytes:stdout.length,stderrBytes:stderr.length}); guard();
      for(const [name,record] of [[stdoutPath,stdoutRecord],[stderrPath,stderrRecord]]) {
        const after=readRegular(name,WORKSPACE_LIMITS.captureBytes,{text:false});
        need(after.identity === record.identity && after.bytes.equals(record.bytes),'CAPTURE_CHANGED');
      }
      scratchCheck();
      if(original) throw original;
      need(!deadlineFired,'GIT_DEADLINE'); need(!spawnError,'GIT_PROCESS_ERROR');
      need(exit.code === 0 && exit.signal === null,'GIT_EXIT'); need(stderr.length === 0,'GIT_STDERR');
      need(Buffer.from(stdout.toString('utf8'),'utf8').equals(stdout),'INVALID_GIT_OUTPUT'); return stdout;
    } finally {
      if(timer !== undefined) clearTimeout(timer);
      const cleanup=[];
      for(const fd of [out,err]) if(fd !== undefined) { try { fs.closeSync(fd); } catch(e) { cleanup.push(e); } }
      if(cleanup.length) throw error('CAPTURE_CLEANUP_FAILED',new AggregateError(cleanup));
    }
  }
  const line = bytes => { const s = bytes.toString('utf8'); need(/^[^\r\n]+\r?\n$/.test(s),'INVALID_GIT_OUTPUT'); return s.trim(); };
  need(line(await command('version',['--version'])) === config.git.version,'GIT_VERSION_MISMATCH');
  need(line(await command('object-format',['rev-parse','--show-object-format'])) === 'sha1','UNSUPPORTED_OBJECT_FORMAT');
  const commit = line(await command('head',['rev-parse','--verify','HEAD^{commit}'])); need(SHA1.test(commit),'INVALID_COMMIT');
  async function collect() {
    const tree = await command('tree',['ls-tree','-r','-z','-l','--full-tree',commit]);
    const index = await command('index',['ls-files','--stage','-z']);
    return {tree,index};
  }
  const first = await collect(); const rows = [], treeObjects = new Map();
  const nulRows = bytes => { const s = bytes.toString('utf8'); need(!s || s.endsWith('\0'),'INVALID_GIT_OUTPUT'); return s ? s.slice(0,-1).split('\0') : []; };
  const treeEntries = nulRows(first.tree); need(treeEntries.length <= WORKSPACE_LIMITS.files,'FILE_LIMIT');
  let total = 0;
  for(const entry of treeEntries) {
    const m = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/.exec(entry); need(m,'UNSUPPORTED_GIT_TREE');
    const p = portable(m[4]), size = Number(m[3]); integer(size,0,WORKSPACE_LIMITS.fileBytes);
    need(!forbidden(p),'UNSUPPORTED_PROJECT'); total += size; need(total <= WORKSPACE_LIMITS.totalBytes,'TOTAL_BYTES_LIMIT');
    need(!treeObjects.has(p),'DUPLICATE_PATH'); treeObjects.set(p,{mode:m[1],oid:m[2],size});
    const raw = readRegular(path.join(source,...p.split('/')),WORKSPACE_LIMITS.fileBytes);
    need(raw.bytes.length === size && blobHash(raw.bytes) === m[2],'DIRTY_SOURCE');
    if(!WIN) need(!!(raw.stat.mode & 0o111) === (m[1] === '100755'),'MODE_CHANGED');
    rows.push({path:p,kind:'file',bytes:size,sha256:rawHash(raw.bytes),gitMode:m[1]});
  }
  const indexEntries = nulRows(first.index); need(indexEntries.length === rows.length,'INDEX_MISMATCH'); const seen = new Set();
  for(const entry of indexEntries) {
    const m = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(entry); need(m,'UNSUPPORTED_INDEX');
    portable(m[3]); const t = treeObjects.get(m[3]);
    need(t && t.mode === m[1] && t.oid === m[2] && !seen.has(m[3]),'INDEX_MISMATCH'); seen.add(m[3]);
  }
  sortRows(rows); validateRows(rows); scanTree(source,rows,{source:true});
  await hit('baseline.recheck.before',{commit}); guard();
  need(line(await command('head-recheck',['rev-parse','--verify','HEAD^{commit}'])) === commit,'HEAD_CHANGED');
  const second = await collect(); need(first.tree.equals(second.tree) && first.index.equals(second.index),'GIT_CHANGED');
  need(metadata(source) === meta,'GIT_METADATA_CHANGED'); scanTree(source,rows,{source:true});
  need(rawHash(readRegular(config.git.executable,WORKSPACE_LIMITS.metadataBytes,{text:false,tool:true}).bytes) === config.git.sha256,'GIT_IDENTITY_MISMATCH');
  await hit('baseline.recheck.after',{commit}); guard();
  // Recheck after the last externally controlled barrier as well.
  need(metadata(source) === meta,'GIT_METADATA_CHANGED'); scanTree(source,rows,{source:true});
  const body = ownedJson({schemaVersion:1,provenance:PROVENANCE,commit,objectFormat:'sha1',
    git:{sha256:config.git.sha256,version:config.git.version},files:rows});
  return baselineRecord({...body,baselineDigest:digest(body)});
}

export async function inspectBaseline(input) {
  const o = closed(input,['sourceRoot','scratchRoot','protectedRoots','git'],['failpoint']);
  need(o.failpoint === undefined || typeof o.failpoint === 'function','INVALID_FAILPOINT');
  const roots = ownedJson(o.protectedRoots); need(Array.isArray(roots) && roots.length <= 64,'INVALID_ROOTS');
  const [sourceRoot,scratchRoot] = checkedRoots([o.sourceRoot,o.scratchRoot,...roots]);
  return gitCollector({sourceRoot,scratchRoot,git:gitOptions(o.git),failpoint:o.failpoint});
}

function workspaceOptions(input) {
  const o = closed(input,['sourceRoot','workspaceRoot','scratchRoot','governanceRoot','legacyRoot','configRoot',
    'protectedRoots','protectedFiles','git','baseline','authority'],['failpoint']);
  need(o.failpoint === undefined || typeof o.failpoint === 'function','INVALID_FAILPOINT');
  const protectedRoots = ownedJson(o.protectedRoots), protectedFiles = ownedJson(o.protectedFiles);
  need(Array.isArray(protectedRoots) && protectedRoots.length <= 64 && Array.isArray(protectedFiles) && protectedFiles.length <= 256,'INVALID_ROOTS');
  pathSet(protectedFiles);
  const rootNames = ['sourceRoot','workspaceRoot','scratchRoot','governanceRoot','legacyRoot','configRoot'];
  const rootValues = checkedRoots([...rootNames.map(k=>o[k]),...protectedRoots]);
  const authority = closed(o.authority,['readCurrent']); need(typeof authority.readCurrent === 'function','INVALID_AUTHORITY');
  const git = gitOptions(o.git), baseline = baselineRecord(o.baseline);
  need(same(baseline.git,{sha256:git.sha256,version:git.version}),'GIT_IDENTITY_MISMATCH');
  return Object.freeze({...Object.fromEntries(rootNames.map((k,i)=>[k,rootValues[i]])),
    protectedRoots:Object.freeze(rootValues.slice(rootNames.length)),protectedFiles,git,baseline,
    readCurrent:authority.readCurrent.bind(Object.freeze({readCurrent:authority.readCurrent})),failpoint:o.failpoint});
}
function readOwner(file) {
  const r = readRegular(file,65536), text = textBytes(r.bytes); let value;
  try { value = ownedJson(JSON.parse(text)); } catch(e) { throw error('OWNER_LOST',e); }
  need(canonicalize(value) === text,'OWNER_LOST');
  return {text,identity:r.identity,value};
}
function stateFrom(config,actor,assignmentId,cache) {
  let raw;
  try { raw=config.readCurrent(); } catch(cause) { throw error('AUTHORITY_UNAVAILABLE',cause); }
  if(types.isPromise(raw)) { raw.catch(()=>{}); throw error('ASYNC_AUTHORITY'); }
  need(raw && typeof raw === 'object','AUTHORITY_UNAVAILABLE');
  if(cache?.raw === raw && cache.actor === actor && cache.assignmentId === assignmentId) return cache.state;
  deepFrozen(raw); const s = ownedJson(raw);
  exact(s,['schemaVersion','provenance','jobId','projectId','revision','generation','phase','planGeneration',
    'plan','attempts','authors','assignments','results','evidence','decision','candidate','action']);
  need(s.schemaVersion === 1 && s.provenance === PROVENANCE,'INVALID_AUTHORITY');
  id(s.jobId); hash(s.projectId); integer(s.revision,1); integer(s.generation,1); integer(s.planGeneration,1);
  const plan = validatePlan(s.plan);
  need(s.jobId === plan.jobId && s.projectId === plan.projectId && plan.projectId === digest(fold(config.sourceRoot)) &&
    plan.baseline === config.baseline.baselineDigest,'AUTHORITY_IDENTITY_MISMATCH');
  need(Array.isArray(s.assignments) && Array.isArray(s.results) && Array.isArray(s.attempts) && Array.isArray(s.authors) && Array.isArray(s.evidence),'INVALID_AUTHORITY');
  s.assignments.forEach(validateAssignment); s.results.forEach(validateResult); s.authors.forEach(validateActor);
  need(s.decision !== null,'PLAN_NOT_AUTHORIZED'); validateDecision(s.decision);
  need(s.attempts.length >= 1 && s.attempts.length <= 3,'ATTEMPT_REQUIRED');
  s.attempts.forEach((a,i)=>{exact(a,['index','assignmentId','planDigest']);need(a.index === i,'INVALID_ATTEMPT');id(a.assignmentId);hash(a.planDigest);});
  const assignment = s.assignments.find(a=>a.id === assignmentId), attempt = s.attempts.at(-1);
  need(assignment && assignment.role === 'author' && same(assignment.actor,actor) && assignment.actor.provider === plan.policy.implementerProvider &&
    same(assignment.binding,bindingFor(plan,null)) && attempt.assignmentId === assignmentId && attempt.planDigest === digest(plan),'ASSIGNMENT_MISMATCH');
  assertModelMutation(s,{assignmentId,actor,generation:s.generation,planDigest:digest(plan),revision:s.revision});
  if(cache) Object.assign(cache,{raw,actor,assignmentId,state:s,stateDigest:digest(s)});
  return s;
}
function readStateV2(config) {
  let value;
  try { value=config.readCurrent(); } catch(cause) { throw error('AUTHORITY_UNAVAILABLE',cause); }
  if(types.isPromise(value)) { value.catch(()=>{}); throw error('ASYNC_AUTHORITY'); }
  need(value && typeof value === 'object','AUTHORITY_UNAVAILABLE'); deepFrozen(value);
  const s=validateStateV2(value), p=validatePlanV2(s.plan);
  need(s.schemaVersion === 2 && s.provenance === V2_PROVENANCE,'INVALID_AUTHORITY');
  need(s.jobId === p.jobId && s.projectId === p.projectId && p.projectId === digest(fold(config.sourceRoot)) &&
    p.baseline === config.baseline.baselineDigest,'AUTHORITY_IDENTITY_MISMATCH');
  s.assignments.forEach(validateAssignmentV2);s.results.forEach(validateResultV2);s.authors.forEach(validateActorV2);
  need(s.decision !== null,'PLAN_NOT_AUTHORIZED');validateDecisionV2(s.decision);
  const review=s.results.findLast(r=>r.role==='plan-review'&&r.generation===s.planGeneration);
  need(review?.outcome==='completed-pass'&&s.decision.decision==='authorize'&&s.decision.planDigest===digest(p)&&
    s.decision.reviewResultId===review.id&&s.decision.generation===s.planGeneration,'PLAN_NOT_AUTHORIZED');
  return s;
}
function stateFromV2(config,actor,assignmentId,cache) {
  // No v1-shaped projection or provenance substitution can create v2 authority.
  const s=readStateV2(config),p=s.plan,a=s.assignments.find(row=>row.id===assignmentId),last=s.attempts.at(-1);
  const actorRecord=validateActorV2(actor);
  need(a && a.role === 'author' && same(a.actor,actorRecord) && same(a.binding,bindingForV2(p,null)) &&
    last?.assignmentId === assignmentId && last.planDigest === digest(p),'ASSIGNMENT_MISMATCH');
  assertModelMutationV2(s,{assignmentId,actor:actorRecord,generation:s.generation,planDigest:digest(p),revision:s.revision});
  if(cache) Object.assign(cache,{state:s,stateDigest:digest(s)});
  return s;
}
function custodyInventory(root) {
  if(!maybeStat(root)) return null;
  checkedPath(root);let entries=0,bytes=0;const sum=createHash('sha256');
  function walk(dir,relative) {
    const st=lstat(dir);ordinaryDirectory(st);sum.update(canonicalize([relative,'directory',st.dev,st.ino])+'\n');
    for(const name of boundedNames(dir)) {
      need(++entries<=WORKSPACE_LIMITS.metadataEntries,'RETENTION_EXHAUSTED');const file=path.join(dir,name),p=relative?relative+'/'+name:name,stat=lstat(file);
      need(!stat.isSymbolicLink(),'PATH_LINK');
      if(stat.isDirectory())walk(file,p);
      else{regular(stat);bytes+=stat.size;need(bytes<=WORKSPACE_LIMITS.metadataBytes,'RETENTION_EXHAUSTED');
        const r=readRegular(file,WORKSPACE_LIMITS.metadataBytes,{text:false});sum.update(canonicalize([p,r.identity,rawHash(r.bytes)])+'\n');}
    }
  }
  return withPaths(()=>{walk(root,'');return sum.digest('hex');});
}
function checkPlanScope(config,plan) {
  const baseline = new Map(config.baseline.files.map(f=>[f.path,f]));
  const protectedPaths = [...config.protectedFiles,...plan.protectedTests];
  protectedPaths.forEach(portable);
  // A protected directory-like prefix cannot be weakened by granting its descendant.
  const protectedPath = p => protectedPaths.some(v=>p.toLowerCase() === v.toLowerCase() || p.toLowerCase().startsWith(v.toLowerCase()+'/'));
  for(const f of plan.files) {
    portable(f.path); need(!forbidden(f.path) && !protectedPath(f.path),'PROTECTED_PATH');
    const row = baseline.get(f.path);
    if(f.operation === 'create') need(!row && f.expectedHash === null,'BASELINE_PRECONDITION');
    else need(row && row.sha256 === f.expectedHash,'BASELINE_PRECONDITION');
  }
  pathSet([...config.baseline.files.map(f=>f.path),...plan.files.filter(f=>f.operation === 'create').map(f=>f.path)]);
  return new Map(plan.files.map(f=>[f.path,f]));
}
function fileRequest(input) {
  // Large file text is intentionally excluded from the canonical metadata envelope.
  const r = closed(input,['operation','path'],['expectedHash','text','oldText','newText','offset','limit']);
  portable(r.path); need(!forbidden(r.path),'PROTECTED_PATH');
  let keys;
  switch(r.operation) {
    case 'read': keys=['operation','path','offset','limit']; break;
    case 'create': case 'replace': keys=['operation','path','expectedHash','text']; break;
    case 'edit': keys=['operation','path','expectedHash','oldText','newText']; break;
    case 'delete': keys=['operation','path','expectedHash']; break;
    default: throw error('INVALID_OPERATION');
  }
  need(Object.keys(r).length === keys.length && keys.every(k=>Object.hasOwn(r,k)),'CLOSED_SCHEMA');
  const metadata = {};
  for(const key of keys) if(!['text','oldText','newText'].includes(key)) metadata[key]=r[key];
  const owned = ownedJson(metadata);
  if(r.operation === 'read') { integer(owned.offset,0,WORKSPACE_LIMITS.fileBytes); integer(owned.limit,1,WORKSPACE_LIMITS.readBytes); }
  else if(r.operation === 'create') need(owned.expectedHash === null,'INVALID_PRECONDITION');
  else hash(owned.expectedHash);
  const result={...owned};
  if(Object.hasOwn(r,'text')) result.text=rawText(r.text,WORKSPACE_LIMITS.fileBytes);
  if(r.operation === 'edit') {
    result.oldText=rawText(r.oldText,WORKSPACE_LIMITS.editBytes); result.newText=rawText(r.newText,WORKSPACE_LIMITS.editBytes);
    need(result.oldText.length > 0,'EMPTY_EDIT');
  }
  return Object.freeze(result);
}
function sliceReceipt(row,bytes,offset,limit) {
  need(offset <= bytes.length,'INVALID_OFFSET'); const end = Math.min(bytes.length,offset+limit);
  const slice = bytes.subarray(offset,end), text = textBytes(slice);
  // A split codepoint is a refusal, never replacement-character output.
  return Object.freeze({provenance:PROVENANCE,path:row.path,sha256:row.sha256,bytes:row.bytes,offset,text,nextOffset:end});
}
function sameNode(a,b) { return a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory(); }

/** Side-effect-free factory. Only an acknowledged M1 author reservation may allocate an attempt. */
export function createWorkspace(input) { return createWorkspaceEngine(input,false); }
export function createWorkspaceV2(input) { return createWorkspaceEngine(input,true); }
function createWorkspaceEngine(input,v2) {
  const authorityCache={};
  const stateReader=v2?stateFromV2:stateFrom, actorValidator=v2?validateActorV2:validateActor;
  const provenance=v2?V2_PROVENANCE:PROVENANCE;
  const config = workspaceOptions(input), hit = makeHook(config.failpoint);
  let epoch=0,admission=false,revoked=false,poisoned=null,started=false,closedOwner=false;
  let baselineState=null,stateDigest=null,actor=null,assignmentId=null,plan=null,grants=null,owner=null,storeOwner=null;
  let beginTask=null,sealTask=null,closing=null,execution=null,disposal=null;
  let queue=Promise.resolve(),queued=0,mutations=0,sealed=null;
  let transferring=false,transferred=false,custodyTask=null,custodyFacade=null,v2ProtectedSnapshot=null,v2WorkspaceSnapshot=null;
  const custodyPending=new Set(),replicas=new Set(),sealedIdentities=new Map(),deliveryFacades=new Set();
  let deliveryAdmission=false;
  const root=config.workspaceRoot, lockPath=path.join(root,'lock.json'), working=path.join(root,'working'),
    sealedRoot=path.join(root,'sealed'), control=path.join(root,'control');
  const nodes=new Map(), controls=new Set(), rootEntries=new Set(['lock.json']);
  let cursor=new Map(config.baseline.files.map(r=>[r.path,r]));
  const baselineBytes=new Map(), consumed=new Set(), viewActors=new Map(), pendingViews=new Set();
  let enrolling=false;
  const poison = e => { poisoned ??= e; admission=false; epoch++; return e; };
  const live = () => { need(!poisoned,'WORKSPACE_POISONED'); need(!revoked && !closedOwner,'WORKSPACE_REVOKED'); };
  function rootsNow() {
    checkedRoots([config.sourceRoot,root,config.scratchRoot,config.governanceRoot,config.legacyRoot,config.configRoot,...config.protectedRoots]);
  }
  function current(expectedEpoch,{authoring=false}={}) {
    live(); need(epoch === expectedEpoch,'STALE_EPOCH'); if(authoring) need(admission,'ADMISSION_CLOSED');
    const s = stateReader(config,actor,assignmentId,authorityCache);
    // Callback reentrancy may revoke, close or freeze. Its returned snapshot cannot undo that.
    live(); need(epoch === expectedEpoch,'STALE_EPOCH'); if(authoring) need(admission,'ADMISSION_CLOSED');
    need(authorityCache.stateDigest === stateDigest,'STALE_AUTHORITY');
    const store = readOwner(path.join(config.governanceRoot,'lock.json'));
    need(store.text === storeOwner.text && store.identity === storeOwner.identity,'AUTHORITY_OWNER_LOST');
    return s;
  }
  function ownership() { return withPaths(ownershipNow); }
  function ownershipNow() {
    checkedPath(root); const saved = readOwner(lockPath);
    need(saved.text === owner.text && saved.identity === owner.identity,'OWNER_LOST');
    const actual = boundedNames(root,8);
    need(actual.length === rootEntries.size && actual.every(n=>rootEntries.has(n)),'UNKNOWN_WORKSPACE_ENTRY');
    for(const [dir,stat] of nodes) { checkedPath(dir); const now=lstat(dir); need(sameNode(stat,now),'OWNER_DIRECTORY_CHANGED'); }
    if(nodes.has(control)) {
      const entries=boundedNames(control,WORKSPACE_LIMITS.mutations+2);
      need(entries.length === controls.size && entries.every(n=>controls.has(n)),'UNKNOWN_CONTROL_ENTRY');
      for(const name of entries) regular(lstat(path.join(control,name)));
    }
  }
  function localCheck(e,mode='author') {
    live(); need(epoch === e,'STALE_EPOCH'); if(mode === 'author') need(admission,'ADMISSION_CLOSED');
  }
  function guard(e,mode='author') {
    localCheck(e,mode);
    current(e,{authoring:mode === 'author'});
    // The callback may have changed the namespace: ownership is checked last.
    if(owner) { try { ownership(); } catch(error) { throw poison(error); } }
    localCheck(e,mode);
  }
  const rows = () => sortRows([...cursor.values()]);
  function treeNow(retain=false,tree=working,expected=rows()) {
    try { return scanTree(tree,expected,{retain}); } catch(e) { throw poison(e); }
  }
  function actorCheck(handleActor) { need(actor === handleActor,'WRONG_ACTOR'); }
  async function stageDirectory(dir,stage,e,mode,context={}) {
    await hit(stage+'.mkdir.before',context); guard(e,mode); checkedPath(dir,{missing:true});
    fs.mkdirSync(dir,{mode:0o700});
    if(path.dirname(dir) === root) rootEntries.add(path.basename(dir));
    nodes.set(dir,lstat(dir));
    await hit(stage+'.mkdir.after',context); guard(e,mode);
  }
  async function ensureParents(p,e,mode,onSubmit) {
    const parts=p.split('/'); let dir=working;
    for(let i=0;i<parts.length-1;i++) {
      dir=path.join(dir,parts[i]);
      if(maybeStat(dir)) { checkedPath(dir); continue; }
      await hit('mutation.mkdir.before',{path:p,parent:parts.slice(0,i+1).join('/')}); guard(e,mode);
      checkedPath(dir,{missing:true}); localCheck(e,mode);
      onSubmit(); fs.mkdirSync(dir,{mode:0o700}); nodes.set(dir,lstat(dir));
      await hit('mutation.mkdir.after',{path:p,parent:parts.slice(0,i+1).join('/')}); guard(e,mode);
    }
  }
  async function begin(input) {
    const o=closed(input,['actor','assignmentId','execution','disposed']);
    need(!started && !revoked && !closedOwner,'ATTEMPT_ALREADY_STARTED');
    deepFrozen(o.actor); const actorMetadata=actorValidator(o.actor); id(o.assignmentId);
    need(types.isPromise(o.execution) && types.isPromise(o.disposed),'INVALID_LIFECYCLE');
    const enrollmentEpoch=epoch;
    const s=stateReader(config,actorMetadata,o.assignmentId);
    need(epoch === enrollmentEpoch && !revoked && !closedOwner,'STALE_EPOCH');
    const scoped=checkPlanScope(config,s.plan);
    if(v2) for(const testFile of s.plan.executionPolicy.testFiles){
      const row=config.baseline.files.find(f=>f.path===testFile.path);
      need(row && row.sha256===testFile.sha256 && s.plan.protectedTests.includes(testFile.path),'PROTECTED_TEST_IDENTITY');
    }
    const durableOwner=readOwner(path.join(config.governanceRoot,'lock.json'));
    if(v2){exact(durableOwner.value,['schemaVersion','provenance','nonce','projectId']);
      need(durableOwner.value.schemaVersion===2&&durableOwner.value.provenance===V2_PROVENANCE&&durableOwner.value.projectId===s.projectId,'V2_OWNER_REQUIRED');hash(durableOwner.value.nonce);}
    rootsNow();
    // Even an empty existing root can be a crash between allocation and lock creation.
    need(!maybeStat(root),'RECONCILIATION_REQUIRED');
    actor=o.actor; assignmentId=o.assignmentId; baselineState=s; stateDigest=digest(s); plan=s.plan; grants=scoped; storeOwner=durableOwner;
    // Observe both promises before the first allocation, suppressing no outcome.
    execution=Promise.resolve(o.execution).then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}));
    disposal=Promise.resolve(o.disposed).then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}));
    started=true; admission=true; const e=epoch; let touched=false;
    const preguard=()=>{guard(e);rootsNow();};
    try {
      await hit('begin.authority',{assignmentId}); preguard();
      // Verify the exact accepted baseline before creating the ownership root.
      const inspected=await gitCollector(config,preguard,()=>localCheck(e)); need(same(inspected,config.baseline),'BASELINE_CHANGED');
      preguard(); need(!maybeStat(root),'RECONCILIATION_REQUIRED');
      const allocationNodes=await makeDirectories(root,hit,()=>{preguard();touched=true;},'root',{},undefined,()=>localCheck(e),true);
      const ownerRecord=ownedJson({schemaVersion:v2?2:1,provenance,nonce:randomBytes(32).toString('hex'),
        jobId:s.jobId,projectId:s.projectId,assignmentId,attempt:s.attempts.at(-1).index,
        planDigest:digest(plan),baselineDigest:config.baseline.baselineDigest,generation:s.generation,revision:s.revision});
      const ownerText=canonicalize(ownerRecord);
      const lockGuard=()=>{current(e,{authoring:true});rootsNow();checkDirectories(allocationNodes);localCheck(e);};
      const lockIdentity=await exclusiveWrite(lockPath,Buffer.from(ownerText),0o600,hit,lockGuard,'lock',
        {assignmentId},()=>{touched=true;});
      checkDirectories(allocationNodes); localCheck(e);
      const acquiredOwner=readOwner(lockPath);
      need(acquiredOwner.text === ownerText && acquiredOwner.identity === lockIdentity,'OWNER_LOST');
      owner=acquiredOwner; nodes.set(root,allocationNodes.get(root));
      await stageDirectory(control,'root',e,'author',{directory:'control'});
      await stageDirectory(working,'root',e,'author',{directory:'working'});
      for(const row of config.baseline.files) {
        guard(e); const sourceFile=path.join(config.sourceRoot,...row.path.split('/'));
        const r=readRegular(sourceFile,WORKSPACE_LIMITS.fileBytes);
        need(r.bytes.length === row.bytes && rawHash(r.bytes) === row.sha256,'SOURCE_CHANGED');
        baselineBytes.set(row.path,Buffer.from(r.bytes));
        const dest=path.join(working,...row.path.split('/'));
        const parts=row.path.split('/'); let dir=working;
        for(let i=0;i<parts.length-1;i++) { dir=path.join(dir,parts[i]); if(!maybeStat(dir)) await stageDirectory(dir,'materialize',e,'author',{path:row.path}); else checkedPath(dir); }
        await exclusiveWrite(dest,r.bytes,row.gitMode === '100755' ? 0o700 : 0o600,hit,()=>guard(e),'materialize',{path:row.path});
      }
      treeNow();
      const rechecked=await gitCollector(config,()=>guard(e),()=>localCheck(e)); need(same(rechecked,config.baseline),'BASELINE_CHANGED');
      const sourceMetadata=metadata(config.sourceRoot);
      await hit('begin.beforePublish',{assignmentId}); guard(e);
      need(metadata(config.sourceRoot) === sourceMetadata,'GIT_METADATA_CHANGED');
      scanTree(config.sourceRoot,config.baseline.files,{source:true}); treeNow(); localCheck(e);
      const handle=opaque(); authors.set(handle,{owner:internal,actor,epoch:e}); return handle;
    } catch(e) {
      const refused=e.code === 'EEXIST' && !owner ? error('LOCKED',e) : e;
      admission=false; if(touched || owner) poison(refused); else {revoked=true;epoch++;} throw refused;
    }
  }
  function enqueue(handleActor,request,handleEpoch) {
    actorCheck(handleActor); live(); need(admission && handleEpoch === epoch,'ADMISSION_CLOSED');
    guard(handleEpoch); need(queued < WORKSPACE_LIMITS.queue,'QUEUE_LIMIT');
    if(request.operation !== 'read') need(mutations < WORKSPACE_LIMITS.mutations,'MUTATION_LIMIT');
    queued++;
    const task=queue.then(async()=>{
      await hit('authority.before',{operation:request.operation,path:request.path}); guard(handleEpoch);
      await hit('authority.after',{operation:request.operation,path:request.path}); guard(handleEpoch);
      return perform(request,handleEpoch);
    });
    queue=task.then(()=>{queued--;},()=>{queued--;}); return task;
  }
  async function perform(r,e) {
    guard(e); const currentRow=cursor.get(r.path), target=path.join(working,...r.path.split('/'));
    if(r.operation === 'read') {
      need(currentRow,'UNKNOWN_FILE'); treeNow(); guard(e);
      const bytes=readRegular(target,WORKSPACE_LIMITS.fileBytes).bytes;
      need(rawHash(bytes) === currentRow.sha256,'FILE_CHANGED'); localCheck(e);
      const receipt=sliceReceipt(currentRow,bytes,r.offset,r.limit);
      return v2?ownedJson({...receipt,provenance}):receipt;
    }
    need(mutations < WORKSPACE_LIMITS.mutations,'MUTATION_LIMIT');
    const grant=grants.get(r.path); need(grant && grant.operation === r.operation,'OPERATION_NOT_GRANTED');
    need(!consumed.has(r.path),'ONE_SHOT_OPERATION');
    if(r.operation === 'create') need(!currentRow && r.expectedHash === null,'CURRENT_PRECONDITION');
    else need(currentRow && currentRow.sha256 === r.expectedHash,'CURRENT_PRECONDITION');
    treeNow(); guard(e); let bytes=null;
    if(r.operation === 'replace' || r.operation === 'create') bytes=Buffer.from(r.text,'utf8');
    if(r.operation === 'edit') {
      const before=readRegular(target,WORKSPACE_LIMITS.fileBytes).bytes, text=textBytes(before);
      need(rawHash(before) === currentRow.sha256,'CURRENT_PRECONDITION');
      const at=text.indexOf(r.oldText); need(at >= 0 && text.indexOf(r.oldText,at+1) < 0,'EDIT_NOT_UNIQUE');
      bytes=Buffer.from(rawText(text.slice(0,at)+r.newText+text.slice(at+r.oldText.length),WORKSPACE_LIMITS.fileBytes),'utf8');
    }
    const next=new Map(cursor);
    if(r.operation === 'delete') next.delete(r.path);
    else next.set(r.path,ownedJson({path:r.path,kind:'file',bytes:bytes.length,sha256:rawHash(bytes),gitMode:currentRow?.gitMode??'100644'}));
    const nextRows=sortRows([...next.values()]); validateRows(nextRows);
    const deletions=config.baseline.files.filter(f=>!next.has(f.path)); need(deletions.length <= WORKSPACE_LIMITS.deletions,'DELETION_LIMIT');
    let submitted=false; const onSubmit=()=>{submitted=true;};
    try {
      if(r.operation === 'create') {
        await ensureParents(r.path,e,'author',onSubmit); guard(e); need(!maybeStat(target),'CREATE_EXISTS');
        await exclusiveWrite(target,bytes,0o600,hit,()=>guard(e),'mutation',{path:r.path,operation:r.operation},onSubmit);
      } else if(r.operation === 'delete') {
        const original=readRegular(target,WORKSPACE_LIMITS.fileBytes);
        await hit('mutation.unlink.before',{path:r.path,operation:r.operation}); guard(e);
        need(identity(lstat(target)) === original.identity,'TARGET_CHANGED'); checkedPath(target,{file:true});
        onSubmit(); fs.unlinkSync(target);
        await hit('mutation.unlink.after',{path:r.path,operation:r.operation}); guard(e);
      } else {
        const original=readRegular(target,WORKSPACE_LIMITS.fileBytes);
        const stageName='stage-'+randomBytes(24).toString('hex'), stagePath=path.join(control,stageName);
        // Staging is private control data, never an extra candidate file or a caller-selected path.
        const stageGuard=()=>guard(e);
        await exclusiveWrite(stagePath,bytes,currentRow.gitMode === '100755' ? 0o700 : 0o600,hit,stageGuard,'mutation',
          {path:r.path,operation:r.operation,stageName},()=>{onSubmit();controls.add(stageName);});
        await hit('mutation.rename.before',{path:r.path,operation:r.operation,stageName}); guard(e);
        checkedPath(target,{file:true}); need(identity(lstat(target)) === original.identity,'TARGET_CHANGED');
        need(readRegular(stagePath,WORKSPACE_LIMITS.fileBytes).bytes.equals(bytes),'STAGE_CHANGED');
        // Rename/unlink is the commit linearization. Any subsequent failure poisons; no rollback or retry.
        onSubmit(); fs.renameSync(stagePath,target); controls.delete(stageName);
        await hit('mutation.rename.after',{path:r.path,operation:r.operation,stageName}); guard(e);
      }
      // Remove only newly empty ancestors of the exact deleted path. No recursive action exists.
      if(r.operation === 'delete') {
        let dir=path.dirname(target);
        while(dir !== working && boundedNames(dir,WORKSPACE_LIMITS.files*WORKSPACE_LIMITS.depth).length === 0) {
          await hit('mutation.rmdir.before',{path:r.path}); guard(e); checkedPath(dir);
          fs.rmdirSync(dir); nodes.delete(dir);
          await hit('mutation.rmdir.after',{path:r.path}); guard(e); dir=path.dirname(dir);
        }
      }
      scanTree(working,nextRows); await hit('mutation.beforeAck',{path:r.path,operation:r.operation}); guard(e);
      scanTree(working,nextRows); localCheck(e); cursor=next; mutations++;
      if(['create','delete'].includes(r.operation)) consumed.add(r.path);
      const row=next.get(r.path);
      return ownedJson({provenance,path:r.path,sha256:row?.sha256??null,bytes:row?.bytes??0});
    } catch(e) { if(submitted) throw poison(e); throw e; }
  }
  function descriptorFor(files) {
    const original=new Map(config.baseline.files.map(f=>[f.path,f]));
    const final=new Map(files.map(f=>[f.path,f]));
    const deletions=config.baseline.files.filter(f=>!final.has(f.path)).map(f=>({path:f.path,kind:'deleted',bytes:f.bytes,sha256:f.sha256,gitMode:f.gitMode}));
    const changes=[];
    for(const p of [...new Set([...original.keys(),...final.keys()])].sort()) {
      const before=original.get(p)??null, after=final.get(p)??null;
      if(!same(before,after)) changes.push({path:p,operation:before === null ? 'create' : after === null ? 'delete' : 'modify',before,after});
    }
    need(deletions.length <= WORKSPACE_LIMITS.deletions,'DELETION_LIMIT');
    const identity=(v2?planIdentityV2:planIdentity)(plan);
    const body=ownedJson({schemaVersion:v2?2:1,provenance,jobId:baselineState.jobId,projectId:baselineState.projectId,
      assignmentId,attempt:baselineState.attempts.at(-1).index,generation:baselineState.generation,revision:baselineState.revision,
      ...identity,baselineDigest:config.baseline.baselineDigest,commit:config.baseline.commit,objectFormat:'sha1',git:config.baseline.git,
      files,deletions,changes});
    const descriptor=ownedJson({...body,candidateDigest:digest(body)});
    return v2?validateCandidateDescriptorV2(descriptor):descriptor;
  }
  async function settleExecution() {
    if(!execution) return;
    const [result,disposed]=await Promise.all([execution,disposal]);
    need(result.status === 'fulfilled' && result.value === 'completed','AUTHOR_NOT_COMPLETED');
    need(disposed.status === 'fulfilled','DISPOSAL_FAILED');
  }
  function seal() {
    if(sealTask) return sealTask;
    try { live(); need(started && beginTask,'ATTEMPT_REQUIRED'); } catch(e) { return Promise.reject(e); }
    admission=false; epoch++; const e=epoch;
    sealTask=(async()=>{
      await Promise.allSettled([beginTask,queue]);
      await settleExecution(); guard(e,'seal'); need(!poisoned,'WORKSPACE_POISONED');
      const snapshot=treeNow(true); const descriptor=descriptorFor(snapshot.rows);
      // Validate the complete record before creating any sealed content.
      ownedJson(descriptor); let touched=false;
      try {
        await hit('seal.begin',{assignmentId}); guard(e,'seal');
        touched=true; await stageDirectory(sealedRoot,'seal',e,'seal',{directory:'sealed'});
        for(const row of snapshot.rows) {
          const parts=row.path.split('/'); let dir=sealedRoot;
          for(let i=0;i<parts.length-1;i++) { dir=path.join(dir,parts[i]); if(!maybeStat(dir)) await stageDirectory(dir,'seal',e,'seal',{path:row.path}); else checkedPath(dir); }
          const sealedFile=path.join(sealedRoot,...parts);
          const fileIdentity=await exclusiveWrite(sealedFile,snapshot.contents.get(row.path),row.gitMode === '100755' ? 0o700 : 0o600,
            hit,()=>guard(e,'seal'),'seal',{path:row.path});
          if(v2)sealedIdentities.set(sealedFile,fileIdentity);
        }
        await hit('seal.hash.before',{}); guard(e,'seal');
        scanTree(sealedRoot,snapshot.rows); treeNow();
        await hit('seal.hash.after',{}); guard(e,'seal');
        const manifestFile=path.join(control,'manifest.json');
        const manifestIdentity=await exclusiveWrite(manifestFile,Buffer.from(canonicalize(descriptor)),0o600,hit,()=>guard(e,'seal'),'manifest',{},()=>controls.add('manifest.json'));
        if(v2)sealedIdentities.set(manifestFile,manifestIdentity);
        await hit('seal.beforeAck',{candidateDigest:descriptor.candidateDigest}); guard(e,'seal');
        scanTree(sealedRoot,snapshot.rows); treeNow();
        need(readRegular(path.join(control,'manifest.json'),WORKSPACE_LIMITS.fileBytes).bytes.toString('utf8') === canonicalize(descriptor),'MANIFEST_CHANGED');
        if(v2){for(const [file,expected]of sealedIdentities)need(readRegular(file,WORKSPACE_LIMITS.fileBytes).identity===expected,'SEALED_IDENTITY_CHANGED');
          v2ProtectedSnapshot=[config.sourceRoot,config.legacyRoot,config.configRoot,...config.protectedRoots].map(custodyInventory);
          v2WorkspaceSnapshot=custodyInventory(root);}
        localCheck(e,'seal'); const handle=opaque(); sealed={handle,descriptor,epoch:e};
        return Object.freeze({handle,descriptor});
      } catch(error) { if(touched) throw poison(error); throw error; }
    })();
    return sealTask;
  }
  function sealedNow() {
    try {
      scanTree(sealedRoot,sealed.descriptor.files);
      if(v2){for(const [file,expected]of sealedIdentities)need(readRegular(file,WORKSPACE_LIMITS.fileBytes).identity===expected,'SEALED_IDENTITY_CHANGED');
        need(custodyInventory(root)===v2WorkspaceSnapshot,'CUSTODY_IDENTITY_CHANGED');}
      need(readRegular(path.join(control,'manifest.json'),WORKSPACE_LIMITS.fileBytes).bytes.toString('utf8') === canonicalize(sealed.descriptor),'MANIFEST_CHANGED');
    } catch(e) { throw poison(e); }
  }
  function view(viewActor,role) {
    live(); need(!transferring && !transferred,'CUSTODY_TRANSFERRED'); need(sealed && epoch === sealed.epoch,'SEAL_REQUIRED'); need(role === 'reviewer' || role === 'validator','INVALID_ROLE');
    deepFrozen(viewActor); const metadata=actorValidator(viewActor);
    need(viewActor !== actor && metadata.id !== actor.id && !viewActors.has(role) &&
      ![...viewActors.values()].some(a=>a === viewActor || a.id === metadata.id),'ROLE_NOT_DISTINCT');
    guard(sealed.epoch,'view'); sealedNow();
    viewActors.set(role,viewActor); const handle=opaque(); views.set(handle,{owner:internal,actor:viewActor,role,seal:sealed}); return handle;
  }
  async function readView(record,readActor,input) {
    need(record.actor === readActor,'WRONG_ACTOR'); live(); need(sealed && record.seal === sealed && epoch === sealed.epoch,'STALE_VIEW');
    const o=closed(input,['operation'],['path','offset','limit']); let request;
    if(o.operation === 'read' || o.operation === 'before') {
      const operation=o.operation;
      request=fileRequest({...o,operation:'read'}); request={...request,operation};
    } else {
      need(o.operation === 'list' || o.operation === 'changes','INVALID_OPERATION');
      exact(o,['operation','offset','limit']); request=ownedJson(o); integer(request.offset,0,512); integer(request.limit,1,128);
    }
    const e=sealed.epoch;
    await hit('view.before',{operation:request.operation}); guard(e,'view');
    sealedNow();
    let result;
    if(request.operation === 'list' || request.operation === 'changes') {
      const all=request.operation === 'list' ? sealed.descriptor.files : sealed.descriptor.changes;
      need(request.offset <= all.length,'INVALID_OFFSET');
      const end=Math.min(all.length,request.offset+request.limit);
      result=ownedJson({provenance:PROVENANCE,candidateDigest:sealed.descriptor.candidateDigest,rows:all.slice(request.offset,end),total:all.length,nextOffset:end});
    } else {
      const before=request.operation === 'before';
      const row=(before ? config.baseline.files : sealed.descriptor.files).find(f=>f.path === request.path); need(row,'UNKNOWN_FILE');
      const bytes=before ? baselineBytes.get(row.path) : readRegular(path.join(sealedRoot,...row.path.split('/')),WORKSPACE_LIMITS.fileBytes).bytes;
      need(bytes && rawHash(bytes) === row.sha256,'FILE_CHANGED'); result=sliceReceipt(row,bytes,request.offset,request.limit);
    }
    await hit('view.after',{operation:request.operation}); guard(e,'view'); sealedNow(); return result;
  }
  function transfer(sealHandle) {
    need(v2,'V2_REQUIRED');live();
    if(transferring||transferred||!sealed||sealHandle!==sealed.handle)throw poison(error('UNKNOWN_SEAL'));
    // Admission and old view epochs end before the caller can advance the durable journal.
    transferring=true;admission=false;epoch++;const transferEpoch=epoch;
    custodyTask=(async()=>{
      try{
        await Promise.allSettled([beginTask,queue,...pendingViews].filter(Boolean));await settleExecution();
        guard(transferEpoch,'seal');sealedNow();treeNow();
        const protectedSnapshot=v2ProtectedSnapshot;
        need([config.sourceRoot,config.legacyRoot,config.configRoot,...config.protectedRoots].every((p,i)=>custodyInventory(p)===protectedSnapshot[i]),'PROTECTED_TREE_CHANGED');
        need(!revoked && !poisoned && epoch===transferEpoch,'STALE_EPOCH');transferred=true;transferring=false;
        let stageObserved=false,custodyClosed=false,leaseCount=0;
        const check=(leaseRecord=null,allowAuthor=true)=>{
          live();need(transferred && !custodyClosed && epoch===transferEpoch,'CUSTODY_REVOKED');
          let s;
          try{s=readStateV2(config);}catch(e){if(e.code==='AUTHORITY_UNAVAILABLE')throw e;custodyClosed=true;throw poison(e);}
          // Final external callback precedes all filesystem observations.
          live();need(!custodyClosed && epoch===transferEpoch,'CUSTODY_REVOKED');
          const sameCandidate=s.candidate===sealed.descriptor.candidateDigest;
          const authorTransition=s.phase==='AUTHORING' && s.candidate===null && s.revision===baselineState.revision;
          if(!(s.generation===sealed.descriptor.generation && same(planIdentityV2(s.plan),planIdentityV2(plan)) &&
            s.attempts.at(-1)?.assignmentId===assignmentId)) {custodyClosed=true;throw poison(error('STALE_CUSTODY'));}
          if(authorTransition){if(stageObserved||digest(s)!==stateDigest){custodyClosed=true;throw poison(error('STALE_CUSTODY'));}need(allowAuthor,'CANDIDATE_NOT_COMMITTED');}
          else{
            if(!(sameCandidate&&['FROZEN','VALIDATING','REVIEWING','DIAGNOSTIC_READY'].includes(s.phase))){custodyClosed=true;throw poison(error('STALE_CUSTODY'));}
            stageObserved=true;
          }
          if(leaseRecord){
            need(!authorTransition,'CANDIDATE_NOT_COMMITTED');const a=s.assignments.find(x=>x.id===leaseRecord.assignmentId);
            need(a && a.generation===s.generation && a.role===leaseRecord.role && same(a.actor,leaseRecord.metadata) &&
              same(a.binding,bindingForV2(plan,sealed.descriptor.candidateDigest)),'STALE_LEASE');
          }
          try{
            const currentStore=readOwner(path.join(config.governanceRoot,'lock.json'));
            need(currentStore.text===storeOwner.text && currentStore.identity===storeOwner.identity,'AUTHORITY_OWNER_LOST');
            ownership();sealedNow();treeNow();
            const roots=[config.sourceRoot,config.legacyRoot,config.configRoot,...config.protectedRoots];
            need(roots.every((p,i)=>custodyInventory(p)===protectedSnapshot[i]),'PROTECTED_TREE_CHANGED');
          }catch(e){custodyClosed=true;throw poison(e);}
          live();need(epoch===transferEpoch,'STALE_EPOCH');return s;
        };
        const leaseRecord=(handle,exactActor)=>{
          const value=custodyLeases.get(handle);need(value && value.custody===custodyFacade && value.actor===exactActor,'UNKNOWN_CUSTODY_LEASE');return value;
        };
        const track=operation=>{
          live();need(custodyPending.size<WORKSPACE_LIMITS.queue,'QUEUE_LIMIT');
          const task=Promise.resolve().then(operation);custodyPending.add(task);task.then(()=>custodyPending.delete(task),()=>custodyPending.delete(task));return task;
        };
        const readRequest=input=>{
          const o=closed(input,['operation'],['path','offset','limit']);
          if(o.operation==='read'||o.operation==='before'){const request=fileRequest({...o,operation:'read'});return {...request,operation:o.operation};}
          need(o.operation==='list'||o.operation==='changes','INVALID_OPERATION');exact(o,['operation','offset','limit']);integer(o.offset,0,512);integer(o.limit,1,128);return ownedJson(o);
        };
        custodyFacade=Object.freeze({
          descriptor(){check();return sealed.descriptor;},
          verify(){check();return true;},
          lease(input){
            need(!deliveryAdmission,'DELIVERY_IN_PROGRESS');
            const o=closed(input,['actor','assignmentId','role']);deepFrozen(o.actor);const metadata=validateActorV2(o.actor);id(o.assignmentId);
            need(['validator','reviewer'].includes(o.role) && metadata.id!==actor.id,'ROLE_NOT_DISTINCT');
            const record={custody:custodyFacade,actor:o.actor,metadata,assignmentId:o.assignmentId,role:o.role};check(record,false);
            need(leaseCount<WORKSPACE_LIMITS.queue,'VIEW_LIMIT');const token=opaque();custodyLeases.set(token,record);leaseCount++;return token;
          },
          read(handle,exactActor,input){
            need(!deliveryAdmission,'DELIVERY_IN_PROGRESS');
            const record=leaseRecord(handle,exactActor),r=readRequest(input);
            return track(async()=>{
              await hit('custody.read.before',{operation:r.operation});check(record,false);let result;
              if(r.operation==='list'||r.operation==='changes'){
                const all=r.operation==='list'?sealed.descriptor.files:sealed.descriptor.changes;need(r.offset<=all.length,'INVALID_OFFSET');const end=Math.min(all.length,r.offset+r.limit);
                result=ownedJson({provenance:V2_PROVENANCE,candidateDigest:sealed.descriptor.candidateDigest,rows:all.slice(r.offset,end),total:all.length,nextOffset:end});
              }else{
                const before=r.operation==='before',row=(before?config.baseline.files:sealed.descriptor.files).find(x=>x.path===r.path);need(row,'UNKNOWN_FILE');
                const bytes=before?baselineBytes.get(row.path):readRegular(path.join(sealedRoot,...row.path.split('/')),WORKSPACE_LIMITS.fileBytes).bytes;
                need(bytes&&rawHash(bytes)===row.sha256,'FILE_CHANGED');result=ownedJson({...sliceReceipt(row,bytes,r.offset,r.limit),provenance:V2_PROVENANCE});
              }
              await hit('custody.read.after',{operation:r.operation});check(record,false);return result;
            });
          },
          replica(handle,exactActor,input){
            need(!deliveryAdmission,'DELIVERY_IN_PROGRESS');
            const record=leaseRecord(handle,exactActor);need(record.role==='validator','REPLICA_ROLE');const o=closed(input,['replicaRoot','scratchRoot']);
            const proposed=ownedJson(o);
            return track(async()=>{
              check(record,false);const replicaRoot=absolute(proposed.replicaRoot),scratchRoot=absolute(proposed.scratchRoot);
              checkedRoots([config.sourceRoot,config.workspaceRoot,config.scratchRoot,config.governanceRoot,config.legacyRoot,config.configRoot,...config.protectedRoots,replicaRoot,scratchRoot]);
              need(!maybeStat(replicaRoot)&&!maybeStat(scratchRoot),'REPLICA_EXISTS');
              const journalSnapshot=custodyInventory(config.governanceRoot),replicaNodes=retainedDirectories(replicaRoot),scratchNodes=retainedDirectories(scratchRoot);
              let replicaClosed=false,replicaBad=false,finished=false;const copies=new Map();
              const verify=()=>{
                need(!replicaClosed&&!replicaBad,'REPLICA_REVOKED');check(record,false);
                need(!replicaClosed&&!replicaBad,'REPLICA_REVOKED');
                try{
                  checkDirectories(replicaNodes);checkDirectories(scratchNodes);need(custodyInventory(config.governanceRoot)===journalSnapshot,'JOURNAL_CHANGED');
                  if(finished){scanTree(replicaRoot,sealed.descriptor.files);for(const [p,expected]of copies)need(readRegular(path.join(replicaRoot,...p.split('/')),WORKSPACE_LIMITS.fileBytes).identity===expected,'REPLICA_IDENTITY_CHANGED');}
                }catch(e){replicaBad=true;throw e;}return true;
              };
              try{
                await makeDirectories(replicaRoot,hit,verify,'replica',{},replicaNodes,()=>localCheck(transferEpoch,'seal'),true);
                await makeDirectories(scratchRoot,hit,verify,'replica.scratch',{},scratchNodes,()=>localCheck(transferEpoch,'seal'),true);
                for(const row of sealed.descriptor.files){
                  const target=path.join(replicaRoot,...row.path.split('/'));await makeDirectories(path.dirname(target),hit,verify,'replica.directory',{},replicaNodes,()=>localCheck(transferEpoch,'seal'));
                  const bytes=readRegular(path.join(sealedRoot,...row.path.split('/')),WORKSPACE_LIMITS.fileBytes).bytes;
                  need(rawHash(bytes)===row.sha256,'FILE_CHANGED');const writtenIdentity=await exclusiveWrite(target,bytes,row.gitMode==='100755'?0o700:0o600,hit,verify,'replica.file',{path:row.path});
                  copies.set(row.path,writtenIdentity);const written=readRegular(target,WORKSPACE_LIMITS.fileBytes);
                  need(written.identity===writtenIdentity,'REPLICA_IDENTITY_CHANGED');
                  need(!sameNode(written.stat,lstat(path.join(sealedRoot,...row.path.split('/')))),'REPLICA_NOT_INDEPENDENT');
                }
                finished=true;verify();const facade=Object.freeze({root:replicaRoot,scratchRoot,verify,close(){replicaClosed=true;replicas.delete(facade);}});replicas.add(facade);return facade;
              }catch(e){replicaBad=true;throw e;}
            });
          },
        });
        custodians.set(custodyFacade,{owner:internal,descriptor:sealed.descriptor,prepareDelivery(input){
          need(!deliveryAdmission,'DELIVERY_ALREADY_ADMITTED');need(custodyPending.size===0&&replicas.size===0,'DELIVERY_UNSETTLED');
          const state=check(null,false);need(state.phase==='DIAGNOSTIC_READY','DELIVERY_NOT_READY');
          deliveryAdmission=true;
          const facade=makeCustodyDeliveryM4B(input,{descriptor:sealed.descriptor,sealedRoot,state,
            protectedRoots:[config.sourceRoot,config.workspaceRoot,config.scratchRoot,config.governanceRoot,config.legacyRoot,config.configRoot,...config.protectedRoots],
            check(){const current=check(null,false);need(current.phase==='DIAGNOSTIC_READY','DELIVERY_NOT_READY');},
            track,failpoint:config.failpoint});
          deliveryFacades.add(facade);return facade;
        }});check();return custodyFacade;
      }catch(e){transferring=false;throw poison(e);}
    })();return custodyTask;
  }
  function revoke() { if(!revoked) { revoked=true; admission=false; epoch++;for(const replica of [...replicas])replica.close();for(const delivery of deliveryFacades)delivery.revoke(); } }
  function close() {
    if(closing) return closing; revoke();
    closing=(async()=>{
      await Promise.allSettled([beginTask,queue,sealTask,custodyTask,...pendingViews,...custodyPending].filter(Boolean));
      let failure;
      for(const delivery of deliveryFacades)try{await delivery.close();}catch(e){failure??=e;}
      try { await settleExecution(); } catch(e) { failure??=e; }
      if(failure && owner) poison(failure);
      need(!poisoned,'WORKSPACE_POISONED');
      if(owner) {
        try {
          ownership();
          await hit('lock.release.before',{assignmentId}); ownership();
          // Closing never renews authority. Only the exact retained owner may remove its own lock.
          fs.unlinkSync(lockPath); owner=null; rootEntries.delete('lock.json');
          await hit('lock.release.after',{assignmentId});
        } catch(e) { throw poison(e); }
      }
      closedOwner=true;
    })(); return closing;
  }
  const internal={enqueue,readView(record,readActor,input) {
    live(); need(pendingViews.size < WORKSPACE_LIMITS.queue,'QUEUE_LIMIT');
    const ownedInput=ownedJson(input);
    const task=Promise.resolve().then(()=>readView(record,readActor,ownedInput)); pendingViews.add(task);
    task.then(()=>pendingViews.delete(task),()=>pendingViews.delete(task)); return task;
  }};
  return Object.freeze({
    beginAttempt(input) {
      if(beginTask || enrolling) return Promise.reject(error('ATTEMPT_ALREADY_STARTED'));
      enrolling=true; beginTask=begin(input); enrolling=false; return beginTask;
    },seal,view,revoke,close,...(v2?{transfer}:{}),
  });
}

export async function workspaceFile(handle,exactActor,request) {
  const record=authors.get(handle); need(record && record.actor === exactActor,'UNKNOWN_AUTHOR_HANDLE');
  const owned=fileRequest(request); return record.owner.enqueue(exactActor,owned,record.epoch);
}
export async function workspaceRead(handle,exactActor,request) {
  const record=views.get(handle); need(record && record.actor === exactActor,'UNKNOWN_VIEW_HANDLE');
  return record.owner.readView(record,exactActor,request);
}

// Destination and copy handles are trusted-owner capabilities, never model facades or serialized grants.
const deliveryDestinationsM4B=new WeakMap();
export function captureDeliveryDestinationM4B(input){
  const config=ownedJson(input);exact(config,['destinationId','outputRoot','protectedRoots']);id(config.destinationId);
  const outputRoot=absolute(config.outputRoot);need(outputRoot===config.outputRoot,'DELIVERY_NONCANONICAL_ROOT');
  need(Array.isArray(config.protectedRoots)&&config.protectedRoots.length>0&&config.protectedRoots.length<=64,'INVALID_ROOTS');
  const protectedRoots=config.protectedRoots.map(p=>{const value=absolute(p);need(value===p,'DELIVERY_NONCANONICAL_ROOT');return value;});
  need(new Set(protectedRoots.map(fold)).size===protectedRoots.length,'DELIVERY_DUPLICATE_ROOT');
  checkedPath(outputRoot,{missing:true});need(!maybeStat(outputRoot),'DELIVERY_OUTPUT_EXISTS');checkedPath(path.dirname(outputRoot));
  for(const root of protectedRoots){checkedPath(root,{missing:true});need(!overlap(outputRoot,root)&&!overlap(root,outputRoot),'DELIVERY_ROOT_OVERLAP');}
  const nodes=retainedDirectories(outputRoot),protectedNodes=protectedRoots.map(retainedDirectories),handle=opaque();
  deliveryDestinationsM4B.set(handle,{config,outputRoot,protectedRoots,nodes,protectedNodes,admitted:false,verifyClaim:null});return handle;
}
export function verifyDeliveryDestinationM4B(handle){
  const record=deliveryDestinationsM4B.get(handle);need(record,'UNKNOWN_DELIVERY_DESTINATION');
  checkDirectories(record.nodes);for(const nodes of record.protectedNodes)checkDirectories(nodes);
  if(record.verifyClaim)record.verifyClaim();else{checkedPath(record.outputRoot,{missing:true});need(!maybeStat(record.outputRoot),'DELIVERY_OUTPUT_EXISTS');}
  return ownedJson({destinationId:record.config.destinationId});
}
export const assertDeliveryDestinationM4B=verifyDeliveryDestinationM4B;
export function prepareCustodyDeliveryM4B(custody,input){
  const owner=custodians.get(custody);need(owner&&typeof owner.prepareDelivery==='function','UNKNOWN_CUSTODY');return owner.prepareDelivery(input);
}
function makeCustodyDeliveryM4B(input,owner){
  const o=closed(input,['destination','qualificationReceipt','authorize'],['failpoint']);
  need(typeof o.authorize==='function'&&(o.failpoint===undefined||typeof o.failpoint==='function'),'INVALID_DELIVERY_CALLBACK');
  const destination=deliveryDestinationsM4B.get(o.destination);need(destination&&!destination.admitted,'UNKNOWN_DELIVERY_DESTINATION');
  verifyDeliveryDestinationM4B(o.destination);
  const receipt=validateDeliveryReceiptM4B(o.qualificationReceipt),descriptor=owner.descriptor;
  need(receipt.candidateDigest===descriptor.candidateDigest&&receipt.destinationId===destination.config.destinationId&&
    receipt.descriptorDigest===digest(descriptor)&&receipt.payloadInventoryDigest===digest(descriptor.files)&&
    receipt.jobId===owner.state.jobId&&receipt.projectId===owner.state.projectId&&receipt.generation===owner.state.generation,'DELIVERY_RECEIPT_MISMATCH');
  for(const root of owner.protectedRoots)need(!overlap(destination.outputRoot,root)&&!overlap(root,destination.outputRoot),'DELIVERY_ROOT_OVERLAP');
  need(descriptor.files.length<=WORKSPACE_LIMITS.files&&descriptor.files.reduce((n,row)=>n+row.bytes,0)<=WORKSPACE_LIMITS.totalBytes,'DELIVERY_PAYLOAD_LIMIT');
  const descriptorBytes=Buffer.from(canonicalize(descriptor)),receiptBytes=Buffer.from(canonicalize(receipt));
  need(descriptorBytes.length<=WORKSPACE_LIMITS.fileBytes&&receiptBytes.length<=WORKSPACE_LIMITS.fileBytes,'DELIVERY_METADATA_LIMIT');
  const receiptHash=digest(receipt),payloadRoot=path.join(destination.outputRoot,'payload'),dirs=new Map(destination.nodes),files=new Map(),admittedFiles=new Map(),knownPaths=new Set();
  const hook=makeHook(async(name,detail)=>{
    if(owner.failpoint){await owner.failpoint(name,detail);if(!name.startsWith('cleanup.'))guard();}
    if(o.failpoint&&o.failpoint!==owner.failpoint){await o.failpoint(name,detail);if(!name.startsWith('cleanup.'))guard();}
  });
  let revoked=false,bad=false,copied=false,marked=false,copyUsed=false,markerUsed=false,active=null,closing,drainFailure;
  destination.admitted=true;
  function directoryInventory(){
    checkDirectories(dirs);for(const nodes of destination.protectedNodes)checkDirectories(nodes);
    const allowedDirs=new Set([...dirs.keys()].filter(p=>p===destination.outputRoot||p.startsWith(destination.outputRoot+path.sep)));
    function walk(dir){
      for(const name of boundedNames(dir,WORKSPACE_LIMITS.files*WORKSPACE_LIMITS.depth+8)){
        const p=path.join(dir,name),st=lstat(p);need(!st.isSymbolicLink(),'DELIVERY_PATH_LINK');
        if(st.isDirectory()){need(allowedDirs.has(p),'DELIVERY_EXTRA_DIRECTORY');walk(p);}
        else{regular(st);need(admittedFiles.has(p),'DELIVERY_EXTRA_FILE');const original=admittedFiles.get(p);need(sameNode(st,original),'DELIVERY_FILE_REPLACED');}
      }
    }
    if(dirs.has(destination.outputRoot))walk(destination.outputRoot);else need(!maybeStat(destination.outputRoot),'DELIVERY_OUTPUT_EXISTS');
    for(const [file,expected]of files){const current=readRegular(file,WORKSPACE_LIMITS.fileBytes);need(current.identity===expected.identity&&rawHash(current.bytes)===expected.sha256,'DELIVERY_FILE_CHANGED');}
  }
  destination.verifyClaim=directoryInventory;
  function guard(){
    need(!revoked&&!bad,'DELIVERY_REVOKED');
    const admitted=o.authorize();if(admitted&&typeof admitted.then==='function'){Promise.resolve(admitted).catch(()=>{});throw error('DELIVERY_ASYNC_AUTHORITY');}
    need(admitted===true&&!revoked&&!bad,'DELIVERY_REVOKED');owner.check();need(!revoked&&!bad,'DELIVERY_REVOKED');directoryInventory();
  }
  const context=relative=>({path:relative,destinationId:destination.config.destinationId});
  async function write(relative,bytes,mode,stage){
    const target=path.join(destination.outputRoot,...relative.split('/'));
    need(!knownPaths.has(target),'DELIVERY_DUPLICATE_PATH');knownPaths.add(target);
    await makeDirectories(path.dirname(target),hook,guard,'delivery.directory',context(relative),dirs,()=>need(!revoked&&!bad,'DELIVERY_REVOKED'));
    guard();ownedTarget(dirs,target,{file:true});
    const identity=await exclusiveWrite(target,bytes,mode,hook,guard,stage,context(relative),
      ()=>{guard();ownedTarget(dirs,target,{file:true});},node=>{admittedFiles.set(target,node);});
    files.set(target,{identity,sha256:rawHash(bytes)});guard();
  }
  function finalInventory(marker){
    guard();scanTree(payloadRoot,descriptor.files);
    const expected=['payload','descriptor.json','qualification-receipt.json',...(marker?['complete.json']:[])].sort();
    need(same(boundedNames(destination.outputRoot),expected),'DELIVERY_OUTPUT_INVENTORY');
    need(readRegular(path.join(destination.outputRoot,'descriptor.json'),WORKSPACE_LIMITS.fileBytes).bytes.equals(descriptorBytes),'DELIVERY_DESCRIPTOR_CHANGED');
    need(readRegular(path.join(destination.outputRoot,'qualification-receipt.json'),WORKSPACE_LIMITS.fileBytes).bytes.equals(receiptBytes),'DELIVERY_RECEIPT_CHANGED');
    for(const row of descriptor.files){const copiedFile=readRegular(path.join(payloadRoot,...row.path.split('/')),WORKSPACE_LIMITS.fileBytes),source=readRegular(path.join(owner.sealedRoot,...row.path.split('/')),WORKSPACE_LIMITS.fileBytes);
      need(!sameNode(copiedFile.stat,source.stat),'DELIVERY_NOT_INDEPENDENT');}
    guard();return true;
  }
  function track(operation){
    need(!active&&!revoked&&!bad,'DELIVERY_UNAVAILABLE');
    const task=owner.track(async()=>{try{return await operation();}catch(e){bad=true;if(e.code==='WRITE_AND_CLEANUP_FAILED')drainFailure=e;throw e;}});active=task;
    task.then(()=>{if(active===task)active=null;},()=>{if(active===task)active=null;});return task;
  }
  const api={
    copy(){
      need(arguments.length===0&&!copyUsed,'DELIVERY_ALREADY_COPIED');copyUsed=true;
      return track(async()=>{
        guard();await makeDirectories(destination.outputRoot,hook,guard,'delivery.root',context(''),dirs,()=>need(!revoked&&!bad,'DELIVERY_REVOKED'),true);
        await makeDirectories(payloadRoot,hook,guard,'delivery.payload',context('payload'),dirs,()=>need(!revoked&&!bad,'DELIVERY_REVOKED'),true);
        for(const row of descriptor.files){
          guard();const source=readRegular(path.join(owner.sealedRoot,...row.path.split('/')),WORKSPACE_LIMITS.fileBytes);
          need(source.bytes.length===row.bytes&&rawHash(source.bytes)===row.sha256,'DELIVERY_SOURCE_CHANGED');
          await write('payload/'+row.path,source.bytes,row.gitMode==='100755'?0o700:0o600,'delivery.file');
        }
        await write('descriptor.json',descriptorBytes,0o600,'delivery.descriptor');
        await write('qualification-receipt.json',receiptBytes,0o600,'delivery.receipt');
        finalInventory(false);copied=true;return ownedJson({qualificationOnly:true,operationallyAccepted:false,gateActive:false,candidateDigest:descriptor.candidateDigest,destinationId:destination.config.destinationId,receiptHash});
      });
    },
    verify(){need(copied,'DELIVERY_COPY_REQUIRED');return finalInventory(marked);},
    complete(input){
      need(copied&&!markerUsed,'DELIVERY_MARKER_ALREADY_ADMITTED');const marker=validateDeliveryMarkerM4B(input);
      need(marker.receiptHash===receiptHash&&marker.candidateDigest===descriptor.candidateDigest&&marker.destinationId===destination.config.destinationId,'DELIVERY_MARKER_MISMATCH');
      markerUsed=true;return track(async()=>{finalInventory(false);await write('complete.json',Buffer.from(canonicalize(marker)),0o600,'delivery.marker');finalInventory(true);marked=true;return ownedJson(marker);});
    },
    revoke(){revoked=true;},
    close(){if(!closing){revoked=true;const task=active;closing=(async()=>{if(task)await task.catch(()=>{});if(drainFailure)throw drainFailure;directoryInventory();})();}return closing;},
  };
  guard();return Object.freeze(api);
}

/** Cold output consistency only; it neither captures a destination nor constructs custody authority. */
export function inspectDeliveryOutputM4B(input,expectedReceipt,eventDigest){
  const config=ownedJson(input);exact(config,['destinationId','outputRoot','protectedRoots']);id(config.destinationId);hash(eventDigest);
  const outputRoot=absolute(config.outputRoot);need(outputRoot===config.outputRoot,'DELIVERY_NONCANONICAL_ROOT');
  need(Array.isArray(config.protectedRoots)&&config.protectedRoots.length>0&&config.protectedRoots.length<=64,'INVALID_ROOTS');
  for(const root of config.protectedRoots){need(absolute(root)===root,'DELIVERY_NONCANONICAL_ROOT');checkedPath(root,{missing:true});need(!overlap(outputRoot,root)&&!overlap(root,outputRoot),'DELIVERY_ROOT_OVERLAP');}
  checkedPath(outputRoot);const dirs=retainedDirectories(outputRoot),snapshot=custodyInventory(outputRoot);
  need(same(boundedNames(outputRoot),['complete.json','descriptor.json','payload','qualification-receipt.json']),'DELIVERY_OUTPUT_INVENTORY');
  const receipt=validateDeliveryReceiptM4B(expectedReceipt),receiptBytes=readRegular(path.join(outputRoot,'qualification-receipt.json'),WORKSPACE_LIMITS.fileBytes).bytes;
  need(receipt.destinationId===config.destinationId&&receiptBytes.equals(Buffer.from(canonicalize(receipt))),'DELIVERY_RECEIPT_MISMATCH');
  const descriptor=validateCandidateDescriptorV2(JSON.parse(textBytes(readRegular(path.join(outputRoot,'descriptor.json'),WORKSPACE_LIMITS.fileBytes).bytes)));
  need(receipt.descriptorDigest===digest(descriptor)&&receipt.payloadInventoryDigest===digest(descriptor.files)&&receipt.candidateDigest===descriptor.candidateDigest,'DELIVERY_DESCRIPTOR_CHANGED');
  need(readRegular(path.join(outputRoot,'descriptor.json'),WORKSPACE_LIMITS.fileBytes).bytes.equals(Buffer.from(canonicalize(descriptor))),'DELIVERY_DESCRIPTOR_CHANGED');
  need(descriptor.files.length<=WORKSPACE_LIMITS.files&&descriptor.files.reduce((n,row)=>n+row.bytes,0)<=WORKSPACE_LIMITS.totalBytes,'DELIVERY_PAYLOAD_LIMIT');
  scanTree(path.join(outputRoot,'payload'),descriptor.files);
  const marker=validateDeliveryMarkerM4B(JSON.parse(textBytes(readRegular(path.join(outputRoot,'complete.json'),WORKSPACE_LIMITS.fileBytes).bytes)));
  need(marker.eventDigest===eventDigest&&marker.receiptHash===digest(receipt)&&marker.candidateDigest===descriptor.candidateDigest&&marker.destinationId===config.destinationId,'DELIVERY_MARKER_MISMATCH');
  need(readRegular(path.join(outputRoot,'complete.json'),WORKSPACE_LIMITS.fileBytes).bytes.equals(Buffer.from(canonicalize(marker))),'DELIVERY_MARKER_MISMATCH');
  checkDirectories(dirs);need(custodyInventory(outputRoot)===snapshot,'DELIVERY_OUTPUT_CHANGED');
  return ownedJson({qualificationOnly:true,operationallyAccepted:false,gateActive:false,complete:true,destinationId:config.destinationId,candidateDigest:descriptor.candidateDigest,receiptHash:digest(receipt),eventDigest});
}
