import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DEFAULT_BUNDLE_ROOT, assertNode, parseArgs, resolveToolsModule} from './setup.mjs';

export const DOCTOR_HELP = `Usage: node scripts/doctor.mjs [--tools-module <absolute host dsh-tools/lib/index.js>]
Checks local source and generated entry imports without applying a Cordis plugin.
Importing modules executes their trusted top-level code. No credentials, provider calls,
route qualifications, host services, or live duplicate registrations are checked.`;
/** Offline inspection only: importing a plugin is not applying or starting it. */
export async function doctor({bundleRoot = DEFAULT_BUNDLE_ROOT, toolsModule} = {}) {
  const checks = [];
  const result = {status: 'OK', checks, startupPerformed: false, hostServicesChecked: false, credentialsChecked: false, routesQualified: false, liveDuplicateToolsChecked: false};
  try {assertNode(); checks.push({name: 'node', ok: true, version: process.versions.node});}
  catch (error) {checks.push({name: 'node', ok: false, detail: error.message}); result.status = 'INVALID'; return result;}
  if (typeof bundleRoot !== 'string' || !path.isAbsolute(bundleRoot)) {result.status = 'INVALID'; checks.push({name: 'bundle', ok: false, detail: 'Absolute bundleRoot required.'}); return result;}
  const bundle = path.resolve(bundleRoot);
  for (const relative of ['package.json', 'src/plugin.mjs']) {
    try {const stat = await fs.stat(path.join(bundle, relative)); if (!stat.isFile()) throw new Error('Not a regular file'); checks.push({name: relative, ok: true});}
    catch (error) {checks.push({name: relative, ok: false, detail: error.message}); result.status = 'INVALID';}
  }
  if (result.status !== 'OK') return result;
  let source;
  try {source = await import(pathToFileURL(path.join(bundle, 'src', 'plugin.mjs')).href); if (typeof source.createPlugin !== 'function') throw new Error('src/plugin.mjs must export createPlugin(defineTool).'); checks.push({name: 'sourceFactory', ok: true});}
  catch (error) {checks.push({name: 'sourceFactory', ok: false, detail: error.message}); result.status = 'INVALID'; return result;}
  if (toolsModule !== undefined) {
    try {
      const filename = await resolveToolsModule({toolsModule});
      const host = await import(pathToFileURL(filename).href);
      if (typeof host.defineTool !== 'function') throw new Error('Host module does not export defineTool.');
      const candidate = source.createPlugin(host.defineTool);
      if (typeof candidate?.apply !== 'function' || !Array.isArray(candidate.inject) || !candidate.inject.includes('tools')) throw new Error('Factory must return a Cordis plugin with apply and tools injection.');
      checks.push({name: 'hostDefineTool', ok: true});
    } catch (error) {checks.push({name: 'hostDefineTool', ok: false, detail: error.message}); result.status = 'INVALID'; return result;}
  }
  const entry = path.join(bundle, '.local', 'entry.mjs'), patch = path.join(bundle, '.local', 'host-patch.yml');
  try {
    for (const filename of [entry, patch]) {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Generated files must be regular non-symlink files.');
    }
  } catch (error) {
    result.status = error.code === 'ENOENT' ? 'NEEDS_SETUP' : 'INVALID';
    checks.push({name: 'generatedFiles', ok: false, detail: error.code === 'ENOENT' ? 'Run scripts/setup.mjs with your host tools module, then run doctor again.' : error.message});
    return result;
  }
  try {
    const text = await fs.readFile(entry, 'utf8');
    const match = text.match(/^import \{ defineTool \} from ("(?:[^"\\]|\\.)*");$/m);
    if (!match) throw new Error('Generated entry is not recognized; regenerate it with setup.');
    const hostURL = JSON.parse(match[1]);
    if (!hostURL.startsWith('file:')) throw new Error('Generated tools import must be a local file URL.');
    const host = await import(hostURL);
    if (typeof host.defineTool !== 'function') throw new Error('Generated entry host module lacks defineTool.');
    const {default: plugin} = await import(pathToFileURL(entry).href + '?doctor=' + Date.now());
    if (typeof plugin?.apply !== 'function' || !Array.isArray(plugin.inject) || !plugin.inject.includes('tools')) throw new Error('Generated entry must export a Cordis plugin with apply and tools injection.');
    checks.push({name: 'generatedEntryImport', ok: true});
  } catch (error) {checks.push({name: 'generatedEntryImport', ok: false, detail: error.message}); result.status = 'INVALID';}
  return result;
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, ['--tools-module']);
  if (args.help) {console.log(DOCTOR_HELP); return;}
  const result = await doctor({toolsModule: args['--tools-module']});
  console.log(JSON.stringify(result, null, 2));
  console.log('Offline only: tools/llm/subagents(spawn), authentication, duplicate tool names, and route qualification require checks in the destination host.');
  process.exitCode = result.status === 'OK' ? 0 : result.status === 'NEEDS_SETUP' ? 2 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {console.error(`Doctor failed: ${error.message}`); process.exitCode = 1;});
