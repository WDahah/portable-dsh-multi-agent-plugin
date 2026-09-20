# A project-agnostic task prompt

Use this after installation and fresh qualification in the **same root agent session**. Replace every bracketed value. `task.json` is metadata; it does not itself name a project or authorize writes. See [USAGE.md](../docs/USAGE.md) for a complete delegation argument example.

## Initial read-only assignment

```text
Objective: [one concrete improvement or question]
Mode: INSPECT ONLY
Project root: [actual absolute path on this machine]
Allowed read paths: [specific files/directories within that project]
Expected output: [brief findings, proposed change and acceptance checks]
Stop condition: Return that output after at most [small number] relevant tool calls.

Use the orchestrator's qualified task-based route; do not invent a provider/model mapping or qualification. Work only on this objective. Read the project's own instructions before inspecting relevant files. Do not edit files, run shell commands, access network, delete anything, or delegate again. If a required path, permission or tool is unavailable, report that concrete limitation and stop rather than substitute invented results.

Separate observed facts from recommendations. Do not include credentials or unrelated source content in the answer. Give exact relevant paths and explain how the proposed change could be tested. Finish when the bounded objective is met.
```

Call `orchestrator_delegate` with a unique `run_id`, the metadata from `task.json`, the completed prompt, and `allowed_tools:["read","glob","grep"]`. Read the result back with `orchestrator_delegate_read`. This establishes a scoped real task result, not general model competence.

## Implementation only after explicit write authority

```text
Objective: Implement [one approved change] in [actual project root].
Mode: WRITE
Allowed reads: [paths needed for this change]
Allowed writes: [exact files; no other files may change]
Permitted commands: [specific necessary commands, or none]
Network: None unless I explicitly name and authorize an endpoint.
Acceptance checks: [specific expected behavior and tests]
Stop condition/tool budget: [bounded completion condition and call limit]

Read applicable project instructions and each existing target before editing. Preserve pre-existing unrelated changes. Use the already qualified route through the orchestrator; never fabricate evidence or broaden the scope. Do not delete files, modify credentials, change host profiles, install packages, or migrate databases unless separately authorized here.

If a call is interrupted or its side effects are uncertain, preserve available output and report what is known. Do not blindly repeat the operation or reset its task ID. File-changing agents do not automatically continue merely because a token limit was reached. Return the actual changed paths, observed acceptance-check results, remaining limits and saved assignment ID.
```

Add `write` and `edit` to `allowed_tools` only for this authorized scope. Add `pwsh` only if an explicitly permitted command needs it and normal host policy allows it. A soft budget never overrides those restrictions.

Use `standard` for ordinary planning, implementation and integration; `deep` when the work warrants a stronger model; `review` when judging another run; `vision` for image input; `domain` for a specialist field. Put what the task is *for* in `intent`: it is recorded and shown in the child's label, but never changes the routing. A category is a descriptive nonempty string, not a privilege. Do not use image/domain role labels to bypass missing capability evidence. Use the native delegation tool directly; do not request workflow tooling unless a workflow is actually part of the user's request.
