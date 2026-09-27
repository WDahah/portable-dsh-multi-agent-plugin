// Bundle entry, mounted through this package's own cordis.patch.yml when it is installed with
// `dsh plugin --profile <name> add`.
//
// The host supplies @deepseek-ai/dsh-tools to the plugins it mounts, so the package name is the
// first choice. A local `link:` checkout resolves imports from its own directory instead, where no
// node_modules exists, so the same module is then taken from the installation named by DSH_HOME.
// The portable flow keeps using its generated .local/entry.mjs, which takes an explicit tools path.
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createPlugin} from './plugin.mjs';

/**
 * The host's native defineTool, from the host when it supplies one and from the installation
 * otherwise.
 * @returns the defineTool function; throws when neither route resolves it.
 */
async function loadDefineTool() {
  try {
    return (await import('@deepseek-ai/dsh-tools')).defineTool;
  } catch (error) {
    const home = process.env.DSH_HOME;
    if (typeof home !== 'string' || home === '') throw error;
    const require = createRequire(path.join(home, 'package.json'));
    const resolved = require.resolve('@deepseek-ai/dsh-tools');
    return (await import(pathToFileURL(resolved).href)).defineTool;
  }
}

export default createPlugin(await loadDefineTool());
