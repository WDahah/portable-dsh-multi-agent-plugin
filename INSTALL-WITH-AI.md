# Install with any capable AI assistant

Copy this entire prompt into the AI you want to help with installation. Replace the three bracketed values first. The AI must be able to inspect local files and the intended host; a chat-only AI can explain the steps but cannot claim it executed them.

```text
Install the portable Multi-agent folder on this machine and use it with my chosen, unrelated project.

Portable folder: <actual absolute folder path>
Project: <actual absolute project path>
Initial project objective: <concrete bounded task>

Authority and scope:
- Discover the actual working directory, OS and paths; do not reuse another machine's paths.
- Read the portable README.md and docs/SECURITY-AND-LIMITS.md first, then START-HERE.md and docs/USAGE.md.
- You may run offline tests/setup/doctor, create the documented local entry and candidate patch, and back up and merge the necessary plugin insertion into the active user-owned host patch after identifying it exactly. Preserve unrelated configuration.
- You may run a small number of bounded live qualifications using public synthetic prompts, then one scoped read-only acceptance task. Disclose that these calls may consume paid or subscription quota. No separate per-call budget approval is needed from me; $1 is a soft target, not a cap.
- This permission does not bypass the host's sandbox, file permissions, approval policies, provider terms, or other security controls. If they deny an operation, report it and stop that operation.
- Do not delete files, uninstall providers, copy old state, or modify project source during installation. Begin project work read-only. Ask for an explicit file-write scope before implementation unless I already supplied one.

1. Establish the real prerequisites
- Confirm Node.js >=22 and inspect package.json plus scripts/setup.mjs and scripts/doctor.mjs. If the files are absent or their flags differ from the documentation, stop and report the mismatch; do not invent scripts.
- This is a DSH/Cordis native plugin, not a standalone agent framework. Identify the existing DSH version, host composition, active user profile, and actual installed dsh-tools/lib/index.js module.
- If DSH is absent, find current official DSH installation guidance through available documentation tools, report the official source, and follow only that supported procedure with the necessary authority. Do not invent npm package names, versions or CLI commands. If official guidance or a compatible host is unavailable, stop honestly.
- Use the host's exact Inspect APIs, if available, to confirm the tools, llm and subagents services and signatures. Otherwise inspect the installed API contracts. Require native registration, prepared LLM streaming, and scoped child-agent start/result/disposal; a model name or browser chat window alone is insufficient.
- The original compatibility reference is dsh-tools 0.1.5-rc.2/Cordis ^4.0.2, not a universal cross-version guarantee.

2. Prepare locally, without inference
- After copying the complete finalized folder, run node scripts/verify.mjs first. It reads portable-manifest.json and checks listed file hashes for modification/missing files. It is not a signature or authenticity proof and does not reject unlisted extra files. Stop on a missing manifest or failed check; do not regenerate the manifest to hide a mismatch. This command is offline and does not qualify models.
- Run npm test from the portable folder. These are offline synthetic tests, not live model qualification. No npm install is needed for this package's Node-built-in implementation; this does not install DSH.
- Choose an absolute, fresh, private state directory for this installation. Never copy another machine's .local entry, credentials, account files, qualification records or task journals.
- Run:
  node scripts/setup.mjs --tools-module "<actual-host-dsh-tools/lib/index.js>" --state-root "<absolute fresh state directory>"
- The state-root flag is optional; use it explicitly here. Supply exactly one of --tools-module or --harness-root. For discovery, replace the --tools-module option with --harness-root "<absolute installed host directory>"; do not supply both or guess a module path.
- Run node scripts/doctor.mjs, with its optional tools-module argument if required by its actual contract.
- Inspect the generated .local/entry.mjs and .local/host-patch.yml. Setup generates those two artifacts only and does not edit a live profile. Doctor is offline and does not prove authentication, provider success or runtime activation.

3. Activate through the actual user host composition
- Identify and back up the ACTIVE USER-OWNED host patch before changing it. Do not edit shipped preset directories or old deployment/source installations.
- Compare existing plugin rows and visible orchestrator_* tools. Do not install duplicate tool registrations. If an older orchestrator collides, identify its exact row, ownership and rollback mapping; disable that old row only under my installation authority, with backup. If you cannot identify it reliably, stop instead of deleting or rewriting broadly.
- Merge the generated root insertion into the existing patch without wholesale replacement or damage to unrelated rows. Follow the host's supported reload/restart behavior; do not start a replacement GUI server.
- Verify the entry actually loads and the expected nine orchestrator tools are visible. A file on disk, candidate YAML patch or successful doctor result is not runtime proof.
- Keep the backup and explain how the specific added row can be disabled or rolled back. Do not execute rollback unless required and authorized.

4. Discover and qualify this machine's routes
- Read src/routes.mjs. Its identifiers and effort expectations are deployment-specific candidates, not universal availability claims.
- Obtain provider/model inventory through the real host's registered services, including listModels and exact model/effort contracts where supported. Do not print credentials or whole settings objects.
- Authenticate only through the host's approved UI or official authentication flow. Never request API keys in chat, clipboard dumps or copied account files.
- Do not fabricate providers, aliases, effort support or qualifications. If the host uses different IDs, propose an explicit mapping change covering ROUTES, POOL_PRIORITY, expected efforts and related tests; obtain any additional source-edit authority needed, then requalify it. Do not silently substitute a similar model or convert synthetic fixtures into live records.
- In the SAME ROOT AGENT SESSION that will dispatch this project's work, call orchestrator_inventory and run orchestrator_qualify for only the needed exact route/effort pairs. Each must pass the real native-child text/tool echo challenge. Evidence is owner/session-scoped and expires after24 hours; a new project/session must establish its own evidence.
- Mark failed, unsupported or unauthenticated routes unavailable, with their observed outcome. Do not repeatedly retry a failed probe automatically, uninstall a provider, or claim every pool is ready when only one route passed.
- Generic text/tool smoke is not image or specialist-domain qualification. R05 requires image evidence; R08/R09 require domain evidence. Use a suitable general role for ordinary planning, coding or review, not a false specialist label.

5. Verify and begin the chosen project safely
- Use examples/task.json as TASK METADATA, not the entire tool request. For an initial read-only assignment, call orchestrator_delegate with a unique run_id, that task object, a complete prompt naming the actual project, allowed read paths, stop condition and expected output, and allowed_tools ["read","glob","grep"].
- Verify the selected provider/model/effort, returned child identity, saved output and terminal status with orchestrator_delegate_read. Do not claim all real tests passed merely because npm test passed.
- For direct-model continuation, use orchestrator_plan -> orchestrator_run -> orchestrator_read. Resume only a proven safe settled state; never reset or replay an uncertain task ID. A new diagnostic task is not evidence that an earlier failure was resolved.
- Keep project writes scoped. Add write/edit only for explicitly authorized implementation; use pwsh only when necessary and permitted. File-changing work must not automatically repeat after a token limit or unknown interruption.
- Do not invoke a workflow tool merely because multiple agents are useful. Use the native orchestrator delegation tools; use workflow tooling only when explicitly requested and supported.

Report separately:
A. Offline tests and generated candidate artifacts.
B. Verified host activation and exact installed row.
C. Fresh live qualifications: passed/failed route-effort pairs and owner/session scope.
D. Actual project acceptance result and saved output location.
E. Remaining limitations, unknown costs, state directory, and rollback backup.

Do not claim successful installation/use if a required stage was not observed. Stop on a missing/incompatible host, unsafe profile ambiguity, denied permission, or no qualified route for the task. Preserve partial output and explain the concrete limitation instead of inventing success.
```
