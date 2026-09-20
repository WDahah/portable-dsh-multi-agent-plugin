import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {prepareSetup, resolveToolsModule, parseArgs, assertNode} from '../scripts/setup.mjs';
import {doctor} from '../scripts/doctor.mjs';
import {verify} from '../scripts/verify.mjs';
import {createHash} from 'node:crypto';

// Explicit synthetic host/factory fixtures: no real host application or provider calls.
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-agent-setup-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true})); // Only this test-created temporary tree.
  const bundle = path.join(temporary, "bundle spaces ü ' quote"), host = path.join(temporary, 'synthetic host');
  await fs.mkdir(path.join(bundle, 'src'), {recursive: true}); await fs.mkdir(host);
  await fs.writeFile(path.join(bundle, 'package.json'), JSON.stringify({name: 'synthetic-portable-fixture', type: 'module'}));
  await fs.writeFile(path.join(bundle, 'src', 'plugin.mjs'), `export function createPlugin(defineTool) { if (typeof defineTool !== 'function') throw new Error('defineTool missing'); return {inject:['tools'],apply(){throw new Error('Doctor must never apply this plugin');}}; }`);
  const toolsModule = path.join(host, 'tools.mjs');
  await fs.writeFile(toolsModule, 'export const defineTool = value => value;');
  return {temporary, bundle, host, toolsModule, stateRoot: path.join(temporary, 'private state')};
}

test('setup generates local imports and quoted patch for spaces/unicode, without applying or creating state', async t => {
  const f = await fixture(t);
  const result = await prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: f.stateRoot});
  const entry = await fs.readFile(result.entryPath, 'utf8'), patch = await fs.readFile(result.patchPath, 'utf8');
  assert.ok(entry.includes(JSON.stringify(pathToFileURL(f.toolsModule).href)));
  assert.ok(entry.includes("import { createPlugin } from '../src/plugin.mjs';"));
  assert.ok(entry.includes('export default createPlugin(defineTool);'));
  assert.ok(patch.includes(pathToFileURL(result.entryPath).href.replaceAll("'", "''")));
  assert.ok(patch.includes('enabled: true'));
  assert.equal(result.hostModified, false); assert.equal(result.providerCalls, 0);
  await assert.rejects(fs.stat(f.stateRoot), {code: 'ENOENT'});
  assert.deepEqual((await fs.readdir(path.join(f.bundle, '.local'))).sort(), ['entry.mjs', 'host-patch.yml']);
  const report = await doctor({bundleRoot: f.bundle});
  assert.equal(report.status, 'OK');
  assert.equal(report.startupPerformed, false); assert.equal(report.credentialsChecked, false); assert.equal(report.routesQualified, false);
});

test('same configuration is idempotent; moving requires regenerated local URLs', async t => {
  const f = await fixture(t), args = {bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: f.stateRoot};
  const first = await prepareSetup(args), before = await fs.readFile(first.patchPath, 'utf8');
  await prepareSetup(args); assert.equal(await fs.readFile(first.patchPath, 'utf8'), before);
  const moved = path.join(f.temporary, 'moved bundle'); await fs.rename(f.bundle, moved);
  const next = await prepareSetup({...args, bundleRoot: moved});
  const after = await fs.readFile(next.patchPath, 'utf8');
  assert.notEqual(after, before); assert.ok(after.includes(pathToFileURL(next.entryPath).href));
  assert.equal((await doctor({bundleRoot: moved})).status, 'OK');
});

test('invalid options and in-bundle state fail before creating local output', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: ''}), /absolute path/);
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: 'relative.mjs'}), /absolute path/);
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: path.join(f.host, 'missing.mjs')}), {code: 'ENOENT'});
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: path.join(f.bundle, 'history')}), /outside the portable bundle/);
  for (const control of ['\n', '\r', '\t', '\u0000', '\u007f']) {
    await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: f.stateRoot + control + 'unsafe'}), /control characters/);
  }
  await assert.rejects(fs.stat(path.join(f.bundle, '.local')), {code: 'ENOENT'});
  assert.throws(() => parseArgs(['--apply'], ['--tools-module']), /Unknown/);
  assert.throws(() => parseArgs(['--tools-module'], ['--tools-module']), /Missing/);
  assert.deepEqual(parseArgs(['--help'], ['--tools-module']), {help: true});
  assert.throws(() => assertNode('20.0.0'), /22/); assert.doesNotThrow(() => assertNode('22.0.0'));
});

test('harness-root resolves host-owned package without installing or vendoring it', async t => {
  const f = await fixture(t), packageRoot = path.join(f.host, 'node_modules', '@deepseek-ai', 'dsh-tools');
  await fs.mkdir(path.join(packageRoot, 'lib'), {recursive: true});
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({name: '@deepseek-ai/dsh-tools', type: 'module', exports: './lib/index.js'}));
  await fs.writeFile(path.join(packageRoot, 'lib', 'index.js'), 'export const defineTool = value => value;');
  const resolved = await resolveToolsModule({harnessRoot: f.host});
  assert.equal(resolved, await fs.realpath(path.join(packageRoot, 'lib', 'index.js')));
  await prepareSetup({bundleRoot: f.bundle, harnessRoot: f.host, stateRoot: f.stateRoot});
  assert.equal((await doctor({bundleRoot: f.bundle, toolsModule: resolved})).status, 'OK');
  await assert.rejects(fs.stat(path.join(f.bundle, 'node_modules')), {code: 'ENOENT'});
  await assert.rejects(resolveToolsModule({harnessRoot: f.host, toolsModule: f.toolsModule}), /exactly one/);
});

test('existing generated links and non-files cannot overwrite external data', async t => {
  const f = await fixture(t), local = path.join(f.bundle, '.local'), protectedFile = path.join(f.temporary, 'protected.mjs');
  await fs.mkdir(local); await fs.writeFile(protectedFile, 'protected');
  await fs.link(protectedFile, path.join(local, 'entry.mjs'));
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: f.stateRoot}), /Refusing linked/);
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'protected');
  await fs.unlink(path.join(local, 'entry.mjs')); // Test-owned link only.
  await fs.mkdir(path.join(local, 'host-patch.yml'));
  await assert.rejects(prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule, stateRoot: f.stateRoot}), /non-regular/);
  await assert.rejects(fs.stat(path.join(local, 'entry.mjs')), {code: 'ENOENT'});
});

test('doctor explains fresh setup and detects missing defineTool without starting plugin', async t => {
  const f = await fixture(t);
  let report = await doctor({bundleRoot: f.bundle});
  assert.equal(report.status, 'NEEDS_SETUP');
  assert.match(report.checks.at(-1).detail, /setup.mjs/);
  const invalidTools = path.join(f.host, 'not-tools.mjs'); await fs.writeFile(invalidTools, 'export const unrelated = 1;');
  await prepareSetup({bundleRoot: f.bundle, toolsModule: invalidTools, stateRoot: f.stateRoot});
  report = await doctor({bundleRoot: f.bundle});
  assert.equal(report.status, 'INVALID'); assert.match(report.checks.at(-1).detail, /defineTool/);
  assert.equal(report.startupPerformed, false); assert.equal(report.hostServicesChecked, false);
});

test('integrity verifies listed files and refuses tampering, traversal and duplicate entries', async t => {
  const f = await fixture(t), filename = path.join(f.bundle, 'src', 'plugin.mjs');
  const entry = {path: 'src/plugin.mjs', sha256: createHash('sha256').update(await fs.readFile(filename)).digest('hex')};
  const manifestPath = path.join(f.bundle, 'portable-manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, files: [entry]}));
  assert.equal((await verify(f.bundle)).ok, true);
  await fs.appendFile(filename, '\n// Synthetic tamper');
  assert.deepEqual((await verify(f.bundle)).failures, ['src/plugin.mjs']);
  await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, files: [entry, entry]}));
  await assert.rejects(verify(f.bundle), /duplicate/);
  await fs.writeFile(manifestPath, JSON.stringify({schemaVersion: 1, files: [{...entry, path: '../outside'}]}));
  await assert.rejects(verify(f.bundle), /Unsafe/);
});

test('default state path is host-home based, never created by setup', async t => {
  const f = await fixture(t);
  const result = await prepareSetup({bundleRoot: f.bundle, toolsModule: f.toolsModule});
  assert.equal(result.stateRoot, path.join(os.homedir(), '.dsh', 'portable-multi-agent-state'));
  assert.equal(result.entryPath.startsWith(path.join(f.bundle, '.local') + path.sep), true);
});
