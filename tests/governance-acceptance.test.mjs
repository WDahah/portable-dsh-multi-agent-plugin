import test from 'node:test';
import assert from 'node:assert/strict';
import {healProfileFallback} from '../scripts/governance-acceptance.mjs';

// Synthetic host modules only: no installation under acceptance, no boot, no provider call.
const anchor = 'C:/install/node_modules/@deepseek-ai/dsh/package.json';
const home = 'C:/disposable-home';

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
