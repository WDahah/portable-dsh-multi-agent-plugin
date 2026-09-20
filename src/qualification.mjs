import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export const BUILD_ID = 'portable-multi-agent-1';
const sha = value => createHash('sha256').update(value).digest('hex');
export const keyOf = value => 'x' + sha(value);
export function need(value, code = 'BRIDGE_REFUSED') {if (!value) throw Object.assign(new Error(code), {code});}
export function scopedSignal(parent, milliseconds) {
  parent.throwIfAborted();
  const controller = new AbortController();
  const relay = () => controller.abort(parent.reason);
  parent.addEventListener('abort', relay, {once: true});
  if (parent.aborted) relay();
  const timer = setTimeout(() => controller.abort(new DOMException('Bridge deadline', 'AbortError')), milliseconds);
  return {controller, signal: controller.signal, close() {clearTimeout(timer); parent.removeEventListener('abort', relay);}};
}
async function safeDirectory(directory, create = false) {
  const absolute = path.resolve(directory), base = path.parse(absolute).root;
  let current = base;
  for (const part of ['', ...absolute.slice(base.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat;
    try {stat = await fs.lstat(current);} catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      try {await fs.mkdir(current, {mode: 0o700});} catch (e) {if (e.code !== 'EEXIST') throw e;}
      stat = await fs.lstat(current);
    }
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_JOURNAL_PATH');
  }
  return true;
}
/** Owned JSON only. Immutable revisions, file fsync, latest corruption refuses recovery. */
export function createRecordStore(root, owner, namespace) {
  need(path.isAbsolute(root) && typeof owner === 'string' && owner.length > 0 && owner.length <= 256);
  need(['qualifications', 'assignments'].includes(namespace));
  const base = path.join(root, 'bridge', keyOf(owner), namespace);
  const location = key => {need(/^x[a-f0-9]{64}$/.test(key)); return path.join(base, key);};
  async function read(key) {
    const directory = location(key);
    if (!await safeDirectory(directory)) return null;
    const entries = await fs.readdir(directory, {withFileTypes: true});
    need(entries.length <= 1024 && entries.every(e => e.isFile() && !e.isSymbolicLink() && /^\d{8}\.json$/.test(e.name)), 'CORRUPT_JOURNAL');
    const names = entries.map(e => e.name).sort();
    names.forEach((name, i) => need(name === String(i + 1).padStart(8, '0') + '.json', 'CORRUPT_JOURNAL'));
    if (!names.length) return null;
    const filename = path.join(directory, names.at(-1)), stat = await fs.lstat(filename);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, 'CORRUPT_JOURNAL');
    const envelope = JSON.parse(await fs.readFile(filename, 'utf8'));
    need(envelope && Object.keys(envelope).sort().join() === 'data,key,owner,revision,sha256,version', 'CORRUPT_JOURNAL');
    const {sha256, ...body} = envelope;
    need(body.version === 1 && body.owner === owner && body.key === key && body.revision === names.length && sha(JSON.stringify(body)) === sha256, 'CORRUPT_JOURNAL');
    return {revision: body.revision, data: body.data};
  }
  async function save(key, data, expectedRevision) {
    const directory = location(key); await safeDirectory(directory, true);
    const current = await read(key);
    need((current?.revision || 0) === expectedRevision && expectedRevision < 1024, 'JOURNAL_CONFLICT');
    const body = {version: 1, owner, key, revision: expectedRevision + 1, data};
    const encoded = JSON.stringify({...body, sha256: sha(JSON.stringify(body))});
    need(Buffer.byteLength(encoded) <= 2 * 1024 * 1024, 'JOURNAL_BOUND');
    const handle = await fs.open(path.join(directory, String(body.revision).padStart(8, '0') + '.json'), 'wx', 0o600);
    try {await handle.writeFile(encoded); await handle.sync();} finally {await handle.close();}
    return body.revision;
  }
  async function list() {
    if (!await safeDirectory(base)) return [];
    const entries = await fs.readdir(base, {withFileTypes: true});
    need(entries.length <= 256 && entries.every(e => e.isDirectory() && !e.isSymbolicLink() && /^x[a-f0-9]{64}$/.test(e.name)), 'CORRUPT_JOURNAL');
    const records = [];
    for (const entry of entries) {const value = await read(entry.name); if (value) records.push(value.data);}
    return records;
  }
  return {read, save, list};
}
export function visibleOutput(output) {
  need(Array.isArray(output), 'INVALID_CHILD_OUTPUT');
  let text = '';
  for (const block of output) if (block?.type === 'text') {
    need(typeof block.text === 'string' && text.length + block.text.length <= 262144, 'CHILD_OUTPUT_BOUND');
    text += block.text;
  }
  return text;
}
export function createQualificationManager({root, owner, getLlm, getSubagents, clock = Date.now, deadlineMs = 180000}) {
  const store = createRecordStore(root, owner, 'qualifications'), challenges = new Map(), busy = new Set(), controllers = new Set();
  need(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 180000, 'INVALID_DEADLINE');
  const runtimeId = randomUUID(); let disposed = false;
  function echo(args, exec) {
    const c = challenges.get(args.token);
    need(c && !disposed && clock() < c.expiresAt && typeof exec.agent?.id === 'string', 'INVALID_CHALLENGE');
    c.calls.push(exec.agent.id); need(c.calls.length === 1, 'CHALLENGE_ALREADY_USED');
    return {marker: c.marker};
  }
  async function qualify(route, effort, exec) {
    need(!disposed && exec.agent?.id === owner, 'OWNER_REFUSED');
    need(route && typeof route.provider === 'string' && typeof route.model === 'string' && typeof effort === 'string');
    const key = keyOf(route.provider + '\0' + route.model + '\0' + effort);
    need(!busy.has(key) && busy.size < 2, 'QUALIFICATION_BUSY'); exec.signal.throwIfAborted();
    const scope = scopedSignal(exec.signal, deadlineMs); busy.add(key); controllers.add(scope.controller);
    let run, token, childId = null, stopReason = 'error', textPassed = false, toolPassed = false, transportPassed = false, revision;
    const issuedAt = clock();
    try {
      const previous = await store.read(key); revision = previous?.revision || 0;
      const llm = getLlm?.(), subagents = getSubagents?.(); need(llm && subagents, 'MISSING_SERVICE');
      const maxTokens = ['high', 'max'].includes(effort) ? 16384 : 8192;
      const config = {provider: route.provider, model: route.model, reasoningEffort: effort, maxTokens};
      const prepared = await llm.prepareCall(config, scope.signal);
      need(prepared.config.provider === config.provider && prepared.config.model === config.model && prepared.config.reasoningEffort === effort && prepared.config.maxTokens === maxTokens, 'QUALIFICATION_CONFIG_MISMATCH');
      token = randomUUID(); const marker = randomUUID();
      const challenge = {marker, calls: [], expiresAt: issuedAt + deadlineMs}; challenges.set(token, challenge);
      run = await subagents.start('spawn', {parent: exec.agent, signal: scope.signal, label: 'Route qualification',
        agentOptions: config, maxDepth: 1, toolFilter: {allow: ['orchestrator_qualification_echo']},
        persona: 'Perform only the bounded qualification. Do not delegate or access other tools.',
        prompt: [{type: 'text', text: `Call orchestrator_qualification_echo exactly once with token ${token}. Compute 19 + 23. Then return exactly QUALIFIED:<marker returned by the tool>:42 and no other text.`}]});
      childId = run.id;
      const result = await run.result; scope.signal.throwIfAborted(); stopReason = result.stopReason;
      const text = visibleOutput(result.output).trim();
      transportPassed = stopReason === 'completed'; textPassed = transportPassed && text === `QUALIFIED:${marker}:42`;
      toolPassed = transportPassed && challenge.calls.length === 1 && challenge.calls[0] === childId;
    } catch {stopReason = scope.signal.aborted ? 'aborted' : 'error';}
    finally {
      if (token) challenges.delete(token);
      if (run) {try {await run.dispose();} catch {stopReason = 'error'; transportPassed = false; toolPassed = false; textPassed = false;}}
      scope.close(); controllers.delete(scope.controller);
    }
    const record = {schemaVersion: 1, qualificationType: 'smoke', issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId},
      runtimeBuildId: BUILD_ID, adapterFingerprint: sha(route.provider + '\0' + route.model + '\0' + BUILD_ID),
      provider: route.provider, model: route.model, effort, issuedAt, expiresAt: issuedAt + 86400000,
      durationMs: Math.max(0, Math.floor(clock() - issuedAt)), available: transportPassed && textPassed && toolPassed,
      transportPassed, textPassed, toolPassed, imagePassed: false,
      caseResults: [{name: 'text', passed: textPassed}, {name: 'native-tool-roundtrip', passed: toolPassed}],
      allowedDataClasses: ['public', 'internal'], domainEvidence: false};
    try {
      need(revision !== undefined, 'QUALIFICATION_STORAGE_UNAVAILABLE');
      await store.save(key, record, revision);
      return {qualification: record, child_id: childId, stop_reason: stopReason, cost_unknown: true, provider_usage_available: false};
    } finally {busy.delete(key);}
  }
  return {qualify, echo, async list() {
    const records = await store.list();
    return records.filter(record => record?.schemaVersion === 1 && record.runtimeBuildId === BUILD_ID &&
      record.adapterFingerprint === sha(record.provider + '\0' + record.model + '\0' + BUILD_ID));
  }, dispose() {disposed = true; for (const controller of controllers) controller.abort(); challenges.clear();}};
}
