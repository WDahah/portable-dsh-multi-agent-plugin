// Offline admission and journal races. Every child and synchronization point is owned
// by its test; no provider, subprocess, fixed delay, or shared state directory is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeTempRoot} from './helpers/tmp.mjs';
import {createAgentDispatcher} from '../src/agent-dispatch.mjs';
import {createRecordStore, keyOf} from '../src/qualification.mjs';
import {WORKER_RESULT_SCHEMA} from '../src/worker-result.mjs';

const owner = 'concurrency-owner', route = {provider: 'synthetic', model: 'offline'};
const exec = (signal = new AbortController().signal) => ({agent: {id: owner}, signal});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const result = (text = 'done', extra = {}) => ({stopReason: 'completed', output: [{type: 'text', text}], ...extra});
const busy = error => error.code === 'DELEGATION_BUSY';

async function fixture(t, {holdDisposal = false, deadlineMs = 900000, rejectStart = () => false} = {}) {
  const root = await makeTempRoot('portable-dispatch-concurrency-');
  const calls = [], waiters = new Map(), work = [];
  let cleaning = false;
  const dispatcher = createAgentDispatcher({root, owner, deadlineMs, getSubagents: () => ({async start(_name, request) {
    if (rejectStart(request)) throw new Error('synthetic spawn refusal');
    const output = deferred(), disposal = deferred(), disposing = deferred();
    const call = {request, output, disposal, disposing, id: `child-${calls.length}`, disposeCalls: 0};
    calls.push(call); waiters.get(calls.length)?.resolve(call);
    if (!holdDisposal || cleaning) disposal.resolve();
    if (cleaning) output.resolve(result('', {stopReason: 'aborted'}));
    return {id: call.id, result: output.promise, async dispose() {
      call.disposeCalls++; disposing.resolve(); await disposal.promise;
    }};
  }})});
  const track = promise => {work.push(promise); promise.catch(() => {}); return promise;};
  t.after(async () => {
    cleaning = true;
    const drained = dispatcher.dispose();
    for (const call of calls) {call.output.resolve(result('', {stopReason: 'aborted'})); call.disposal.resolve();}
    await drained; await Promise.allSettled(work);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, calls, dispatcher, track, store: createRecordStore(root, owner, 'assignments'),
    call(number) {
      if (calls.length >= number) return Promise.resolve(calls[number - 1]);
      if (!waiters.has(number)) waiters.set(number, deferred());
      return waiters.get(number).promise;
    },
    delegate(run_id, options, signal, extra = {}) {
      return track(dispatcher.delegate({run_id, prompt: run_id, max_rounds: 1, ...extra}, route, 'medium', exec(signal), options));
    },
    compact(run_id, subject = 'subject') {
      return track(dispatcher.compact({run_id, subject}, route, 'medium', exec()));
    }};
}
async function subject(f) {
  const pending = f.delegate('subject'), call = await f.call(1);
  call.output.resolve(result('Source material. '.repeat(300))); call.disposal.resolve(); await pending;
}

test('delegate and compact share two slots and reserve compact IDs before any await', async t => {
  const f = await fixture(t); await subject(f);
  const compacted = f.compact('compact');
  await assert.rejects(f.compact('compact'), busy);
  await assert.rejects(f.delegate('compact', {queue: true}), busy);
  const worker = f.delegate('worker');
  await assert.rejects(f.delegate('third'), busy);
  await assert.rejects(f.compact('third-compact'), busy);
  const [a, b] = await Promise.all([f.call(2), f.call(3)]);
  assert.equal(f.calls.length, 3);
  for (const call of [a, b]) call.output.resolve(result('short', {structured: {summary: 'short', retained: []}}));
  assert.equal((await compacted).applied, true); assert.equal((await worker).state, 'COMPLETED');
});

test('FIFO queue holds eight pending IDs and never admits an ordinary busy caller', async t => {
  const f = await fixture(t);
  const first = f.delegate('first'); const one = await f.call(1);
  const second = f.delegate('second'); const two = await f.call(2);
  const queued = Array.from({length: 8}, (_, index) => f.delegate(`queued-${index}`, {queue: true}));
  await assert.rejects(f.delegate('overflow', {queue: true}), error => error.code === 'DELEGATION_QUEUE_FULL');
  await assert.rejects(f.delegate('queued-0', {queue: true}), busy);
  await assert.rejects(f.delegate('ordinary'), busy);
  assert.equal(f.calls.length, 2);
  one.output.resolve(result()); await first;
  for (let index = 0; index < queued.length; index++) {
    const call = await f.call(index + 3);
    assert.equal(call.request.prompt[0].text, `queued-${index}`);
    call.output.resolve(result()); await queued[index];
  }
  two.output.resolve(result()); await second;
  assert.equal(f.calls.length, 10);
});

test('pending cancellation dispatches nothing, releases its ID, and drains other FIFO work', async t => {
  const f = await fixture(t);
  const first = f.delegate('first'), second = f.delegate('second');
  const [one, two] = await Promise.all([f.call(1), f.call(2)]);
  const controller = new AbortController();
  const cancelled = f.delegate('cancelled', {queue: true}, controller.signal);
  const next = f.delegate('next', {queue: true});
  const rejection = assert.rejects(cancelled, error => error.name === 'AbortError');
  controller.abort(); await rejection;
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.dispatcher.read('cancelled'), error => error.code === 'UNKNOWN_ASSIGNMENT');
  const reused = f.delegate('cancelled', {queue: true});
  one.output.resolve(result()); await first;
  const nextCall = await f.call(3); assert.equal(nextCall.request.prompt[0].text, 'next');
  nextCall.output.resolve(result()); await next;
  const reusedCall = await f.call(4); assert.equal(reusedCall.request.prompt[0].text, 'cancelled');
  reusedCall.output.resolve(result()); two.output.resolve(result()); await Promise.all([reused, second]);
});

test('aborted active work keeps its slot until both result and disposal settle', async t => {
  const f = await fixture(t, {holdDisposal: true});
  const controller = new AbortController();
  const first = f.delegate('first', undefined, controller.signal), second = f.delegate('second');
  const [one, two] = await Promise.all([f.call(1), f.call(2)]);
  const queued = f.delegate('queued', {queue: true});
  controller.abort(); await one.disposing.promise;
  assert.equal(one.disposeCalls, 1);
  one.disposal.resolve();
  await assert.rejects(f.delegate('still-busy'), busy);
  assert.equal(f.calls.length, 2, 'teardown alone cannot release a pending result');
  one.output.resolve(result('prefix', {stopReason: 'aborted'}));
  assert.equal((await first).state, 'INTERRUPTED_UNKNOWN');
  const three = await f.call(3);
  two.output.resolve(result()); three.output.resolve(result());
  await Promise.all([two.disposing.promise, three.disposing.promise]);
  await assert.rejects(f.delegate('awaiting-teardown'), busy);
  two.disposal.resolve(); three.disposal.resolve(); await Promise.all([second, queued]);
  assert.equal(one.disposeCalls, 1, 'abort and normal completion share one teardown');
});

test('dispose cancels every pending item and its promise awaits active child quiescence', async t => {
  const f = await fixture(t, {holdDisposal: true});
  const first = f.delegate('first'), second = f.delegate('second');
  const [one, two] = await Promise.all([f.call(1), f.call(2)]);
  const pending = f.delegate('pending', {queue: true});
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  let drained = false;
  const disposal = f.dispatcher.dispose().then(() => {drained = true;});
  await rejected; await Promise.all([one.disposing.promise, two.disposing.promise]);
  assert.equal(drained, false); assert.equal(f.calls.length, 2);
  await assert.rejects(f.delegate('closed', {queue: true}), error => error.code === 'OWNER_REFUSED');
  one.output.resolve(result('', {stopReason: 'aborted'})); two.output.resolve(result('', {stopReason: 'aborted'}));
  one.disposal.resolve(); two.disposal.resolve();
  await Promise.all([first, second, disposal]);
  assert.equal(drained, true); assert.equal(f.calls.length, 2);
});

test('queued deadline begins at reservation and expiry never spawns a child', async t => {
  const f = await fixture(t);
  const first = f.delegate('first'), second = f.delegate('second');
  const [one, two] = await Promise.all([f.call(1), f.call(2)]);
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: Date.now()});
  const queued = f.delegate('expired', {queue: true});
  const rejected = assert.rejects(queued, error => error.name === 'AbortError');
  t.mock.timers.tick(900000); await rejected;
  t.mock.timers.reset();
  assert.equal(f.calls.length, 2);
  one.output.resolve(result()); two.output.resolve(result()); await Promise.all([first, second]);
});

test('queued evidence is rechecked after admission instead of using expired selection', async t => {
  const f = await fixture(t);
  const first = f.delegate('first'), second = f.delegate('second');
  const [one, two] = await Promise.all([f.call(1), f.call(2)]);
  const now = Date.now(); t.mock.timers.enable({apis: ['Date'], now});
  const evidence = {evidenceId: 'e' + 'a'.repeat(31), issuedAt: now, expiresAt: now + 5};
  const queued = f.delegate('expired-evidence', {queue: true}, undefined, {evidence});
  const rejected = assert.rejects(queued, error => error.code === 'EVIDENCE_EXPIRED');
  t.mock.timers.tick(6); one.output.resolve(result()); await first; await rejected;
  t.mock.timers.reset();
  assert.equal(f.calls.length, 2);
  two.output.resolve(result()); await second;
});

test('evidence expiry across journal writes remains diagnosable without spawning', async t => {
  for (const operation of ['delegate', 'compact']) {
    for (const revision of [1, 2]) {
      await t.test(`${operation} expires after revision ${revision}`, async t => {
        let unexpectedStarts = 0;
        const f = await fixture(t, {rejectStart: request => {
          if (request.label.startsWith('compact') || request.prompt[0].text === 'expiring') {unexpectedStarts++; return true;}
          return false;
        }}); await subject(f);
        const now = Date.now(); t.mock.timers.enable({apis: ['Date'], now});
        const evidence = {evidenceId: 'e' + 'b'.repeat(31), issuedAt: now, expiresAt: now + 5};
        const run_id = 'expiring';
        const filename = path.join(f.root, 'bridge', keyOf(owner), 'assignments', keyOf(run_id), `${String(revision).padStart(8, '0')}.json`);
        const originalOpen = fs.open;
        let expired = false;
        t.mock.method(fs, 'open', async function (file, ...args) {
          const handle = await originalOpen.call(this, file, ...args);
          if (file !== filename) return handle;
          return {writeFile: encoded => handle.writeFile(encoded), sync: () => handle.sync(), async close() {
            await handle.close(); expired = true; t.mock.timers.tick(6);
          }};
        });
        const answer = await (operation === 'delegate'
          ? f.delegate(run_id, undefined, undefined, {evidence})
          : f.track(f.dispatcher.compact({run_id, subject: 'subject', evidence}, route, 'medium', exec())));
        const saved = await f.dispatcher.read(run_id);
        assert.equal(expired, true, 'expiry occurs after the intended journal write');
        assert.equal(unexpectedStarts, 0, 'expired evidence must not reach native start');
        assert.equal(f.calls.length, 1, 'only the fixture subject was dispatched');
        assert.equal(saved.failure_code, 'EVIDENCE_EXPIRED');
        assert.equal(saved.state, 'INTERRUPTED_UNKNOWN');
        assert.equal(saved.returned_children, 0);
        assert.equal(saved.child_attempts, revision - 1, 'only pre-expiry dispatch commitments are counted');
        if (operation === 'delegate') assert.equal(answer.failure_code, 'EVIDENCE_EXPIRED');
        else {assert.equal(answer.applied, false); assert.equal(answer.reason, 'EVIDENCE_EXPIRED');}
        await assert.rejects(f.delegate(run_id), {code: 'ASSIGNMENT_ALREADY_EXISTS'});
      });
    }
  }
});

test('expired compaction evidence refuses before creating an assignment', async t => {
  const f = await fixture(t); await subject(f);
  const now = Date.now(), evidence = {evidenceId: 'e' + 'c'.repeat(31), issuedAt: now - 10, expiresAt: now - 1};
  await assert.rejects(f.track(f.dispatcher.compact({run_id: 'expired-compact', subject: 'subject', evidence}, route, 'medium', exec())),
    {code: 'EVIDENCE_EXPIRED'});
  await assert.rejects(f.dispatcher.read('expired-compact'), {code: 'UNKNOWN_ASSIGNMENT'});
  assert.equal(f.calls.length, 1);
});

test('compaction commits PLANNED and STARTING before spawn, journals child and terminal result', async t => {
  const f = await fixture(t); await subject(f);
  const compacted = f.compact('compact'); const call = await f.call(2);
  const directory = path.join(f.root, 'bridge', keyOf(owner), 'assignments', keyOf('compact'));
  const planned = JSON.parse(await fs.readFile(path.join(directory, '00000001.json'), 'utf8')).data;
  const starting = JSON.parse(await fs.readFile(path.join(directory, '00000002.json'), 'utf8')).data;
  assert.equal(planned.state, 'PLANNED'); assert.equal(starting.state, 'STARTING');
  assert.equal(starting.rounds[0].child_id, null); assert.equal(starting.rounds[0].state, 'STARTING');
  call.output.resolve(result('', {structured: {summary: 'Concise context', retained: ['important']}}));
  assert.equal((await compacted).applied, true);
  const read = await f.dispatcher.read('compact');
  assert.equal(read.rounds[0].child_id, call.id); assert.equal(read.rounds[0].state, 'completed');
  assert.equal(read.state, 'COMPLETED'); assert.equal(read.compaction_reason, null);
  assert.ok(read.finished_at >= read.started_at); assert.ok(read.duration_ms >= read.queue_wait_ms);
  assert.equal(read.usage, null); assert.equal(read.child_attempts, 1);
});

test('unusable, incomplete and rejected compactions all remain readable and cannot be replayed', async t => {
  const f = await fixture(t); await subject(f);
  const cases = [
    ['unusable', result('not JSON'), 'COMPACTION_NOT_SMALLER_OR_UNREADABLE', 'PARTIAL_NO_PROGRESS'],
    ['partial', result('prefix', {stopReason: 'max-tokens', structured: {summary: 'short'}}), 'COMPACTION_DID_NOT_COMPLETE', 'PARTIAL'],
    ['failed', null, 'COMPACTION_FAILED', 'INTERRUPTED_UNKNOWN'],
  ];
  for (let index = 0; index < cases.length; index++) {
    const [runId, answer, reason, state] = cases[index];
    const pending = f.compact(runId), call = await f.call(index + 2);
    if (answer) call.output.resolve(answer); else call.output.reject(new Error('synthetic result failure'));
    assert.equal((await pending).reason, reason);
    const saved = await f.dispatcher.read(runId);
    assert.equal(saved.state, state); assert.equal(saved.compaction, null); assert.equal(saved.compaction_reason, reason);
    assert.equal(saved.rounds[0].child_id, call.id); assert.equal(saved.usage, null);
    await assert.rejects(f.compact(runId), error => error.code === 'ASSIGNMENT_ALREADY_EXISTS');
  }
});

test('a compact spawn failure still persists the committed attempt without a fabricated child', async t => {
  const f = await fixture(t, {rejectStart: request => request.label.startsWith('compact')}); await subject(f);
  const failed = await f.compact('spawn-failed');
  assert.equal(failed.applied, false); assert.equal(failed.reason, 'COMPACTION_FAILED');
  const saved = await f.dispatcher.read('spawn-failed');
  assert.equal(saved.state, 'INTERRUPTED_UNKNOWN'); assert.equal(saved.rounds[0].state, 'INTERRUPTED_UNKNOWN');
  assert.equal(saved.rounds[0].child_id, null); assert.equal(saved.child_attempts, 1); assert.equal(saved.returned_children, 0);
  assert.equal(f.calls.length, 1); assert.equal(saved.usage, null);
});

test('findings schema is internal opt-in, journaled and rendered without inventing usage', async t => {
  const f = await fixture(t);
  const worker = f.delegate('findings', {queue: true, resultFormat: 'findings'}), call = await f.call(1);
  assert.equal(call.request.outputSchema, WORKER_RESULT_SCHEMA);
  const structured = {status: 'complete', summary: 'Found the boundary.', findings: [{detail: 'Serialized.', evidence: 'src/qualification.mjs:54'}], uncertainties: []};
  call.output.resolve(result('', {structured}));
  const saved = await worker;
  assert.deepEqual(saved.worker_result, structured); assert.equal(saved.worker_result_reason, null);
  assert.ok(saved.text.includes('Found the boundary.')); assert.equal(saved.usage, null);
  assert.deepEqual((await f.dispatcher.read('findings')).worker_result, structured);
  const unreadable = f.delegate('unreadable', {resultFormat: 'findings'}), bad = await f.call(2);
  bad.output.resolve(result('ordinary prose'));
  assert.equal((await unreadable).worker_result_reason, 'WORKER_RESULT_UNREADABLE');
});

test('namespace queue excludes reads, listings and remove while an exclusive revision is partial', async t => {
  const root = await makeTempRoot('portable-store-concurrency-');
  const cleanup = [];
  t.after(async () => {for (const settle of cleanup) await settle(); await fs.rm(root, {recursive: true, force: true});});
  const store = createRecordStore(root, owner, 'assignments'), peer = createRecordStore(root, owner, 'assignments');
  const key = keyOf('record'); await store.save(key, {value: 1}, 0);
  const filename = path.join(root, 'bridge', keyOf(owner), 'assignments', key, '00000002.json');
  const entered = deferred(), release = deferred(), originalOpen = fs.open, originalLstat = fs.lstat;
  let lstatCalls = 0;
  t.mock.method(fs, 'open', async function (file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (file !== filename) return handle;
    return {async writeFile(encoded) {entered.resolve(); await release.promise; await handle.writeFile(encoded);},
      sync: () => handle.sync(), close: () => handle.close()};
  });
  const saving = store.save(key, {value: 2}, 1); saving.catch(() => {});
  cleanup.push(async () => {release.resolve(); await saving;});
  await entered.promise;
  assert.equal(await fs.readFile(filename, 'utf8'), '', 'the held revision is genuinely partial');
  // Top-level tests in this file are serial; this synchronous counter covers only the
  // invocation boundary below, before any async operation can run in another fixture.
  t.mock.method(fs, 'lstat', function (...args) {lstatCalls++; return originalLstat.apply(this, args);});
  const reading = peer.read(key), entries = store.entries(), listing = peer.list(), removing = peer.remove(key);
  assert.equal(lstatCalls, 0, 'all public readers and deletion join the namespace queue before filesystem access');
  release.resolve();
  assert.equal(await saving, 2); assert.equal((await reading).data.value, 2);
  assert.equal((await entries)[0].data.value, 2); assert.equal((await listing)[0].value, 2);
  assert.equal(await removing, true); assert.equal(await store.read(key), null);
  const batches = createRecordStore(root, owner, 'batches');
  await batches.save(key, {batch_id: 'batch'}, 0); assert.equal((await batches.list())[0].batch_id, 'batch');
});

test('forget excludes all active/queued work and reserves deletion before review can interleave', async t => {
  const f = await fixture(t); await subject(f);
  const reviewing = f.delegate('review', undefined, undefined, {reviews: 'subject', role: 'review'});
  await assert.rejects(f.dispatcher.forget('subject', {force: true}), busy);
  const compacting = f.compact('compact');
  const queued = f.delegate('queued', {queue: true});
  await assert.rejects(f.dispatcher.forget('absent', {force: true}), busy);
  const [reviewCall, compactCall] = await Promise.all([f.call(2), f.call(3)]);
  for (const call of [reviewCall, compactCall]) call.output.resolve(result('done'));
  await Promise.all([reviewing, compacting]);
  const queuedCall = await f.call(4); queuedCall.output.resolve(result()); await queued;
  await assert.rejects(f.dispatcher.forget('subject'), error => error.code === 'ASSIGNMENT_REFERENCED_BY_REVIEW');
  const deleting = f.dispatcher.forget('subject', {force: true});
  await assert.rejects(f.delegate('interleaved', {queue: true}, undefined, {reviews: 'subject'}), busy);
  await assert.rejects(f.compact('interleaved-compact'), busy);
  await assert.rejects(f.dispatcher.forget('review'), busy);
  assert.equal((await deleting).removed, true);
  const after = f.delegate('after-deletion'); const finalCall = await f.call(5);
  finalCall.output.resolve(result()); assert.equal((await after).state, 'COMPLETED');
});

test('dispatcher disposal also drains a deletion already in progress', async t => {
  const f = await fixture(t); await subject(f);
  const entered = deferred(), release = deferred(), originalRemove = fs.rm;
  const deleting = f.dispatcher.forget('subject');
  t.mock.method(fs, 'rm', async function (...args) {
    entered.resolve(); await release.promise; return originalRemove.apply(this, args);
  });
  t.after(() => release.resolve());
  await entered.promise;
  let settled = false;
  const draining = f.dispatcher.dispose().then(() => {settled = true;});
  try {
    await Promise.resolve();
    assert.equal(settled, false);
  } finally {release.resolve(); await deleting; await draining;}
  assert.equal(settled, true);
});
