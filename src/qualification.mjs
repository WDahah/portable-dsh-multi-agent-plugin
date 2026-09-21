import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createImageProbe, createStructuredProbe} from './probes.mjs';

export const BUILD_ID = 'portable-multi-agent-1';
// Ordinary smoke admits these; anything stricter needs an operator attestation whose
// authority this plugin cannot manufacture from a model's own output.
export const BASE_DATA_CLASSES = Object.freeze(['public', 'internal']);
export const ATTESTABLE_DATA_CLASSES = Object.freeze(['public', 'internal', 'confidential', 'restricted']);
export const CAPABILITY_PROBES = Object.freeze(['image', 'structured-output']);
const sha = value => createHash('sha256').update(value).digest('hex');
export const keyOf = value => 'x' + sha(value);
/** Identity of one exact probe, derived from the evidence itself rather than assigned.
 * Being recomputable is the point: a run's recorded link can be checked against the
 * evidence it names instead of being taken on trust. */
export function evidenceIdOf(record) {
  if (!record || typeof record !== 'object') return null;
  const {provider, model, effort, issuedAt} = record;
  const runtimeId = record.issuer?.runtimeId;
  if (typeof provider !== 'string' || typeof model !== 'string' || typeof effort !== 'string') return null;
  if (!Number.isSafeInteger(issuedAt) || typeof runtimeId !== 'string' || !runtimeId) return null;
  return 'e' + sha([provider, model, effort, issuedAt, runtimeId].join('\0')).slice(0, 31);
}
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
// Share the allocation queue across store instances for the same namespace. Concurrent
// assignments must not both claim the last directory slot before either creates it.
const recordStoreQueues = new Map();
function serializeRecordSave(base, operation) {
  const result = (recordStoreQueues.get(base) ?? Promise.resolve()).then(operation);
  const settled = result.then(() => {}, () => {});
  recordStoreQueues.set(base, settled);
  settled.then(() => {if (recordStoreQueues.get(base) === settled) recordStoreQueues.delete(base);});
  return result;
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
  async function directories() {
    if (!await safeDirectory(base)) return [];
    const found = await fs.readdir(base, {withFileTypes: true});
    need(found.length <= 256 && found.every(e => e.isDirectory() && !e.isSymbolicLink() && /^x[a-f0-9]{64}$/.test(e.name)), 'CORRUPT_JOURNAL');
    return found;
  }
  async function save(key, data, expectedRevision) {
    const directory = location(key);
    return serializeRecordSave(base, async () => {
      const found = await directories();
      // Count directories, including empty ones, exactly as listing does. Refuse before
      // creating anything, while still allowing revisions of existing records at capacity.
      need(found.some(entry => entry.name === key) || found.length < 256, 'JOURNAL_BOUND');
      const current = await read(key);
      need((current?.revision || 0) === expectedRevision && expectedRevision < 1024, 'JOURNAL_CONFLICT');
      const body = {version: 1, owner, key, revision: expectedRevision + 1, data};
      const encoded = JSON.stringify({...body, sha256: sha(JSON.stringify(body))});
      need(Buffer.byteLength(encoded) <= 2 * 1024 * 1024, 'JOURNAL_BOUND');
      await safeDirectory(directory, true);
      const handle = await fs.open(path.join(directory, String(body.revision).padStart(8, '0') + '.json'), 'wx', 0o600);
      try {await handle.writeFile(encoded); await handle.sync();} finally {await handle.close();}
      return body.revision;
    });
  }
  async function entries() {
    const found = await directories();
    const records = [];
    for (const entry of found) {const value = await read(entry.name); if (value) records.push({key: entry.name, revision: value.revision, data: value.data});}
    return records;
  }
  async function list() {
    return (await entries()).map(entry => entry.data);
  }
  /** Delete one record's whole revision directory. Validates the key and refuses a linked
   * path exactly as read and save do, so deletion cannot escape this owner's namespace. */
  async function remove(key) {
    const directory = location(key);
    if (!await safeDirectory(directory)) return false;
    const entries = await fs.readdir(directory, {withFileTypes: true});
    need(entries.every(e => e.isFile() && !e.isSymbolicLink() && /^\d{8}\.json$/.test(e.name)), 'CORRUPT_JOURNAL');
    await fs.rm(directory, {recursive: true, force: true});
    return true;
  }
  return {read, save, list, entries, remove};
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
const nonempty = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
/** Reduce a selection's evidence to the owned, storable fields. Returns null when the
 * caller supplied none, which is how a run started without recorded evidence reports
 * itself rather than inventing a link it never had. */
export function normalizeEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const {evidenceId, issuedAt, expiresAt} = input;
  if (typeof evidenceId !== 'string' || !/^e[a-f0-9]{31}$/.test(evidenceId)) return null;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return null;
  return {
    evidenceId, issuedAt, expiresAt,
    runtimeBuildId: typeof input.runtimeBuildId === 'string' ? input.runtimeBuildId : null,
    adapterFingerprint: typeof input.adapterFingerprint === 'string' ? input.adapterFingerprint : null,
    domainEvidence: input.domainEvidence === true,
    imagePassed: input.imagePassed === true,
    allowedDataClasses: Array.isArray(input.allowedDataClasses) ? input.allowedDataClasses.filter(c => typeof c === 'string') : [],
    caseResults: Array.isArray(input.caseResults) ? input.caseResults.filter(c => typeof c === 'string') : [],
    attestedBy: nonempty(input.attestedBy) ? input.attestedBy.trim() : null,
  };
}
/** Validate an operator attestation. Absent is normal; malformed is refused outright so
 * a typo silently widens nothing. This records a human claim; it proves no capability. */
export function normalizeAttestation(input) {
  if (input === undefined || input === null) return null;
  need(typeof input === 'object' && !Array.isArray(input), 'INVALID_ATTESTATION');
  const dataClasses = input.dataClasses ?? [...BASE_DATA_CLASSES];
  need(Array.isArray(dataClasses) && dataClasses.length > 0 && new Set(dataClasses).size === dataClasses.length &&
    dataClasses.every(c => ATTESTABLE_DATA_CLASSES.includes(c)), 'INVALID_ATTESTED_DATA_CLASS');
  // Every widening must name a responsible human and a reviewable basis.
  const widens = dataClasses.some(c => !BASE_DATA_CLASSES.includes(c)) || input.domainEvidence === true;
  need(!widens || (nonempty(input.attestedBy) && nonempty(input.basis, 2000)), 'ATTESTATION_AUTHOR_AND_BASIS_REQUIRED');
  need(input.domainEvidence === undefined || typeof input.domainEvidence === 'boolean', 'INVALID_ATTESTATION');
  return {
    dataClasses: [...dataClasses], domainEvidence: input.domainEvidence === true,
    attestedBy: nonempty(input.attestedBy) ? input.attestedBy.trim() : null,
    basis: nonempty(input.basis, 2000) ? input.basis.trim() : null,
    kind: 'operator-attestation',
  };
}
export function createQualificationManager({root, owner, getLlm, getSubagents, getAttachments, clock = Date.now, deadlineMs = 180000}) {
  const store = createRecordStore(root, owner, 'qualifications'), challenges = new Map(), busy = new Set(), controllers = new Set();
  need(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 180000, 'INVALID_DEADLINE');
  const runtimeId = randomUUID(); let disposed = false;
  function echo(args, exec) {
    const c = challenges.get(args.token);
    need(c && !disposed && clock() < c.expiresAt && typeof exec.agent?.id === 'string', 'INVALID_CHALLENGE');
    c.calls.push(exec.agent.id); need(c.calls.length === 1, 'CHALLENGE_ALREADY_USED');
    return {marker: c.marker};
  }
  /** One bounded child per capability. A probe never upgrades the base smoke result:
   * it can only add its own case, so a failed core probe cannot be rescued here. */
  async function runCapabilityProbe(capability, route, effort, config, exec, scope, subagents) {
    const probe = capability === 'image' ? createImageProbe() : createStructuredProbe();
    let run;
    try {
      const prompt = [{type: 'text', text: probe.instruction}];
      // Images ride as content blocks; the host attachment service owns durable storage.
      if (capability === 'image') {
        const attachments = getAttachments?.();
        need(attachments && typeof attachments.saveImage === 'function', 'IMAGE_ATTACHMENTS_UNAVAILABLE');
        for (const image of probe.images) {
          const attachment = await attachments.saveImage({data: image.data, mediaType: image.mediaType, name: image.name});
          prompt.push({type: 'image', attachment});
        }
      }
      run = await subagents.start('spawn', {parent: exec.agent, signal: scope.signal,
        label: `Qualify ${capability} · ${route.provider}/${route.model} · ${effort}`, agentOptions: config, maxDepth: 1,
        toolFilter: {allow: []},
        persona: 'Answer only the bounded capability probe. Do not delegate or use tools.',
        prompt});
      const result = await run.result; scope.signal.throwIfAborted();
      return result.stopReason === 'completed' && probe.verify(visibleOutput(result.output));
    } catch {return false;}
    finally {if (run) {try {await run.dispose();} catch { /* Probe already scored; disposal failure cannot pass it. */ }}}
  }
  async function qualify(route, effort, exec, options = {}) {
    need(!disposed && exec.agent?.id === owner, 'OWNER_REFUSED');
    need(route && typeof route.provider === 'string' && typeof route.model === 'string' && typeof effort === 'string');
    const capabilities = options.capabilities ?? [];
    need(Array.isArray(capabilities) && capabilities.every(c => CAPABILITY_PROBES.includes(c)) &&
      new Set(capabilities).size === capabilities.length, 'UNKNOWN_CAPABILITY_PROBE');
    const attestation = normalizeAttestation(options.attestation);
    const key = keyOf(route.provider + '\0' + route.model + '\0' + effort);
    need(!busy.has(key) && busy.size < 2, 'QUALIFICATION_BUSY'); exec.signal.throwIfAborted();
    const scope = scopedSignal(exec.signal, deadlineMs); busy.add(key); controllers.add(scope.controller);
    let run, token, childId = null, stopReason = 'error', textPassed = false, toolPassed = false, transportPassed = false, revision;
    const probed = new Map();
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
      run = await subagents.start('spawn', {parent: exec.agent, signal: scope.signal,
        label: `Qualify smoke · ${route.provider}/${route.model} · ${effort}`,
        agentOptions: config, maxDepth: 1, toolFilter: {allow: ['orchestrator_qualification_echo']},
        persona: 'Perform only the bounded qualification. Do not delegate or access other tools.',
        prompt: [{type: 'text', text: `Call orchestrator_qualification_echo exactly once with token ${token}. Compute 19 + 23. Then return exactly QUALIFIED:<marker returned by the tool>:42 and no other text.`}]});
      childId = run.id;
      const result = await run.result; scope.signal.throwIfAborted(); stopReason = result.stopReason;
      const text = visibleOutput(result.output).trim();
      transportPassed = stopReason === 'completed'; textPassed = transportPassed && text === `QUALIFIED:${marker}:42`;
      toolPassed = transportPassed && challenge.calls.length === 1 && challenge.calls[0] === childId;
      if (run) {await run.dispose(); run = undefined;}
      // Only probe once the core smoke passed: extra capability evidence on an
      // unusable route would be recorded but could never be selected.
      if (transportPassed && textPassed && toolPassed) {
        for (const capability of capabilities) {
          scope.signal.throwIfAborted();
          probed.set(capability, await runCapabilityProbe(capability, route, effort, config, exec, scope, subagents));
        }
      }
    } catch {stopReason = scope.signal.aborted ? 'aborted' : 'error';}
    finally {
      if (token) challenges.delete(token);
      if (run) {try {await run.dispose();} catch {stopReason = 'error'; transportPassed = false; toolPassed = false; textPassed = false;}}
      scope.close(); controllers.delete(scope.controller);
    }
    const caseResults = [{name: 'text', passed: textPassed}, {name: 'native-tool-roundtrip', passed: toolPassed}];
    for (const capability of capabilities) caseResults.push({name: capability, passed: probed.get(capability) === true});
    // An attestation is an operator statement recorded with its author, never a model
    // self-report: it widens policy only, and cannot fabricate a machine probe result.
    const attested = attestation && transportPassed && textPassed && toolPassed ? attestation : null;
    const record = {schemaVersion: 1, qualificationType: 'smoke', issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId},
      runtimeBuildId: BUILD_ID, adapterFingerprint: sha(route.provider + '\0' + route.model + '\0' + BUILD_ID),
      provider: route.provider, model: route.model, effort, issuedAt, expiresAt: issuedAt + 86400000,
      durationMs: Math.max(0, Math.floor(clock() - issuedAt)), available: transportPassed && textPassed && toolPassed,
      transportPassed, textPassed, toolPassed, imagePassed: probed.get('image') === true,
      caseResults,
      allowedDataClasses: attested ? [...attested.dataClasses] : [...BASE_DATA_CLASSES],
      domainEvidence: attested ? attested.domainEvidence : false,
      attestation: attested};
    try {
      need(revision !== undefined, 'QUALIFICATION_STORAGE_UNAVAILABLE');
      await store.save(key, record, revision);
      return {qualification: record, child_id: childId, stop_reason: stopReason, cost_unknown: true, provider_usage_available: false};
    } finally {busy.delete(key);}
  }
  const usable = record => record?.schemaVersion === 1 && record.runtimeBuildId === BUILD_ID &&
    record.adapterFingerprint === sha(record.provider + '\0' + record.model + '\0' + BUILD_ID);
  /** Delete stored evidence. Expired records are removed by default; an exact route and
   * effort removes one record whether or not it has expired. A probe in flight for that
   * route is refused rather than deleted beneath itself. */
  async function forget({route, effort, expiredOnly = true} = {}) {
    need(!disposed, 'DISPOSED');
    const now = clock();
    const removed = [];
    for (const entry of await store.entries()) {
      const record = entry.data;
      if (!usable(record)) continue;
      if (route) {
        if (record.provider !== route.provider || record.model !== route.model) continue;
        if (effort !== undefined && record.effort !== effort) continue;
      } else if (expiredOnly && record.expiresAt > now) continue;
      const key = keyOf(record.provider + '\0' + record.model + '\0' + record.effort);
      need(!busy.has(key), 'QUALIFICATION_BUSY');
      await store.remove(entry.key);
      removed.push({provider: record.provider, model: record.model, effort: record.effort, expiresAt: record.expiresAt, expired: record.expiresAt <= now});
    }
    return {removed, count: removed.length};
  }
  return {qualify, echo, forget, async list() {
    return (await store.list()).filter(usable);
  }, dispose() {disposed = true; for (const controller of controllers) controller.abort(); challenges.clear();}};
}
