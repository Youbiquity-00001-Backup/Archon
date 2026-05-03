# youbiquity-branch patch plan

Patches carried on this branch on top of upstream main (`fd6d75e7`).
All intended to be contributable upstream as PRs against `coleam00/Archon`,
modulo the youbiquity-specific config payload (`.archon/mcp/jira.json`,
which references our Jira tenant via env vars only).

Branch: `youbiquity` (this branch).
Base: upstream/main at v0.3.10.
Target downstream: ECS Fargate deployment in
[`youbiquity-archon-infra`](https://github.com/Youbiquity-00001-Backup/youbiquity-archon-infra).

---

## Patch 1 — `user_env_vars`: per-user env injection

### Problem

Anthropic OAuth credentials are per-user (each user has their own
`.credentials.json` from `claude /login`). In a multi-tenant Archon
deployment we want each Claude SDK call to read the requesting user's
creds. The Claude Agent SDK's `query()` accepts per-call `env` already
(line 750-763 of `sdk.d.ts`); Archon's `claude.ts:328` already plumbs
`requestOptions.env` through. The missing piece is the
**user → env-var mapping** at the orchestrator's `requestOptions` build
site (`orchestrator-agent.ts:867-869`).

Today Archon has two env-var sources merged at that site:

1. `config.envVars` from `.archon/config.yaml` (process-wide)
2. `getCodebaseEnvVars(conversation.codebase_id)` (per-codebase)

This patch adds a third source: per-user env vars indexed by
`platformUserId`. Highest priority of the three (overrides the others).

### Shape

1. **Config schema addition** in `packages/core/src/config/config-loader.ts`:

   ```yaml
   # .archon/config.yaml
   userEnvVars:
     U01ABC123: # Slack user ID
       HOME: /home/appuser/.archon/users/U01ABC123
     U02DEF456:
       HOME: /home/appuser/.archon/users/U02DEF456
   ```

   Type: `Record<string, Record<string, string>>` on `MergedConfig`.
   Optional. Empty/missing → no overlay (backward compatible).

2. **Plumb `platformUserId` through `HandleMessageContext`** in
   `packages/core/src/types/index.ts`:

   ```typescript
   export interface HandleMessageContext {
     // existing...
     readonly platformUserId?: string;
   }
   ```

   Adapters that know the user ID populate it; others leave it `undefined`.

3. **Slack adapter** populates `platformUserId: event.user` when calling
   `handleMessage()`. (Adapter call site is in `server/src/index.ts:451`,
   not the adapter itself — the adapter passes `userId` via
   `SlackMessageEvent.user` which the server callback already destructures.)

4. **Orchestrator overlay** in `orchestrator-agent.ts` near line 854:

   ```typescript
   const userEnvVarsMap = config.userEnvVars ?? {};
   const userEnvVars =
     context.platformUserId && userEnvVarsMap[context.platformUserId]
       ? userEnvVarsMap[context.platformUserId]
       : {};
   const effectiveEnv = {
     ...(config.envVars ?? {}),
     ...dbEnvVars,
     ...userEnvVars, // user-level overrides codebase-level
   };
   ```

5. **Tests:**
   - `config-loader.test.ts`: parses `userEnvVars` correctly; absent →
     undefined; malformed → graceful warn
   - `orchestrator-agent` test (or a new `user-env-vars.test.ts`):
     given a context with `platformUserId` matching a userEnvVars entry,
     the SDK call receives the user's overlay merged with config + db
     env

### Out of scope for this patch

- Persisting `platformUserId` on the `conversations` table. Not
  needed — the user is known per-message via context.
- A web UI for managing `userEnvVars`. The deployment populates it
  from terraform/Secrets Manager into the mounted `config.yaml`.
- Telegram/Discord/GitHub adapters populating `platformUserId`. They
  can opt in independently; not required for AWS Phase A.

---

## Patch 2 — `POST /admin/drain`: graceful blue-task drain

### Problem

ECS Fargate CodeDeploy blue/green keeps blue tasks alive for
`terminationWaitTimeInMinutes` (planned: 240 / 4 hr) so in-flight
workflows can finish. ALB cleanly stops sending HTTP traffic to blue.
But Slack Socket Mode is outbound — blue's socket stays open and Slack
random-routes events to it, so blue picks up _new_ `@archon` mentions
and runs them on old code. We want blue to:

- Stop accepting new work (Slack mentions, web UI new conversations)
- Continue handling in-flight workflows (including posting to their
  existing Slack threads via the `WebClient`)

### Shape

1. **In-process flag** in `packages/server/src/index.ts`:

   ```typescript
   let acceptingNewWork = true;
   ```

   Exported from a small drain-state module so adapters and route
   handlers can both consult it.

2. **New endpoint** `POST /admin/drain` (auth via `Authorization: Bearer
<ADMIN_DRAIN_SECRET>`, secret read from env at startup, fail-closed
   if the env var is unset and the request arrives):

   ```typescript
   app.post('/admin/drain', async c => {
     const authz = c.req.header('Authorization');
     if (authz !== `Bearer ${process.env.ADMIN_DRAIN_SECRET}`) {
       return c.json({ error: 'unauthorized' }, 401);
     }
     setAcceptingNewWork(false);
     slack?.stop(); // closes SocketModeClient inbound only
     getLog().info('admin.drain_initiated');
     return c.json({ status: 'draining' });
   });
   ```

3. **Slack `app.stop()` semantics**: Slack Bolt's `App.stop()` stops
   the configured receiver (in our case `SocketModeReceiver`) but the
   underlying `WebClient` (used by `app.client.chat.postMessage`)
   remains usable for outbound calls. Verified by reading
   `@slack/bolt/dist/App.js` — `stop()` calls `receiver.stop()` only.
   In-flight workflows can keep posting to their existing threads.

4. **Web-adapter gate** in the new-conversation route handler:
   if `!acceptingNewWork`, return 503 with `{ error: 'draining' }`.
   Existing-conversation message endpoints stay open so users can
   continue conversations that started on blue.

5. **Tests:**
   - Route smoke: 401 without secret, 200 with secret, secret
     comparison is constant-time (re-use `timingSafeEqual` pattern)
   - Mock test: drain endpoint flips `acceptingNewWork` and calls
     `slack.stop()`
   - Web-adapter test: new-conversation request returns 503 when
     `acceptingNewWork === false`

### Out of scope for this patch

- Telegram/Discord/GitHub adapter draining. Phase A is Slack-first;
  others can be added when those adapters are deployed.
- A retry mechanism for the deploy script if the drain endpoint is
  briefly unreachable. CodeDeploy's `AfterAllowTraffic` Lambda can
  retry on its own.

---

## Patch 3 — `global_mcp`: per-environment global MCP servers

### Problem

Per-node `mcp:` config requires every workflow YAML to opt in by name.
That's the right primitive for workflow-specific tools (e.g. one workflow
needs the Postgres MCP), but wrong for cross-cutting integrations the
operator wants on **every** Claude call (Jira tools whenever the user has
linked Jira creds, internal docs MCP, secrets vault, etc.).

The youbiquity Fargate fleet already plumbs per-user `JIRA_BASE_URL`/
`JIRA_EMAIL`/`JIRA_API_TOKEN` via the user-creds patch. Nothing reads
those vars. We want every Claude workflow spawn — default or custom,
bundled or `.archon/`-defined, in-tree or in a worktree — to expose Jira
tools without per-workflow configuration.

### Shape

1. **Config schema addition** in `packages/core/src/config/config-types.ts`:

   ```yaml
   # .archon/config.yaml (or ~/.archon/config.yaml)
   globalMcp:
     - .archon/mcp/jira.json
   ```

   Type: `string[]` on `RepoConfig`, `GlobalConfig`, and the merged
   `MergedConfig`. Optional. Loader appends repo entries after global
   entries (`mergeRepoConfig` in `packages/core/src/config/config-loader.ts`).

2. **`MergedConfig.globalMcp` → `SendQueryOptions.globalMcp`**: new
   optional field on `SendQueryOptions` (`packages/providers/src/types.ts`).
   Both the orchestrator (`orchestrator-agent.ts`) and the dag executor
   (`dag-executor.ts`, including the loop-node options builder) plumb
   `config.globalMcp` through to every `sendQuery` call.

3. **Claude provider `applyGlobalMcp`** (`packages/providers/src/claude/provider.ts`):
   after `applyNodeConfig` populates per-node MCPs, walks each
   `globalMcp` path, calls `loadMcpConfig`, and merges:
   - **Per-node wins on name conflict** — operators can override a global
     server inside a specific node by re-declaring under the same name.
   - **Effective-env source for substitution + gating** — `applyGlobalMcp`
     receives the SDK call's effective env (process.env merged with
     `requestOptions.env`) and uses it for both `${VAR}` substitution and
     `requireEnv` lookup. Per-user overlays from the user_env_vars patch
     (Jira creds keyed by `platformUserId`) live in `requestOptions.env`
     only, not in `process.env`. Reading `process.env` alone would
     silently gate out every server for every user in a multi-tenant
     deploy.
   - **`requireEnv` gating** — each server may declare `requireEnv: ["VAR1", ...]`.
     If any required env var is missing or empty in the effective env, the
     server is silently skipped (debug log `claude.mcp_global_skipped_missing_env`).
     Without `requireEnv`, falls back to "all `${VAR}` substitutions resolved".
   - **Routing-call skip** — when `nodeConfig.allowed_tools === []` (the
     "no tools" idiom used by the router and `title-generator`), the
     entire global-MCP merge is skipped. No uvx cold-start cost when
     tools are disabled anyway.
   - **Load-error tolerance** — a single broken MCP file is warn-logged
     and skipped; other files in the list still load. One bad config
     doesn't take down every Claude workflow.
   - **`mcpServers` envelope unwrap** — `loadMcpConfig` now accepts both
     the existing flat `{ <name>: {...} }` shape and the
     `{ mcpServers: { <name>: {...} } }` envelope used by Claude Code's
     own settings file. Frictionless copy/paste.
   - **`requireEnv` strip** — the field is an Archon gating signal, not
     part of the SDK schema. Stripped before the server config is handed
     to the SDK.

4. **Image (`Dockerfile`)**: install `uv` and pre-warm `mcp-atlassian`
   into a system-wide tool dir (`/usr/local/share/uv/tools`) so every
   user shares one venv and the first per-user spawn doesn't pay the
   resolve+download. Unpinned — image rebuilds pick up whatever
   `mcp-atlassian` ships on PyPI; the layer SHA is the version handle.

5. **Jira config** (`.archon/mcp/jira.json`): Atlassian MCP server with
   `requireEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]` and
   env-var rename (`JIRA_BASE_URL` → `JIRA_URL`, `JIRA_EMAIL` →
   `JIRA_USERNAME`) so the existing `${VAR}` substitution bridges the
   names at execution time. Confluence is excluded by enumerating only
   the 15 Jira toolsets in `--toolsets` (verified against `mcp-atlassian`
   0.21.x — there is no `jira` umbrella value and the older
   `--enabled-tools` flag was removed).

6. **Tests**:
   - `provider.test.ts`: happy path, requireEnv missing → skip,
     per-node wins on conflict, routing-style call (`allowed_tools: []`)
     skips merge, fallback to ${VAR}-resolution gating, load failure on
     one file doesn't abort, empty-list no-op.
   - `dag-executor.test.ts`: `loadMcpConfig` accepts the
     `mcpServers` envelope.
   - `config-loader.test.ts`: globalMcp paths propagate, repo entries
     append after global entries, undefined when not configured.

### Out of scope for this patch

- Codex and Pi providers — neither supports MCP through the standard
  `mcpServers` pathway. Jira tooling on those providers needs a
  separate design.
- Confluence MCP. `mcp-atlassian` exposes both, but Confluence creds
  are not part of the `/archon-creds jira` scope.
- OAuth-based Atlassian MCP. Out of scope until `/archon-creds jira`
  grows an OAuth flow.

---

## Implementation order

1. **Patch 2 first** — smaller, more self-contained, doesn't touch the
   orchestrator hot path. Ship + test in isolation.
2. **Patch 1 after** — touches more files (types, config, orchestrator),
   benefits from the validated branch baseline that patch 2 establishes.
3. **Patch 3 (`global_mcp`)** — depends on patch 1's per-user env-overlay
   for the requireEnv gate to actually do anything useful. See
   [`JIRA-MCP-PLAN.md`](./JIRA-MCP-PLAN.md) for the design discussion.

Each patch is its own commit on `youbiquity`. All pass `bun run validate`
before being declared done.
