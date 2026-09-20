import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const DEFAULT_BUNDLE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SETUP_HELP = `Usage: node scripts/setup.mjs --tools-module <absolute dsh-tools/lib/index.js> [--state-root <absolute directory>]
   or: node scripts/setup.mjs --harness-root <absolute installed host directory> [--state-root <absolute directory>]
Generates only .local/entry.mjs and .local/host-patch.yml. No host configuration is applied.
The tools module is supplied by the existing DSH host, never downloaded or vendored.
Regenerate after moving the folder. Do not distribute .local or your state directory.`;

export function assertNode(version = process.versions.node) {
  if (!/^\d+\./.test(version) || Number(version.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
}
export function parseArgs(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') {result.help = true; continue;}
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new Error(`Unknown or duplicate option: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    result[key] = value;
  }
  return result;
}
function absolute(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must not contain control characters.`);
  return path.resolve(value);
}
async function regularFile(filename) {
  const actual = await fs.realpath(filename);
  if (!(await fs.stat(actual)).isFile()) throw new Error(`Expected a regular file: ${filename}`);
  return actual;
}
export async function resolveToolsModule({toolsModule, harnessRoot} = {}) {
  if ((toolsModule !== undefined) === (harnessRoot !== undefined)) throw new Error('Supply exactly one of --tools-module or --harness-root.');
  let filename;
  if (toolsModule !== undefined) filename = absolute(toolsModule, 'toolsModule');
  else {
    const root = absolute(harnessRoot, 'harnessRoot');
    if (!(await fs.stat(root)).isDirectory()) throw new Error('harnessRoot must be a directory.');
    filename = createRequire(path.join(root, 'package.json')).resolve('@deepseek-ai/dsh-tools');
  }
  return regularFile(filename);
}
function yamlString(value) {return "'" + value.replaceAll("'", "''") + "'";}
async function checkOwnedTarget(filename) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`Refusing linked or non-regular generated target: ${filename}`);
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
}
/** Local generation only. Inputs and the existing host module are trusted user selections. */
export async function prepareSetup({bundleRoot = DEFAULT_BUNDLE_ROOT, toolsModule, harnessRoot, stateRoot} = {}) {
  assertNode();
  const bundle = await fs.realpath(absolute(bundleRoot, 'bundleRoot'));
  const tools = await resolveToolsModule({toolsModule, harnessRoot});
  await regularFile(path.join(bundle, 'src', 'plugin.mjs'));
  const state = absolute(stateRoot ?? path.join(os.homedir(), '.dsh', 'portable-multi-agent-state'), 'stateRoot');
  const relativeState = path.relative(bundle, state);
  if (relativeState === '' || (!relativeState.startsWith('..' + path.sep) && relativeState !== '..' && !path.isAbsolute(relativeState))) throw new Error('State must be outside the portable bundle; do not transport history with code.');
  // Resolve an existing state ancestor too, so a link cannot disguise a state directory inside this bundle.
  let ancestor = state, suffix = [];
  while (true) {
    try {ancestor = await fs.realpath(ancestor); break;}
    catch (error) {if (error.code !== 'ENOENT') throw error; const parent = path.dirname(ancestor); if (parent === ancestor) throw error; suffix.unshift(path.basename(ancestor)); ancestor = parent;}
  }
  const resolvedState = path.join(ancestor, ...suffix), resolvedRelative = path.relative(bundle, resolvedState);
  if (resolvedRelative === '' || (!resolvedRelative.startsWith('..' + path.sep) && resolvedRelative !== '..' && !path.isAbsolute(resolvedRelative))) throw new Error('State resolves inside the portable bundle.');
  const local = path.join(bundle, '.local');
  try {const stat = await fs.lstat(local); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing linked or non-directory .local.');}
  catch (error) {if (error.code !== 'ENOENT') throw error; await fs.mkdir(local, {mode: 0o700});}
  const entryPath = path.join(local, 'entry.mjs'), patchPath = path.join(local, 'host-patch.yml');
  await checkOwnedTarget(entryPath); await checkOwnedTarget(patchPath);
  const entry = `// Generated locally; regenerate after moving this bundle. Do not distribute .local.\nimport { defineTool } from ${JSON.stringify(pathToFileURL(tools).href)};\nimport { createPlugin } from '../src/plugin.mjs';\nexport default createPlugin(defineTool);\n`;
  const patch = `# Merge into the ACTIVE USER HOST composition, never an agent preset.\n# Disable another copy registering orchestrator_* tools before enabling this one.\n- insert:\n    - id: portable-multi-agent\n      name: ${yamlString(pathToFileURL(entryPath).href)}\n      config:\n        stateRoot: ${yamlString(state)}\n        enabled: true\n`;
  await fs.writeFile(entryPath, entry, {encoding: 'utf8', mode: 0o600});
  await fs.writeFile(patchPath, patch, {encoding: 'utf8', mode: 0o600});
  return {entryPath, patchPath, toolsModule: tools, stateRoot: state, hostModified: false, providerCalls: 0};
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, ['--tools-module', '--harness-root', '--state-root']);
  if (args.help) {console.log(SETUP_HELP); return;}
  const result = await prepareSetup({toolsModule: args['--tools-module'], harnessRoot: args['--harness-root'], stateRoot: args['--state-root']});
  console.log(JSON.stringify(result, null, 2));
  console.log('Merge the generated patch into your ACTIVE USER HOST configuration, not an agent preset. Back up that configuration first.');
  console.log('If orchestrator_* tools already exist, disable the other copy before enabling this one; duplicate tools must not overwrite one another.');
  console.log('Host prerequisites: Cordis tools, llm, and subagents with spawn. Setup did not inspect live tools, authenticate, qualify routes, install packages, apply the patch, or restart the host.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {console.error(`Setup failed: ${error.message}`); process.exitCode = 1;});
