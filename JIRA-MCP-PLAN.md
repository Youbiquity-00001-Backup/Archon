# Jira MCP — global availability on Fargate

Plan to make a Jira MCP server available on **every** Claude workflow spawn
running on the youbiquity Archon Fargate fleet, without requiring each
workflow YAML to opt in.

The credential plumbing already exists (commit `5699426`, `feat(user-creds):
add jira PAT provider to /archon-creds`). Per-user `JIRA_BASE_URL` /
`JIRA_EMAIL` / `JIRA_API_TOKEN` env vars now overlay onto every worker
subprocess. **Nothing reads them yet** — this plan wires up the consumer.

---

## Goal

A user with linked Jira creds can invoke any Claude workflow (default or
custom, bundled or `.archon/`-defined, in-tree or in a worktree) and the
assistant has Jira tools available without any per-workflow configuration.

A user **without** linked Jira creds gets the same workflows working as
before — the MCP either is not spawned for them or spawns and fails to
auth on first call (gating decision below).

## Out of scope

- Codex and Pi providers — neither supports MCP through Archon's standard
  `mcpServers` path (`packages/providers/src/{codex,community/pi}/capabilities.ts`).
  Jira tooling on those providers needs a separate design.
- Confluence MCP. `mcp-atlassian` exposes both, but Confluence creds are
  not part of the `/archon-creds jira` scope. Default config should
  disable Confluence to avoid noise on tool listings.
- OAuth-based Atlassian MCP. Out of scope until we add an OAuth flow to
  `/archon-creds jira` (see `feat(user-creds): add jira PAT provider`
  commit message — modal+PAT was the chosen scope, OAuth is deferred).

## Current state

- **Creds plumbing**: ✅ live on dev (`archon-dev.vesselhaven.com`),
  `5699426`. `getEnvOverlay()` emits the three `JIRA_*` env vars for any
  user with linked Jira creds.
- **MCP loader**: `packages/providers/src/claude/provider.ts:262
loadMcpConfig(mcpPath, cwd)` — single file, per-node, expands env vars
  at execution time. Called from per-node config build only.
- **Global MCP surface**: none. No `globalMcp` key in
  `.archon/config.yaml` schema; no merge step in the Claude provider.
- **Image (`/Dockerfile` line 67)**: bun:1.3.11-slim + apt + gh + node
  (purged after build). **No `uv` / `uvx`.** `mcp-atlassian` runs via
  `uvx`, so the image has to grow.
- **MCP capability**: Claude only. Codex (`codex/capabilities.ts`)
  and Pi (`community/pi/capabilities.ts`) both have `mcp: false`.

## Design decisions

### D1 — Where does the "global MCP" config live?

Four candidates, ordered by my preference:

**A. `globalMcp:` list in `.archon/config.yaml`** ⭐ recommended

```yaml
globalMcp:
  - .archon/mcp/jira.json
```

The Claude provider reads this once at call build time, merges with
per-node `mcp:` entries (per-node wins on name conflicts), and hands the
combined set to the SDK.

- ✅ Configurable per environment (dev/prod can differ via overlay)
- ✅ Extensible — future global MCPs (internal docs, secrets vault) just
  add to the list
- ✅ Doesn't bake in policy about which MCP
- ✅ Same env-var-expansion path as per-node MCPs — zero new substitution
  logic
- ❌ New config surface — needs Zod schema, loader, doc
- ❌ Spawns even when current user has no Jira creds (mitigation: D2)

**B. Auto-inject when env vars are present**

Claude provider checks `process.env.JIRA_BASE_URL` at call build time;
if set, injects a hardcoded Atlassian MCP block.

- ✅ Zero config — links cred → MCP appears
- ❌ Magic — invisible coupling between cred shape and MCP choice
- ❌ Hardcoded to mcp-atlassian; changing args means a code deploy
- ❌ Breaks the "operator picks tools, user picks creds" separation

**C. Add to every bundled default workflow YAML**

Add `mcp: .archon/mcp/jira.json` to every node in
`.archon/workflows/defaults/*.yaml`.

- ✅ Uses existing mechanism — zero code change
- ❌ Doesn't apply to user-defined workflows
- ❌ Touches ~20 YAML files; rebundle on every change
- ❌ Per-node, not per-workflow — verbose

**D. Materialize an MCP config into per-user `~/.claude/`**

`materialize()` writes `~/.claude/mcp_servers.json` (or whatever the SDK
discovers) when Jira creds are present.

- ✅ Uses Claude SDK's own discovery — zero Archon code
- ❌ Need to confirm the SDK reads a global MCP file from `HOME` — I
  don't think it does in the form Archon spawns it
- ❌ Couples to per-user HOME; breaks for users who haven't linked
  anything but should still get the global MCP

**Decision needed before implementation**: A vs. B. Default to A unless
operator-friction is the binding constraint.

### D2 — Spawn-when-creds-missing behavior

If the current platform user has no Jira creds (`JIRA_BASE_URL` unset),
the MCP can either:

1. **Skip spawn** — Claude provider checks env presence before adding
   the server to `mcpServers`. Cleanest: no failed-auth tool calls,
   no "tool unavailable" surface area for unlinked users.
2. **Spawn anyway** — every Claude call spawns the MCP regardless;
   first tool call fails 401, model self-corrects.

Recommend (1). Implementation: in the global-MCP merge step, gate each
server by a configurable env-presence check. Could be a new field in
the MCP JSON like `requireEnv: ["JIRA_BASE_URL"]`, or a hardcoded
"all `${VAR}` references must be set" rule.

### D3 — Routing-call MCPs

The Claude provider makes a special "routing" call with `tools: []` to
classify intent. Including MCPs in that call buys nothing (no tools
exposed) and costs uvx cold-start latency.

Recommend: skip global MCPs when the SDK call has `tools: []`. Single
boolean check in the provider's call builder.

### D4 — Where do the Dockerfile changes land?

Two repos in play:

- `Archon` (this repo) — has `Dockerfile`. Changes here apply to all
  downstream forks of Archon.
- `archon-youbiquity` — overlay repo with `Dockerfile.user.example`
  and youbiquity-specific image deltas.

`uvx` and `uv` are general-purpose tools (not youbiquity-specific). The
_configuration_ (which MCP to use) is youbiquity-specific.

Recommend:

- **`uv` install** lands in `Archon/Dockerfile` — useful upstream too
  (anyone running Python MCP servers benefits)
- **`.archon/mcp/jira.json` + `globalMcp:` config entry** lands in
  `archon-youbiquity` overlay (or in `.archon/` of this fork — it's a
  soft-fork policy decision)

Open question: do we want to upstream the `globalMcp:` config feature
to `coleam00/Archon`? It's a clean general feature; worth a PR. Until
then, the patch lives here on the `youbiquity` branch and gets
re-applied on upstream merges (add to `PATCH-PLAN.md`).

## Implementation steps (assuming Decision D1=A, D2=skip, D3=skip-routing)

### Step 1 — Image: install `uv`

`Dockerfile` after the apt-install block (around line 77):

```Dockerfile
# uv: Python toolchain runner used by MCP servers (mcp-atlassian etc.)
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
```

Verify it lands at `/usr/local/bin/uvx` and is on `appuser`'s PATH.
Image size delta: ~30 MB.

**Optional pre-warm**: bake `mcp-atlassian` into the uv tool cache so
the first per-user spawn doesn't pay the download. Adds ~50 MB but
removes ~5 s from the first Jira tool call after a deploy:

```Dockerfile
RUN uv tool install mcp-atlassian
```

Tradeoff: pre-warming pins the version into the image (rebuild to
upgrade). Without it, `uvx mcp-atlassian` resolves the latest version
on each cold start. Recommend pre-warm for deploy stability.

### Step 2 — MCP config: `.archon/mcp/jira.json`

```json
{
  "mcpServers": {
    "atlassian": {
      "command": "uvx",
      "args": [
        "mcp-atlassian",
        "--toolsets",
        "jira_issues,jira_projects,jira_agile,jira_fields,jira_comments,jira_transitions,jira_links,jira_worklog,jira_attachments,jira_users,jira_watchers,jira_service_desk,jira_forms,jira_metrics,jira_development"
      ],
      "env": {
        "JIRA_URL": "${JIRA_BASE_URL}",
        "JIRA_USERNAME": "${JIRA_EMAIL}",
        "JIRA_API_TOKEN": "${JIRA_API_TOKEN}"
      },
      "requireEnv": ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]
    }
  }
}
```

Notes (verified against `mcp-atlassian` 0.21.x):

- **Env-var rename**: Archon emits `JIRA_BASE_URL`/`JIRA_EMAIL`,
  `mcp-atlassian` wants `JIRA_URL`/`JIRA_USERNAME`. The `${VAR}`
  substitution in `loadMcpConfig` bridges them at execution time
  (`packages/providers/src/claude/provider.ts`).
- **Toolset enumeration**: `--toolsets` requires individual toolset names;
  there is no `jira` umbrella value and no `--enabled-tools` flag in
  current versions. Listing all 15 Jira toolsets and omitting Confluence
  toolsets keeps Confluence tools out of the surface entirely (rather
  than letting them spawn and fail at first call).
- **`requireEnv`**: gates the spawn on per-user creds. Users without
  linked Jira creds silently skip — see Patch 3 in `PATCH-PLAN.md`.

### Step 3 — Config schema: `globalMcp`

Add to whatever Zod schema covers `.archon/config.yaml`. Search starting
from `packages/core/src/config/`.

```ts
globalMcp: z.array(z.string()).optional().default([]),
```

Each entry is a path (relative to the workspace root or absolute) to an
MCP JSON file in the same shape `loadMcpConfig` already parses.

### Step 4 — Claude provider: merge step

In the Claude `sendQuery` path (`packages/providers/src/claude/provider.ts`),
after building the per-node `mcpServers` map but before handing it to
the SDK:

1. If `assistantConfig.tools === []` (routing call), skip — return
   per-node MCPs as-is. Implements D3.
2. For each path in `config.globalMcp`, call `loadMcpConfig(path, cwd)`.
3. For each server in the loaded config, check `requireEnv` (or fall
   back to "all `${VAR}` substitutions resolved"). Skip if missing —
   log a `mcp_global_skipped_missing_env` debug line. Implements D2.
4. Merge into the per-node `mcpServers` map. Per-node wins on name
   conflicts (operator override).

### Step 5 — Bundled defaults regen

If `.archon/mcp/jira.json` and the new `globalMcp:` entry land inside
`.archon/`, run `bun run generate:bundled` so the defaults bundle ships
the change in compiled binaries.

### Step 6 — Tests

- Unit: `loadMcpConfig` already has tests. Add tests for the new
  global-merge step in the Claude provider — happy path, conflict
  precedence (per-node wins), env-missing skip, routing-call skip.
- Integration: add a smoke test against a workflow that opts into
  `tools: ["jira_get_issue"]` (or whichever tool name `mcp-atlassian`
  exposes) and stubs the MCP subprocess. Goal is to confirm the tool
  reaches the Claude SDK's available-tools list.

### Step 7 — Docs

- `packages/docs-web/src/content/docs/guides/mcp-servers.md` — add a
  "Global MCPs" subsection documenting `globalMcp:` and the env-presence
  gating rule.
- `CLAUDE.md` — extend the "Workflow Engine" section's MCP description
  to mention global MCPs.

## Rollout

1. **Local validation**: `bun run validate`. Run a workflow against a
   stubbed MCP and confirm the tool surface includes Jira tools.
2. **Dev deploy** (the only env that exists today): merge the patch,
   the existing infra hook auto-bumps `archon_sha` and deploys to
   `archon-dev.vesselhaven.com`.
3. **Smoke**: `/archon-creds jira` (already linked for the test user).
   Run any chat that should use Jira and confirm the model calls a
   Jira tool successfully.
4. **Watch logs** for `mcp_global_skipped_missing_env` (expected for
   unlinked users) and any uvx errors (cold-start, network, version).
5. **Prod**: doesn't exist yet (no GitHub Environments, no terraformed
   prod cluster). When prod gets stood up, the global MCP rides along
   automatically since the config lives in-repo.

## Risks and mitigations

- **uvx cold-start latency on first call after deploy** — first Jira
  tool invocation pays ~5 s for download. Mitigation: pre-warm in
  Dockerfile (Step 1 optional). Without pre-warming, set user
  expectation that first call is slow.
- **mcp-atlassian version drift** — community package, breaking changes
  possible. Mitigation: pin a specific version in the Dockerfile pre-warm
  (`uv tool install mcp-atlassian==X.Y.Z`); upgrade deliberately.
- **Spawning MCPs we don't use wastes worker slot resources** — every
  Claude call with tools enabled spawns the MCP subprocess. The SDK
  _may_ spawn lazily (verify before deploying). If not, we pay per
  call. Mitigation: D2 skip-when-unlinked already handles the common
  case; for linked users who don't use Jira tools, the cost is small
  but real.
- **Auth failures leak to model output** — if creds are wrong (revoked,
  rotated), the first Jira tool call returns a 401 the model surfaces.
  Mitigation: same as the rest of `/archon-creds` design — fail loud at
  the tool boundary, user re-runs `/archon-creds jira`.
- **Upstream merge conflicts** — `globalMcp:` is a real schema/code
  change and will conflict with upstream config schema edits. Mitigation:
  list this patch in `PATCH-PLAN.md` so future merges know to expect it.

## Open questions

1. D1 — config-driven (A) or env-driven auto-inject (B)?
2. Pre-warm `mcp-atlassian` in the Dockerfile, or accept first-call
   cold-start?
3. Is `globalMcp` a feature we want to PR upstream to `coleam00/Archon`,
   or keep on the `youbiquity` branch?
4. Confluence — disabled by default in Step 2, but should we add
   Confluence creds to `/archon-creds jira` (renaming the subcommand)
   or keep it Jira-only and let Confluence be a separate provider?
5. Do we want a per-workflow opt-out (`useGlobalMcp: false` on a node)
   for workflows that should NOT have MCPs spawned (security-sensitive,
   minimal-context workflows)?
