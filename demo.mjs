#!/usr/bin/env node
// A runnable tour of the routing and verdict logic, with no DSH host and no network.
//
// This calls the SAME selectRoute and parseVerdict the plugin uses in production. Only the
// qualification evidence is synthetic, and it is labelled as such: a demo that reimplemented
// the logic could agree with itself while the real thing was broken.
//
//   node demo.mjs            every scene
//   node demo.mjs routing    one scene by name
import {selectRoute, expectedEffort, ROUTES, ROLES, ROLE_ALIASES, POOL_PRIORITY} from './src/routes.mjs';
import {parseVerdict, loopDecision, normalizeObjective, objectiveMaterial, VERDICTS} from './src/verdict.mjs';

const NOW = Date.now();
// Colour helps a terminal and ruins a pipe or a log file, so it is used only where it
// lands on a real terminal and the reader has not asked for it to stop.
const COLOUR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = code => text => (COLOUR ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const mark = value => (value ? green('yes') : red('no'));
function scene(title, explanation) {
  console.log(`\n${bold('── ' + title + ' ')}${dim('─'.repeat(Math.max(0, 62 - title.length)))}`);
  if (explanation) console.log(dim(explanation) + '\n');
}
/** Synthetic evidence shaped exactly like a real probe result. Nothing here proves a model
 * can do anything: it stands in for evidence the plugin would only accept from a real probe. */
function evidenceFor(routeId, pool, overrides = {}) {
  const route = ROUTES.find(r => r.id === routeId);
  return {
    schemaVersion: 1, qualificationType: 'smoke',
    issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId: 'SYNTHETIC-DEMO'},
    runtimeBuildId: 'portable-multi-agent-1', adapterFingerprint: 'SYNTHETIC-DEMO-FINGERPRINT',
    provider: route.provider, model: route.model, effort: expectedEffort(route, pool),
    issuedAt: NOW - 60_000, expiresAt: NOW + 3_600_000, durationMs: 1200,
    available: true, transportPassed: true, textPassed: true, toolPassed: true, imagePassed: false,
    caseResults: [{name: 'text', passed: true}, {name: 'native-tool-roundtrip', passed: true}],
    allowedDataClasses: ['public', 'internal'], domainEvidence: false, attestation: null,
    ...overrides,
  };
}
const task = overrides => ({category: 'demo', risk: 'low', complexity: 'routine', escalate: false, ...overrides});
const show = result => (result.status === 'SELECTED'
  ? `${green('SELECTED')} ${result.route.provider}/${result.route.model} at ${result.effort} (${result.pool})`
  : `${red('UNAVAILABLE')} ${result.reason}`);

const scenes = {
  routing() {
    scene('1. A role names routing you can predict',
      'Five roles. Each one decides a pool and an effort, and nothing else pretends to.');
    // vision and domain demand evidence a plain text probe never produces, so their
    // records carry the image pass and the attestation those roles actually require.
    const evidence = [...new Set(Object.values(ROLES).map(r => r.pool))]
      .flatMap(pool => POOL_PRIORITY[pool].map(id => evidenceFor(id, pool, {
        imagePassed: true,
        caseResults: [{name: 'text', passed: true}, {name: 'native-tool-roundtrip', passed: true}, {name: 'image', passed: true}],
        domainEvidence: true,
        attestation: {kind: 'operator-attestation', attestedBy: 'SYNTHETIC-DEMO-OPERATOR',
          basis: 'Synthetic demo fixture; no real review took place.', domainEvidence: true},
      })));
    for (const [name, definition] of Object.entries(ROLES)) {
      const result = selectRoute({task: task({role: name}), qualifications: evidence, now: NOW});
      console.log(`  ${name.padEnd(9)} -> ${show(result)}`);
      if (definition.image || definition.domain) {
        console.log(dim(`            ${definition.describes}`));
      }
    }
    console.log(`\n  ${dim('Risk and complexity override the role:')}`);
    for (const override of [{risk: 'high'}, {complexity: 'complex'}, {escalate: true}]) {
      const result = selectRoute({task: task({role: 'standard', ...override}), qualifications: evidence, now: NOW});
      console.log(`  standard + ${JSON.stringify(override).padEnd(22)} -> ${result.pool}`);
    }
  },
  refusal() {
    scene('2. A refusal tells you what to run next',
      'No evidence means no dispatch. The refusal names the exact probe that would fix it,\nrather than failing vaguely or quietly downgrading to a weaker model.');
    const result = selectRoute({task: task({role: 'deep'}), qualifications: [], now: NOW});
    console.log(`  ${show(result)}\n`);
    for (const reason of result.reasons) {
      console.log(`  ${reason.id.padEnd(20)} ${reason.reason}`);
      console.log(dim(`  ${' '.repeat(20)} fix: orchestrator_qualify ${JSON.stringify(reason.requalify)}`));
    }
    console.log(`\n  ${dim('A vision task asks for the image probe it will actually need, on every')}`);
    console.log(`  ${dim('candidate route, so following the hint produces usable evidence:')}`);
    const vision = selectRoute({task: task({role: 'vision'}), qualifications: [], now: NOW});
    for (const reason of vision.reasons) console.log(`  ${JSON.stringify(reason.requalify)}`);
    console.log(`\n  ${dim('A domain task cannot be probed at all, so it asks for a human attestation:')}`);
    const domain = selectRoute({task: task({role: 'domain'}), qualifications: [], now: NOW});
    console.log(`  ${JSON.stringify(domain.reasons[0].requalify.attestation)}`);
  },
  expiry() {
    scene('3. Evidence expires, and stale evidence is refused',
      'A route that passed yesterday is not a route that works today.');
    const fresh = evidenceFor('codex-sol', 'advanced');
    const stale = {...fresh, issuedAt: NOW - 90_000_000, expiresAt: NOW - 1000};
    console.log(`  fresh evidence  -> ${show(selectRoute({task: task({role: 'deep'}), qualifications: [fresh], now: NOW}))}`);
    const expired = selectRoute({task: task({role: 'deep'}), qualifications: [stale], now: NOW});
    console.log(`  expired         -> ${show(expired)}`);
    console.log(dim(`                     ${expired.reasons[0].reason}, lapsed ${Math.round(expired.reasons[0].expiredForMs / 1000)}s ago`));
    const unavailable = selectRoute({task: task({role: 'deep'}), qualifications: [{...fresh, available: false}], now: NOW});
    console.log(`  probe said down -> ${show(unavailable)}`);
    console.log(dim(`                     ${unavailable.reasons[0].reason}`));
    // Two records with the same timestamp cannot be ordered, so neither is trusted.
    const tie = selectRoute({task: task({role: 'deep'}), qualifications: [fresh, {...fresh}], now: NOW});
    console.log(`  ambiguous tie   -> ${show(tie)}`);
    console.log(dim(`                     ${tie.reasons[0].reason} (refuses rather than picking one)`));
  },
  diversity() {
    scene('4. A review avoids the model it is judging',
      'A review that runs on the model that produced the work shares its blind spots.\nThe subject\u2019s provider is avoided when another one is qualified.');
    const all = POOL_PRIORITY.advanced.map(id => evidenceFor(id, 'advanced'));
    const plain = selectRoute({task: task({role: 'review'}), qualifications: all, now: NOW});
    console.log(`  no subject to avoid      -> ${plain.route.provider}/${plain.route.model}`);
    const avoided = selectRoute({task: task({role: 'review'}), qualifications: all, now: NOW, avoidProvider: 'codex'});
    console.log(`  avoiding codex           -> ${avoided.route.provider}/${avoided.route.model}  independent=${mark(avoided.independence.independent)}`);
    console.log(`\n  ${dim('When no alternative is qualified it proceeds and says so, rather than')}`);
    console.log(`  ${dim('refusing the review or quietly passing it off as independent:')}`);
    const forced = selectRoute({task: task({role: 'review'}), qualifications: [evidenceFor('codex-sol', 'advanced')], now: NOW, avoidProvider: 'codex'});
    console.log(`  only the subject's own   -> ${forced.route.provider}/${forced.route.model}  independent=${mark(forced.independence.independent)}`);
    console.log(dim(`                              reason: ${forced.independence.reason}`));
    console.log(dim(`                              warning: ${forced.warnings.at(-1)}`));
    console.log(`\n  ${dim('Avoidance never relaxes the evidence rules:')}`);
    const expired = selectRoute({task: task({role: 'review'}), now: NOW, avoidProvider: 'codex',
      qualifications: [{...evidenceFor('claude-opus', 'advanced'), issuedAt: NOW - 9e7, expiresAt: NOW - 1}]});
    console.log(`  expired alternative      -> ${show(expired)} ${dim('(not promoted for being independent)')}`);
  },
  verdicts() {
    scene('5. A verdict is declared, not inferred',
      'The reviewer states a verdict. The plugin records it and reads only the declared\nstate to decide whether another cycle may run. It never reads prose to judge work.');
    const base = {onObjective: true, summary: 'Checked against the acceptance criteria.', findings: [], clarifications: [], verified: []};
    console.log(`  ${dim('Accepted:')}`);
    for (const state of VERDICTS) {
      const parsed = parseVerdict({structured: {...base, verdict: state}});
      const decision = loopDecision({verdict: parsed, cycle: 1, maxCycles: 3, canWrite: false});
      const arrow = decision.continue ? yellow('continue') : green('stop    ');
      console.log(`  ${state.padEnd(21)} ${arrow} ${decision.state}`);
    }
    console.log(`\n  ${dim('Refused, because none of these is a verdict anybody declared:')}`);
    const rejects = [
      ['prose', {output: 'Looks good to me, ship it.'}],
      ['invented state', {structured: {...base, verdict: 'approved'}}],
      ['missing onObjective', {structured: {verdict: 'verified', summary: 'x'}}],
      ['empty summary', {structured: {...base, verdict: 'verified', summary: '   '}}],
    ];
    for (const [label, input] of rejects) {
      console.log(`  ${label.padEnd(21)} ${parseVerdict(input) === null ? green('refused') : red('ACCEPTED')}`);
    }
    console.log(`\n  ${dim('An unreadable verdict stops the loop instead of assuming the work passed:')}`);
    const blind = loopDecision({verdict: null, cycle: 1, maxCycles: 3, canWrite: false});
    console.log(`  ${blind.state}: ${blind.reason}`);
    console.log(`\n  ${dim('And the cap is a stop, never a pass:')}`);
    const capped = loopDecision({verdict: parseVerdict({structured: {...base, verdict: 'failed'}}), cycle: 3, maxCycles: 3, canWrite: false});
    console.log(`  ${capped.state}: ${capped.reason}`);
  },
  objective() {
    scene('6. The objective travels as data',
      'Every child is handed the objective again, fenced so it reads as material rather\nthan as fresh instructions. Drift is something the reviewer reports, not something\nthe plugin infers by comparing text.');
    const objective = normalizeObjective({statement: 'Add password reset', acceptance: ['tests pass', 'no new dependencies']});
    console.log(objectiveMaterial(objective).split('\n').map(line => '  ' + line).join('\n'));
    const drifted = parseVerdict({structured: {verdict: 'failed', onObjective: false,
      summary: 'Implemented account deletion instead.', findings: [{severity: 'blocker', detail: 'Solved a different problem.'}]}});
    console.log(`\n  reviewer reports onObjective=${red(String(drifted.onObjective))} -> ${drifted.summary}`);
    console.log(dim('  The plugin stores that. It does not decide for itself whether the work drifted.'));
  },
  aliases() {
    scene('7. Old identifiers keep working, and say that they are old',
      'Twelve numeric role codes shipped before the names existed. Each still routes\nexactly where it always did, while reporting the name that replaced it.');
    const evidence = ['balanced', 'advanced'].flatMap(pool => POOL_PRIORITY[pool].map(id => evidenceFor(id, pool)));
    const seen = new Map();
    for (const [code, canonical] of Object.entries(ROLE_ALIASES)) {
      if (!seen.has(canonical)) seen.set(canonical, []);
      seen.get(canonical).push(code);
    }
    for (const [canonical, codes] of seen) {
      console.log(`  ${codes.join(' ').padEnd(26)} -> ${canonical}`);
    }
    const legacy = selectRoute({task: task({role: 'R12'}), qualifications: evidence, now: NOW});
    console.log(`\n  R12 routes to ${legacy.pool}, reporting role=${legacy.role} deprecated=${mark(legacy.roleDeprecated)}`);
    console.log(dim(`  warning: ${legacy.warnings.at(-1)}`));
    console.log(`\n  ${dim('A plausible-sounding role that was never real is still refused:')}`);
    for (const invented of ['architect', 'security', 'R13']) {
      console.log(`  ${invented.padEnd(12)} ${red(selectRoute({task: task({role: invented}), qualifications: evidence, now: NOW}).reason)}`);
    }
  },
};

const requested = process.argv[2];
const chosen = requested ? {[requested]: scenes[requested]} : scenes;
if (requested && !scenes[requested]) {
  console.error(`Unknown scene "${requested}". Available: ${Object.keys(scenes).join(', ')}`);
  process.exit(1);
}
console.log(bold('\nportable-dsh-multi-agent — routing and verdict logic, no host required'));
console.log(dim('Real selectRoute and parseVerdict. Only the qualification evidence is synthetic.'));
for (const run of Object.values(chosen)) run();
console.log(`\n${dim('These decisions are the whole point: the plugin routes, records and refuses.')}`);
console.log(`${dim('Whether the work is any good stays a judgement for a model and for you.')}`);
console.log(`${dim('Running it for real needs a DSH/Cordis host — see START-HERE.md.')}\n`);
