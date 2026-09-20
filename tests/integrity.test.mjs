// Fixtures for the three gaps that only appeared once the loop ran against real models:
// a schema-only reviewer leaving no readable answer, a deletion stranding a reviews link,
// and an unreadable verdict that did not say why.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeTempRoot} from './helpers/tmp.mjs';
import {createPlugin} from '../src/plugin.mjs';
import {createAgentDispatcher, renderVerdict} from '../src/agent-dispatch.mjs';
import {parseVerdict} from '../src/verdict.mjs';

const root = await makeTempRoot('portable-integrity-test-');
after(() => fs.rm(root, {recursive: true, force: true}));
let sequence = 0;
const fresh = () => path.join(root, 'case-' + ++sequence);
const owner = 'integrity-owner';
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const declared = overrides => ({verdict: 'verified', onObjective: true, summary: 'All criteria met.',
  findings: [], clarifications: [], verified: ['compiles'], ...overrides});
/** A reviewer that answers only through the structured channel, as a real one did. */
function schemaOnlyHost(verdictValue, {reviewerStop = 'completed'} = {}) {
  return () => ({async start(_name, request) {
    if (request.outputSchema) {
      return {id: 'reviewer', result: Promise.resolve({stopReason: reviewerStop,
        ...(verdictValue ? {structured: verdictValue} : {}), output: []}), async dispose() {}};
    }
    return {id: 'worker', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'THE WORK'}]}), async dispose() {}};
  }});
}

test('a verdict rendered as text keeps every part a reader needs', () => {
  const verdict = parseVerdict({structured: declared({verdict: 'partial', onObjective: false,
    findings: [{severity: 'blocker', detail: 'Wrong problem solved.'}], clarifications: ['Which auth method?'], verified: ['compiles']})});
  const rendered = renderVerdict(verdict);
  assert.ok(rendered.includes('Verdict: partial'));
  assert.ok(rendered.includes('On objective: false'));
  assert.ok(rendered.includes('All criteria met.'));
  assert.ok(rendered.includes('[blocker] Wrong problem solved.'));
  assert.ok(rendered.includes('Which auth method?'));
  assert.ok(rendered.includes('compiles'));
  // A verdict with nothing to add renders without dangling empty sections.
  const bare = renderVerdict(parseVerdict({structured: declared({verified: [], findings: [], clarifications: []})}));
  assert.equal(bare.includes('Findings:'), false);
  assert.equal(bare.includes('Needs clarification:'), false);
});
test('a schema-only reviewer still leaves a readable answer', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: schemaOnlyHost(declared())});
  await dispatcher.delegate({run_id: 'work', prompt: 'do it', role: 'deep'}, {provider: 'codex', model: 'm'}, 'high', exec());
  const review = await dispatcher.delegate({run_id: 'review', prompt: 'judge it', role: 'review', reviews: 'work'}, {provider: 'claude', model: 'n'}, 'high', exec());
  // The decision is stored, and the saved answer is no longer empty.
  assert.equal(review.verdict.verdict, 'verified');
  assert.ok(review.text.length > 0);
  assert.ok(review.text.includes('Verdict: verified'));
  // The parsed verdict stays the authority; the text is a view of it.
  assert.equal(review.verdict_source, 'schema');
  dispatcher.dispose();
});
test('a review can itself be reviewed, which an empty answer prevented', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: schemaOnlyHost(declared())});
  await dispatcher.delegate({run_id: 'work', prompt: 'do it', role: 'deep'}, {provider: 'codex', model: 'm'}, 'high', exec());
  await dispatcher.delegate({run_id: 'review', prompt: 'judge it', role: 'review', reviews: 'work'}, {provider: 'claude', model: 'n'}, 'high', exec());
  // Reviewing the review used to fail with REVIEW_SUBJECT_EMPTY.
  const meta = await dispatcher.delegate({run_id: 'meta', prompt: 'judge the judge', role: 'review', reviews: 'review'}, {provider: 'codex', model: 'm'}, 'high', exec());
  assert.equal(meta.reviews, 'review');
  assert.equal(meta.state, 'COMPLETED');
  dispatcher.dispose();
});
test('a run a review points at cannot be deleted by default', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: schemaOnlyHost(declared())});
  await dispatcher.delegate({run_id: 'work', prompt: 'do it', role: 'deep'}, {provider: 'codex', model: 'm'}, 'high', exec());
  await dispatcher.delegate({run_id: 'review', prompt: 'judge it', role: 'review', reviews: 'work'}, {provider: 'claude', model: 'n'}, 'high', exec());
  await assert.rejects(dispatcher.forget('work'), error => error.code === 'ASSIGNMENT_REFERENCED_BY_REVIEW');
  // The refusal names what blocks it rather than leaving the caller to search.
  assert.deepEqual(await dispatcher.referencedBy('work'), ['review']);
  // Deleting the review first releases the subject.
  await dispatcher.forget('review');
  assert.deepEqual(await dispatcher.referencedBy('work'), []);
  assert.equal((await dispatcher.forget('work')).removed, true);
  dispatcher.dispose();
});
test('force accepts a dangling reference deliberately rather than silently', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: schemaOnlyHost(declared())});
  await dispatcher.delegate({run_id: 'work', prompt: 'do it', role: 'deep'}, {provider: 'codex', model: 'm'}, 'high', exec());
  await dispatcher.delegate({run_id: 'review', prompt: 'judge it', role: 'review', reviews: 'work'}, {provider: 'claude', model: 'n'}, 'high', exec());
  const forced = await dispatcher.forget('work', {force: true});
  assert.equal(forced.removed, true);
  assert.equal(forced.forced, true);
  // The review survives and still records what it judged; only the subject is gone.
  const review = await dispatcher.read('review');
  assert.equal(review.reviews, 'work');
  await assert.rejects(dispatcher.read('work'), error => error.code === 'UNKNOWN_ASSIGNMENT');
  dispatcher.dispose();
});
test('the forget tool refuses through the tool surface and names the blockers', async t => {
  const definitions = new Map();
  const services = {
    llm: {listProviders: () => [{id: 'codex'}], async prepareCall(config) {return {config};}},
    subagents: {list: () => ['spawn'], getProvider: () => ({name: 'spawn', capabilities: {outputSchema: true}}),
      ...schemaOnlyHost(declared())()},
  };
  const ctx = {tools: {register(d) {definitions.set(d.name, d); return () => definitions.delete(d.name);}},
    get: name => services[name], effect(fn) {const release = fn(); t.after(() => release?.()); return release;}};
  const state = fresh();
  createPlugin(d => d).apply(ctx, {stateRoot: state, enabled: true});
  // Build the pair through the same state the plugin reads.
  const dispatcher = createAgentDispatcher({root: state, owner, getSubagents: schemaOnlyHost(declared())});
  await dispatcher.delegate({run_id: 'work', prompt: 'do it', role: 'deep'}, {provider: 'codex', model: 'm'}, 'high', exec());
  await dispatcher.delegate({run_id: 'review', prompt: 'judge', role: 'review', reviews: 'work'}, {provider: 'claude', model: 'n'}, 'high', exec());
  dispatcher.dispose();
  const refused = await definitions.get('orchestrator_forget').execute({run_id: 'work'}, exec());
  assert.equal(refused.reason, 'ASSIGNMENT_REFERENCED_BY_REVIEW');
  assert.deepEqual(refused.referenced_by, ['review']);
  assert.ok(refused.hint.includes('force'));
  // The escape hatch is explicit, never the default.
  const forced = await definitions.get('orchestrator_forget').execute({run_id: 'work', force: true}, exec());
  assert.equal(forced.assignment.forced, true);
});
test('an unreadable verdict reports whether the reviewer was cut off', async t => {
  const definitions = new Map();
  const services = {
    llm: {listProviders: () => [{id: 'codex'}, {id: 'claude'}], async prepareCall(config) {return {config};}},
    subagents: {list: () => ['spawn'], getProvider: () => ({name: 'spawn', capabilities: {outputSchema: true}}),
      async start(_name, request) {
        const token = /token ([a-f0-9-]+)/.exec(request.prompt[0].text);
        if (token) {
          const answer = await definitions.get('orchestrator_qualification_echo').execute({token: token[1]}, {agent: {id: 'probe'}, signal: request.signal});
          return {id: 'probe', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: `QUALIFIED:${answer.marker}:42`}]}), async dispose() {}};
        }
        // The reviewer runs out of tokens before saying anything, exactly as observed live.
        if (request.outputSchema) return {id: 'reviewer', result: Promise.resolve({stopReason: 'max-tokens', output: []}), async dispose() {}};
        return {id: 'worker', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'THE WORK'}]}), async dispose() {}};
      }},
  };
  const ctx = {tools: {register(d) {definitions.set(d.name, d); return () => definitions.delete(d.name);}},
    get: name => services[name], effect(fn) {const release = fn(); t.after(() => release?.()); return release;}};
  createPlugin(d => d).apply(ctx, {stateRoot: fresh(), enabled: true});
  for (const [route_id, effort] of [['codex-sol', 'high'], ['claude-opus', 'high']]) {
    await definitions.get('orchestrator_qualify').execute({route_id, effort}, exec());
  }
  const meta = {role: 'deep', category: 'c', risk: 'low', complexity: 'routine', escalate: false};
  await definitions.get('orchestrator_delegate').execute({task: meta, run_id: 'w', prompt: 'do it', allowed_tools: ['read'], max_rounds: 1, max_tokens: 1024}, exec());
  const loop = await definitions.get('orchestrator_iterate').execute({task: meta, run_id: 'j', reviews: 'w', max_cycles: 2, allowed_tools: ['read'], max_tokens: 1024}, exec());
  assert.equal(loop.stopped, 'VERDICT_UNREADABLE');
  // The cause is now in the cycle record, not only discoverable by reading the review.
  assert.equal(loop.cycles[0].reviewState, 'PARTIAL');
  assert.equal(loop.cycles[0].unreadableCause, 'REVIEWER_HIT_TOKEN_LIMIT');
});
test('a reviewer that finished but said nothing usable is reported differently', async t => {
  const definitions = new Map();
  const services = {
    llm: {listProviders: () => [{id: 'codex'}, {id: 'claude'}], async prepareCall(config) {return {config};}},
    subagents: {list: () => ['spawn'], getProvider: () => ({name: 'spawn', capabilities: {outputSchema: true}}),
      async start(_name, request) {
        const token = /token ([a-f0-9-]+)/.exec(request.prompt[0].text);
        if (token) {
          const answer = await definitions.get('orchestrator_qualification_echo').execute({token: token[1]}, {agent: {id: 'probe'}, signal: request.signal});
          return {id: 'probe', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: `QUALIFIED:${answer.marker}:42`}]}), async dispose() {}};
        }
        if (request.outputSchema) return {id: 'reviewer', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'Looks fine to me.'}]}), async dispose() {}};
        return {id: 'worker', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'THE WORK'}]}), async dispose() {}};
      }},
  };
  const ctx = {tools: {register(d) {definitions.set(d.name, d); return () => definitions.delete(d.name);}},
    get: name => services[name], effect(fn) {const release = fn(); t.after(() => release?.()); return release;}};
  createPlugin(d => d).apply(ctx, {stateRoot: fresh(), enabled: true});
  for (const [route_id, effort] of [['codex-sol', 'high'], ['claude-opus', 'high']]) {
    await definitions.get('orchestrator_qualify').execute({route_id, effort}, exec());
  }
  const meta = {role: 'deep', category: 'c', risk: 'low', complexity: 'routine', escalate: false};
  await definitions.get('orchestrator_delegate').execute({task: meta, run_id: 'w', prompt: 'do it', allowed_tools: ['read'], max_rounds: 1, max_tokens: 1024}, exec());
  const loop = await definitions.get('orchestrator_iterate').execute({task: meta, run_id: 'j', reviews: 'w', max_cycles: 2, allowed_tools: ['read'], max_tokens: 1024}, exec());
  assert.equal(loop.cycles[0].reviewState, 'COMPLETED');
  // Prose from a finished reviewer needs a reworded request, not a bigger token budget.
  assert.equal(loop.cycles[0].unreadableCause, 'REVIEWER_RETURNED_NO_USABLE_VERDICT');
});
