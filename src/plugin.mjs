import path from 'node:path';
import {registerLifetimeTool} from './cancellation.mjs';
import {ROUTES, selectRoute} from './routes.mjs';
import {createTaskEngine} from './engine.mjs';
import {createQualificationManager, need, BUILD_ID} from './qualification.mjs';
import {createAgentDispatcher} from './agent-dispatch.mjs';

/** Inject the installed host's native defineTool; this package does not vendor DSH. */
export function createPlugin(defineTool) {
  if (typeof defineTool !== 'function') throw new TypeError('Native defineTool function required');
  return {
  name: 'portable-multi-agent', inject: ['tools'],
  apply(ctx, config = {}) {
    need(typeof config.stateRoot === 'string' && path.isAbsolute(config.stateRoot), 'ABSOLUTE_STATE_ROOT_REQUIRED');
    const enabled = config.enabled ?? false; need(typeof enabled === 'boolean', 'BOOLEAN_ENABLED_REQUIRED');
    const owners = new Map(); let disposed = false;
    ctx.effect(() => () => {disposed = true; for (const entry of owners.values()) {entry.qualifications.dispose(); entry.agents.dispose(); entry.engine.dispose();} owners.clear();});
    function owned(exec) {
      need(!disposed && typeof exec.agent?.id === 'string' && exec.agent.id, 'OWNER_REQUIRED'); exec.signal.throwIfAborted();
      if (!owners.has(exec.agent.id)) {
        need(owners.size < 64, 'OWNER_CAPACITY');
        const options = {root: config.stateRoot, owner: exec.agent.id, getLlm: () => ctx.get('llm'), getSubagents: () => ctx.get('subagents')};
        owners.set(exec.agent.id, {qualifications: createQualificationManager(options), agents: createAgentDispatcher(options), engine: createTaskEngine(options)});
      }
      return owners.get(exec.agent.id);
    }
    const schema = {type: 'object', additionalProperties: true};
    function register(name, description, parameters, fn, timeoutMs = 60000) {
      registerLifetimeTool(ctx, defineTool({name, description, parameters, timeoutMs, output: {schema, render(_a, value) {return [{type: 'text', text: JSON.stringify(value)}];}},
        async execute(args, exec) {try {return await fn(args, exec);} catch {return {status: 'BRIDGE_REFUSED_OR_FAILED', details_redacted: true, automatic_retry: false};}}}));
    }
    register('orchestrator_qualification_echo', 'Bounded readonly qualification challenge; no filesystem, network or delegation.', {token: {type: 'string', required: true}}, (args, exec) => {
      need(!disposed, 'DISPOSED');
      for (const entry of owners.values()) {try {return entry.qualifications.echo(args, exec);} catch { /* Only the manager owning this unguessable token can answer. */ }}
      throw new Error('INVALID_CHALLENGE');
    });
    register('orchestrator_inventory', 'Read exact route inventory and privately recorded smoke qualifications; no provider call.', {}, async (_args, exec) => {
      const entry = owned(exec), records = await entry.qualifications.list();
      const llm = ctx.get('llm'), providers = llm ? llm.listProviders().map(provider => provider.id) : [];
      return {enabled, build_id: BUILD_ID, approval_required: false, soft_target_usd: 1, hard_budget_cap: false,
        routes: ROUTES.map(route => ({id: route.id, provider: route.provider, model: route.model, pools: [...route.pools], efforts: {...route.effortsExpected}, provider_registered: providers.includes(route.provider)})), qualifications: records};
    });
    register('orchestrator_qualify', 'Run one bounded real native-agent text/tool smoke probe and record actual evidence. Costs may be unknown; no approval or financial ceiling.',
      {route_id: {type: 'string', required: true}, effort: {type: 'string', required: true}}, async (args, exec) => {
        need(enabled, 'DISABLED'); const entry = owned(exec), route = ROUTES.find(route => route.id === args.route_id); need(route, 'UNKNOWN_ROUTE');
        need(Object.values(route.effortsExpected).includes(args.effort), 'EFFORT_NOT_IN_ROUTE_POLICY');
        return entry.qualifications.qualify(route, args.effort, exec);
      }, 190000);
    async function choose(args, exec) {
      const entry = owned(exec), selected = selectRoute({task: args.task, qualifications: await entry.qualifications.list()});
      return {entry, selected};
    }
    const task = {task: {type: 'json', required: true}};
    register('orchestrator_plan', 'Automatically select a smoke-qualified route and persist a direct-model task for bounded automatic continuation.',
      {...task, task_id: {type: 'string', required: true}, prompt: {type: 'string', required: true}, max_rounds: {type: 'integer'}, context_chars: {type: 'integer'}, max_tokens: {type: 'integer'}}, async (args, exec) => {
        need(enabled, 'DISABLED'); const {entry, selected} = await choose(args, exec); if (selected.status !== 'SELECTED') return selected;
        const maxTokens = args.max_tokens ?? 32768; need(Number.isInteger(maxTokens) && maxTokens >= 64 && maxTokens <= 65536, 'INVALID_MAX_TOKENS');
        const route = selected.route, planned = {task_id: args.task_id, prompt: args.prompt,
          route: {provider: route.provider, model: route.model, effort: selected.effort, maxTokens}, maxRounds: args.max_rounds ?? 3, contextChars: args.context_chars ?? 160000};
        planned.route.costRates = route.pricing ? {inputMicrosPerMillion: Math.round(route.pricing.inputPerMillion * 1000000), outputMicrosPerMillion: Math.round(route.pricing.outputPerMillion * 1000000)} : null;
        return {selection: selected, task: await entry.engine.plan(planned)};
      });
    register('orchestrator_run', 'Run a persisted direct-model task with bounded automatic continuation; no approval, no hard dollar ceiling, no error retry.',
      {task_id: {type: 'string', required: true}}, (args, exec) => {need(enabled, 'DISABLED'); return owned(exec).engine.run(args.task_id, exec);}, 910000);
    register('orchestrator_resume', 'Resume only an engine-approved settled token-limited task; never replay uncertain interrupted work.',
      {task_id: {type: 'string', required: true}}, (args, exec) => {need(enabled, 'DISABLED'); return owned(exec).engine.resume(args.task_id, exec);}, 910000);
    register('orchestrator_read', 'Read persisted direct-task output and accounting without model dispatch.',
      {task_id: {type: 'string', required: true}, page: {type: 'integer'}}, (args, exec) => owned(exec).engine.read(args.task_id, args.page ?? 0));
    register('orchestrator_delegate', 'Select a qualified route and run a real scoped child agent. Automatic new-child continuation is restricted to readonly tool sets; no error retry.',
      {...task, run_id: {type: 'string', required: true}, prompt: {type: 'string', required: true}, allowed_tools: {type: 'array', items: {type: 'string'}}, max_rounds: {type: 'integer'}, max_tokens: {type: 'integer'}}, async (args, exec) => {
        need(enabled, 'DISABLED'); const {entry, selected} = await choose(args, exec); if (selected.status !== 'SELECTED') return selected;
        return {selection: selected, delegation: await entry.agents.delegate({...args, role: args.task.role}, selected.route, selected.effort, exec)};
      }, 910000);
    register('orchestrator_delegate_read', 'Read immutable child-assignment output; never restarts the child.',
      {run_id: {type: 'string', required: true}, offset: {type: 'integer'}}, (args, exec) => owned(exec).agents.read(args.run_id, args.offset ?? 0));
  }
  };
}
export default createPlugin;
