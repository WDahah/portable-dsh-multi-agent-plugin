import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {healProfileFallback, presetHostApi, presetHostRows} from '../scripts/governance-acceptance.mjs';

// Synthetic host modules only: no installation under acceptance, no boot, no provider call.
const anchor = 'C:/install/node_modules/@deepseek-ai/dsh/package.json';
const home = 'C:/disposable-home';

/** A synthetic installation exposing exactly the preset packages named. */
async function syntheticInstall(t, names) {
  const install = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-api-'));
  t.after(() => fs.rm(install, {recursive: true, force: true}));
  for (const name of names) await fs.mkdir(path.join(install, 'node_modules', '@deepseek-ai', name), {recursive: true});
  return install;
}

test('healProfileFallback: absent module (0.1.7-rc.2 and later) is a supported host state', async () => {
  assert.deepEqual(await healProfileFallback(undefined, {installAnchor: anchor, home}), {
    healed: false,
    reason: 'HOST_RESOLVES_INSTALLATION_PACKAGES_FROM_ANCHOR'
  });
});

test('healProfileFallback: a non-function export is treated as absent, never called', async () => {
  assert.equal((await healProfileFallback({healProfilesModuleFallback: null}, {installAnchor: anchor, home})).healed, false);
});

test('healProfileFallback: a host that ships the heal receives the exact anchor and home', async () => {
  const calls = [];
  const result = await healProfileFallback({healProfilesModuleFallback: options => {calls.push(options);}}, {installAnchor: anchor, home});
  assert.deepEqual(result, {healed: true});
  assert.deepEqual(calls, [{installAnchor: anchor, home}]);
});

test('presetHostApi: prefers the split registry, accepts the legacy one, else reports absent', async t => {
  assert.equal(await presetHostApi(await syntheticInstall(t, ['dsh-agent-preset-registry', 'dsh-agent-preset'])), 'registry');
  assert.equal(await presetHostApi(await syntheticInstall(t, ['dsh-agent-presets'])), 'roots');
  // A transitioning installation that carries both takes the API the newer profile rows use.
  assert.equal(await presetHostApi(await syntheticInstall(t, ['dsh-agent-preset-registry', 'dsh-agent-presets'])), 'registry');
  assert.equal(await presetHostApi(await syntheticInstall(t, [])), null);
});

test('presetHostRows: a roots host keeps the authored directory as a configured root', async t => {
  const rows = await presetHostRows({install: await syntheticInstall(t, ['dsh-agent-presets']), presetRoot: 'C:/presets', presetId: 'governed',
    presetPlugins: [{id: 'noop'}], name: 'owned preset', description: 'no capabilities'});
  assert.deepEqual(rows, {api: 'roots', packages: ['dsh-agent-presets'],
    configs: {'dsh-agent-presets': {default: 'governed', roots: [{path: 'C:/presets', trust: 'user'}], includeShippedRoot: false, includeUserRoot: false}}, rows: []});
});

test('presetHostRows: a registry host takes a default and the preset is declared with its plugins', async t => {
  const presetPlugins = [{id: 'noop', name: 'file:///noop.mjs'}];
  const rows = await presetHostRows({install: await syntheticInstall(t, ['dsh-agent-preset-registry', 'dsh-agent-preset']), presetRoot: 'C:/presets',
    presetId: 'governed', presetPlugins, name: 'owned preset', description: 'no capabilities'});
  assert.deepEqual(rows, {api: 'registry', packages: ['dsh-agent-preset-registry', 'dsh-agent-preset'], configs: {'dsh-agent-preset-registry': {default: 'governed'}},
    rows: [{id: 'preset-governed', name: '@deepseek-ai/dsh-agent-preset',
      config: {id: 'governed', name: 'owned preset', description: 'no capabilities', plugins: presetPlugins}}]});
});

test('presetHostRows: a host with neither preset API refuses by name', async t => {
  await assert.rejects(presetHostRows({install: await syntheticInstall(t, []), presetRoot: 'C:/presets', presetId: 'governed',
    presetPlugins: [], name: 'owned preset', description: 'no capabilities'}), {code: 'PRESET_API_ABSENT'});
});
