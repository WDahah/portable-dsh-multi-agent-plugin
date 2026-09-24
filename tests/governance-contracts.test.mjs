// Pure M1 fixture schemas; validation and hashes are not operational authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  PROVENANCE, LIMITS, ownedJson, canonicalize, digest, relativePath, planIdentity,
  bindingFor, same, validateActor, validatePlan, validateSubmission,
  validateAssignment, validateDecision, validateResult, validateEvidence,
} from '../src/governance/contracts.mjs';

const HASH = 'a'.repeat(64), OTHER_HASH = 'b'.repeat(64);
const CAP = {timeout: 30000};
const clone = value => JSON.parse(JSON.stringify(value));
const refusal = code => ({code});
const sha256 = bytes => createHash('sha256').update(bytes, 'utf8').digest('hex');

function makePlan() {
  return {
    schemaVersion: 1, jobId: 'fixture-job', projectId: HASH, baseline: HASH,
    objective: 'Exercise only synthetic governance contracts.',
    nonGoals: ['No dispatch or operational acceptance.'],
    files: [{path: 'src/fixture.mjs', operation: 'create', expectedHash: null}],
    protectedTests: ['tests/existing.test.mjs'],
    criteria: [{id: 'criterion-1', description: 'The synthetic fixture passes.', method: 'test'}],
    commands: [{id: 'unit', executable: '/fixture/node', argv: ['--test', 'tests/fixture.test.mjs'],
      cwd: 'frozen', environment: {LANG: 'C'}, timeoutMs: 30000, expectedExit: 0,
      inventory: ['fixture-test']}],
    policy: {planner: {id: 'planner', provider: 'planner-provider'},
      implementerProvider: 'author-provider', correctionLimit: 2},
    testInventory: ['fixture-test'], environmentDigest: HASH,
  };
}
function makeSubmission() {
  return {criteria: [{id: 'criterion-1', outcome: 'pass'}],
    findings: [{id: 'finding-1', criterionId: 'criterion-1', detail: 'Synthetic nonblocking note.',
      severity: 'note', status: 'resolved'}], evidenceIds: ['frozen-1', 'test-1']};
}
function makeAssignment() {
  return {id: 'assignment-1', actor: {id: 'validator', provider: 'validator-provider'},
    role: 'validator', generation: 1, binding: clone(bindingFor(makePlan(), HASH)),
    provenance: PROVENANCE};
}
function makeDecision() {
  return {id: 'decision-1', planDigest: planIdentity(makePlan()).planDigest,
    reviewResultId: 'result-1', generation: 1, decision: 'authorize', provenance: PROVENANCE};
}
function makeResult() {
  const assignment = makeAssignment();
  return {id: 'result-1', assignmentId: assignment.id, actor: assignment.actor,
    role: assignment.role, generation: assignment.generation, binding: assignment.binding,
    outcome: 'completed-pass', submission: makeSubmission(), provenance: PROVENANCE};
}
function makeFrozenEvidence() {
  const plan = makePlan();
  const details = {manifest: [{path: 'src/fixture.mjs', sha256: HASH, operation: 'present', mode: 420}],
    inventory: [...plan.testInventory]};
  const contentDigest = digest(details.manifest);
  return {id: 'frozen-1', kind: 'frozen', assignmentId: 'author-assignment',
    binding: clone(bindingFor(plan, contentDigest)), contentDigest,
    status: 'completed', details, provenance: PROVENANCE};
}
function makeTestEvidence() {
  const plan = makePlan();
  const details = {commandId: 'unit', commandDigest: digest(plan.commands[0]), expectedExit: 0,
    actualExit: 0, stdoutDigest: HASH, stderrDigest: OTHER_HASH, captureComplete: true,
    inventory: [{id: 'fixture-test', outcome: 'pass'}], managedSettled: true};
  return {id: 'test-1', kind: 'test', assignmentId: 'test-assignment',
    binding: clone(bindingFor(plan, makeFrozenEvidence().contentDigest)),
    contentDigest: digest(details), status: 'completed', details, provenance: PROVENANCE};
}
function resealEvidence(value) {
  value.contentDigest = digest(value.kind === 'frozen' ? value.details.manifest : value.details);
  if (value.kind === 'frozen') value.binding.candidateDigest = value.contentDigest;
  return value;
}
function assertFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const item of Object.values(value)) assertFrozen(item);
}
const recordCases = [
  ['actor', () => makeAssignment().actor, validateActor],
  ['plan', makePlan, validatePlan],
  ['submission', makeSubmission, validateSubmission],
  ['assignment', makeAssignment, validateAssignment],
  ['decision', makeDecision, validateDecision],
  ['result', makeResult, validateResult],
  ['frozen evidence', makeFrozenEvidence, validateEvidence],
  ['test evidence', makeTestEvidence, validateEvidence],
];

for (const [name, make, validate] of recordCases) {
  test(`M1-01 ${name} round-trips as a detached, deeply frozen owned record`, CAP, () => {
    const input = make(), expected = clone(input), owned = validate(input);
    assert.deepEqual(owned, expected);
    assert.notEqual(owned, input);
    assertFrozen(owned);
    assert.deepEqual(JSON.parse(canonicalize(owned)), expected);
    input.extra = 'caller mutation';
    assert.deepEqual(owned, expected);
    assert.throws(() => {owned.extra = 'mutation';}, TypeError);
  });
  test(`M1-01 ${name} rejects every missing field and unknown top-level fields`, CAP, () => {
    const valid = make();
    assert.deepEqual(validate(valid), valid);
    for (const key of Object.keys(valid)) {
      const missing = make(); delete missing[key];
      assert.throws(() => validate(missing), refusal('CLOSED_SCHEMA'), `missing ${key}`);
    }
    assert.throws(() => validate({...make(), unknown: true}), refusal('CLOSED_SCHEMA'));
    for (const wrong of [null, [], 'record', 1, true]) {
      assert.throws(() => validate(wrong), refusal('CLOSED_SCHEMA'));
    }
  });
}

test('M1-01 all nested schema records reject unknown and missing fields', CAP, () => {
  const nested = [
    [makePlan, validatePlan, p => p.files[0]],
    [makePlan, validatePlan, p => p.criteria[0]],
    [makePlan, validatePlan, p => p.commands[0]],
    [makePlan, validatePlan, p => p.policy],
    [makePlan, validatePlan, p => p.policy.planner],
    [makeSubmission, validateSubmission, s => s.criteria[0]],
    [makeSubmission, validateSubmission, s => s.findings[0]],
    [makeAssignment, validateAssignment, a => a.actor],
    [makeAssignment, validateAssignment, a => a.binding],
    [makeResult, validateResult, r => r.actor],
    [makeResult, validateResult, r => r.binding],
    [makeResult, validateResult, r => r.submission],
    [makeFrozenEvidence, validateEvidence, e => e.binding],
    [makeFrozenEvidence, validateEvidence, e => e.details],
    [makeFrozenEvidence, validateEvidence, e => e.details.manifest[0]],
    [makeTestEvidence, validateEvidence, e => e.details],
    [makeTestEvidence, validateEvidence, e => e.details.inventory[0]],
  ];
  for (const [make, validate, select] of nested) {
    assert.deepEqual(validate(make()), make());
    const unknown = make(); select(unknown).unknown = true;
    assert.throws(() => validate(unknown), refusal('CLOSED_SCHEMA'));
    for (const key of Object.keys(select(make()))) {
      const missing = make(); delete select(missing)[key];
      assert.throws(() => validate(missing), refusal('CLOSED_SCHEMA'), `nested missing ${key}`);
    }
  }
});

test('M1-01 data descriptors are copied without executing accessors or toJSON', CAP, () => {
  let reads = 0;
  const get = () => {reads++; throw new Error('accessor executed');};
  const set = () => {reads++;};
  for (const descriptor of [{get}, {set}, {get, set}]) {
    const object = {};
    Object.defineProperty(object, 'value', {...descriptor, enumerable: true});
    assert.throws(() => ownedJson(object), refusal('INVALID_DESCRIPTOR'));
    const array = [1];
    Object.defineProperty(array, '0', {...descriptor, enumerable: true});
    assert.throws(() => ownedJson(array), refusal('INVALID_DESCRIPTOR'));
    const plan = makePlan();
    Object.defineProperty(plan, 'objective', {...descriptor, enumerable: true});
    assert.throws(() => validatePlan(plan), refusal('INVALID_DESCRIPTOR'));
  }
  assert.throws(() => ownedJson({toJSON() {reads++; return 'forged';}}), refusal('INVALID_JSON'));
  assert.equal(reads, 0);
  const valid = {};
  Object.defineProperty(valid, 'value', {value: 'owned', enumerable: true, writable: false});
  assert.deepEqual(ownedJson(valid), {value: 'owned'});
  const original = makePlan(), owned = validatePlan(original), bytes = canonicalize(owned);
  original.files[0].path = 'other.mjs'; original.commands[0].argv.push('--changed');
  assert.equal(canonicalize(owned), bytes);
});

test('M1-01 plain/null-prototype objects and dense arrays pass; exotic prototypes reject', CAP, () => {
  const nullObject = Object.assign(Object.create(null), {value: [null, true, false, 1, 'text']});
  assert.deepEqual(ownedJson(nullObject), {value: [null, true, false, 1, 'text']});
  const dangerousKeys = JSON.parse('{"__proto__":{"safe":true},"constructor":"data","prototype":null}');
  const owned = ownedJson(dangerousKeys);
  assert.equal(Object.getPrototypeOf(owned), Object.prototype);
  assert.equal(Object.hasOwn(owned, '__proto__'), true);
  assert.deepEqual(owned, dangerousKeys);
  class Record { constructor() {this.value = 1;} }
  class ArraySubclass extends Array {}
  for (const input of [new Record(), Object.create({value: 1}), new Date(0), new Map(), new Set(),
    /pattern/, new Number(1), new String('text'), new Uint8Array([1]), new ArraySubclass(1)]) {
    assert.throws(() => ownedJson(input), refusal('INVALID_PROTOTYPE'));
  }
  const array = [1]; Object.setPrototypeOf(array, null);
  assert.throws(() => ownedJson(array), refusal('INVALID_PROTOTYPE'));
});

test('M1-01 symbols, hidden properties, sparse arrays and custom array keys reject', CAP, () => {
  assert.deepEqual(ownedJson({items: [1, 2]}), {items: [1, 2]});
  for (const input of [{[Symbol('hidden')]: 1}, Object.assign([1], {[Symbol('hidden')]: 1})]) {
    assert.throws(() => ownedJson(input), refusal('INVALID_JSON'));
  }
  const hiddenObject = {}; Object.defineProperty(hiddenObject, 'hidden', {value: 1});
  assert.throws(() => ownedJson(hiddenObject), refusal('INVALID_DESCRIPTOR'));
  const hiddenIndex = [1]; Object.defineProperty(hiddenIndex, '0', {enumerable: false});
  assert.throws(() => ownedJson(hiddenIndex), refusal('INVALID_DESCRIPTOR'));
  for (const array of [Array(1), [1, , 3]]) {
    assert.throws(() => ownedJson(array), refusal('SPARSE_ARRAY'));
  }
  for (const key of ['extra', '01', '-1', '4294967295']) {
    const array = [1]; array[key] = 2;
    assert.throws(() => ownedJson(array), refusal('SPARSE_ARRAY'), key);
  }
  const hiddenArray = [1]; Object.defineProperty(hiddenArray, 'hidden', {value: 2});
  assert.throws(() => ownedJson(hiddenArray), refusal('SPARSE_ARRAY'));
  const maskedHole = Array(1); maskedHole.extra = 1;
  assert.throws(() => ownedJson(maskedHole), refusal('INVALID_DESCRIPTOR'));
});

test('M1-01 cycles reject but shared acyclic values are copied independently', CAP, () => {
  const shared = {leaf: [1]}, input = {left: shared, right: shared};
  const owned = ownedJson(input);
  assert.deepEqual(owned, input); assert.notEqual(owned.left, owned.right);
  const object = {}; object.self = object;
  const array = []; array.push(array);
  const indirect = {next: {}}; indirect.next.previous = indirect;
  for (const cyclic of [object, array, indirect]) {
    assert.throws(() => ownedJson(cyclic), refusal('CYCLIC_DATA'));
  }
  for (const invalid of [undefined, () => {}, Symbol('value'), 1n]) {
    assert.throws(() => ownedJson(invalid), refusal('INVALID_JSON'));
    assert.throws(() => ownedJson({nested: invalid}), refusal('INVALID_JSON'));
    assert.throws(() => ownedJson([invalid]), refusal('INVALID_JSON'));
  }
});

test('M1-01 finite safe integers preserve exact values; lossy numbers reject', CAP, () => {
  for (const value of [0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    assert.equal(ownedJson(value), value);
    assert.equal(canonicalize(value), String(value));
  }
  for (const value of [-0, NaN, Infinity, -Infinity, 0.1, Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
    assert.throws(() => ownedJson(value), refusal('INVALID_NUMBER'));
    assert.throws(() => ownedJson({value}), refusal('INVALID_NUMBER'));
  }
});

test('M1-01 Unicode is preserved without normalization; lone surrogates reject in keys and values', CAP, () => {
  for (const value of ['é', 'e\u0301', '雪', '😀', '\u0000\n\t', '\uD800\uDC00']) {
    assert.equal(ownedJson(value), value);
    assert.equal(JSON.parse(canonicalize({[value]: value}))[value], value);
  }
  assert.notEqual(digest('é'), digest('e\u0301'));
  for (const invalid of ['\uD800', '\uDC00', 'a\uD800b', '\uDC00\uD800', '\uD800\uD800']) {
    assert.throws(() => ownedJson(invalid), refusal('INVALID_UNICODE'));
    assert.throws(() => ownedJson({[invalid]: 'valid'}), refusal('INVALID_UNICODE'));
  }
});

test('M1-01 exact depth, node and canonical-byte boundaries refuse overflow', CAP, () => {
  assert.deepEqual(LIMITS, {depth: 16, nodes: 10000, bytes: 1048576, text: 16384});
  assert.equal(Object.isFrozen(LIMITS), true);
  const nested = depth => {let value = null; while (depth--) value = {next: value}; return value;};
  assert.deepEqual(ownedJson(nested(16)), nested(16));
  assert.throws(() => ownedJson(nested(17)), refusal('STRUCTURE_LIMIT'));
  assert.equal(ownedJson(Array(9999).fill(null)).length, 9999);
  assert.throws(() => ownedJson(Array(10000).fill(null)), refusal('STRUCTURE_LIMIT'));
  for (const value of ['a'.repeat(1048574), 'é'.repeat(524287), '\n'.repeat(524287)]) {
    const bytes = canonicalize(value);
    assert.equal(Buffer.byteLength(bytes, 'utf8'), 1048576);
    assert.throws(() => canonicalize(value + 'a'), refusal('ARTIFACT_TOO_LARGE'));
  }
  const object = {a: 'x'.repeat(1048568)};
  assert.equal(Buffer.byteLength(canonicalize(object), 'utf8'), 1048576);
  assert.throws(() => canonicalize({a: object.a + 'x'}), refusal('ARTIFACT_TOO_LARGE'));
  const largeKey = 'x'.repeat(1048569);
  assert.equal(Buffer.byteLength(canonicalize({[largeKey]: ''}), 'utf8'), 1048576);
  assert.throws(() => canonicalize({[largeKey + 'x']: ''}), refusal('ARTIFACT_TOO_LARGE'));
});

test('M1-02 canonical keys are lexicographic even for numeric names; array order remains significant', CAP, () => {
  const a = {z: [3, 2, 1], '2': 'two', '10': 'ten', a: {β: true, aa: null, A: false}};
  const b = {a: {A: false, aa: null, β: true}, '10': 'ten', '2': 'two', z: [3, 2, 1]};
  const expected = '{"10":"ten","2":"two","a":{"A":false,"aa":null,"β":true},"z":[3,2,1]}';
  assert.equal(canonicalize(a), expected);
  assert.equal(canonicalize(b), expected);
  assert.equal(digest(a), sha256(expected));
  assert.equal(digest(a), digest(b));
  assert.equal(same(a, b), true);
  assert.notEqual(digest(a), digest({...b, z: [1, 2, 3]}));
  assert.equal(same(a, {...b, z: [1, 2, 3]}), false);
  assert.notEqual(digest(' a '), digest('a'));
  assert.notEqual(digest('line\n'), digest('line\r\n'));
});

test('M1-01 IDs, digests and schema versions require exact unambiguous encodings', CAP, () => {
  for (const value of ['a', 'A_-09', 'x'.repeat(64)]) {
    assert.equal(validateActor({id: value, provider: value}).id, value);
  }
  for (const value of ['', 'x'.repeat(65), 'with space', '../id', 'a/b', 'é', 'id\n', 1, null]) {
    assert.throws(() => validateActor({id: value, provider: 'provider'}), refusal('INVALID_ID'));
    assert.throws(() => validateActor({id: 'actor', provider: value}), refusal('INVALID_ID'));
  }
  for (const key of ['projectId', 'baseline', 'environmentDigest']) {
    for (const value of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 1, null]) {
      const plan = makePlan(); plan[key] = value;
      assert.throws(() => validatePlan(plan), refusal('INVALID_DIGEST'), key);
    }
  }
  for (const version of [0, 2, '1', null]) {
    const plan = makePlan(); plan.schemaVersion = version;
    assert.throws(() => validatePlan(plan), refusal('SCHEMA_VERSION'));
  }
  assert.equal(validatePlan(makePlan()).schemaVersion, 1);
});

test('M1-01 declared paths accept relative Unicode names without claiming disk authority', CAP, () => {
  for (const path of ['src/file.mjs', 'tests/has space.test.mjs', '.config/file', 'a'.repeat(512),
    'conifer.txt', 'com0.txt', 'com10.txt', 'lpt10/file', 'é/file', 'e\u0301/file', '雪/😀.txt']) {
    assert.equal(relativePath(path), path);
  }
  for (const path of ['', '.', '..', './a', '../a', 'a/../b', 'a/./b', '/root', '//host/share',
    'a//b', 'a/', 'C:/file', 'C:relative', 'file:stream', 'a\\b', '\\\\host\\share',
    'a\u0000b', 'a\nb', 'a\tb', 'a\u007fb', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b',
    'a.', 'a ', 'dir./file', 'dir /file', 'a'.repeat(513)]) {
    assert.throws(() => relativePath(path), error => ['INVALID_PATH', 'INVALID_TEXT'].includes(error.code), path);
  }
  for (const device of ['CON', 'prn', 'Aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT9',
    'CONIN$', 'CONOUT$', 'COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³']) {
    for (const path of [device, `${device}.txt`, `folder/${device}/file`]) {
      assert.throws(() => relativePath(path), refusal('INVALID_PATH'), path);
    }
  }
});

test('M1-01 file declarations, protected tests and manifests reject duplicate/case-colliding paths', CAP, () => {
  const distinct = makePlan(); distinct.files.push({path: 'src/other.mjs', operation: 'edit', expectedHash: HASH});
  assert.equal(validatePlan(distinct).files.length, 2);
  const unicode = makePlan();
  unicode.files = ['é/file', 'e\u0301/file'].map(path => ({path, operation: 'create', expectedHash: null}));
  assert.equal(validatePlan(unicode).files.length, 2, 'paths are not silently Unicode-normalized');
  for (const path of ['src/fixture.mjs', 'SRC/FIXTURE.MJS']) {
    const plan = makePlan(); plan.files.push({...plan.files[0], path});
    assert.throws(() => validatePlan(plan), refusal('DUPLICATE_ID'));
  }
  for (const path of ['tests/existing.test.mjs', 'TESTS/EXISTING.TEST.MJS']) {
    const plan = makePlan(); plan.protectedTests.push(path);
    assert.throws(() => validatePlan(plan), refusal('DUPLICATE_ID'));
  }
  for (const path of ['src/fixture.mjs', 'SRC/FIXTURE.MJS']) {
    const evidence = makeFrozenEvidence(); evidence.details.manifest.push({...evidence.details.manifest[0], path});
    resealEvidence(evidence);
    assert.throws(() => validateEvidence(evidence), refusal('DUPLICATE_ID'));
  }
});

test('M1-01 narrative bounds count UTF-8 bytes and preserve content', CAP, () => {
  for (const value of ['x'.repeat(16384), 'é'.repeat(8192), '  exact text\n']) {
    const plan = makePlan(); plan.objective = value;
    assert.equal(validatePlan(plan).objective, value);
  }
  for (const value of ['', ' \t\n', 'x'.repeat(16385), 'é'.repeat(8193)]) {
    for (const apply of [p => {p.objective = value;}, p => {p.nonGoals = [value];},
      p => {p.criteria[0].description = value;}]) {
      const plan = makePlan(); apply(plan);
      assert.throws(() => validatePlan(plan), refusal('INVALID_TEXT'));
    }
    const submission = makeSubmission(); submission.findings[0].detail = value;
    assert.throws(() => validateSubmission(submission), refusal('INVALID_TEXT'));
  }
});

test('M1-01 plan list bounds accept the exact maximum and reject one additional item', CAP, () => {
  const limits = [
    ['files', 256, i => ({path: `src/file-${i}.mjs`, operation: 'create', expectedHash: null})],
    ['protectedTests', 256, i => `tests/test-${i}.mjs`],
    ['criteria', 128, i => ({id: `criterion-${i}`, description: 'Synthetic criterion', method: 'test'})],
    ['commands', 32, i => ({...makePlan().commands[0], id: `command-${i}`})],
    ['nonGoals', 64, i => `Non-goal ${i}`],
    ['testInventory', 128, i => `test-${i}`],
  ];
  for (const [key, max, make] of limits) {
    const plan = makePlan(); plan[key] = Array.from({length: max}, (_, i) => make(i));
    if (key === 'testInventory') plan.commands[0].inventory = [...plan.testInventory];
    assert.equal(validatePlan(plan)[key].length, max, key);
    plan[key].push(make(max));
    assert.throws(() => validatePlan(plan), refusal('INVALID_LIST'), key);
  }
  const emptyCriteria = makePlan(); emptyCriteria.criteria = [];
  assert.throws(() => validatePlan(emptyCriteria), refusal('MISSING_CRITERIA'));
  const emptyInventory = makePlan(); emptyInventory.testInventory = [];
  assert.throws(() => validatePlan(emptyInventory), refusal('MISSING_INVENTORY'));
});

test('M1-01 exact file operations, preconditions, criterion methods and two-correction budget', CAP, () => {
  for (const operation of ['create', 'replace', 'edit', 'delete']) {
    const plan = makePlan(); plan.files[0] = {path: 'file', operation, expectedHash: operation === 'create' ? null : HASH};
    assert.equal(validatePlan(plan).files[0].operation, operation);
    plan.files[0].expectedHash = operation === 'create' ? HASH : null;
    assert.throws(() => validatePlan(plan), refusal(operation === 'create' ? 'INVALID_PRECONDITION' : 'INVALID_DIGEST'));
  }
  for (const operation of ['write', 'append', 'CREATE', 'create ', '', null]) {
    const plan = makePlan(); plan.files[0].operation = operation;
    assert.throws(() => validatePlan(plan), refusal('INVALID_ENUM'));
  }
  for (const method of ['test', 'review', 'human']) {
    const plan = makePlan(); plan.criteria[0].method = method;
    assert.equal(validatePlan(plan).criteria[0].method, method);
  }
  for (const method of ['TEST', 'automatic', '', null]) {
    const plan = makePlan(); plan.criteria[0].method = method;
    assert.throws(() => validatePlan(plan), refusal('INVALID_ENUM'));
  }
  assert.equal(validatePlan(makePlan()).policy.correctionLimit, 2);
  for (const correctionLimit of [-1, 0, 1, 3, '2', null]) {
    const plan = makePlan(); plan.policy.correctionLimit = correctionLimit;
    assert.throws(() => validatePlan(plan), refusal('INVALID_BUDGET'));
  }
});

test('M1-01 approved commands retain exact executable, arguments, environment and bounded budgets', CAP, () => {
  for (const executable of ['/fixture/node', 'C:\\fixture\\node.exe', 'D:/fixture/node.exe']) {
    const plan = makePlan(); plan.commands[0].executable = executable;
    assert.equal(validatePlan(plan).commands[0].executable, executable);
  }
  for (const executable of ['node', './node', 'C:node']) {
    const plan = makePlan(); plan.commands[0].executable = executable;
    assert.throws(() => validatePlan(plan), refusal('EXECUTABLE_NOT_ABSOLUTE'));
  }
  for (const [key, values, invalid] of [
    ['cwd', ['frozen', 'scratch'], ['project', 'FROZEN', null]],
    ['timeoutMs', [1, 900000], [0, 900001, -1, '30000']],
    ['expectedExit', [0, 255], [-1, 256, '0']],
  ]) {
    for (const value of values) {
      const plan = makePlan(); plan.commands[0][key] = value;
      assert.equal(validatePlan(plan).commands[0][key], value);
    }
    for (const value of invalid) {
      const plan = makePlan(); plan.commands[0][key] = value;
      assert.throws(() => validatePlan(plan), refusal(key === 'cwd' ? 'INVALID_ENUM' : 'INVALID_INTEGER'));
    }
  }
  const argv = makePlan(); argv.commands[0].argv = Array(128).fill('');
  assert.equal(validatePlan(argv).commands[0].argv.length, 128);
  argv.commands[0].argv.push(''); assert.throws(() => validatePlan(argv), refusal('INVALID_LIST'));
  for (const argument of [null, 1, 'é'.repeat(8193)]) {
    const plan = makePlan(); plan.commands[0].argv = [argument];
    assert.throws(() => validatePlan(plan), refusal('INVALID_TEXT'));
  }
  const environment = makePlan();
  environment.commands[0].environment = Object.fromEntries(Array.from({length: 32}, (_, i) => [`VAR_${i}`, 'value']));
  assert.equal(Object.keys(validatePlan(environment).commands[0].environment).length, 32);
  environment.commands[0].environment.EXTRA = 'value';
  assert.throws(() => validatePlan(environment), refusal('INVALID_ENVIRONMENT'));
  for (const env of [null, [], {'bad-key': 'value'}, {lowercase: 'value'}, {'9INVALID': 'value'}]) {
    const plan = makePlan(); plan.commands[0].environment = env;
    assert.throws(() => validatePlan(plan), refusal('INVALID_ENVIRONMENT'));
  }
  const inventory = makePlan(); inventory.commands[0].inventory = Array.from({length: 128}, (_, i) => `test-${i}`);
  inventory.testInventory = [...inventory.commands[0].inventory];
  assert.equal(validatePlan(inventory).commands[0].inventory.length, 128);
  inventory.commands[0].inventory.push('overflow'); assert.throws(() => validatePlan(inventory), refusal('INVALID_LIST'));
  inventory.commands[0].inventory = []; assert.throws(() => validatePlan(inventory), refusal('MISSING_INVENTORY'));
});

test('M1-01/07 plan inventory is exactly the union of nonempty approved command inventories', CAP, () => {
  const complete = makePlan();
  complete.commands.push({...clone(complete.commands[0]), id: 'second-command', inventory: ['second-test']});
  complete.testInventory.push('second-test');
  assert.deepEqual(validatePlan(complete), complete);
  const reordered = clone(complete); reordered.testInventory.reverse();
  assert.deepEqual(validatePlan(reordered), reordered, 'inventory order does not change membership validity');
  assert.notEqual(planIdentity(reordered).inventoryDigest, planIdentity(complete).inventoryDigest);
  const commandOrder = clone(complete); commandOrder.commands.reverse();
  assert.notEqual(planIdentity(commandOrder).commandsDigest, planIdentity(complete).commandsDigest);
  for (const change of [p => {p.testInventory.push('unexecuted-test');},
    p => {p.commands[0].inventory.push('undeclared-test');},
    p => {p.testInventory[0] = 'wrong-test';}]) {
    const input = makePlan(); change(input);
    assert.throws(() => validatePlan(input), refusal('INVENTORY_MISMATCH'));
  }
  const noCommands = makePlan(); noCommands.commands = [];
  assert.throws(() => validatePlan(noCommands), refusal('MISSING_INVENTORY'));
});

test('M1-01 IDs and lists cannot silently duplicate criteria, commands, findings or evidence', CAP, () => {
  for (const key of ['criteria', 'commands', 'testInventory', 'nonGoals']) {
    const plan = makePlan(); assert.deepEqual(validatePlan(plan), plan);
    plan[key].push(clone(plan[key][0]));
    assert.throws(() => validatePlan(plan), refusal('DUPLICATE_ID'), key);
  }
  const plan = makePlan(); plan.commands[0].inventory.push(plan.commands[0].inventory[0]);
  assert.throws(() => validatePlan(plan), refusal('DUPLICATE_ID'));
  for (const key of ['criteria', 'findings', 'evidenceIds']) {
    const submission = makeSubmission(); assert.deepEqual(validateSubmission(submission), submission);
    submission[key].push(clone(submission[key][0]));
    assert.throws(() => validateSubmission(submission), refusal('DUPLICATE_ID'), key);
  }
});

test('M1-02 every plan identity leaf is content-sensitive and validated before hashing', CAP, () => {
  const changes = [
    ['job', p => {p.jobId = 'other-job';}], ['project', p => {p.projectId = OTHER_HASH;}],
    ['baseline', p => {p.baseline = OTHER_HASH;}], ['objective', p => {p.objective += ' Changed.';}],
    ['non-goal', p => {p.nonGoals[0] += ' Changed.';}], ['path', p => {p.files[0].path = 'src/other.mjs';}],
    ['operation/precondition', p => {p.files[0].operation = 'edit'; p.files[0].expectedHash = HASH;}],
    ['protected tests', p => {p.protectedTests[0] = 'tests/other.test.mjs';}],
    ['criterion id', p => {p.criteria[0].id = 'other-criterion';}],
    ['criterion description', p => {p.criteria[0].description += ' Changed.';}],
    ['criterion method', p => {p.criteria[0].method = 'review';}],
    ['command id', p => {p.commands[0].id = 'other-command';}],
    ['executable', p => {p.commands[0].executable = '/fixture/other-node';}],
    ['argv', p => {p.commands[0].argv[1] = 'tests/other.test.mjs';}],
    ['cwd', p => {p.commands[0].cwd = 'scratch';}],
    ['environment key', p => {p.commands[0].environment = {LC_ALL: 'C'};}],
    ['environment value', p => {p.commands[0].environment.LANG = 'C.UTF-8';}],
    ['timeout', p => {p.commands[0].timeoutMs++;}], ['expected exit', p => {p.commands[0].expectedExit = 1;}],
    ['command inventory', p => {p.commands[0].inventory[0] = 'other-test'; p.testInventory[0] = 'other-test';}],
    ['planner actor', p => {p.policy.planner.id = 'other-planner';}],
    ['planner provider', p => {p.policy.planner.provider = 'other-provider';}],
    ['implementer provider', p => {p.policy.implementerProvider = 'other-provider';}],
    ['test inventory', p => {p.testInventory.push('other-test'); p.commands[0].inventory.push('other-test');}],
    ['environment digest', p => {p.environmentDigest = OTHER_HASH;}],
  ];
  const plan = makePlan(), identity = planIdentity(plan);
  assert.deepEqual(identity, {planDigest: digest(plan), criteriaDigest: digest(plan.criteria),
    commandsDigest: digest(plan.commands), inventoryDigest: digest(plan.testInventory), environmentDigest: HASH});
  assert.equal(Object.isFrozen(identity), true);
  for (const [name, change] of changes) {
    const changed = makePlan(); change(changed);
    assert.deepEqual(validatePlan(changed), changed, name);
    assert.notEqual(planIdentity(changed).planDigest, identity.planDigest, name);
  }
  const editPlan = makePlan(); editPlan.files[0] = {path: 'src/fixture.mjs', operation: 'edit', expectedHash: HASH};
  const expectedHashChanged = clone(editPlan); expectedHashChanged.files[0].expectedHash = OTHER_HASH;
  assert.notEqual(planIdentity(editPlan).planDigest, planIdentity(expectedHashChanged).planDigest);
  const operationChanged = clone(editPlan); operationChanged.files[0].operation = 'replace';
  assert.notEqual(planIdentity(editPlan).planDigest, planIdentity(operationChanged).planDigest);
  const reordered = Object.fromEntries(Object.entries(plan).reverse());
  reordered.policy = Object.fromEntries(Object.entries(plan.policy).reverse());
  assert.deepEqual(planIdentity(reordered), identity);
  const wrongBudget = makePlan(); wrongBudget.policy.correctionLimit = 3;
  assert.throws(() => planIdentity(wrongBudget), refusal('INVALID_BUDGET'));
  const wrongSchema = makePlan(); wrongSchema.schemaVersion = 2;
  assert.throws(() => planIdentity(wrongSchema), refusal('SCHEMA_VERSION'));
});

test('M1-02 criteria and command digests are separate, not substitutes for the full plan', CAP, () => {
  const original = planIdentity(makePlan());
  const scope = makePlan(); scope.objective += ' Changed scope.';
  const scopeIdentity = planIdentity(scope);
  assert.notEqual(scopeIdentity.planDigest, original.planDigest);
  assert.equal(scopeIdentity.criteriaDigest, original.criteriaDigest);
  assert.equal(scopeIdentity.commandsDigest, original.commandsDigest);
  const criteria = makePlan(); criteria.criteria[0].description += ' Changed criterion.';
  const criteriaIdentity = planIdentity(criteria);
  assert.notEqual(criteriaIdentity.criteriaDigest, original.criteriaDigest);
  assert.notEqual(criteriaIdentity.planDigest, original.planDigest);
  assert.equal(criteriaIdentity.commandsDigest, original.commandsDigest);
  const command = makePlan(); command.commands[0].argv.push('--fixture');
  const commandIdentity = planIdentity(command);
  assert.notEqual(commandIdentity.commandsDigest, original.commandsDigest);
  assert.notEqual(commandIdentity.planDigest, original.planDigest);
  assert.equal(commandIdentity.criteriaDigest, original.criteriaDigest);
  const inventory = makePlan(); inventory.testInventory.push('other-test'); inventory.commands[0].inventory.push('other-test');
  assert.notEqual(planIdentity(inventory).inventoryDigest, original.inventoryDigest);
  assert.deepEqual(bindingFor(makePlan()), {...original, candidateDigest: null});
  assert.deepEqual(bindingFor(makePlan(), HASH), {...original, candidateDigest: HASH});
  assert.notEqual(digest(bindingFor(makePlan(), HASH)), digest(bindingFor(makePlan(), OTHER_HASH)));
});

test('M1-03/05 submissions contain judgments only, never authoritative metadata or legacy prose', CAP, () => {
  const valid = makeSubmission(); assert.deepEqual(validateSubmission(valid), valid);
  for (const [key, value] of Object.entries({actor: {id: 'trusted', provider: 'trusted'}, provider: 'trusted',
    jobId: 'job', projectId: HASH, stage: 'review', role: 'reviewer', generation: 1,
    planDigest: HASH, candidateDigest: HASH, binding: bindingFor(makePlan()), assignmentId: 'assignment',
    outcome: 'completed-pass', completed: true, status: 'completed', decision: 'authorize',
    provenance: PROVENANCE, trusted: true, source: 'host-verified'})) {
    assert.throws(() => validateSubmission({...makeSubmission(), [key]: value}), refusal('CLOSED_SCHEMA'), key);
  }
  for (const input of ['APPROVED: implement now.', '# Review\nPASS',
    {verdict: 'pass', approved: true}, {kind: 'm0-live-report', checks: []}]) {
    assert.throws(() => validateSubmission(input), refusal('CLOSED_SCHEMA'));
  }
  assert.deepEqual(validateSubmission({criteria: [], findings: [], evidenceIds: []}),
    {criteria: [], findings: [], evidenceIds: []}, 'schema alone does not prove criterion completeness');
});

test('M1-01/05 submission bounds and closed disposition/finding enumerations', CAP, () => {
  for (const [key, max, make] of [
    ['criteria', 128, i => ({id: `criterion-${i}`, outcome: 'pass'})],
    ['findings', 256, i => ({...makeSubmission().findings[0], id: `finding-${i}`})],
    ['evidenceIds', 1024, i => `evidence-${i}`],
  ]) {
    const input = makeSubmission(); input[key] = Array.from({length: max}, (_, i) => make(i));
    assert.equal(validateSubmission(input)[key].length, max);
    input[key].push(make(max)); assert.throws(() => validateSubmission(input), refusal('INVALID_LIST'));
  }
  for (const outcome of ['pass', 'fail', 'unknown', 'skip']) {
    const input = makeSubmission(); input.criteria[0].outcome = outcome;
    assert.equal(validateSubmission(input).criteria[0].outcome, outcome);
  }
  for (const [key, valid, invalid] of [
    ['severity', ['blocker', 'note'], ['warning', 'BLOCKER', '']],
    ['status', ['open', 'resolved'], ['closed', 'ignored', '']],
  ]) {
    for (const value of valid) {
      const input = makeSubmission(); input.findings[0][key] = value;
      assert.equal(validateSubmission(input).findings[0][key], value);
    }
    for (const value of invalid) {
      const input = makeSubmission(); input.findings[0][key] = value;
      assert.throws(() => validateSubmission(input), refusal('INVALID_ENUM'));
    }
  }
  for (const outcome of ['PASS', 'pending', 'todo', 'approved', true]) {
    const input = makeSubmission(); input.criteria[0].outcome = outcome;
    assert.throws(() => validateSubmission(input), refusal('INVALID_ENUM'));
  }
});

test('M1-05 assignment/result roles, generations and human decisions have closed enums', CAP, () => {
  for (const role of ['plan-review', 'author', 'validator', 'reviewer']) {
    const assignment = makeAssignment(); assignment.role = role;
    assert.equal(validateAssignment(assignment).role, role);
  }
  for (const role of ['plan-review', 'validator', 'reviewer']) {
    const result = makeResult(); result.role = role;
    assert.equal(validateResult(result).role, role);
  }
  for (const [make, validate] of [[makeAssignment, validateAssignment], [makeResult, validateResult]]) {
    for (const role of ['implementer', 'human', 'REVIEWER', '']) {
      const input = make(); input.role = role;
      assert.throws(() => validate(input), refusal('INVALID_ENUM'));
    }
  }
  const authorResult = makeResult(); authorResult.role = 'author';
  assert.throws(() => validateResult(authorResult), refusal('INVALID_ENUM'));
  for (const [make, validate] of [[makeAssignment, validateAssignment], [makeDecision, validateDecision], [makeResult, validateResult]]) {
    for (const generation of [1, Number.MAX_SAFE_INTEGER]) {
      const input = make(); input.generation = generation;
      assert.equal(validate(input).generation, generation);
    }
    for (const generation of [0, -1, '1', null]) {
      const input = make(); input.generation = generation;
      assert.throws(() => validate(input), refusal('INVALID_INTEGER'));
    }
  }
  for (const decision of ['authorize', 'reject']) {
    const input = makeDecision(); input.decision = decision;
    assert.equal(validateDecision(input).decision, decision);
  }
  for (const decision of ['accepted', 'approve', 'AUTHORIZED', true]) {
    const input = makeDecision(); input.decision = decision;
    assert.throws(() => validateDecision(input), refusal('INVALID_ENUM'));
  }
});

test('M1-05 results preserve every terminal failure state and exclude pending/streaming metadata', CAP, () => {
  for (const outcome of ['completed-pass', 'completed-fail', 'cancelled', 'error', 'inconclusive']) {
    const result = makeResult(); result.outcome = outcome;
    if (outcome === 'completed-fail') result.submission.criteria[0].outcome = 'fail';
    const owned = validateResult(result);
    assert.deepEqual(owned, result);
    assert.equal(owned.outcome === 'completed-pass', outcome === 'completed-pass');
  }
  for (const outcome of ['pending', 'streaming', 'pass', 'completed', 'COMPLETED-PASS', true]) {
    const result = makeResult(); result.outcome = outcome;
    assert.throws(() => validateResult(result), refusal('INVALID_ENUM'));
  }
  for (const metadata of [{completed: true}, {settled: true}, {execution: {}}, {trusted: true}]) {
    assert.throws(() => validateResult({...makeResult(), ...metadata}), refusal('CLOSED_SCHEMA'));
  }
});

test('M1-02/07 every binding field is mandatory, exact and content-sensitive across owned records', CAP, () => {
  for (const [make, validate] of [[makeAssignment, validateAssignment], [makeResult, validateResult],
    [makeFrozenEvidence, validateEvidence], [makeTestEvidence, validateEvidence]]) {
    const input = make(), baseline = validate(input);
    assert.deepEqual(baseline.binding, input.binding);
    for (const key of Object.keys(input.binding)) {
      const missing = make(); delete missing.binding[key];
      assert.throws(() => validate(missing), refusal('CLOSED_SCHEMA'), key);
      const malformed = make(); malformed.binding[key] = 'not-a-digest';
      assert.throws(() => validate(malformed), refusal('INVALID_DIGEST'), key);
      const changed = make(); changed.binding[key] = OTHER_HASH;
      if (changed.kind === 'frozen' && ['candidateDigest', 'inventoryDigest'].includes(key)) {
        assert.throws(() => validate(changed), refusal(key === 'candidateDigest' ? 'EVIDENCE_DIGEST_MISMATCH' : 'INVENTORY_MISMATCH'));
      } else {
        assert.equal(validate(changed).binding[key], OTHER_HASH);
        assert.notEqual(digest(changed), digest(baseline), key);
      }
    }
  }
  const assignment = makeAssignment(); assignment.binding.candidateDigest = null;
  assert.equal(validateAssignment(assignment).binding.candidateDigest, null, 'pre-candidate plan review is representable');
});

test('M1-02/07 frozen evidence binds complete manifest bytes and exact inventory', CAP, () => {
  const original = makeFrozenEvidence(); assert.deepEqual(validateEvidence(original), original);
  for (const change of [e => {e.details.manifest[0].path = 'src/other.mjs';},
    e => {e.details.manifest[0].sha256 = OTHER_HASH;}, e => {e.details.manifest[0].mode = 493;},
    e => {e.details.manifest.push({path: 'src/second.mjs', sha256: HASH, operation: 'present', mode: 420});},
    e => {e.details.manifest[0].operation = 'deleted'; e.details.manifest[0].sha256 = null;}]) {
    const changed = makeFrozenEvidence(); change(changed);
    assert.throws(() => validateEvidence(changed), refusal('EVIDENCE_DIGEST_MISMATCH'));
    resealEvidence(changed);
    assert.deepEqual(validateEvidence(changed), changed, 'changed bytes need a distinct complete identity');
    assert.notEqual(changed.contentDigest, original.contentDigest);
    assert.notEqual(changed.binding.candidateDigest, original.binding.candidateDigest);
  }
  const wrongInventory = makeFrozenEvidence(); wrongInventory.details.inventory.push('other-test');
  assert.throws(() => validateEvidence(wrongInventory), refusal('INVENTORY_MISMATCH'));
  wrongInventory.binding.inventoryDigest = digest(wrongInventory.details.inventory);
  assert.deepEqual(validateEvidence(wrongInventory), wrongInventory);
  const wrongCandidate = makeFrozenEvidence(); wrongCandidate.binding.candidateDigest = null;
  assert.throws(() => validateEvidence(wrongCandidate), refusal('EVIDENCE_DIGEST_MISMATCH'));
  const wrongContent = makeFrozenEvidence(); wrongContent.contentDigest = OTHER_HASH;
  assert.throws(() => validateEvidence(wrongContent), refusal('EVIDENCE_DIGEST_MISMATCH'));
});

test('M1-01/07 frozen manifest limits, modes and deletion preconditions are closed', CAP, () => {
  const evidence = makeFrozenEvidence();
  evidence.details.manifest = Array.from({length: 256}, (_, i) => ({path: `src/file-${i}`, sha256: HASH, operation: 'present', mode: 420}));
  resealEvidence(evidence); assert.equal(validateEvidence(evidence).details.manifest.length, 256);
  evidence.details.manifest.push({path: 'overflow', sha256: HASH, operation: 'present', mode: 420});
  resealEvidence(evidence); assert.throws(() => validateEvidence(evidence), refusal('INVALID_LIST'));
  for (const mode of [0, 511]) {
    const input = makeFrozenEvidence(); input.details.manifest[0].mode = mode; resealEvidence(input);
    assert.equal(validateEvidence(input).details.manifest[0].mode, mode);
  }
  for (const [key, value, code] of [['mode', -1, 'INVALID_INTEGER'], ['mode', 512, 'INVALID_INTEGER'],
    ['mode', '420', 'INVALID_INTEGER'], ['operation', 'create', 'INVALID_ENUM'],
    ['sha256', null, 'INVALID_DIGEST']]) {
    const input = makeFrozenEvidence(); input.details.manifest[0][key] = value; resealEvidence(input);
    assert.throws(() => validateEvidence(input), refusal(code));
  }
  const deleted = makeFrozenEvidence(); deleted.details.manifest[0].operation = 'deleted';
  deleted.details.manifest[0].sha256 = null; resealEvidence(deleted);
  assert.equal(validateEvidence(deleted).details.manifest[0].sha256, null);
  deleted.details.manifest[0].sha256 = HASH; resealEvidence(deleted);
  assert.throws(() => validateEvidence(deleted), refusal('INVALID_DIGEST'));
});

test('M1-07 test evidence binds command, exit, full logs, inventory and settlement bytes', CAP, () => {
  const original = makeTestEvidence(); assert.deepEqual(validateEvidence(original), original);
  const changes = [
    ['command ID', e => {e.details.commandId = 'other-command';}],
    ['command digest', e => {e.details.commandDigest = OTHER_HASH;}],
    ['expected exit', e => {e.details.expectedExit = 1;}],
    ['actual exit', e => {e.details.actualExit = 1;}],
    ['absent exit', e => {e.details.actualExit = null;}],
    ['stdout', e => {e.details.stdoutDigest = OTHER_HASH;}],
    ['stderr', e => {e.details.stderrDigest = HASH;}],
    ['incomplete logs', e => {e.details.captureComplete = false;}],
    ['inventory ID', e => {e.details.inventory[0].id = 'other-test';}],
    ['failed inventory', e => {e.details.inventory[0].outcome = 'fail';}],
    ['skipped inventory', e => {e.details.inventory[0].outcome = 'skip';}],
    ['todo inventory', e => {e.details.inventory[0].outcome = 'todo';}],
    ['unknown inventory', e => {e.details.inventory[0].outcome = 'unknown';}],
    ['unsettled', e => {e.details.managedSettled = false;}],
  ];
  for (const [name, change] of changes) {
    const changed = makeTestEvidence(); change(changed);
    assert.throws(() => validateEvidence(changed), refusal('EVIDENCE_DIGEST_MISMATCH'), name);
    resealEvidence(changed);
    assert.deepEqual(validateEvidence(changed), changed, `${name} is recorded honestly, not silently passed`);
    assert.notEqual(changed.contentDigest, original.contentDigest, name);
  }
  for (const status of ['completed', 'failed', 'pending']) {
    for (const make of [makeFrozenEvidence, makeTestEvidence]) {
      const evidence = make(); evidence.status = status;
      assert.equal(validateEvidence(evidence).status, status);
      if (status !== 'completed') assert.notEqual(digest(evidence), digest(make()));
    }
  }
  const foreign = makeTestEvidence(); foreign.assignmentId = 'foreign-assignment';
  assert.equal(validateEvidence(foreign).assignmentId, 'foreign-assignment');
  assert.notEqual(digest(foreign), digest(original), 'assignment association is part of the record identity');
});

test('M1-01/07 test evidence rejects invented kinds, statuses, outcomes and malformed receipt fields', CAP, () => {
  assert.deepEqual(validateEvidence(makeTestEvidence()), makeTestEvidence());
  for (const [key, value] of [['kind', 'legacy-report'], ['kind', 'TEST'], ['status', 'passed'],
    ['status', 'streaming'], ['status', true]]) {
    const input = makeTestEvidence(); input[key] = value;
    assert.throws(() => validateEvidence(input), refusal('INVALID_ENUM'));
  }
  for (const [key, value, code] of [
    ['expectedExit', null, 'INVALID_INTEGER'], ['expectedExit', 256, 'INVALID_INTEGER'],
    ['actualExit', -1, 'INVALID_INTEGER'], ['actualExit', 256, 'INVALID_INTEGER'],
    ['actualExit', '0', 'INVALID_INTEGER'], ['captureComplete', 1, 'INVALID_BOOLEAN'],
    ['managedSettled', 'true', 'INVALID_BOOLEAN'], ['commandDigest', '', 'INVALID_DIGEST'],
    ['stdoutDigest', null, 'INVALID_DIGEST'], ['stderrDigest', 'x'.repeat(64), 'INVALID_DIGEST'],
  ]) {
    const input = makeTestEvidence(); input.details[key] = value; resealEvidence(input);
    assert.throws(() => validateEvidence(input), refusal(code), key);
  }
  const unknownOutcome = makeTestEvidence(); unknownOutcome.details.inventory[0].outcome = 'PASS';
  resealEvidence(unknownOutcome); assert.throws(() => validateEvidence(unknownOutcome), refusal('INVALID_ENUM'));
  const duplicate = makeTestEvidence(); duplicate.details.inventory.push({...duplicate.details.inventory[0]});
  resealEvidence(duplicate); assert.throws(() => validateEvidence(duplicate), refusal('DUPLICATE_ID'));
  for (const extra of [{path: '/untrusted/receipt.json'}, {rawLogPath: 'log.txt'}, {completed: true}, {trusted: true}]) {
    assert.throws(() => validateEvidence({...makeTestEvidence(), ...extra}), refusal('CLOSED_SCHEMA'));
  }
  for (const make of [makeFrozenEvidence, makeTestEvidence]) {
    const input = make();
    input.details.inventory = Array.from({length: 128}, (_, i) => input.kind === 'frozen' ? `test-${i}` : {id: `test-${i}`, outcome: 'pass'});
    if (input.kind === 'frozen') input.binding.inventoryDigest = digest(input.details.inventory);
    resealEvidence(input); assert.equal(validateEvidence(input).details.inventory.length, 128);
    input.details.inventory.push(input.kind === 'frozen' ? 'overflow' : {id: 'overflow', outcome: 'pass'});
    if (input.kind === 'frozen') input.binding.inventoryDigest = digest(input.details.inventory);
    resealEvidence(input); assert.throws(() => validateEvidence(input), refusal('INVALID_LIST'));
  }
});

test('M1-03/15/16 fixture provenance survives JSON round-trip but cannot be forged as trusted', CAP, () => {
  assert.equal(PROVENANCE, 'fixture-untrusted');
  for (const [make, validate] of [[makeDecision, validateDecision], [makeAssignment, validateAssignment],
    [makeResult, validateResult], [makeFrozenEvidence, validateEvidence], [makeTestEvidence, validateEvidence]]) {
    const original = make(), owned = validate(original);
    assert.equal(owned.provenance, 'fixture-untrusted');
    const reopened = validate(JSON.parse(canonicalize(owned)));
    assert.deepEqual(reopened, original); assert.equal(reopened.provenance, 'fixture-untrusted');
    for (const provenance of ['trusted', 'host-verified', 'human-verified', 'fixture-trusted',
      'FIXTURE-UNTRUSTED', '', null, true, {}]) {
      const forged = make(); forged.provenance = provenance;
      assert.throws(() => validate(forged), refusal('UNTRUSTED_PROVENANCE'));
    }
    const missing = make(); delete missing.provenance;
    assert.throws(() => validate(missing), refusal('CLOSED_SCHEMA'));
  }
});

// M3 additions: unchanged v1 prefix remains the fixture compatibility boundary.
import {V2_PROVENANCE,validatePlanV2,validateExecutionPolicyV2,planIdentityV2,bindingForV2,
  validateActorV2,validateAssignmentV2,validateEvidenceV2,validateCandidateDescriptorV2,validateStateV2,diagnosticFactsReadyV2} from '../src/governance/contracts.mjs';
function m3ContractPlan(){const p=makePlan();p.schemaVersion=2;p.protectedTests=['test.mjs'];p.commands=[{id:'unit',executable:process.execPath,argv:['--test','--test-isolation=none','--test-reporter=tap','test.mjs'],cwd:'frozen',environment:{SYSTEMROOT:'C:\\Windows'},timeoutMs:1000,expectedExit:0,inventory:['fixture-test']}];p.executionPolicy={schemaVersion:1,routes:{'plan-review':{provider:'review-provider',model:'fixture',effort:'low'},author:{provider:'author-provider',model:'fixture',effort:'low'},validator:{provider:'validator-provider',model:'fixture',effort:'low'},reviewer:{provider:'review-provider',model:'fixture',effort:'low'}},node:{executable:process.execPath,sha256:HASH,version:process.version,systemRoot:'C:\\Windows'},enforcement:'guarded-native-trusted-code',settlementGraceMs:1000,testFiles:[{path:'test.mjs',sha256:HASH}],environmentRecipe:'systemroot-owned-temp-v1'};p.environmentDigest=digest({node:p.executionPolicy.node,enforcement:p.executionPolicy.enforcement,environmentRecipe:p.executionPolicy.environmentRecipe});return p;}
test('M3-01 v2 plan binds exact execution policy while v1 remains fixture-only',()=>{
  const p=m3ContractPlan(),owned=validatePlanV2(p);assert.equal(Object.isFrozen(owned.executionPolicy.routes.author),true);assert.equal(planIdentityV2(p).executionPolicyDigest,digest(p.executionPolicy));assert.equal(bindingForV2(p).candidateDigest,null);assert.throws(()=>validatePlan(p),{code:'CLOSED_SCHEMA'});assert.throws(()=>validatePlanV2(makePlan()));
  for(const change of [p=>p.executionPolicy.enforcement='unconfined',p=>p.executionPolicy.routes.reviewer.provider='author-provider',p=>p.commands[0].argv=['-e','attack'],p=>p.executionPolicy.testFiles[0].path='other.mjs',p=>p.environmentDigest=OTHER_HASH,p=>p.commands[0].environment.NODE_OPTIONS='--import=bad']){const bad=m3ContractPlan();change(bad);assert.throws(()=>validatePlanV2(bad));}
});
test('M3-02 actual actor and complete v2 assignment have closed route identities',()=>{
  const p=m3ContractPlan(),a={schemaVersion:2,provenance:V2_PROVENANCE,id:'assignment',actor:{id:'actor',...p.executionPolicy.routes.author},role:'author',generation:2,binding:bindingForV2(p)};assert.deepEqual(validateAssignmentV2(a),a);
  assert.throws(()=>validateActorV2({id:'actor',provider:'author-provider'}));assert.throws(()=>validateAssignmentV2({...a,provenance:PROVENANCE}));assert.throws(()=>validateAssignmentV2({...a,actor:{...a.actor,approved:true}}));
});
test('M3-10 invalid capture cannot invent raw stream digests',()=>{
  const p=m3ContractPlan(),details={commandId:'unit',commandDigest:digest(p.commands[0]),expectedExit:0,actualExit:null,stdoutDigest:null,stderrDigest:null,captureComplete:false,inventory:[],managedSettled:true,enforcement:'partial',deadlineFired:true,signal:null,logArtifacts:[]};const e={schemaVersion:2,provenance:V2_PROVENANCE,id:'e',kind:'test',assignmentId:'a',generation:2,binding:bindingForV2(p,HASH),status:'failed',contentDigest:digest(details),artifactHash:HASH,details};assert.deepEqual(validateEvidenceV2(e),e);assert.throws(()=>validateEvidenceV2({...e,status:'completed'}));assert.throws(()=>validateEvidenceV2({...e,details:{...details,captureComplete:true}}));
});
test('M3-01 owner-facing closed v2 schemas refuse getters without invocation',()=>{
  let count=0;const p=m3ContractPlan();Object.defineProperty(p.executionPolicy,'node',{enumerable:true,get(){count++;return {};}});assert.throws(()=>validatePlanV2(p),{code:'INVALID_DESCRIPTOR'});assert.equal(count,0);
});
test('M3-08 descriptor independently bounds 256 present and 256 deleted files',()=>{
  const p=m3ContractPlan(),row=(prefix,i,kind='file')=>({path:prefix+String(i).padStart(3,'0'),kind,bytes:1,sha256:HASH,gitMode:'100644'}),files=Array.from({length:256},(_,i)=>row('a',i)),deletions=Array.from({length:256},(_,i)=>row('d',i,'deleted'));
  const body={schemaVersion:2,provenance:V2_PROVENANCE,jobId:p.jobId,projectId:p.projectId,assignmentId:'author',attempt:0,generation:2,revision:5,...planIdentityV2(p),baselineDigest:p.baseline,commit:'a'.repeat(40),objectFormat:'sha1',git:{sha256:HASH,version:'git version fixture'},files,deletions,changes:[...files.map(after=>({path:after.path,operation:'create',before:null,after})),...deletions.map(d=>({path:d.path,operation:'delete',before:{...d,kind:'file'},after:null}))]};const descriptor={...body,candidateDigest:digest(body)};assert.equal(validateCandidateDescriptorV2(descriptor).changes.length,512);
  const oversized={...body,files:[...files,row('a',256)]};assert.throws(()=>validateCandidateDescriptorV2({...oversized,candidateDigest:digest(oversized)}),{code:'INVALID_LIST'});
});
test('M3-06 passing judgments without all current producer references never ready',()=>{
  const p=m3ContractPlan(),header={schemaVersion:2,provenance:V2_PROVENANCE},a=(role,generation,candidateDigest)=>({...header,id:role,actor:{id:role,...p.executionPolicy.routes[role]},role,generation,binding:bindingForV2(p,candidateDigest)}),assignments=[a('plan-review',1,null),a('author',2,null),a('validator',2,HASH),a('reviewer',2,HASH)];
  const submission=ids=>({criteria:[{id:'criterion-1',outcome:'pass'}],findings:[],evidenceIds:ids}),result=(assignment,ids)=>{const s=submission(ids);return {...header,id:'r-'+assignment.id,assignmentId:assignment.id,actor:assignment.actor,role:assignment.role,generation:assignment.generation,binding:assignment.binding,outcome:'completed-pass',submission:s,submissionArtifactHash:digest(s)};};
  const frozen={...header,id:'frozen',kind:'frozen',assignmentId:'author',generation:2,binding:bindingForV2(p,HASH),status:'completed',contentDigest:HASH,artifactHash:HASH,details:{descriptorArtifactHash:HASH,producerAssignmentId:'author',stage:'frozen'}};
  const details={commandId:'unit',commandDigest:digest(p.commands[0]),expectedExit:0,actualExit:0,stdoutDigest:HASH,stderrDigest:HASH,captureComplete:true,inventory:[{id:'fixture-test',outcome:'pass'}],managedSettled:true,enforcement:'partial',deadlineFired:false,signal:null,logArtifacts:[]},evidence={...header,id:'test',kind:'test',assignmentId:'validator',generation:2,binding:bindingForV2(p,HASH),status:'completed',contentDigest:digest(details),artifactHash:HASH,details};
  const state={...header,jobId:p.jobId,projectId:p.projectId,revision:12,generation:2,phase:'REVIEWING',planGeneration:1,plan:p,attempts:[{index:0,assignmentId:'author',planDigest:digest(p)}],authors:[assignments[1].actor],assignments,results:[result(assignments[0],[]),result(assignments[1],[]),result(assignments[2],['frozen','test']),result(assignments[3],['frozen','test'])],evidence:[frozen,evidence],decision:{...header,id:'human',planDigest:digest(p),reviewResultId:'r-plan-review',generation:1,decision:'authorize'},candidate:HASH,action:{type:'RESULT_RECORDED'}};
  assert.equal(diagnosticFactsReadyV2(state),true);for(const role of ['validator','reviewer']){const missing=clone(state),r=missing.results.find(r=>r.role===role);r.submission.evidenceIds=['frozen'];r.submissionArtifactHash=digest(r.submission);assert.equal(diagnosticFactsReadyV2(missing),false);}const foreign=clone(state);foreign.evidence[1].assignmentId='reviewer';assert.throws(()=>validateStateV2(foreign),{code:'EVIDENCE_ASSIGNMENT_MISMATCH'});
});

import {validateControlRecordM4,validateControlBindingM4,validateTransitionV2,validateReadRequestM4,validateResumeRequestM4,boundedResponseM4} from '../src/governance/contracts.mjs';
function m4AuthorizedContractState(){const p=m3ContractPlan(),h={schemaVersion:2,provenance:V2_PROVENANCE},a={...h,id:'review',actor:{id:'review',...p.executionPolicy.routes['plan-review']},role:'plan-review',generation:1,binding:bindingForV2(p)},submission={criteria:[{id:'criterion-1',outcome:'pass'}],findings:[],evidenceIds:[]},r={...h,id:'result',assignmentId:a.id,actor:a.actor,role:a.role,generation:1,binding:a.binding,outcome:'completed-pass',submission,submissionArtifactHash:digest(submission)};return {...h,jobId:p.jobId,projectId:p.projectId,revision:4,generation:1,phase:'PLAN_AUTHORIZED',planGeneration:1,plan:p,attempts:[],authors:[],assignments:[a],results:[r],evidence:[],decision:{...h,id:'human',planDigest:digest(p),reviewResultId:r.id,generation:1,decision:'authorize'},candidate:null,action:{type:'HUMAN_DECIDED'}};}
test('M4 closed control transition changes only revision/action with exactly one bound artifact',()=>{
  const before=m4AuthorizedContractState(),after={...before,revision:5,action:{type:'CONTROL_RECORDED'}},record={schemaVersion:1,kind:'pause',id:'record',checkpointDigest:HASH,ownerId:'owner',epoch:1,priorHeadDigest:OTHER_HASH,planDigest:digest(before.plan),decisionDigest:digest(before.decision),attemptsDigest:digest(before.attempts),attemptsUsed:0,nextAction:'author'};
  assert.deepEqual(validateControlBindingM4(before,after,OTHER_HASH,[record]),record);for(const artifacts of [[],[record,record]])assert.throws(()=>validateControlBindingM4(before,after,OTHER_HASH,artifacts),{code:'CONTROL_ARTIFACT_REQUIRED'});assert.throws(()=>validateControlBindingM4(before,after,HASH,[record]),{code:'CONTROL_BINDING_MISMATCH'});
  for(const changed of [{phase:'AUTHORING'},{candidate:HASH},{generation:2}])assert.throws(()=>validateTransitionV2(before,'CONTROL_RECORDED',{...after,...changed}));for(const phase of ['PLANNING','FROZEN','VALIDATING','REVIEWING','DIAGNOSTIC_READY'])assert.throws(()=>validateTransitionV2({...before,phase},'CONTROL_RECORDED',{...after,phase}),{code:'INVALID_CONTROL_PHASE'});assert.throws(()=>validateTransitionV2(before,'UNKNOWN_CONTROL',{...after,action:{type:'UNKNOWN_CONTROL'}}),{code:'UNKNOWN_EVENT_TYPE'});
});
test('M4 closed read and resume requests reject surplus fields and oversized pages',()=>{
  const request={kind:'history',id:null,offset:0,limit:64,cursor:null};assert.deepEqual(validateReadRequestM4(request),request);assert.throws(()=>validateReadRequestM4({...request,limit:65}),{code:'INVALID_INTEGER'});assert.throws(()=>validateReadRequestM4({...request,offset:1}),{code:'CURSOR_REQUIRED'});assert.throws(()=>validateReadRequestM4({...request,path:'C:/secret'}),{code:'CLOSED_SCHEMA'});assert.throws(()=>boundedResponseM4({text:'x'.repeat(16384)}),{code:'READ_RESPONSE_TOO_LARGE'});assert.deepEqual(validateResumeRequestM4({checkpointDigest:HASH,nextAction:'author'}),{checkpointDigest:HASH,nextAction:'author'});assert.throws(()=>validateResumeRequestM4({checkpointDigest:HASH,nextAction:'validate'}),{code:'INVALID_NEXT_ACTION'});assert.throws(()=>validateControlRecordM4({trusted:true}));
});

// Stage 6 slice A1: the pure nine-predicate acceptance evaluator.
import {evaluateAcceptanceV2} from '../src/governance/contracts.mjs';
const A1_FACTS={custodyVerified:true,journalHealthy:true,scopeClean:true,identityRecheck:true};
function a1Base(plan=m3ContractPlan()){
  const p=plan,header={schemaVersion:2,provenance:V2_PROVENANCE};
  const a=(role,generation,candidateDigest)=>({...header,id:role,actor:{id:role,...p.executionPolicy.routes[role]},role,generation,binding:bindingForV2(p,candidateDigest)}),assignments=[a('plan-review',1,null),a('author',2,null),a('validator',2,HASH),a('reviewer',2,HASH)];
  const submission=(ids,findings=[])=>({criteria:p.criteria.map(c=>({id:c.id,outcome:'pass'})),findings,evidenceIds:ids}),result=(assignment,ids,findings=[])=>{const s=submission(ids,findings);return {...header,id:'r-'+assignment.id,assignmentId:assignment.id,actor:assignment.actor,role:assignment.role,generation:assignment.generation,binding:assignment.binding,outcome:'completed-pass',submission:s,submissionArtifactHash:digest(s)};};
  const frozen={...header,id:'frozen',kind:'frozen',assignmentId:'author',generation:2,binding:bindingForV2(p,HASH),status:'completed',contentDigest:HASH,artifactHash:HASH,details:{descriptorArtifactHash:HASH,producerAssignmentId:'author',stage:'frozen'}};
  const details={commandId:'unit',commandDigest:digest(p.commands[0]),expectedExit:0,actualExit:0,stdoutDigest:HASH,stderrDigest:HASH,captureComplete:true,inventory:[{id:'fixture-test',outcome:'pass'}],managedSettled:true,enforcement:'partial',deadlineFired:false,signal:null,logArtifacts:[]},evidence={...header,id:'test',kind:'test',assignmentId:'validator',generation:2,binding:bindingForV2(p,HASH),status:'completed',contentDigest:digest(details),artifactHash:HASH,details};
  return {...header,jobId:p.jobId,projectId:p.projectId,revision:12,generation:2,phase:'REVIEWING',planGeneration:1,plan:p,attempts:[{index:0,assignmentId:'author',planDigest:digest(p)}],authors:[assignments[1].actor],assignments,results:[result(assignments[0],[]),result(assignments[1],[]),result(assignments[2],['frozen','test']),result(assignments[3],['frozen','test'])],evidence:[frozen,evidence],decision:{...header,id:'human',planDigest:digest(p),reviewResultId:'r-plan-review',generation:1,decision:'authorize'},candidate:HASH,action:{type:'RESULT_RECORDED'}};
}
const A1_IDS=['P1','P2','P3','P4','P5','P6','P7','P8','P9'];
const A1_BASELINE={P1:{pass:true,reason:null},P2:{pass:true,reason:null},P3:{pass:true,reason:null},P4:{pass:true,reason:null},P5:{pass:true,reason:null},P6:{pass:true,reason:null},P7:{pass:true,reason:null},P8:{pass:true,reason:null},P9:{pass:true,reason:null}};
function expectAll(res,overrides={}){
  const expected={...A1_BASELINE,...overrides};
  assert.equal(res.predicates.length,9);assert.deepEqual(res.predicates.map(p=>p.id),A1_IDS);
  for(const entry of res.predicates){const want=expected[entry.id];assert.equal(entry.pass,want.pass,entry.id+' pass');assert.equal(entry.reason,want.reason,entry.id+' reason');}
}
function expectAllCode(state,code,facts=A1_FACTS){
  assert.throws(()=>validateStateV2(state),{code});
  const res=evaluateAcceptanceV2(state,facts);
  assert.equal(res.stateValid,false);assert.equal(res.predicatesHold,false);
  assert.deepEqual(res.predicates.map(p=>p.pass),[false,false,false,false,false,false,false,false,false]);
  assert.deepEqual(res.predicates.map(p=>p.reason),[code,code,code,code,code,code,code,code,code]);
}
test('A1-01 baseline reports P1 passing from the authorized plan and P2-P9 passing in a deep-frozen shape',()=>{
  const base=a1Base();
  assert.doesNotThrow(()=>validateStateV2(base));
  assert.equal(diagnosticFactsReadyV2(base),true);
  const res=evaluateAcceptanceV2(base,A1_FACTS);
  expectAll(res,{});
  assert.equal(res.schemaVersion,1);assert.equal(res.kind,'acceptance-evaluation');
  assert.equal(res.complete,false);assert.equal(res.predicatesHold,true);assert.equal(res.stateValid,true);
  assert.equal(res.operationallyAccepted,false);assert.equal(res.gateActive,false);
  assert.deepEqual(Object.keys(res).sort(),['complete','gateActive','kind','operationallyAccepted','predicates','predicatesHold','schemaVersion','stateValid']);
  assert.equal(Object.isFrozen(res),true);assert.equal(Object.isFrozen(res.predicates),true);
  for(const entry of res.predicates){assert.equal(Object.isFrozen(entry),true);assert.deepEqual(Object.keys(entry).sort(),['id','pass','reason']);}
});
test('A1-02 a reviewer submission missing current evidence fails only P3 with MISSING_RESULT_EVIDENCE',()=>{
  const m=clone(a1Base()),r=m.results.find(x=>x.role==='reviewer');
  r.submission.evidenceIds=['frozen'];r.submissionArtifactHash=digest(r.submission);
  assert.doesNotThrow(()=>validateStateV2(m));
  const res=evaluateAcceptanceV2(m,A1_FACTS);
  assert.equal(res.stateValid,true);
  expectAll(res,{P3:{pass:false,reason:'MISSING_RESULT_EVIDENCE'}});
});
test('A1-03 an unsettled managed test receipt fails only P4 with TEST_NOT_PASSED',()=>{
  const m=clone(a1Base()),e=m.evidence.find(x=>x.kind==='test');
  e.details={...e.details,managedSettled:false};e.contentDigest=digest(e.details);
  assert.doesNotThrow(()=>validateStateV2(m));
  const res=evaluateAcceptanceV2(m,A1_FACTS);
  assert.equal(res.stateValid,true);
  expectAll(res,{P4:{pass:false,reason:'TEST_NOT_PASSED'}});
});
test('A1-04 a second current frozen evidence fails only P2 with FROZEN_EVIDENCE_REQUIRED',()=>{
  const m=clone(a1Base()),frozen=m.evidence.find(x=>x.kind==='frozen');
  m.evidence.push({...frozen,id:'frozen-2'});
  for(const r of m.results.filter(x=>x.role==='validator'||x.role==='reviewer')){r.submission.evidenceIds=['frozen','frozen-2','test'];r.submissionArtifactHash=digest(r.submission);}
  assert.doesNotThrow(()=>validateStateV2(m));
  const res=evaluateAcceptanceV2(m,A1_FACTS);
  assert.equal(res.stateValid,true);
  expectAll(res,{P2:{pass:false,reason:'FROZEN_EVIDENCE_REQUIRED'}});
});
test('A1-05 one finding id bound to two criteria across validator results fails only P7 with FINDING_ID_CONFLICT',()=>{
  const p=m3ContractPlan();p.criteria=[...p.criteria,{id:'criterion-2',description:'Second synthetic acceptance criterion.',method:'test'}];
  const m=clone(a1Base(p)),header={schemaVersion:2,provenance:V2_PROVENANCE};
  const va={...header,id:'validator-1',actor:{id:'validator-1',...m.plan.executionPolicy.routes.validator},role:'validator',generation:1,binding:bindingForV2(m.plan,HASH)};
  m.assignments.push(va);
  const older={criteria:m.plan.criteria.map(c=>({id:c.id,outcome:'pass'})),findings:[{id:'f1',criterionId:'criterion-1',detail:'Conflict finding in the earlier validator result.',severity:'note',status:'resolved'}],evidenceIds:[]};
  m.results.push({...header,id:'r-validator-1',assignmentId:va.id,actor:va.actor,role:'validator',generation:1,binding:va.binding,outcome:'completed-pass',submission:older,submissionArtifactHash:digest(older)});
  const current=m.results.find(r=>r.role==='validator'&&r.generation===2);
  current.submission.findings=[{id:'f1',criterionId:'criterion-2',detail:'Conflict finding in the current validator result.',severity:'note',status:'resolved'}];
  current.submissionArtifactHash=digest(current.submission);
  assert.doesNotThrow(()=>validateStateV2(m));
  const res=evaluateAcceptanceV2(m,A1_FACTS);
  assert.equal(res.stateValid,true);
  expectAll(res,{P7:{pass:false,reason:'FINDING_ID_CONFLICT'}});
});
test('A1-06 scopeClean false fails only P7 with SCOPE_NOT_CLEAN while facts stay diagnostic-ready',()=>{
  const base=a1Base();
  assert.equal(diagnosticFactsReadyV2(base),true);
  const res=evaluateAcceptanceV2(base,{...A1_FACTS,scopeClean:false});
  assert.equal(res.stateValid,true);
  expectAll(res,{P7:{pass:false,reason:'SCOPE_NOT_CLEAN'}});
  assert.equal(diagnosticFactsReadyV2(base),true);
});
test('A1-07 journalHealthy false fails only P7 with JOURNAL_UNHEALTHY while facts stay diagnostic-ready',()=>{
  const base=a1Base();
  assert.equal(diagnosticFactsReadyV2(base),true);
  const res=evaluateAcceptanceV2(base,{...A1_FACTS,journalHealthy:false});
  assert.equal(res.stateValid,true);
  expectAll(res,{P7:{pass:false,reason:'JOURNAL_UNHEALTHY'}});
});
test('A1-08 identityRecheck false fails only P9 with IDENTITY_RECHECK_REQUIRED while facts stay diagnostic-ready',()=>{
  const base=a1Base();
  assert.equal(diagnosticFactsReadyV2(base),true);
  const res=evaluateAcceptanceV2(base,{...A1_FACTS,identityRecheck:false});
  assert.equal(res.stateValid,true);
  expectAll(res,{P9:{pass:false,reason:'IDENTITY_RECHECK_REQUIRED'}});
});
test('A1-09 custodyVerified false fails only P9 with CUSTODY_NOT_VERIFIED while facts stay diagnostic-ready',()=>{
  const base=a1Base();
  assert.equal(diagnosticFactsReadyV2(base),true);
  const res=evaluateAcceptanceV2(base,{...A1_FACTS,custodyVerified:false});
  assert.equal(res.stateValid,true);
  expectAll(res,{P9:{pass:false,reason:'CUSTODY_NOT_VERIFIED'}});
});
test('A1-10 reusing the validator actor id for the reviewer is refused by validateStateV2:236 with ACTOR_REUSED',()=>{
  const m=clone(a1Base()),validator=m.assignments.find(a=>a.role==='validator'),reviewer=m.assignments.find(a=>a.role==='reviewer'),result=m.results.find(r=>r.role==='reviewer');
  reviewer.actor={...reviewer.actor,id:validator.actor.id};result.actor={...result.actor,id:validator.actor.id};
  expectAllCode(m,'ACTOR_REUSED');
});
test('A1-11 a reviewer route provider outside the plan policy is refused by validateStateV2:231 with ACTUAL_ROUTE_CHANGED',()=>{
  const m=clone(a1Base()),reviewer=m.assignments.find(a=>a.role==='reviewer'),result=m.results.find(r=>r.role==='reviewer');
  reviewer.actor={...reviewer.actor,provider:'other-provider'};result.actor={...result.actor,provider:'other-provider'};
  expectAllCode(m,'ACTUAL_ROUTE_CHANGED');
});
test('A1-12 a fourth attempt is refused by validateStateV2:230 with INVALID_LIST',()=>{
  const m=clone(a1Base());for(let i=1;i<=3;i++)m.attempts.push({index:i,assignmentId:'extra-attempt-'+i,planDigest:HASH});assert.equal(m.attempts.length,4);
  expectAllCode(m,'INVALID_LIST');
});
test('A1-13 dropping a criterion from a completed-pass submission is refused by validateStateV2:239 with CRITERIA_NOT_PASSED',()=>{
  const m=clone(a1Base()),result=m.results.find(r=>r.role==='reviewer');
  result.submission.criteria=[];result.submissionArtifactHash=digest(result.submission);
  expectAllCode(m,'CRITERIA_NOT_PASSED');
});
test('A1-14 a reject decision stays schema-valid, is not diagnostic-ready, and fails P1 with PLAN_NOT_AUTHORIZED',()=>{
  const m=clone(a1Base());m.decision.decision='reject';
  assert.doesNotThrow(()=>validateStateV2(m));
  assert.equal(diagnosticFactsReadyV2(m),false);
  const res=evaluateAcceptanceV2(m,A1_FACTS);
  assert.equal(res.stateValid,true);assert.equal(res.predicatesHold,false);
  expectAll(res,{P1:{pass:false,reason:'PLAN_NOT_AUTHORIZED'}});
});
test('A1-15 a non-boolean fact value is structurally invalid and fails P7 and P9 with FACTS_INVALID',()=>{
  const base=a1Base();
  for(const value of ['true',1,null])for(const key of ['custodyVerified','journalHealthy','scopeClean','identityRecheck']){
    const res=evaluateAcceptanceV2(base,{...A1_FACTS,[key]:value});
    assert.equal(res.stateValid,true);
    expectAll(res,{P7:{pass:false,reason:'FACTS_INVALID'},P9:{pass:false,reason:'FACTS_INVALID'}});
  }
});
test('A1-16 a missing key, a surplus key, undefined facts and null facts all fail P7 and P9 with FACTS_INVALID',()=>{
  const base=a1Base(),omitted={...A1_FACTS};delete omitted.journalHealthy;
  for(const facts of [omitted,{...A1_FACTS,surplus:true},undefined,null]){
    const res=evaluateAcceptanceV2(base,facts);
    assert.equal(res.stateValid,true);
    expectAll(res,{P7:{pass:false,reason:'FACTS_INVALID'},P9:{pass:false,reason:'FACTS_INVALID'}});
  }
});
test('A1-17 null, {}, a string and a number as state never throw and fail all nine predicates with a string reason',()=>{
  for(const state of [null,{},'x',5]){
    const res=evaluateAcceptanceV2(state,A1_FACTS);
    assert.equal(res.stateValid,false);assert.equal(res.predicatesHold,false);assert.equal(res.complete,false);
    assert.deepEqual(res.predicates.map(p=>p.id),A1_IDS);
    for(const entry of res.predicates){assert.equal(entry.pass,false);assert.equal(typeof entry.reason,'string');}
  }
});
test('A1-18 a getter on a fact is refused as FACTS_INVALID without invoking the accessor',()=>{
  const base=a1Base(),facts={custodyVerified:true,journalHealthy:true,identityRecheck:true};
  let count=0;Object.defineProperty(facts,'scopeClean',{enumerable:true,configurable:true,get(){count++;return true;}});
  const res=evaluateAcceptanceV2(base,facts);
  assert.equal(res.stateValid,true);
  expectAll(res,{P7:{pass:false,reason:'FACTS_INVALID'},P9:{pass:false,reason:'FACTS_INVALID'}});
  assert.equal(count,0);
});
test('A1-19 an open blocker carried by a non-completed-pass validator result fails only P7 with OPEN_BLOCKER',()=>{
  const m=clone(a1Base()),header={schemaVersion:2,provenance:V2_PROVENANCE};
  const va={...header,id:'validator-1',actor:{id:'validator-1',...m.plan.executionPolicy.routes.validator},role:'validator',generation:1,binding:bindingForV2(m.plan,HASH)};
  m.assignments.push(va);
  const submission={criteria:[],findings:[{id:'f1',criterionId:'criterion-1',detail:'Unresolved blocker on the earlier validator attempt.',severity:'blocker',status:'open'}],evidenceIds:[]};
  m.results.push({...header,id:'r-validator-1',assignmentId:va.id,actor:va.actor,role:'validator',generation:1,binding:va.binding,outcome:'cancelled',submission,submissionArtifactHash:digest(submission)});
  assert.doesNotThrow(()=>validateStateV2(m));
  const res=evaluateAcceptanceV2(m,A1_FACTS);
  assert.equal(res.stateValid,true);
  expectAll(res,{P7:{pass:false,reason:'OPEN_BLOCKER'}});
});
test('A1-24 a human decision bound to a different plan digest is refused by validateStateV2:240 with INVALID_HUMAN_DECISION',()=>{
  const m=clone(a1Base());m.decision.planDigest=OTHER_HASH;
  expectAllCode(m,'INVALID_HUMAN_DECISION');
});
test('A1-25 a single current frozen evidence whose content differs from the candidate fails only P2 and is not diagnostic-ready',()=>{
  const m=clone(a1Base()),frozen=m.evidence.find(x=>x.kind==='frozen');frozen.contentDigest=OTHER_HASH;
  let valid=true;try{validateStateV2(m);}catch{valid=false;}
  if(valid){assert.equal(diagnosticFactsReadyV2(m),true);const res=evaluateAcceptanceV2(m,A1_FACTS);assert.equal(res.stateValid,true);expectAll(res,{P2:{pass:false,reason:'FROZEN_EVIDENCE_REQUIRED'}});}
  else{const res=evaluateAcceptanceV2(m,A1_FACTS);assert.equal(res.stateValid,false);assert.equal(res.predicatesHold,false);}
});

// Stage 6 slice A2a: the pure plan-level acceptance contract digest.
import {acceptanceDigestV2} from '../src/governance/contracts.mjs';
test('A2a-T1 acceptance digest is a deterministic 64-hex contract digest distinct from the plan and environment digests',()=>{
  const p=m3ContractPlan(),base=acceptanceDigestV2(p);
  assert.match(base,/^[a-f0-9]{64}$/);
  assert.equal(acceptanceDigestV2(m3ContractPlan()),base);
  assert.notEqual(base,digest(p));
  assert.notEqual(base,p.environmentDigest);
  assert.equal(acceptanceDigestV2(validatePlanV2(p)),base);
});
test('A2a-T2 criteria addition and criteria reorder change the digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),added=m3ContractPlan();
  added.criteria.push({id:'criterion-2',description:'Second synthetic criterion.',method:'review'});
  assert.doesNotThrow(()=>validatePlanV2(added));
  const addedDigest=acceptanceDigestV2(added);
  assert.notEqual(addedDigest,base);
  added.criteria=[added.criteria[1],added.criteria[0]];
  assert.doesNotThrow(()=>validatePlanV2(added));
  assert.notEqual(acceptanceDigestV2(added),addedDigest);
});
test('A2a-T2 protectedTests addition changes the digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutated=m3ContractPlan();
  mutated.protectedTests.push('tests/other.test.mjs');
  assert.doesNotThrow(()=>validatePlanV2(mutated));
  assert.notEqual(acceptanceDigestV2(mutated),base);
});
test('A2a-T2 executionPolicy.testFiles content hash change alone changes the digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutated=m3ContractPlan();
  mutated.executionPolicy.testFiles[0].sha256=OTHER_HASH;
  assert.doesNotThrow(()=>validatePlanV2(mutated));
  assert.notEqual(acceptanceDigestV2(mutated),base);
});
test('A2a-T2 command timeout change changes the digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutated=m3ContractPlan();
  mutated.commands[0].timeoutMs=2000;
  assert.doesNotThrow(()=>validatePlanV2(mutated));
  assert.notEqual(acceptanceDigestV2(mutated),base);
});
test('A2a-T2 testInventory change is coupled at contracts.mjs:194 and changes the digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutated=m3ContractPlan();
  mutated.commands[0].inventory=['fixture-test','fixture-test-2'];
  mutated.testInventory=['fixture-test','fixture-test-2'];
  assert.doesNotThrow(()=>validatePlanV2(mutated));
  assert.notEqual(acceptanceDigestV2(mutated),base);
});
test('A2a-T2 environmentDigest change is recomputed per contracts.mjs:196 and changes the digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutated=m3ContractPlan();
  mutated.executionPolicy.node.version='v0.0.0-fixture';
  mutated.environmentDigest=digest({node:mutated.executionPolicy.node,enforcement:mutated.executionPolicy.enforcement,environmentRecipe:mutated.executionPolicy.environmentRecipe});
  assert.notEqual(mutated.environmentDigest,m3ContractPlan().environmentDigest);
  assert.doesNotThrow(()=>validatePlanV2(mutated));
  assert.notEqual(acceptanceDigestV2(mutated),base);
});
test('A2a-T3 objective, nonGoals, files, routes, planner id and baseline do not change the digest while digest(plan) does',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutations=[
    p=>{p.objective='Changed objective.';},
    p=>{p.nonGoals.push('Another non-goal.');},
    p=>{p.files.push({path:'src/other.mjs',operation:'create',expectedHash:null});},
    p=>{p.executionPolicy.routes.validator.model='fixture-2';},
    p=>{p.policy.planner.id='planner-2';},
    p=>{p.baseline=OTHER_HASH;},
  ];
  for(const change of mutations){
    const mutated=m3ContractPlan();
    change(mutated);
    assert.doesNotThrow(()=>validatePlanV2(mutated));
    assert.equal(acceptanceDigestV2(mutated),base);
    assert.notEqual(digest(mutated),digest(m3ContractPlan()));
  }
});
test('A2a-T4 invalid plans throw the validator code before any digest',()=>{
  assert.throws(()=>acceptanceDigestV2({...m3ContractPlan(),criteria:[]}),{code:'MISSING_CRITERIA'});
  assert.throws(()=>acceptanceDigestV2(makePlan()),{code:'CLOSED_SCHEMA'});
  let count=0;
  const base=m3ContractPlan(),policy=base.executionPolicy,mutated={...base};
  Object.defineProperty(mutated,'executionPolicy',{enumerable:true,get(){count++;return policy;}});
  assert.throws(()=>acceptanceDigestV2(mutated),{code:'INVALID_DESCRIPTOR'});
  assert.equal(count,0);
});
test('A2a-T5 plan and command key order does not change the digest',()=>{
  const p=m3ContractPlan(),base=acceptanceDigestV2(p);
  const reversed=Object.fromEntries(Object.entries(p).reverse());
  assert.doesNotThrow(()=>validatePlanV2(reversed));
  assert.equal(acceptanceDigestV2(reversed),base);
  const commandReversed=m3ContractPlan();
  commandReversed.commands[0]=Object.fromEntries(Object.entries(commandReversed.commands[0]).reverse());
  assert.doesNotThrow(()=>validatePlanV2(commandReversed));
  assert.equal(acceptanceDigestV2(commandReversed),base);
});
test('A2a-T6 acceptance evaluation follows A1_BASELINE (P1 derived in A2b) and the authorized decision still carries only planDigest',()=>{
  const state=a1Base(),res=evaluateAcceptanceV2(state,A1_FACTS);
  assert.equal(res.stateValid,true);
  expectAll(res);
  assert.notEqual(acceptanceDigestV2(state.plan),state.decision.planDigest);
});

// Stage 6 slice A2b: P1 derives from the authorized plan.
test('A2b-B1 an authorized plan derives P1 from its acceptance digest in a deep-frozen shape',()=>{
  const res=evaluateAcceptanceV2(a1Base(),A1_FACTS);
  assert.equal(res.stateValid,true);
  assert.deepEqual(res.predicates.find(p=>p.id==='P1'),{id:'P1',pass:true,reason:null});
  assert.equal(res.predicatesHold,true);
  assert.equal(res.complete,false);
  assert.equal(res.operationallyAccepted,false);
  assert.equal(res.gateActive,false);
  assert.equal(Object.isFrozen(res),true);
  expectAll(res);
});
test('A2b-B2 a false fact fails only P7 with SCOPE_NOT_CLEAN',()=>{
  const res=evaluateAcceptanceV2(a1Base(),{...A1_FACTS,scopeClean:false});
  assert.equal(res.stateValid,true);
  assert.equal(res.predicatesHold,false);
  assert.deepEqual(res.predicates.filter(p=>!p.pass).map(p=>p.id),['P7']);
});
test('A2b-B2 a reject decision fails only P1 with PLAN_NOT_AUTHORIZED',()=>{
  const m=clone(a1Base());m.decision.decision='reject';
  const res=evaluateAcceptanceV2(m,A1_FACTS);
  assert.equal(res.stateValid,true);
  assert.equal(res.predicatesHold,false);
  assert.deepEqual(res.predicates.filter(p=>!p.pass).map(p=>p.id),['P1']);
  assert.equal(res.predicates.find(p=>p.id==='P1').reason,'PLAN_NOT_AUTHORIZED');
});
test('A2b-B2 an unsettled managed test receipt fails only P4 with TEST_NOT_PASSED',()=>{
  const m=clone(a1Base()),e=m.evidence.find(x=>x.kind==='test');
  e.details={...e.details,managedSettled:false};e.contentDigest=digest(e.details);
  const res=evaluateAcceptanceV2(m,A1_FACTS);
  assert.equal(res.stateValid,true);
  assert.equal(res.predicatesHold,false);
  assert.deepEqual(res.predicates.filter(p=>!p.pass).map(p=>p.id),['P4']);
});
test('A2b-B3 a null human decision is schema-valid and fails only P1 with PLAN_NOT_AUTHORIZED',()=>{
  const m=clone(a1Base());m.decision=null;
  assert.doesNotThrow(()=>validateStateV2(m));
  const res=evaluateAcceptanceV2(m,A1_FACTS);
  assert.equal(res.stateValid,true);
  expectAll(res,{P1:{pass:false,reason:'PLAN_NOT_AUTHORIZED'}});
  assert.equal(res.predicatesHold,false);
});
test('A2b-B4 each criteria addition and reorder changes digest(plan) and the acceptance digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),planDigest=digest(m3ContractPlan()),added=m3ContractPlan();
  added.criteria.push({id:'criterion-2',description:'Second synthetic criterion.',method:'review'});
  assert.doesNotThrow(()=>validatePlanV2(added));
  const addedDigest=acceptanceDigestV2(added);
  assert.notEqual(addedDigest,base);
  assert.notEqual(digest(added),planDigest);
  added.criteria=[added.criteria[1],added.criteria[0]];
  assert.doesNotThrow(()=>validatePlanV2(added));
  assert.notEqual(acceptanceDigestV2(added),base);
  assert.notEqual(digest(added),planDigest);
});
test('A2b-B4 a protectedTests addition changes digest(plan) and the acceptance digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutated=m3ContractPlan();
  mutated.protectedTests.push('tests/other.test.mjs');
  assert.doesNotThrow(()=>validatePlanV2(mutated));
  assert.notEqual(acceptanceDigestV2(mutated),base);
  assert.notEqual(digest(mutated),digest(m3ContractPlan()));
});
test('A2b-B4 an executionPolicy.testFiles hash change changes digest(plan) and the acceptance digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutated=m3ContractPlan();
  mutated.executionPolicy.testFiles[0].sha256=OTHER_HASH;
  assert.doesNotThrow(()=>validatePlanV2(mutated));
  assert.notEqual(acceptanceDigestV2(mutated),base);
  assert.notEqual(digest(mutated),digest(m3ContractPlan()));
});
test('A2b-B4 a command timeout change changes digest(plan) and the acceptance digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutated=m3ContractPlan();
  mutated.commands[0].timeoutMs=2000;
  assert.doesNotThrow(()=>validatePlanV2(mutated));
  assert.notEqual(acceptanceDigestV2(mutated),base);
  assert.notEqual(digest(mutated),digest(m3ContractPlan()));
});
test('A2b-B4 a testInventory change is coupled at contracts.mjs:194 and changes digest(plan) and the acceptance digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutated=m3ContractPlan();
  mutated.commands[0].inventory=['fixture-test','fixture-test-2'];
  mutated.testInventory=['fixture-test','fixture-test-2'];
  assert.doesNotThrow(()=>validatePlanV2(mutated));
  assert.notEqual(acceptanceDigestV2(mutated),base);
  assert.notEqual(digest(mutated),digest(m3ContractPlan()));
});
test('A2b-B4 an environmentDigest change changes digest(plan) and the acceptance digest',()=>{
  const base=acceptanceDigestV2(m3ContractPlan()),mutated=m3ContractPlan();
  mutated.executionPolicy.node.version='v0.0.0-fixture';
  mutated.environmentDigest=digest({node:mutated.executionPolicy.node,enforcement:mutated.executionPolicy.enforcement,environmentRecipe:mutated.executionPolicy.environmentRecipe});
  assert.notEqual(mutated.environmentDigest,m3ContractPlan().environmentDigest);
  assert.doesNotThrow(()=>validatePlanV2(mutated));
  assert.notEqual(acceptanceDigestV2(mutated),base);
  assert.notEqual(digest(mutated),digest(m3ContractPlan()));
});
test('A2b-B4 a decision bound to the old plan digest over a mutated plan is refused by validateStateV2:240',()=>{
  const mutated=m3ContractPlan();mutated.commands[0].timeoutMs=2000;
  const m=a1Base(mutated);m.decision.planDigest=digest(m3ContractPlan());
  expectAllCode(m,'INVALID_HUMAN_DECISION');
});
test('A2b-B6 a plan missing its criteria never throws and fails all nine predicates with MISSING_CRITERIA',()=>{
  const m=clone(a1Base());m.plan.criteria=[];
  assert.doesNotThrow(()=>evaluateAcceptanceV2(m,A1_FACTS));
  expectAllCode(m,'MISSING_CRITERIA');
});
test('A2b-B6 a getter-bearing state never throws and refuses the accessor without invocation',()=>{
  let count=0;
  const base=a1Base(),plan=base.plan,state={...base};
  Object.defineProperty(state,'plan',{enumerable:true,get(){count++;return plan;}});
  expectAllCode(state,'INVALID_DESCRIPTOR');
  assert.equal(count,0);
});

// Stage 6 bundle: the offline acceptance record (receipt schema, scope rule, transition and invariants).
import {ACCEPTANCE_EVENT_V2,validateAcceptRequestV2,acceptanceScopeCleanV2,validateAcceptanceReceiptV2,validateAcceptanceAuditV2,qualificationReferencesM4B} from '../src/governance/contracts.mjs';
const A6_BODY={schemaVersion:1,kind:'acceptance-recorded',operationallyAccepted:false,gateActive:false,id:'acceptance',nonce:HASH,jobId:'fixture-job',projectId:HASH,generation:2,priorHeadDigest:HASH,candidateDigest:OTHER_HASH,planDigest:HASH,acceptanceDigest:OTHER_HASH,frozenArtifactHash:HASH,authorResultId:'author',validatorResultId:'validator',reviewerResultId:'reviewer',submissionArtifacts:[HASH],testArtifacts:[OTHER_HASH],logArtifacts:[]};
function a6Receipt(state=a1Base()){const references=qualificationReferencesM4B(state);return validateAcceptanceReceiptV2({...A6_BODY,...references,facts:{...A1_FACTS},jobId:state.jobId,projectId:state.projectId,generation:state.generation,candidateDigest:state.candidate,planDigest:digest(state.plan),acceptanceDigest:acceptanceDigestV2(state.plan)});}
test('N1 acceptance request and receipt are closed schemas that refuse flags, false facts and accessors',()=>{
  const h=HASH;assert.deepEqual(validateAcceptRequestV2({candidateDigest:h,headDigest:h}),{candidateDigest:h,headDigest:h});
  for(const bad of [{candidateDigest:h},{candidateDigest:h,headDigest:h,accepted:true},{candidateDigest:'A'.repeat(64),headDigest:h},{candidateDigest:h,headDigest:7}])assert.throws(()=>validateAcceptRequestV2(bad));
  const state=a1Base(),receipt=a6Receipt(state);
  assert.deepEqual(validateAcceptanceReceiptV2(receipt),receipt);
  assert.throws(()=>validateAcceptanceReceiptV2({...receipt,surplus:true}),refusal('CLOSED_SCHEMA'));
  const missing={...receipt};delete missing.planDigest;
  assert.throws(()=>validateAcceptanceReceiptV2(missing),refusal('CLOSED_SCHEMA'));
  assert.throws(()=>validateAcceptanceReceiptV2({...receipt,operationallyAccepted:true}),refusal('ACCEPTANCE_RECEIPT_KIND'));
  assert.throws(()=>validateAcceptanceReceiptV2({...receipt,gateActive:true}),refusal('ACCEPTANCE_RECEIPT_KIND'));
  assert.throws(()=>validateAcceptanceReceiptV2({...receipt,kind:'qualification-finalized'}),refusal('ACCEPTANCE_RECEIPT_KIND'));
  assert.throws(()=>validateAcceptanceReceiptV2({...receipt,facts:{...receipt.facts,scopeClean:false}}),refusal('ACCEPTANCE_FACTS_REQUIRED'));
  assert.throws(()=>validateAcceptanceReceiptV2({...receipt,facts:{...receipt.facts,surplus:true}}),refusal('CLOSED_SCHEMA'));
  for(const key of ['planDigest','candidateDigest','priorHeadDigest','acceptanceDigest','frozenArtifactHash'])assert.throws(()=>validateAcceptanceReceiptV2({...receipt,[key]:'not-a-digest'}),refusal('INVALID_DIGEST'));
  for(const key of ['authorResultId','validatorResultId','reviewerResultId'])assert.throws(()=>validateAcceptanceReceiptV2({...receipt,[key]:'bad id'}),refusal('INVALID_ID'));
  assert.throws(()=>validateAcceptanceReceiptV2({...receipt,testArtifacts:['x']}),refusal('INVALID_DIGEST'));
  let count=0;const facts={custodyVerified:true,journalHealthy:true,scopeClean:true};
  Object.defineProperty(facts,'identityRecheck',{enumerable:true,configurable:true,get(){count++;return true;}});
  assert.throws(()=>validateAcceptanceReceiptV2({...receipt,facts}),refusal('INVALID_DESCRIPTOR'));
  const accessor={...receipt};Object.defineProperty(accessor,'planDigest',{enumerable:true,configurable:true,get(){count++;return HASH;}});
  assert.throws(()=>validateAcceptanceReceiptV2(accessor),refusal('INVALID_DESCRIPTOR'));
  assert.equal(count,0);
});
test('N2 acceptance scope is a subset rule over trusted changes and refuses out-of-plan or incompatible work',()=>{
  const header={schemaVersion:2,provenance:V2_PROVENANCE};
  const row=(path,sha256=HASH)=>({path,kind:'file',bytes:1,sha256,gitMode:'100644'});
  const a6Descriptor=(plan,changes,deletions=[])=>{const present=new Map(changes.filter(c=>c.after!==null).map(c=>[c.path,c.after]));
    const body={...planIdentityV2(plan),...header,jobId:plan.jobId,projectId:plan.projectId,schemaVersion:2,provenance:V2_PROVENANCE,assignmentId:'author',attempt:0,generation:2,revision:5,baselineDigest:plan.baseline,commit:'a'.repeat(40),objectFormat:'sha1',git:{sha256:HASH,version:'git version fixture'},files:[...present.values()].sort((a,b)=>a.path<b.path?-1:1),deletions,changes};
    return validateCandidateDescriptorV2({...body,candidateDigest:digest(body)});};
  const p=m3ContractPlan(),replacing={...p,files:[{path:'src/fixture.mjs',operation:'replace',expectedHash:HASH}]};
  const modified={path:'src/fixture.mjs',operation:'modify',before:row('src/fixture.mjs'),after:row('src/fixture.mjs',OTHER_HASH)};
  const clean=a6Descriptor(replacing,[modified]);
  assert.equal(acceptanceScopeCleanV2(replacing,clean,clean.candidateDigest),true);
  const unchanged=a6Descriptor(replacing,[]);
  assert.equal(acceptanceScopeCleanV2(replacing,unchanged,unchanged.candidateDigest),true);
  const foreign=row('other/foreign.mjs'),outOfPlan=a6Descriptor(replacing,[{path:foreign.path,operation:'create',before:null,after:foreign}]);
  assert.equal(acceptanceScopeCleanV2(replacing,outOfPlan,outOfPlan.candidateDigest),false);
  const created=a6Descriptor(replacing,[{path:'src/fixture.mjs',operation:'create',before:null,after:row('src/fixture.mjs',OTHER_HASH)}]);
  assert.equal(acceptanceScopeCleanV2(replacing,created,created.candidateDigest),false);
  assert.equal(acceptanceScopeCleanV2(p,clean,clean.candidateDigest),false);
  assert.equal(acceptanceScopeCleanV2(replacing,clean,OTHER_HASH),false);
  assert.equal(acceptanceScopeCleanV2(replacing,{...clean,planDigest:OTHER_HASH},clean.candidateDigest),false);
  const edited={...p,files:[{path:'src/fixture.mjs',operation:'edit',expectedHash:HASH}]},editChange=a6Descriptor(edited,[modified]);
  assert.equal(acceptanceScopeCleanV2(edited,editChange,editChange.candidateDigest),true);
  assert.equal(acceptanceScopeCleanV2(replacing,editChange,editChange.candidateDigest),false);
  const deleting={...p,files:[{path:'src/fixture.mjs',operation:'delete',expectedHash:HASH}]},removed=row('src/fixture.mjs');
  const deletion=a6Descriptor(deleting,[{path:'src/fixture.mjs',operation:'delete',before:removed,after:null}],[{...removed,kind:'deleted'}]);
  assert.equal(acceptanceScopeCleanV2(deleting,deletion,deletion.candidateDigest),true);
  assert.equal(acceptanceScopeCleanV2(replacing,deletion,deletion.candidateDigest),false);
  for(const malformed of [null,{},[],{schemaVersion:2},'descriptor',7])assert.equal(acceptanceScopeCleanV2(replacing,malformed,HASH),false);
  // Documented precondition: `changes` completeness comes from the trusted workspace producer, not from this helper.
  const omitted=a6Descriptor(replacing,[]);
  assert.equal(acceptanceScopeCleanV2(replacing,omitted,omitted.candidateDigest),true);
});
test('N3 acceptance transitions stay in the ready phase, change no business field and refuse unknown types',()=>{
  const ready=a1Base(),before={...ready,phase:'DIAGNOSTIC_READY'},after={...before,revision:13,action:{type:ACCEPTANCE_EVENT_V2}};
  assert.equal(ACCEPTANCE_EVENT_V2,'ACCEPTANCE_RECORDED');
  assert.doesNotThrow(()=>validateTransitionV2(before,ACCEPTANCE_EVENT_V2,after));
  assert.throws(()=>validateTransitionV2(before,'QUALIFICATION_FINALIZED',after),refusal('EVENT_IDENTITY_MISMATCH'));
  for(const phase of ['PLANNING','AWAITING_HUMAN','PLAN_AUTHORIZED','AUTHORING','FROZEN','VALIDATING','REVIEWING','CORRECTION_REQUIRED']){
    assert.throws(()=>validateTransitionV2({...before,phase},ACCEPTANCE_EVENT_V2,{...after,phase}),refusal('QUALIFICATION_PHASE_REQUIRED'));
  }
  assert.throws(()=>validateTransitionV2(before,ACCEPTANCE_EVENT_V2,{...after,evidence:[...before.evidence,{...before.evidence[0],id:'frozen-2'}]}),refusal('UNEXPECTED_STATE_CHANGE'));
  assert.throws(()=>validateTransitionV2(before,ACCEPTANCE_EVENT_V2,{...after,decision:null}),refusal('QUALIFICATION_BUSINESS_CHANGED'));
  assert.throws(()=>validateTransitionV2(before,ACCEPTANCE_EVENT_V2,{...after,candidate:OTHER_HASH}),refusal('QUALIFICATION_BUSINESS_CHANGED'));
  assert.throws(()=>validateTransitionV2(before,'ACCEPTANCE_UNKNOWN',{...after,action:{type:'ACCEPTANCE_UNKNOWN'}}),refusal('UNKNOWN_EVENT_TYPE'));
  assert.throws(()=>validateAcceptanceAuditV2([],'ACCEPTANCE_UNKNOWN',after,null,[a6Receipt()]),refusal('UNKNOWN_EVENT_TYPE'));
});
test('N4 no accepted phase exists and every acceptance diagnostic keeps the gate closed',()=>{
  const base=a1Base(),result=evaluateAcceptanceV2(base,A1_FACTS);
  assert.equal(result.predicatesHold,true);assert.equal(result.complete,false);
  assert.equal(result.operationallyAccepted,false);assert.equal(result.gateActive,false);
  let phaseCode=null;try{validateStateV2({...base,phase:'ACCEPTED'});}catch(error){phaseCode=error.code;}
  assert.equal(phaseCode,'INVALID_ENUM');
  const receipt=a6Receipt(base);
  assert.equal(receipt.operationallyAccepted,false);assert.equal(receipt.gateActive,false);
  const successor={...base,phase:'DIAGNOSTIC_READY',revision:13,action:{type:ACCEPTANCE_EVENT_V2}},prior={...base,phase:'DIAGNOSTIC_READY'};
  const audit=validateAcceptanceAuditV2([{type:'DIAGNOSTIC_READY',payload:prior}],ACCEPTANCE_EVENT_V2,successor,HASH,[a6Receipt(successor)]);
  assert.equal(audit.id,'acceptance');assert.equal(audit.gateActive,false);assert.equal(audit.operationallyAccepted,false);
});
