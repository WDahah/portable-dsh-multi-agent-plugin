// Synthetic capability-probe fixtures. No provider calls: every child here is a local
// stub, so a passing case proves the probe logic, never a real model's competence.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {solidPng, createImageProbe, createStructuredProbe, PROBE_COLORS, IMAGE_PROBE_PANELS} from '../src/probes.mjs';
import {createQualificationManager, normalizeAttestation, BASE_DATA_CLASSES} from '../src/qualification.mjs';
import {ROUTES, selectRoute} from '../src/routes.mjs';
import {makeTempRoot} from './helpers/tmp.mjs';

const root = await makeTempRoot('portable-probe-test-');
after(() => fs.rm(root, {recursive: true, force: true}));
let sequence = 0;
const fresh = () => path.join(root, 'case-' + ++sequence);
const owner = 'synthetic-parent', route = ROUTES.find(r => r.id === 'codex-terra');
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const llm = {async prepareCall(config) {return {config};}};
// Records only what it was handed; it never inspects real pixels.
const attachments = {async saveImage(input) {
  assert.ok(input.data.length > 0); assert.equal(input.mediaType, 'image/png');
  return {attachmentId: 'attachment-' + input.name, mediaType: input.mediaType, bytes: input.data.length, width: 48, height: 48};
}};
const text = value => ({stopReason: 'completed', output: [{type: 'text', text: value}]});
/** A stub child that answers the core challenge honestly and each probe per `mode`. */
function childFactory(mode, getManager) {
  return {async start(_name, request) {
    const prompt = request.prompt[0].text;
    if (prompt.includes('orchestrator_qualification_echo')) {
      const token = /token ([a-f0-9-]+)/.exec(prompt)[1];
      const {marker} = getManager().echo({token}, {agent: {id: 'synthetic-child'}});
      return {id: 'synthetic-child', result: Promise.resolve(text(`QUALIFIED:${marker}:42`)), async dispose() {}};
    }
    if (prompt.startsWith('You are given')) {
      assert.deepEqual(request.toolFilter, {allow: []});
      const names = request.prompt.filter(p => p.type === 'image').map(p => /probe-(\w+)\.png/.exec(p.attachment.attachmentId)[1]);
      assert.equal(names.length, IMAGE_PROBE_PANELS);
      // A blind guess must be a guess that is actually wrong: naming fixed colors would
      // coincide with the randomly chosen panels about once every few dozen runs and
      // fail this test for the same reason the probe exists.
      const guess = PROBE_COLORS.map(c => c.name).filter(name => !names.includes(name)).slice(0, IMAGE_PROBE_PANELS);
      assert.equal(guess.length, IMAGE_PROBE_PANELS);
      const answer = mode === 'blind' ? 'IMAGE:' + guess.join(':')
        : mode === 'refuse' ? 'I am unable to view images.' : 'IMAGE:' + names.join(':');
      return {id: 'synthetic-image-child', result: Promise.resolve(text(answer)), async dispose() {}};
    }
    const parsed = /nonce to (\S+), sum to (\d+)/.exec(prompt);
    const answer = mode === 'prose' ? 'Certainly! Here is the JSON object you requested.'
      : JSON.stringify({nonce: parsed[1], sum: Number(parsed[2]), ok: true});
    return {id: 'synthetic-structured-child', result: Promise.resolve(text(answer)), async dispose() {}};
  }};
}
function manager(mode = 'honest', services = {}) {
  let created;
  created = createQualificationManager({root: fresh(), owner, getLlm: () => llm,
    getSubagents: () => childFactory(mode, () => created), getAttachments: () => attachments, ...services});
  return created;
}
test('generated probe PNG is a real raster and colors stay distinguishable', () => {
  const png = solidPng(48, 48, [220, 20, 20]);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.includes(Buffer.from('IHDR')) && png.includes(Buffer.from('IEND')));
  assert.equal(new Set(PROBE_COLORS.map(c => c.name)).size, PROBE_COLORS.length);
  const probe = createImageProbe();
  assert.equal(probe.images.length, IMAGE_PROBE_PANELS);
  assert.equal(new Set(probe.images.map(i => i.name)).size, IMAGE_PROBE_PANELS);
  assert.ok(probe.verify(probe.expected));
  assert.equal(probe.verify('IMAGE:' + PROBE_COLORS[0].name), false);
  assert.equal(probe.verify(''), false);
});
test('structured probe accepts only exact parsed JSON, never prose or a fence', () => {
  const probe = createStructuredProbe('fixed-nonce');
  const [, nonce, sum] = /nonce to (\S+), sum to (\d+)/.exec(probe.instruction);
  assert.ok(probe.verify(JSON.stringify({nonce, sum: Number(sum), ok: true})));
  assert.equal(probe.verify('```json\n' + JSON.stringify({nonce, sum: Number(sum), ok: true}) + '\n```'), false);
  assert.equal(probe.verify(JSON.stringify({nonce, sum: Number(sum) + 1, ok: true})), false);
  assert.equal(probe.verify(JSON.stringify({nonce, sum: Number(sum), ok: false})), false);
  assert.equal(probe.verify('I have produced the JSON.'), false);
});
test('honest child earns image and structured evidence that selection then accepts', async () => {
  const m = manager('honest');
  const result = await m.qualify(route, 'medium', exec(), {capabilities: ['image', 'structured-output']});
  assert.equal(result.qualification.imagePassed, true);
  assert.deepEqual(result.qualification.caseResults.map(c => c.name), ['text', 'native-tool-roundtrip', 'image', 'structured-output']);
  assert.ok(result.qualification.caseResults.every(c => c.passed));
  const records = await m.list();
  const base = {category: 'implementation', risk: 'low', complexity: 'routine', escalate: false};
  assert.equal(selectRoute({task: {...base, role: 'R05'}, qualifications: records}).status, 'SELECTED');
  assert.equal(selectRoute({task: {...base, role: 'R04', capabilities: ['structured-output']}, qualifications: records}).status, 'SELECTED');
  m.dispose();
});
test('guessing, refusing and prose each fail their own probe only', async () => {
  for (const [mode, image, structured] of [['blind', false, true], ['refuse', false, true], ['prose', true, false]]) {
    const m = manager(mode);
    const result = await m.qualify(route, 'medium', exec(), {capabilities: ['image', 'structured-output']});
    const passed = name => result.qualification.caseResults.find(c => c.name === name).passed;
    assert.equal(result.qualification.imagePassed, image);
    assert.equal(passed('image'), image); assert.equal(passed('structured-output'), structured);
    // A failed capability never invalidates the core smoke result.
    assert.equal(result.qualification.available, true);
    assert.equal(selectRoute({task: {role: 'R05', category: 'c', risk: 'low', complexity: 'routine', escalate: false}, qualifications: await m.list()}).status,
      image ? 'SELECTED' : 'UNAVAILABLE');
    m.dispose();
  }
});
test('image probe without an attachment service fails instead of claiming support', async () => {
  const m = manager('honest', {getAttachments: () => undefined});
  const result = await m.qualify(route, 'medium', exec(), {capabilities: ['image']});
  assert.equal(result.qualification.imagePassed, false);
  assert.equal(result.qualification.available, true);
  m.dispose();
});
test('unknown capability probes and malformed attestations refuse before any child runs', async () => {
  let starts = 0;
  const m = manager('honest', {getSubagents: () => ({async start() {starts++; throw new Error('must not start');}})});
  await assert.rejects(m.qualify(route, 'medium', exec(), {capabilities: ['telepathy']}), /UNKNOWN_CAPABILITY_PROBE/);
  await assert.rejects(m.qualify(route, 'medium', exec(), {attestation: {dataClasses: ['secret'], attestedBy: 'x', basis: 'y'}}), /INVALID_ATTESTED_DATA_CLASS/);
  await assert.rejects(m.qualify(route, 'medium', exec(), {attestation: {dataClasses: ['restricted']}}), /ATTESTATION_AUTHOR_AND_BASIS_REQUIRED/);
  await assert.rejects(m.qualify(route, 'medium', exec(), {attestation: {domainEvidence: true, attestedBy: 'x'}}), /ATTESTATION_AUTHOR_AND_BASIS_REQUIRED/);
  assert.equal(starts, 0);
  m.dispose();
});
test('attestation widens policy only with an author and basis, and never fakes a probe', () => {
  assert.equal(normalizeAttestation(undefined), null);
  assert.deepEqual(normalizeAttestation({}).dataClasses, [...BASE_DATA_CLASSES]);
  const widened = normalizeAttestation({dataClasses: ['public', 'confidential'], domainEvidence: true, attestedBy: '  Operator  ', basis: 'Signed DPA on file.'});
  assert.equal(widened.attestedBy, 'Operator'); assert.equal(widened.domainEvidence, true); assert.equal(widened.kind, 'operator-attestation');
  // An attestation carries no capability claim: image evidence must still be probed.
  assert.equal(Object.hasOwn(widened, 'imagePassed'), false);
});
test('attested record stores its author and survives selection for confidential work', async () => {
  const m = manager('honest');
  const result = await m.qualify(route, 'medium', exec(), {attestation: {dataClasses: ['public', 'internal', 'confidential'], attestedBy: 'SYNTHETIC-OPERATOR', basis: 'Synthetic fixture; not a real review.'}});
  assert.equal(result.qualification.attestation.attestedBy, 'SYNTHETIC-OPERATOR');
  assert.deepEqual(result.qualification.allowedDataClasses, ['public', 'internal', 'confidential']);
  const selected = selectRoute({task: {role: 'R04', category: 'c', risk: 'low', complexity: 'routine', escalate: false, dataClass: 'confidential'}, qualifications: await m.list()});
  assert.equal(selected.status, 'SELECTED');
  m.dispose();
});
test('a failed core smoke records no attestation and no capability pass', async () => {
  const m = manager('honest', {getSubagents: () => ({async start() {return {id: 'c', result: Promise.resolve({stopReason: 'error', output: []}), async dispose() {}};}})});
  const result = await m.qualify(route, 'medium', exec(), {capabilities: ['image'], attestation: {dataClasses: ['public', 'confidential'], attestedBy: 'x', basis: 'y'}});
  assert.equal(result.qualification.available, false);
  assert.equal(result.qualification.attestation, null);
  assert.deepEqual(result.qualification.allowedDataClasses, [...BASE_DATA_CLASSES]);
  assert.equal(result.qualification.caseResults.find(c => c.name === 'image').passed, false);
  m.dispose();
});
