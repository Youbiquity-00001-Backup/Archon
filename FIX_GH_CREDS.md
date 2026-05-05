# FIX_GH_CREDS — Stop embedding short-lived GitHub tokens in workspace remote URLs

> **Status:** **implemented** (steps 1, 2, 3, 4, 6, 7). Step 5 partial — orchestrator
> isolation path threads `gitEnv` end-to-end; pre-flight `syncWorkspace` in
> `discoverAllWorkflows` still uses default env (non-fatal call, deferred).
> **Scope:** the soft-fork at `Youbiquity-00001-Backup/Archon` (branch `main` / `youbiquity`).
> Original estimate: 1–2 days. Actual: ~2 hours, validated live against archon-dev via ECS Exec.

---

## 1. TL;DR

When `Archon` clones a repo, it embeds the user's current `GH_TOKEN` directly into the URL passed to `git clone`. Git stores the authenticated URL as `remote.origin.url` in the cloned `.git/config`. Subsequent `git fetch` operations against that workspace reuse the embedded token. **GitHub App user-to-server tokens (`ghu_*`) expire every 1 hour**, so every fetch more than an hour after clone fails with `could not read Password for 'https://ghu_xxx@github.com'`. The bug is invisible during local dev (workspace re-clones every time) but bites in production where workspaces persist on EFS across task replacements.

The credential-helper machinery to do this correctly **already exists** in the soft-fork (`UserCredsService.materialize()` writes `.git-credentials` + `.gitconfig` per user, `ensureFreshGithub` rewrites them on refresh). The URL-embedding short-circuits it. This doc describes the surgery to stop the bypass and the migration to clean up existing bad workspaces.

---

## 2. Symptom

User sends a chat message. Conversation has a codebase associated with it. The orchestrator tries to use the workspace, hits `syncWorkspaceBeforeCreate` (or the orchestrator's own pre-flight `syncWorkspace`), which runs `git fetch origin <branch>`. Git uses the embedded token in `.git/config`, which is dead. Error surfaces as:

```
"Failed to fetch base branch from origin: Sync fetch from origin/main failed:
 Command failed: git -C /home/appuser/.archon/workspaces/<owner>/<repo>/source fetch origin main
 fatal: could not read Password for 'https://ghu_xxxxxxxx@github.com': No such device or address."
```

The user sees a generic _"An unexpected error occurred. Try /reset to start a fresh session."_ in chat (from `dispatchToOrchestrator`'s catch). No workflow run is created, so the runs dashboard is empty.

**Reproduction recipe:** register a codebase via Web UI → Wait > 1 hour → send any chat message that triggers worktree creation. Token has expired, fetch fails.

---

## 3. Root cause (file:line)

### The bypass

`packages/core/src/handlers/clone.ts:282-291`

```ts
let cloneUrl = workingUrl;
const ghToken = options?.env?.GH_TOKEN ?? process.env.GH_TOKEN;
if (ghToken && workingUrl.includes('github.com')) {
  if (workingUrl.startsWith('https://github.com')) {
    cloneUrl = workingUrl.replace('https://github.com', `https://${ghToken}@github.com`);
  } else if (workingUrl.startsWith('http://github.com')) {
    cloneUrl = workingUrl.replace('http://github.com', `https://${ghToken}@github.com`);
  } else if (!workingUrl.startsWith('http')) {
    cloneUrl = `https://${ghToken}@${workingUrl}`;
  }
}
```

`cloneUrl` is what gets passed to `git clone`. Git stores it as `remote.origin.url`. Forever.

### The thing that exists but isn't reached

`packages/core/src/services/user-creds/index.ts:816-832`

```ts
if (creds.github) {
  // .git-credentials uses the canonical x-access-token form.
  const gitCredsPath = join(home, '.git-credentials');
  const line = `https://x-access-token:${creds.github.accessToken}@github.com\n`;
  await writeFile(gitCredsPath, line, { encoding: 'utf8' });
  ...
  // Minimal .gitconfig pointing at the per-user .git-credentials.
  const gitconfigPath = join(home, '.gitconfig');
  const cfg = '[credential]\n\thelper = store\n';
  await writeFile(gitconfigPath, cfg, { encoding: 'utf8' });
  ...
}
```

`ensureFreshGithub` (`user-creds/index.ts:637`) refreshes the OAuth token, calls `materialize`, which rewrites `.git-credentials`. So the helper _would_ serve a fresh token if git ever asked it — but git doesn't ask, because the URL has its own token already.

### The fetch path that doesn't thread HOME

`packages/git/src/repo.ts:104`

```ts
await execFileAsync('git', ['-C', workspacePath, 'fetch', 'origin', branchToSync], {
  timeout: 60000,
});
```

No `env` option. Git inherits the default container env, where `HOME=/home/appuser`. There is no `.gitconfig` or `.git-credentials` at `/home/appuser` (those live at `<usersDir>/<slackUserId>`), so even if we stripped the URL token, git would have no credential helper to consult.

### Why this is invisible to local dev

ECS task definition mounts EFS at `/home/appuser/.archon/workspaces` (`fs-098cbf76eeddd362e`, accesspoint `fsap-02e491e02fc31c3d4`, container path `/home/appuser/.archon/workspaces`). Workspaces persist across Fargate task replacements. Local dev typically re-clones every run, so the embedded token is always fresh.

---

## 4. What already works (keep, don't touch)

These pieces are correct and tested. The fix layers on top.

- **`UserCredsService.materialize`** (`user-creds/index.ts:793`) — writes `<usersDir>/<slackUserId>/{.git-credentials,.gitconfig,.claude/.credentials.json}`. Idempotent. chmod 600.
- **`UserCredsService.ensureFreshGithub`** (`user-creds/index.ts:637`) — refreshes near-expiry OAuth via the refresh-token endpoint, on 401 marks chain dead, on success rewrites `.git-credentials` and updates the cache. Already wired into `buildUserEnvOverlayForWorkflow` (`orchestrator-agent.ts:237`) so workflow execution gets a fresh token.
- **`UserCredsService.getEnvOverlay`** — returns `UserEnvOverlay` containing `HOME`, `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `JIRA_*`. The `HOME` here points at the per-user dir.
- **Tests** — `user-creds.test.ts:582` already verifies that `.git-credentials` is rewritten on refresh and `:614` that it's removed on tombstone. Don't break these.

---

## 5. Architecture target

After the fix:

1. `git clone` runs with `HOME=<userHome>` and a clean URL (no embedded auth). Git reads `<userHome>/.gitconfig` → finds `credential.helper = store` → reads `<userHome>/.git-credentials` → uses the token from there. The cloned `.git/config` records `remote.origin.url=https://github.com/<owner>/<repo>` (no auth).
2. `git fetch` runs with the same `HOME=<userHome>`. Same credential lookup, but now backed by the freshly-refreshed `.git-credentials` (because `ensureFreshGithub` ran first).
3. Existing workspaces with embedded tokens get their `remote.origin.url` normalized on first use. Idempotent — if no embedded auth, no-op.
4. PAT deployment still works: when `process.env.GH_TOKEN` is a PAT and there's no per-user creds, fall back to a system-level credential helper (or a process-level `.git-credentials`) — see step 6 below.

---

## 6. Implementation plan

### Step 1 — Stop embedding the token in the clone URL

**File:** `packages/core/src/handlers/clone.ts`
**Lines:** 279-291 (~13-line block, replaced with a comment + 1 line)

Replace the in-URL-token block with a comment explaining the new policy. The clean URL gets passed to `git clone`. The HOME-threaded credential helper (already in place at line 306-308) handles auth.

```ts
// Authentication is supplied via per-user `HOME` set in `options.env`,
// which threads `<userHome>/.gitconfig` (credential.helper=store) and
// `<userHome>/.git-credentials` (refreshed by ensureFreshGithub) to git.
// Embedding ${GH_TOKEN}@ in the URL was previously used as belt-and-suspenders
// but baked an expiring token into .git/config that no later refresh
// reaches. See FIX_GH_CREDS.md.
const cloneUrl = workingUrl;
```

**Edge case:** when `options.env` is absent (CLI-driven clones with no per-user identity), `cloneEnv` is `undefined`. Git uses the default `HOME`. Step 6 covers a fallback.

### Step 2 — Thread `env` through `syncWorkspace`

**File:** `packages/git/src/repo.ts`
**Lines:** 94-150 (function signature + the two `execFileAsync` git calls inside)

Add an optional `env` field to the options bag:

```ts
export async function syncWorkspace(
  workspacePath: RepoPath,
  baseBranch?: BranchName,
  options?: { resetAfterFetch?: boolean; env?: NodeJS.ProcessEnv }
): Promise<WorkspaceSyncResult> {
  ...
  await execFileAsync('git', ['-C', workspacePath, 'fetch', 'origin', branchToSync], {
    timeout: 60000,
    env: options?.env,
  });
  ...
}
```

Also do the same on the `git reset --hard` and `git rev-parse HEAD` calls inside `syncWorkspace` (any subprocess that might need credential lookup; reset/rev-parse don't but threading them is harmless and consistent).

### Step 3 — Thread `env` through worktree creation

**File:** `packages/isolation/src/providers/worktree.ts`
**Lines:** 769-830 (`syncWorkspaceBeforeCreate`) and the `createWorktree` caller chain.

`syncWorkspaceBeforeCreate(repoPath, configuredBaseBranch)` becomes `syncWorkspaceBeforeCreate(repoPath, configuredBaseBranch, env?)`. Plumb the `env` from `createWorktree` (line 709) which reads it from `IsolationRequest`.

### Step 4 — Thread `env` through `IsolationRequest`

**File:** `packages/isolation/src/types.ts`
**Lines:** `IsolationRequestBase` (line 21).

Add an optional field:

```ts
interface IsolationRequestBase {
  ...
  /**
   * Per-user environment overlay for git operations during isolation
   * setup (clone, fetch). Threaded down to `git` subprocesses so the
   * credential helper at $HOME/.gitconfig sees the user's
   * .git-credentials. When undefined, git uses the deployment default
   * env (typically with `process.env.GH_TOKEN` as fallback).
   */
  gitEnv?: NodeJS.ProcessEnv;
}
```

Then update every constructor of `IsolationRequest` (search for `IsolationRequest =` and `IsolationRequestBase` literals — there are a handful in `core/operations/isolation-operations.ts`, the orchestrator, and tests) to populate `gitEnv` from the user env overlay.

### Step 5 — Thread `env` through orchestrator pre-flight syncWorkspace

**File:** `packages/core/src/orchestrator/orchestrator-agent.ts`
**Lines:** 491-493.

The orchestrator's own `syncWorkspace` call (the non-fatal pre-flight) needs the same env. After `buildUserEnvOverlayForWorkflow(platformUserId)`, pass the overlay's `HOME` (and GH_TOKEN if you want belt-and-suspenders).

```ts
syncResult = await syncWorkspace(toRepoPath(codebase.default_cwd), undefined, {
  resetAfterFetch: isManagedClone,
  env: userEnvOverlay ? { ...process.env, ...userEnvOverlay } : undefined,
});
```

### Step 6 — Migration for existing workspaces on EFS

The bad embedded URLs are already on disk. Strip them on first use.

**File:** `packages/git/src/repo.ts:syncWorkspace` — before the `fetch` call.

```ts
// Strip any embedded auth from remote.origin.url left over from when
// Archon previously embedded GH_TOKEN at clone time. Idempotent:
// no-op if the URL is already clean. See FIX_GH_CREDS.md.
try {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', workspacePath, 'config', '--get', 'remote.origin.url'],
    { env: options?.env }
  );
  const current = stdout.trim();
  const stripped = stripEmbeddedAuth(current);
  if (stripped && stripped !== current) {
    await execFileAsync('git', ['-C', workspacePath, 'remote', 'set-url', 'origin', stripped], {
      env: options?.env,
    });
    getLog().info({ workspacePath }, 'workspace.origin_auth_stripped');
  }
} catch (err) {
  // Non-fatal: if we can't read/write origin, the fetch below will
  // surface a clear error.
  getLog().debug({ err, workspacePath }, 'workspace.origin_normalize_skipped');
}
```

`stripEmbeddedAuth` (new utility, colocated):

```ts
/**
 * Strip embedded `user[:pass]@` auth from an https URL. Leaves ssh/local
 * URLs and already-clean URLs unchanged.
 *
 *   https://ghu_xxx@github.com/o/r        → https://github.com/o/r
 *   https://x-access-token:abc@github.com → https://github.com
 *   https://github.com/o/r                → https://github.com/o/r  (no-op)
 *   git@github.com:o/r.git                → git@github.com:o/r.git  (no-op)
 */
export function stripEmbeddedAuth(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/, '$1');
}
```

Unit tests for this function are mandatory — see test plan.

### Step 7 — Fallback for non-orchestrator entry points

CLI-driven clones, GitHub-adapter-driven clones, and webhook flows may not have a per-user identity. They fall through with `options.env === undefined` → git uses the default `HOME`. Two paths to keep these working:

**Option A (recommended):** at server bootstrap, materialize a process-level `.git-credentials` for the deployment-wide `GH_TOKEN` if one is present. Symmetric to `materialize()` but writes to `process.env.HOME` (default `/home/appuser`). One-shot, on boot, idempotent. ~20 lines in `server/src/index.ts` or wherever bootstrap happens.

**Option B:** require deployments using OAuth-only auth to have at least one user materialized; CLI flows error out cleanly with "no GitHub identity available, set GH_TOKEN or link a user." Simpler, more restrictive.

Pick A unless you have a reason not to. Document the decision in the PR description either way.

---

## 7. Test plan

### Unit tests

- `packages/git/src/repo.test.ts` — add cases for `stripEmbeddedAuth` covering: `https://github.com/...`, `https://ghu_x@github.com/...`, `https://x-access-token:y@github.com/...`, `https://user:pass@github.com/...`, `git@github.com:...`, `https://gitlab.com/...`, `https://github.com/with@in/path` (false-positive sanity check).
- `packages/git/src/repo.test.ts` — verify `syncWorkspace({env: {HOME: '/test/home'}})` passes that env to `execFileAsync`.
- `packages/core/src/handlers/clone.test.ts` — update tests at lines 166, 186, 200, 208, 219, 248, 267, 295 (any test that currently asserts the URL passed to `git clone` contains the token). Now they should assert the URL is clean and `env.HOME` is threaded.

### Integration / behavioral tests

- `packages/core/src/services/user-creds.test.ts` — already covers `.git-credentials` rewrite on refresh. Confirm the rewrite is what `git fetch` actually consults (mock execFileAsync, assert HOME env propagation).
- `packages/isolation/src/providers/worktree.test.ts` — update `syncWorkspaceSpy` assertions (~10 places) to assert that the `env` argument is threaded when `IsolationRequest.gitEnv` is set.

### Manual smoke

- Re-register a codebase using OAuth (`/auth/github/initiate` flow). Wait 90 minutes (long enough for the original token to expire). Send a chat message — fetch must succeed via the refreshed token.
- With `GH_TOKEN` PAT set in env and no users linked, run `archon workflow run <name>` from CLI against a private repo. Clone + fetch must succeed via Step 7's fallback.
- After deploy, EFS has workspaces with embedded tokens. First fetch on each must log `workspace.origin_auth_stripped` and succeed.

### Regression watch

- Existing tests pass: `bun run validate` clean.
- Slack & Telegram message paths still work — they go through `dispatchToOrchestrator` which uses the same env-overlay path.
- GitHub adapter (webhooks) — confirm its clone path either threads its own env or falls through to Step 7's bootstrap helper.

---

## 8. Migration safety

`Step 6` rewrites `remote.origin.url` in-place on every fetch where the URL has embedded auth. Two failure modes to consider:

- **Race with concurrent git operations.** `git remote set-url` is atomic at the file level; concurrent fetches will either see the old URL (auth fails — same as today) or the new (auth via helper — succeeds). No corruption. Acceptable.
- **Locally-registered repos** (cwd not under `~/.archon/workspaces/`). These may have user-set remotes with intentional auth (PAT for a private mirror, etc.). The strip is destructive for that case. **Mitigation:** gate the migration on `isManagedClone` (already computed in `syncWorkspace`'s caller — line 794-796 of worktree.ts) and skip stripping on locally-registered repos.

---

## 9. Open questions

1. **Where does the GitHub adapter's clone happen?** I haven't traced its full path. If it has a separate clone code path that _also_ embeds tokens, Step 1 doesn't fix it. Search for `https://${` and `@github.com` outside of `clone.ts`.
2. **What about ssh URLs?** `git@github.com:o/r` doesn't go through the credential helper at all — relies on the configured ssh agent / keys. Out of scope but worth a sanity assertion that ssh URLs aren't touched by Step 6's normalizer.
3. **Token TTL probing.** Should `syncWorkspace` proactively call `ensureFreshGithub` itself (instead of relying on the orchestrator to call it first)? Argument for: defense in depth. Argument against: introduces a `userCreds` dep into `@archon/git`, which is currently dep-free. Likely answer: leave it where it is, document the contract that callers must call `ensureFreshGithub` first.
4. **Bootstrap helper for Step 7.** Where exactly does it go? Probably `packages/server/src/index.ts` immediately after `userCredsService` setup. PR review will clarify.

---

## 10. Confidence & risks

**Confidence on first PR landing clean: 75%.**

Remaining 25% breaks down:

- 10% — undiscovered call sites that build `IsolationRequest` and need `gitEnv` populated
- 10% — non-orchestrator entry points (CLI, GitHub adapter, webhooks) that need their own user-identity story or the Step 7 fallback
- 5% — EFS migration edge cases: locally-registered repos, ssh URLs, malformed `remote.origin.url` strings

**Risks:**

- _Locking out users mid-session._ If Step 1 ships but Step 7 doesn't and the deployment has no `GH_TOKEN` PAT or per-user identity, git fetches start failing across the board. Always ship Step 7 in the same PR.
- _Test brittleness in clone.test.ts._ Roughly 30 tests assert URL-with-token. Sweeping update; ensure no semantic regressions.
- _EFS-stuck deployments._ If `git remote set-url` fails for any reason on a workspace, fetch errors look identical to today's bug. Step 6's error log (`workspace.origin_normalize_skipped`) is the canary — if it ever fires in production, dig into why.

---

## 11. Out of scope (do not scope-creep)

- Migrating to a _real_ git credential helper (oauth refresh-on-demand via a script). Step 6 + the existing `credential.helper=store` are sufficient.
- Cross-platform credential storage (Keychain/macOS, Credential Manager/Windows). Server runs Linux containers only.
- Audit-trail enrichment (per-fetch user identity logging). Separate concern.
- Replacing `.git-credentials` flat-file with libsecret or similar. Same.

---

## 12. PR shape suggestion

Ship as one PR, not split. The seven steps are tightly coupled; a partial fix risks regressions worse than the current bug.

- Branch: `fix/gh-creds-no-url-embedding`
- Touches: `packages/core/src/handlers/clone.ts`, `packages/core/src/handlers/clone.test.ts`, `packages/git/src/repo.ts`, `packages/git/src/repo.test.ts`, `packages/isolation/src/types.ts`, `packages/isolation/src/providers/worktree.ts`, `packages/isolation/src/providers/worktree.test.ts`, `packages/core/src/operations/isolation-operations.ts`, `packages/core/src/orchestrator/orchestrator-agent.ts`, `packages/server/src/index.ts` (Step 7 bootstrap).
- Title: `fix(creds): stop embedding short-lived GitHub tokens in workspace remote URLs`
- Body: link this doc, summarize TL;DR, link the original error log line for traceability.

---

_Drafted as a handoff during a session that produced PR #(archon)5ebbacc and PR #(youbiquity)3 + infra bumps. The trigger was a production failure on archon-dev where the user's `archon-youbiquity` workspace had been on EFS for ~24h and its embedded GitHub App token had expired._
