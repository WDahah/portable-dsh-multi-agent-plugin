# Contributing

Thank you for helping improve the portable DSH multi-agent plugin.

## Before you start

Read [START-HERE.md](START-HERE.md) and [Security and limits](docs/SECURITY-AND-LIMITS.md). This project is a native plugin for a compatible DeepSeek Harness/Cordis host, not a standalone agent runtime.

## Development checks

Use Node.js 22 or newer. From the repository root, run:

```sh
node scripts/verify.mjs
npm test
```

Do not commit `.local/`, `node_modules/`, state directories, credentials, provider settings, or generated machine-local files.

## Pull requests

Keep changes focused. Update the relevant documentation and examples when behavior or setup changes. Explain the user-visible result, compatibility impact, security implications, and checks you ran. Do not claim live provider qualification from offline tests.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
