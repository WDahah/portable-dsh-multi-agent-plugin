import {createRecordStore, keyOf, need, scopedSignal} from './qualification.mjs';
import {resolveRole, selectRoute} from './routes.mjs';
import {WORKER_RESULT_INSTRUCTION} from './worker-result.mjs';

const ID = /^[A-Za-z0-9_-]{1,39}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{1,20}$/;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k));
const KNOWN_FAILURES = new Set(['DELEGATION_BUSY', 'DELEGATION_QUEUE_FULL', 'ASSIGNMENT_ALREADY_EXISTS',
  'EVIDENCE_EXPIRED', 'PERSISTENCE_FAILED', 'JOURNAL_BOUND', 'INVALID_TECHNICAL_LIMIT']);

function requestOf(args) {
  need(fields(args, ['batch_id', 'brief', 'tasks', 'max_tokens', 'deadline_ms', 'spread']) &&
    typeof args.batch_id === 'string' && ID.test(args.batch_id), 'INVALID_BATCH');
  need(text(args.brief, 4000), 'INVALID_BATCH');
  need(Array.isArray(args.tasks) && args.tasks.length >= 2 && args.tasks.length <= 8, 'INVALID_BATCH');
  const maxTokens = args.max_tokens ?? 16384, deadlineMs = args.deadline_ms ?? 900000;
  need(Number.isInteger(maxTokens) && maxTokens >= 1024 && maxTokens <= 65536 &&
    Number.isInteger(deadlineMs) && deadlineMs >= 1000 && deadlineMs <= 900000 &&
    (args.spread === undefined || typeof args.spread === 'boolean'), 'INVALID_BATCH');
  const ids = new Set(), scopes = new Set(), prompts = new Set();
  const tasks = args.tasks.map(item => {
    need(fields(item, ['id', 'scope', 'prompt', 'task']) && typeof item.id === 'string' && ITEM_ID.test(item.id) &&
      text(item.scope, 1000) && text(item.prompt, 8000) && fields(item.task,
        ['role', 'intent', 'category', 'risk', 'complexity', 'escalate', 'dataClass', 'capabilities', 'pool']), 'INVALID_BATCH');
    need(['standard', 'deep', 'domain'].includes(resolveRole(item.task.role)?.role) &&
      (item.task.capabilities === undefined || (Array.isArray(item.task.capabilities) &&
        item.task.capabilities.length <= 3 && new Set(item.task.capabilities).size === item.task.capabilities.length)) &&
      !(item.task.capabilities ?? []).some(c => c === 'image' || c === 'video'), 'INVALID_BATCH');
    need(selectRoute({task: item.task, qualifications: []}).reason !== 'INVALID_INPUT', 'INVALID_BATCH');
    need(!ids.has(item.id) && !scopes.has(item.scope.trim()) && !prompts.has(item.prompt.trim()), 'DUPLICATE_BATCH_TASK');
    ids.add(item.id); scopes.add(item.scope.trim()); prompts.add(item.prompt.trim());
    return {id: item.id, scope: item.scope.trim(), prompt: item.prompt.trim(), task: structuredClone(item.task),
      run_id: `b${args.batch_id.length}-${args.batch_id}-${item.id}`};
  });
  return {batch_id: args.batch_id, brief: args.brief.trim(), tasks, max_tokens: maxTokens,
    deadline_ms: deadlineMs, spread: args.spread === true};
}

function view(record, {details = false, recovered = false} = {}) {
  const uncertain = recovered && ['PLANNED', 'RUNNING'].includes(record.state);
  const attempted = record.tasks.reduce((n, t) => n + (t.round_commitments ?? 0), 0);
  return {batch_id: record.batch_id, state: uncertain ? 'INTERRUPTED_UNKNOWN' : record.state,
    replay_enabled: false, concurrency: 2, task_count: record.tasks.length,
    created_at: record.created_at, finished_at: record.finished_at ?? null,
    duration_ms: record.finished_at == null ? null : record.finished_at - record.created_at,
    deadline_at: record.deadline_at, persistence_failed: record.persistence_failed === true,
    aggregation: 'COLLECT_ONLY', semantic_verification: false,
    tasks: record.tasks.map(t => ({id: t.id, run_id: t.run_id,
      state: uncertain && ['QUEUED', 'RUNNING'].includes(t.state) ? 'INTERRUPTED_UNKNOWN' : t.state,
      provider: t.provider ?? null, model: t.model ?? null, effort: t.effort ?? null,
      reason: t.reason ?? null, summary: t.result?.summary ?? null,
      ...(details ? {result: t.result ?? null} : {}),
      queue_wait_ms: t.queue_wait_ms ?? null, duration_ms: t.duration_ms ?? null,
      round_commitments: t.round_commitments ?? null, observed_children: t.observed_children ?? null})),
    accounting: {recorded_round_commitments: attempted,
      observed_children: record.tasks.reduce((n, t) => n + (t.observed_children ?? 0), 0),
      round_counts_complete: !uncertain && record.tasks.every(t => Number.isInteger(t.round_commitments)),
      model_calls: null, usage: null, usage_complete: false,
      usage_reason: 'CHILD_RESULT_CARRIES_NO_USAGE', cost_unknown: true, hard_budget_cap: false,
      max_rounds_per_task: 1, requested_max_tokens_per_model_call: record.request.max_tokens,
      scheduling_model_calls: 0, automatic_retries: false, automatic_compactions: false},
    note: 'Collected worker declarations, not an integrated or verified answer. Full assignments remain separately readable.'};
}

/** One bounded read-only batch per owner. Admission and child disposal belong to the dispatcher.
 * Saved batches cannot restart; a recovered in-flight batch is uncertain, never replayed. */
export function createBatchRunner({root, owner, agents, qualifications}) {
  const store = createRecordStore(root, owner, 'batches');
  let active = false, activeId = null, disposed = false, currentScope, settled = Promise.resolve(), settle;
  function reserve() {
    need(!disposed, 'DISPOSED'); need(!active, 'BATCH_BUSY'); active = true;
    settled = new Promise(resolve => {settle = resolve;});
  }
  function release() {active = false; activeId = null; settle();}
  const key = id => {need(typeof id === 'string' && ID.test(id), 'INVALID_BATCH'); return keyOf(id);};

  async function run(args, exec) {
    need(!disposed && exec.agent?.id === owner, 'OWNER_REFUSED'); exec.signal.throwIfAborted();
    need(!active, 'BATCH_BUSY');
    const request = requestOf(args), batchKey = key(request.batch_id);
    reserve(); activeId = request.batch_id;
    let revision = 0, record, scope, pendingSave = Promise.resolve();
    async function commit() {
      const operation = pendingSave.then(async () => {
        need(!record.persistence_failed, 'PERSISTENCE_FAILED');
        try {revision = await store.save(batchKey, structuredClone(record), revision);}
        catch (error) {record.persistence_failed = true; scope.controller.abort(); throw error;}
      });
      pendingSave = operation.catch(() => {});
      return operation;
    }
    try {
      need(!(await store.read(batchKey)), 'BATCH_ALREADY_EXISTS');
      need(!disposed, 'DISPOSED');
      scope = scopedSignal(exec.signal, request.deadline_ms); currentScope = scope;
      const now = Date.now();
      record = {schemaVersion: 1, batch_id: request.batch_id, owner, request,
        state: 'PLANNED', created_at: now, deadline_at: now + request.deadline_ms, finished_at: null,
        tasks: request.tasks.map(t => ({id: t.id, run_id: t.run_id, state: 'QUEUED', result: null,
          round_commitments: 0, observed_children: 0, assignment_created: false}))};
      await commit();
      record.state = 'RUNNING'; await commit();
      let next = 0;
      async function worker() {
        while (next < request.tasks.length && !scope.signal.aborted && !record.persistence_failed) {
          const index = next++, item = request.tasks[index], task = record.tasks[index];
          const started = Date.now();
          try {
            // Select at queue consumption, not batch submission, so waiting does not freeze stale evidence.
            const selected = selectRoute({task: item.task, qualifications: await qualifications.list(),
              spread: request.spread ? item.run_id : undefined});
            if (selected.status !== 'SELECTED') {
              task.state = 'UNAVAILABLE'; task.reason = selected.reason; await commit(); continue;
            }
            scope.signal.throwIfAborted();
            Object.assign(task, {state: 'RUNNING', provider: selected.route.provider,
              model: selected.route.model, effort: selected.effort, round_commitments: null, observed_children: null});
            await commit(); scope.signal.throwIfAborted();
            const prompt = 'Inspect only. Do not edit files, run commands, delegate, or access the network.\n\n' +
              `SHARED REQUEST\n${request.brief}\n\nYOUR SCOPE\n${item.scope}\n\nYOUR TASK\n${item.prompt}` + WORKER_RESULT_INSTRUCTION;
            const answer = await agents.delegate({run_id: item.run_id, prompt,
              role: selected.role, intent: selected.intent, evidence: selected.qualification,
              grounds: selected.grounds, routing_provenance: 'SELECTOR',
              allowed_tools: ['read', 'glob', 'grep'], max_rounds: 1, max_tokens: request.max_tokens},
            selected.route, selected.effort, {...exec, signal: scope.signal}, {queue: true, resultFormat: 'findings'});
            task.assignment_created = true;
            task.round_commitments = answer.rounds.length;
            task.observed_children = answer.returned_children ?? answer.rounds.filter(r => r.child_id !== null).length;
            task.queue_wait_ms = answer.queue_wait_ms ?? null;
            task.result = answer.worker_result ?? null;
            if (answer.state !== 'COMPLETED') {
              task.state = 'INCOMPLETE';
              task.reason = answer.state === 'PERSISTENCE_FAILED' ? answer.state :
                KNOWN_FAILURES.has(answer.failure_code) ? answer.failure_code : answer.state;
            }
            else if (!answer.worker_result) {task.state = 'RESULT_UNREADABLE'; task.reason = answer.worker_result_reason ?? 'WORKER_RESULT_UNREADABLE';}
            else {
              task.state = answer.worker_result.status === 'complete' ? 'COMPLETED' :
                answer.worker_result.status === 'partial' ? 'PARTIAL' : 'NEEDS_CLARIFICATION';
            }
          } catch (error) {
            task.state = record.persistence_failed ? 'REFUSED_OR_FAILED' : scope.signal.aborted ? 'CANCELLED_OR_UNKNOWN' : 'REFUSED_OR_FAILED';
            task.reason = record.persistence_failed ? 'PERSISTENCE_FAILED' : scope.signal.aborted ? 'ABORTED_OR_DEADLINE' :
              KNOWN_FAILURES.has(error?.code) ? error.code : 'UNAVAILABLE';
          }
          task.duration_ms = Date.now() - started;
          if (!record.persistence_failed) await commit();
        }
      }
      // Both loops are drained even if persistence fails; owned children must settle before return.
      await Promise.allSettled([worker(), worker()]);
      for (const task of record.tasks) if (task.state === 'QUEUED') {task.state = 'NOT_STARTED'; task.reason = 'BATCH_STOPPED';}
      record.finished_at = Date.now();
      record.state = record.persistence_failed ? 'PERSISTENCE_FAILED' : scope.signal.aborted ? 'INTERRUPTED_UNKNOWN' :
        record.tasks.every(t => t.state === 'COMPLETED') ? 'COMPLETED' : 'INCOMPLETE';
      if (!record.persistence_failed) await commit();
      return view(record, {details: true});
    } finally {
      await pendingSave;
      scope?.close(); currentScope = undefined; release();
    }
  }

  async function read(batchId, details = false) {
    const saved = await store.read(key(batchId)); need(saved?.data?.owner === owner, 'UNKNOWN_BATCH');
    return view(saved.data, {details, recovered: activeId !== batchId});
  }
  async function list() {
    return (await store.list()).map(r => ({batch_id: r.batch_id,
      state: activeId !== r.batch_id && ['PLANNED', 'RUNNING'].includes(r.state) ? 'INTERRUPTED_UNKNOWN' : r.state,
      task_count: r.tasks.length, created_at: r.created_at, finished_at: r.finished_at}));
  }
  async function referencedBy(runId) {
    return (await store.list()).filter(r => r.tasks.some(t => t.run_id === runId &&
      (t.assignment_created || t.state === 'RUNNING'))).map(r => r.batch_id);
  }
  async function forget(batchId) {
    reserve();
    try {need(await store.remove(key(batchId)), 'UNKNOWN_BATCH'); return {batch_id: batchId, removed: true};}
    finally {release();}
  }
  async function withAssignmentDeletion(operation) {
    reserve();
    try {return await operation();} finally {release();}
  }
  return {run, read, list, referencedBy, forget, withAssignmentDeletion,
    dispose() {disposed = true; currentScope?.controller.abort(); return settled;}};
}
