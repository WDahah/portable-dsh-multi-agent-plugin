import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {defaultStateRoot} from '../src/plugin.mjs';

const root = path.resolve(import.meta.dirname, '..');

// The bundle contract a host relies on when this package is installed with `dsh plugin add`: the
// manifest names a patch, the patch mounts the package by name, and the entry resolves the host's
// tools module itself. No host is started and no provider is called.
test('the package declares a bundle whose patch mounts it by name', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(typeof manifest.main, 'string');

  const patch = await fs.readFile(path.join(root, manifest.dsh.bundle.patch.replace(/^\.\//, '')), 'utf8');
  assert.match(patch, /^- insert:/m, 'the patch must mount the plugin, not only override an existing row');
  assert.equal(patch.split('name:').length - 1, 1, 'exactly one mounted row, so this patch cannot shadow another');
  assert.match(patch, new RegExp(`^\\s+name: ${manifest.name}$`, 'm'), 'an installed bundle is resolved by package name, not by file path');
  // A state directory baked into the shipped patch would be wrong on every other machine.
  assert.doesNotMatch(patch, /stateRoot:/, 'the bundle patch must let the plugin default its state root');

  const entry = await fs.readFile(path.join(root, manifest.main), 'utf8');
  assert.match(entry, /@deepseek-ai\/dsh-tools/, 'the host supplies its own tools module to an installed bundle');
  assert.match(entry, /DSH_HOME/, 'a linked checkout resolves the tools module from the installation instead');
  assert.match(entry, /createPlugin\(/);
  const plugin = await import(pathToFileURL(path.join(root, 'src', 'plugin.mjs')).href);
  assert.equal(typeof plugin.createPlugin, 'function');
});

test('the default state root follows the host home, and is absolute either way', () => {
  const saved = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.join(root, 'host-home');
    assert.equal(defaultStateRoot(), path.join(root, 'host-home', 'portable-multi-agent-state'));
    delete process.env.DSH_HOME;
    assert.equal(defaultStateRoot(), path.join(os.homedir(), '.dsh', 'portable-multi-agent-state'));
    assert.equal(path.isAbsolute(defaultStateRoot()), true);
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
  }
});
