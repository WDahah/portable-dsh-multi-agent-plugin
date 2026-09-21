// Distribution fixtures. Pools are priority-ordered, so qualifying more routes does not by
// itself spread work — these cases pin down what the selector actually does, what opting
// into spreading changes, and which failures may move a run to another provider.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeTempRoot} from './helpers/tmp.mjs';
import {selectRoute, expectedEffort, ROUTES, POOL_PRIORITY} from '../src/routes.mjs';
import {createAgentDispatcher, canFailOver} from '../src/agent-dispatch.mjs';

const root = await makeTempRoot('portable-distribution-test-');
after(() => fs.rm(root, {recursive: true, force: true}));
let sequence = 0;
const fresh = () => path.join(root, 'case-' + ++sequence);
const owner = 'distribution-owner';
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const NOW = 1_000_000;
const task = overrides => ({role: 'deep', category: 'c', risk: 'low', complexity: 'routine', escalate: false, ...overrides});
function qualification(id, pool = 'advanced', overrides = {}) {
  const route = ROUTES.find(r => r.id === id);
  return {schemaVersion: 1, qualificationType: 'smoke', issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId: 'SYNTHETIC'},
    runtimeBuildId: 'b', adapterFingerprint: 'f', provider: route.provider, model: route.model, effort: expectedEffort(route, pool),
    issuedAt: NOW - 10, expiresAt: NOW + 90000, durationMs: 1, available: true,
    transportPassed: true, textPassed: true, toolPassed: true, imagePassed: false,
    caseResults: [{name: 'text', passed: true}, {name: 'native-tool-roundtrip', passed: true}],
    allowedDataClasses: ['public', 'internal'], domainEvidence: false, attestation: null, ...overrides};
}
const allAdvanced = () => POOL_PRIORITY.advanced.map(id => qualification(id));
const evidenceId = character => 'e' + character.repeat(31);
const evidence = character => ({evidenceId: evidenceId(character), issuedAt: 1, expiresAt: 9e12,
  runtimeBuildId: 'b', adapterFingerprint: 'f', domainEvidence: false, imagePassed: false,
  allowedDataClasses: ['public'], caseResults: ['text'], attestedBy: null});
const opusStandby = [{route: {id: 'claude-opus', provider: 'claude', model: 'claude-opus-5'}, effort: 'high', qualification: evidence('b')}];

test('by default every task goes to the first qualified route, and that is reported', () => {
  const qualifications = allAdvanced();
  const chosen = new Set();
  for (let index = 0; index < 50; index += 1) {
    chosen.add(selectRoute({task: task(), qualifications, now: NOW}).route.id);
  }
  // Fifty identical tasks, three qualified routes, one destination.
  assert.deepEqual([...chosen], ['codex-sol']);
  const result = selectRoute({task: task(), qualifications, now: NOW});
  assert.equal(result.selectionOrder, 'POOL_PRIORITY');
  // Qualifying a route is not the same as that route receiving work, so the result says so
  // rather than leaving a caller to infer it from a count.
  assert.deepEqual(result.standby.map(entry => entry.route_id), ['claude-opus', 'kimi-k3']);
  assert.ok(result.warnings.includes('LOWER_PRIORITY_ROUTES_IDLE_UNTIL_FAILOVER'));
});
test('a single qualified route reports no idle standby and no warning', () => {
  const result = selectRoute({task: task(), qualifications: [qualification('codex-sol')], now: NOW});
  assert.deepEqual(result.standby, []);
  assert.equal(result.warnings.includes('LOWER_PRIORITY_ROUTES_IDLE_UNTIL_FAILOVER'), false);
});
test('spreading distributes work across every qualified route', () => {
  const qualifications = allAdvanced();
  const tally = new Map();
  for (let index = 0; index < 90; index += 1) {
    const result = selectRoute({task: task(), qualifications, now: NOW, spread: `run-${index}`});
    tally.set(result.route.id, (tally.get(result.route.id) ?? 0) + 1);
    assert.equal(result.selectionOrder, 'SPREAD');
  }
  assert.equal(tally.size, 3, 'every qualified route should receive work');
  // Even-ish rather than exact: the point is that no route is starved.
  for (const count of tally.values()) assert.ok(count >= 20, `a route received only ${count} of 90`);
});
test('spreading is still reproducible for the same key', () => {
  const qualifications = allAdvanced();
  const repeated = new Set();
  for (let index = 0; index < 20; index += 1) {
    repeated.add(selectRoute({task: task(), qualifications, now: NOW, spread: 'job-42'}).route.id);
  }
  // Distribution must not cost reproducibility: one key, one answer.
  assert.equal(repeated.size, 1);
});
test('spreading never reaches a route that failed its evidence rules', () => {
  // kimi-k3 is unqualified; expired evidence for claude-opus must not be rescued either.
  const qualifications = [qualification('codex-sol'),
    qualification('claude-opus', 'advanced', {issuedAt: NOW - 90000, expiresAt: NOW - 1})];
  const reached = new Set();
  for (let index = 0; index < 40; index += 1) {
    reached.add(selectRoute({task: task(), qualifications, now: NOW, spread: `k${index}`}).route.id);
  }
  assert.deepEqual([...reached], ['codex-sol']);
});
test('spreading and review independence hold at the same time', () => {
  const qualifications = allAdvanced();
  for (let index = 0; index < 30; index += 1) {
    const result = selectRoute({task: task({role: 'review'}), qualifications, now: NOW,
      spread: `r${index}`, avoidProvider: 'codex'});
    // Whichever route spreading lands on, a review must still avoid the subject's provider
    // when an alternative exists.
    assert.notEqual(result.route.provider, 'codex');
    assert.equal(result.independence.independent, true);
  }
});
test('only a pre-dispatch refusal with no output and no write scope may move', () => {
  assert.equal(canFailOver({failure: {code: 'rate_limit'}, producedOutput: false, toolsCanWrite: false}).allowed, true);
  // Anything the child already said means work happened, whatever the error claims.
  assert.equal(canFailOver({failure: {code: 'rate_limit'}, producedOutput: true, toolsCanWrite: false}).reason, 'CHILD_ALREADY_PRODUCED_OUTPUT');
  // A write-capable child could have acted before the refusal was reported.
  assert.equal(canFailOver({failure: {code: 'rate_limit'}, producedOutput: false, toolsCanWrite: true}).reason, 'WRITE_SCOPE_CANNOT_BE_REPEATED_BLIND');
  // A mid-stream failure is not a refusal to start.
  assert.equal(canFailOver({failure: {code: 'internal_error'}, producedOutput: false, toolsCanWrite: false}).reason, 'NOT_A_PRE_DISPATCH_REFUSAL');
  // An unnamed failure is never assumed safe.
  assert.equal(canFailOver({failure: {}, producedOutput: false, toolsCanWrite: false}).reason, 'FAILURE_CODE_UNKNOWN');
  assert.equal(canFailOver({failure: null, producedOutput: false, toolsCanWrite: false}).allowed, false);
});
test('a refused route hands the run to a standby, carrying that route evidence', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start(_name, request) {
    if (request.agentOptions.provider === 'codex') {
      return {id: 'refused', result: Promise.resolve({stopReason: 'error', error: {code: 'rate_limit'}, output: []}), async dispose() {}};
    }
    return {id: 'answered', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'ANSWER'}]}), async dispose() {}};
  }})});
  const result = await dispatcher.delegate({run_id: 'moved', prompt: 'go', role: 'deep',
    alternates: opusStandby, allowed_tools: ['read'], evidence: evidence('a')},
  {provider: 'codex', model: 'gpt-5.6-sol'}, 'high', exec());
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.provider, 'claude');
  assert.equal(result.text, 'ANSWER');
  // The run is authorized by the evidence of the route that actually answered.
  assert.equal(result.evidence.evidenceId, evidenceId('b'));
  // The move is journalled, naming who refused and why it was permitted.
  assert.deepEqual(result.failovers, [{from: 'codex/gpt-5.6-sol', round: 1, code: 'rate_limit',
    allowed: true, reason: 'PRE_DISPATCH_REFUSAL_NO_WORK_STARTED', to: 'claude/claude-opus-5'}]);
  assert.equal(result.rounds[0].state, 'FAILED_OVER');
  assert.equal(result.rounds[0].failover_reason, 'rate_limit');
  dispatcher.dispose();
});
test('a write-capable run records the refusal and stays put', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    return {id: 'refused', result: Promise.resolve({stopReason: 'error', error: {code: 'rate_limit'}, output: []}), async dispose() {}};
  }})});
  const result = await dispatcher.delegate({run_id: 'stays', prompt: 'go', role: 'deep',
    alternates: opusStandby, allowed_tools: ['read', 'write'], evidence: evidence('a')},
  {provider: 'codex', model: 'gpt-5.6-sol'}, 'high', exec());
  assert.equal(result.provider, 'codex');
  assert.equal(result.failovers[0].allowed, false);
  assert.equal(result.failovers[0].reason, 'WRITE_SCOPE_CANNOT_BE_REPEATED_BLIND');
  assert.equal(result.failovers[0].to, null);
  dispatcher.dispose();
});
test('without alternates a refusal fails rather than moving', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    return {id: 'refused', result: Promise.resolve({stopReason: 'error', error: {code: 'rate_limit'}, output: []}), async dispose() {}};
  }})});
  const result = await dispatcher.delegate({run_id: 'alone', prompt: 'go', role: 'deep',
    allowed_tools: ['read'], evidence: evidence('a')}, {provider: 'codex', model: 'gpt-5.6-sol'}, 'high', exec());
  assert.equal(result.provider, 'codex');
  assert.deepEqual(result.failovers, []);
  assert.equal(result.standby_available, 0);
  dispatcher.dispose();
});
test('a run that never failed reports no failovers rather than omitting the field', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    return {id: 'fine', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'ok'}]}), async dispose() {}};
  }})});
  const result = await dispatcher.delegate({run_id: 'clean', prompt: 'go', role: 'deep',
    alternates: opusStandby, allowed_tools: ['read'], evidence: evidence('a')},
  {provider: 'codex', model: 'gpt-5.6-sol'}, 'high', exec());
  assert.deepEqual(result.failovers, []);
  assert.equal(result.standby_available, 1);
  assert.equal(result.rounds[0].failover_reason, undefined);
  dispatcher.dispose();
});
