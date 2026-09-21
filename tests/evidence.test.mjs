// Evidence-link fixtures: which qualification authorized a run, whether that link can be
// verified against the evidence it names, and what a record written before the link says.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {makeTempRoot} from './helpers/tmp.mjs';
import {createAgentDispatcher} from '../src/agent-dispatch.mjs';
import {createTaskEngine} from '../src/engine.mjs';
import {createJournal, diskId} from '../src/journal.mjs';
import {evidenceIdOf, normalizeEvidence} from '../src/qualification.mjs';
import {ROUTES, selectRoute, expectedEffort} from '../src/routes.mjs';

const root = await makeTempRoot('portable-evidence-test-');
after(() => fs.rm(root, {recursive: true, force: true}));
let sequence = 0;
const fresh = () => path.join(root, 'case-' + ++sequence);
const owner = 'evidence-owner';
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const route = {provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', maxTokens: 256, costRates: null};
const NOW = 4_000_000;
const streaming = text => ({async prepareCall(config) {return {config, stream: async function* () {
  yield {type: 'text-delta', text};
  yield {type: 'usage', usage: {inputTokens: 5, outputTokens: 2, totalTokens: 7}};
  yield {type: 'finish', reason: {kind: 'stop'}};
}};}});
function qualification(id, pool = 'balanced', overrides = {}) {
  const r = ROUTES.find(x => x.id === id);
  return {schemaVersion: 1, qualificationType: 'smoke', issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId: 'SYNTHETIC-RUNTIME'},
    runtimeBuildId: 'synthetic-build', adapterFingerprint: 'synthetic-key', provider: r.provider, model: r.model,
    effort: expectedEffort(r, pool), issuedAt: NOW - 100, expiresAt: NOW + 100000, durationMs: 5, available: true,
    transportPassed: true, textPassed: true, toolPassed: true, imagePassed: false,
    caseResults: [{name: 'text', passed: true}, {name: 'native-tool-roundtrip', passed: true}],
    allowedDataClasses: ['public', 'internal'], domainEvidence: false, attestation: null, ...overrides};
}
const task = overrides => ({role: 'R04', category: 'implementation', risk: 'low', complexity: 'routine', escalate: false, ...overrides});

test('an evidence id is derived from the evidence, so a link can be rechecked', () => {
  const record = qualification('codex-terra');
  const id = evidenceIdOf(record);
  assert.match(id, /^e[a-f0-9]{31}$/);
  // Recomputing from the same evidence reproduces the id; that is what makes it checkable.
  assert.equal(evidenceIdOf({...record}), id);
  // Any field that identifies the probe changes it.
  assert.notEqual(evidenceIdOf({...record, issuedAt: record.issuedAt + 1}), id);
  assert.notEqual(evidenceIdOf({...record, effort: 'high'}), id);
  assert.notEqual(evidenceIdOf({...record, issuer: {...record.issuer, runtimeId: 'other'}}), id);
  // Incomplete evidence has no identity rather than a made-up one.
  assert.equal(evidenceIdOf(null), null);
  assert.equal(evidenceIdOf({provider: 'codex', model: 'm', effort: 'medium'}), null);
});
test('selection carries the evidence that authorized it', () => {
  const record = qualification('codex-terra');
  const selected = selectRoute({task: task(), qualifications: [record], now: NOW});
  assert.equal(selected.status, 'SELECTED');
  assert.equal(selected.qualification.evidenceId, evidenceIdOf(record));
  assert.deepEqual(selected.qualification.caseResults, ['text', 'native-tool-roundtrip']);
  assert.equal(selected.qualification.attestedBy, null);
  // An attested selection names who attested it.
  const attested = qualification('codex-sol', 'advanced', {domainEvidence: true,
    attestation: {kind: 'operator-attestation', attestedBy: 'SYNTHETIC-OPERATOR', basis: 'Synthetic fixture.', dataClasses: ['public', 'internal'], domainEvidence: true}});
  const domain = selectRoute({task: task({role: 'R08'}), qualifications: [attested], now: NOW});
  assert.equal(domain.status, 'SELECTED');
  assert.equal(domain.qualification.attestedBy, 'SYNTHETIC-OPERATOR');
  assert.equal(domain.qualification.domainEvidence, true);
});
test('a delegation records the evidence and a verifier can match it', async () => {
  const now = Date.now();
  const record = qualification('codex-terra', 'balanced', {issuedAt: now - 1000, expiresAt: now + 3600000});
  const selected = selectRoute({task: task(), qualifications: [record], now});
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    return {id: 'child', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'done'}]}), async dispose() {}};
  }})});
  const result = await dispatcher.delegate({run_id: 'linked', prompt: 'x', evidence: selected.qualification}, route, 'medium', exec());
  assert.equal(result.evidence_recorded, true);
  assert.equal(result.evidence.evidenceId, evidenceIdOf(record));
  // The link survives a read and appears in the listing.
  assert.equal((await dispatcher.read('linked')).evidence.evidenceId, evidenceIdOf(record));
  assert.equal((await dispatcher.list())[0].evidence_id, evidenceIdOf(record));
  dispatcher.dispose();
});
test('a direct task records evidence at plan time and keeps it through the run', async () => {
  const directory = fresh();
  const record = qualification('codex-terra');
  const selected = selectRoute({task: task(), qualifications: [record], now: NOW});
  const engine = createTaskEngine({root: directory, owner, getLlm: () => streaming('answer')});
  const planned = await engine.plan({task_id: 'linked-task', prompt: 'x', route, evidence: selected.qualification});
  assert.equal(planned.evidenceRecorded, true);
  const ran = await engine.run('linked-task', exec());
  assert.equal(ran.status, 'COMPLETED');
  // Running the task must not alter what authorized it.
  assert.deepEqual(ran.evidence, planned.evidence);
  assert.equal((await engine.list())[0].evidenceId, evidenceIdOf(record));
  // A fresh engine reads the same link back from storage.
  assert.equal((await createTaskEngine({root: directory, owner, getLlm: () => null}).read('linked-task')).evidence.evidenceId, evidenceIdOf(record));
});
test('a run started without evidence reports that honestly', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    return {id: 'child', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'done'}]}), async dispose() {}};
  }})});
  const result = await dispatcher.delegate({run_id: 'unlinked', prompt: 'x'}, route, 'medium', exec());
  assert.equal(result.evidence, null);
  assert.equal(result.evidence_recorded, false);
  const engine = createTaskEngine({root: fresh(), owner, getLlm: () => streaming('answer')});
  const planned = await engine.plan({task_id: 'unlinked-task', prompt: 'x', route});
  assert.equal(planned.evidence, null);
  assert.equal(planned.evidenceRecorded, false);
  dispatcher.dispose();
});
test('malformed evidence is dropped rather than stored as a link', () => {
  assert.equal(normalizeEvidence(undefined), null);
  assert.equal(normalizeEvidence({evidenceId: 'not-an-id', issuedAt: 1, expiresAt: 2}), null);
  assert.equal(normalizeEvidence({evidenceId: 'e' + 'a'.repeat(31), issuedAt: 'soon', expiresAt: 2}), null);
  const valid = normalizeEvidence({evidenceId: 'e' + 'a'.repeat(31), issuedAt: 1, expiresAt: 2, attestedBy: '  Operator  ', domainEvidence: true});
  assert.equal(valid.attestedBy, 'Operator');
  assert.equal(valid.domainEvidence, true);
  // Absent optional fields become explicit nulls or empty lists, never undefined.
  assert.equal(valid.runtimeBuildId, null);
  assert.deepEqual(valid.caseResults, []);
});
test('a task record written before evidence existed still loads', async () => {
  const directory = fresh();
  const engine = createTaskEngine({root: directory, owner, getLlm: () => streaming('legacy')});
  await engine.plan({task_id: 'legacy', prompt: 'x', route});
  await engine.run('legacy', exec());
  // The record genuinely has no evidence key, exactly as an older build wrote it.
  const stored = await createJournal(directory, diskId(owner)).load(diskId('legacy'));
  assert.equal(Object.hasOwn(stored, 'evidence'), false);
  const view = await createTaskEngine({root: directory, owner, getLlm: () => null}).read('legacy');
  assert.equal(view.status, 'COMPLETED');
  assert.equal(view.evidence, null);
  assert.equal(view.evidenceRecorded, false);
});
test('evidence cannot be added, edited or removed after planning', async () => {
  const directory = fresh();
  const record = qualification('codex-terra');
  const selected = selectRoute({task: task(), qualifications: [record], now: NOW});
  const engine = createTaskEngine({root: directory, owner, getLlm: () => streaming('answer')});
  await engine.plan({task_id: 'fixed', prompt: 'x', route, evidence: selected.qualification});
  await engine.run('fixed', exec());
  const journal = createJournal(directory, diskId(owner));
  const stored = await journal.load(diskId('fixed'));
  const file = path.join(directory, diskId(owner), diskId('fixed'), String(stored.revision).padStart(8, '0') + '.json');
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  // Rewriting the link to claim different authorization, with a recomputed checksum.
  document.record.evidence.attestedBy = 'SOMEONE-ELSE';
  document.sha256 = createHash('sha256').update(JSON.stringify(document.record), 'utf8').digest('hex');
  await fs.writeFile(file, JSON.stringify(document), 'utf8');
  // The transition check names the exact violation rather than a generic corruption.
  await assert.rejects(createTaskEngine({root: directory, owner, getLlm: () => null}).read('fixed'), error => error.code === 'EVIDENCE_MUTATED');
});
test('an unreadable evidence shape is refused, not silently ignored', async () => {
  const directory = fresh();
  const engine = createTaskEngine({root: directory, owner, getLlm: () => streaming('answer')});
  await engine.plan({task_id: 'bad-shape', prompt: 'x', route});
  const journal = createJournal(directory, diskId(owner));
  const stored = await journal.load(diskId('bad-shape'));
  const file = path.join(directory, diskId(owner), diskId('bad-shape'), String(stored.revision).padStart(8, '0') + '.json');
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  document.record.evidence = {evidenceId: 'nonsense'};
  document.sha256 = createHash('sha256').update(JSON.stringify(document.record), 'utf8').digest('hex');
  await fs.writeFile(file, JSON.stringify(document), 'utf8');
  await assert.rejects(createTaskEngine({root: directory, owner, getLlm: () => null}).read('bad-shape'), error => error.code === 'CORRUPT');
});
