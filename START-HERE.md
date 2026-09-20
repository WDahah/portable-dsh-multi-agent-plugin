# Start here

## What you copied

A portable **DSH/Cordis native plugin** and offline tests—not a standalone AI runtime, authenticated accounts, or ready-qualified model pools. It works with general software projects; the destination needs a compatible host exposing native `tools`, `llm` and `subagents` APIs.

## Fast path

1. Read [README.md](README.md) and [security and limits](docs/SECURITY-AND-LIMITS.md).
2. To have another AI install it, copy the full prompt in [INSTALL-WITH-AI.md](INSTALL-WITH-AI.md), filling in the real portable-folder path, project path and objective.
3. Confirm **Node.js >=22**, an installed compatible DSH host, and this folder's actual package/scripts.
4. In this folder, run the offline preparation commands:

   ```sh
   node scripts/verify.mjs
   npm test
   node scripts/setup.mjs --tools-module "<actual-host-dsh-tools/lib/index.js>" --state-root "<absolute fresh state directory>"
   node scripts/doctor.mjs
   ```

   Verify requires the finalized `portable-manifest.json`; it detects missing/modified listed files, not unlisted additions, and is not an authenticity signature. Stop on a mismatch or missing manifest rather than inventing successful verification.

   `--state-root` is optional; specifying it isolates your state. Supply exactly one of `--tools-module` or the alternative `--harness-root "<absolute installed host directory>"` discovery option, not both. This package uses Node built-ins; `npm install` is not needed. These commands do **not** install DSH.
5. Inspect `.local/entry.mjs` and `.local/host-patch.yml`. Setup generates only those files. Doctor is offline; neither command proves live provider access.
6. Back up the **active user-owned host patch** and merge the generated root insertion. Do not overwrite the patch wholesale, edit shipped presets, or blindly install colliding `orchestrator_*` tools. Follow the actual host's reload procedure.
7. Verify that the host exposes the eleven orchestrator tools. Authenticate providers through the supported host UI, never by putting secrets in chat.
8. In the **same root agent session** that will use the chosen project, discover real routes and run a small number of exact `orchestrator_qualify` probes. They can consume quota or money. Previous-machine successes do not transfer; evidence expires after24 hours.
9. Start with a read-only `orchestrator_delegate` task using [examples/task.json](examples/task.json) plus the scoped prompt in [examples/PROJECT-PROMPT.md](examples/PROJECT-PROMPT.md).

## What “ready” means

- Offline tests passed: local synthetic tests only.
- Generated files passed doctor: local candidate installation only.
- Tools visible in the intended running host: activation verified.
- Exact route/effort passed a live echo challenge in this session: basic text/tool eligibility verified.
- Your scoped project task completed and its output was read back: actual use verified.

A missing compatible host or unavailable qualified route is a reason to stop and report—not invent a successful installation.

## Important defaults

**$1 is a soft target**, not a spending ceiling; normal host security policies still apply. Read-only agents can continue bounded unfinished work; uncertain or potentially side-effecting attempts are not blindly replayed. Direct tasks have a 15-minute deadline beginning at plan time. Unknown subscription cost means **unknown**, not zero. Image/specialist-domain work needs evidence beyond the basic smoke test. See [USAGE.md](docs/USAGE.md) before allowing project writes.
