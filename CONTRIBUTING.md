# Contributing

Thank you for helping improve the portable DSH multi-agent plugin.

## Before you start

Read [START-HERE.md](START-HERE.md) and [Security and limits](docs/SECURITY-AND-LIMITS.md). This project is a native plugin for a compatible DeepSeek Harness/Cordis host, not a standalone agent runtime.

## Development checks

Use Node.js 22 or newer. From the repository root, run:

```sh
node scripts/manifest.mjs --check
node scripts/verify.mjs
npm test
```

**When you add, remove, or change any packaged file, regenerate the integrity manifest** with `node scripts/manifest.mjs`, then review the diff and re-run `verify`. CI runs `--check` on Linux, Windows, and macOS, so a stale manifest fails the build. Regenerating is the supported way to update the manifest for a reviewed change; it is not a way to paper over an unexpected one.

Never disable the line-ending rules in `.gitattributes`. The manifest hashes exact bytes, so a checkout that translates line endings makes verification fail for everyone on that platform.

Do not commit `.local/`, `node_modules/`, state directories, credentials, provider settings, or generated machine-local files.

## Pull requests

Keep changes focused. Update the relevant documentation and examples when behavior or setup changes. Explain the user-visible result, compatibility impact, security implications, and checks you ran. Do not claim live provider qualification from offline tests.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
