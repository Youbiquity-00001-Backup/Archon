/**
 * Orchestrator - Main conversation handler
 * Routes slash commands and AI messages appropriately
 */
import { readFile as fsReadFile, access as fsAccess } from 'fs/promises';

// Wrapper function for reading files - allows mocking without polluting fs/promises globally
export async function readCommandFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf-8');
}
export async function commandFileExists(path: string): Promise<boolean> {
  try {
    await fsAccess(path);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    // Unexpected errors (permissions, I/O) should not be swallowed
    getLog().error({ err, path, code: err.code }, 'command_file_access_error');
    throw new Error(`Cannot access command file at ${path}: ${err.message}`);
  }
}
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator');
  return cachedLog;
}
import {
  IPlatformAdapter,
  Conversation,
  Codebase,
  ConversationNotFoundError,
  isWebAdapter,
} from '../types';
import type { IsolationHints, IsolationEnvironmentRow } from '@archon/isolation';
import {
  IsolationBlockedError,
  IsolationResolver,
  configureIsolation,
  getIsolationProvider,
} from '@archon/isolation';
import * as db from '../db/conversations';
import { createIsolationStore } from '../db/isolation-environments';
import { toError } from '../utils/error';
import { getCodebase } from '../db/codebases';
import { executeWorkflow } from '@archon/workflows/executor';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import { createWorkflowDeps } from '../workflows/store-adapter';
import {
  cleanupToMakeRoom,
  getWorktreeStatusBreakdown,
  STALE_THRESHOLD_DAYS,
} from '../services/cleanup-service';
import { loadRepoConfig } from '../config/config-loader';

type IsolationResolution =
  | { status: 'existing'; cwd: string; env: IsolationEnvironmentRow }
  | { status: 'new'; cwd: string; env: IsolationEnvironmentRow }
  | { status: 'none'; cwd: string; env: null };

// Lazy resolver singleton
let resolver: IsolationResolver | null = null;
let isolationConfigured = false;

function ensureIsolationConfigured(): void {
  if (!isolationConfigured) {
    configureIsolation(async (repoPath: string) => {
      const config = await loadRepoConfig(repoPath);
      return config?.worktree ?? null;
    });
    isolationConfigured = true;
  }
}

function getResolver(): IsolationResolver {
  ensureIsolationConfigured();
  if (!resolver) {
    resolver = new IsolationResolver({
      store: createIsolationStore(),
      provider: getIsolationProvider(),
      cleanup: {
        makeRoom: async (codebaseId, repoPath): Promise<{ removedCount: number }> => {
          const result = await cleanupToMakeRoom(codebaseId, repoPath);
          return { removedCount: result.removed.length };
        },
        getBreakdown: getWorktreeStatusBreakdown,
      },
      staleThresholdDays: STALE_THRESHOLD_DAYS,
    });
  }
  return resolver;
}

/** Export for use by CLI and other consumers that need config initialized */
export { ensureIsolationConfigured };

/**
 * Validate existing isolation reference and coordinate creation of new isolation if needed.
 * Delegates resolution logic to IsolationResolver; handles messaging and conversation updates.
 *
 * @throws {IsolationBlockedError} When isolation is required but blocked (user already notified)
 */
export async function validateAndResolveIsolation(
  conversation: Conversation,
  codebase: Codebase | null,
  platform: IPlatformAdapter,
  conversationId: string,
  hints?: IsolationHints,
  _isRetry = false
): Promise<IsolationResolution> {
  const result = await getResolver().resolve({
    existingEnvId: conversation.isolation_env_id,
    codebase: codebase
      ? { id: codebase.id, defaultCwd: codebase.default_cwd, name: codebase.name }
      : null,
    hints,
    platformType: platform.getPlatformType(),
  });

  switch (result.status) {
    case 'resolved': {
      // Link env to conversation
      try {
        await db.updateConversation(conversation.id, {
          isolation_env_id: result.env.id,
          cwd: result.cwd,
        });
      } catch (updateError) {
        const err = toError(updateError);
        getLog().error(
          { err, conversationId: conversation.id, isolationEnvId: result.env.id },
          'isolation_link_failed'
        );
        try {
          await createIsolationStore().updateStatus(result.env.id, 'destroyed');
        } catch (rollbackError) {
          getLog().error(
            { err: toError(rollbackError), isolationEnvId: result.env.id },
            'isolation_rollback_failed'
          );
        }
        throw err;
      }
      // Send contextual messages
      if (result.method.type === 'linked_issue_reuse') {
        await platform.sendMessage(
          conversationId,
          `Reusing worktree from issue #${String(result.method.issueNumber)}`
        );
      }
      if (result.method.type === 'created' && result.method.autoCleanedCount) {
        await platform.sendMessage(
          conversationId,
          `Cleaned up ${String(result.method.autoCleanedCount)} merged worktree(s) to make room.`
        );
      }
      // Surface any non-fatal warnings from environment creation
      if (result.warnings && result.warnings.length > 0) {
        for (const warning of result.warnings) {
          await platform.sendMessage(conversationId, `Warning: ${warning}`).catch(e => {
            getLog().error({ err: toError(e), conversationId }, 'isolation_warning_send_failed');
          });
        }
      }
      return {
        status: result.method.type === 'existing' ? 'existing' : 'new',
        cwd: result.cwd,
        env: result.env,
      };
    }

    case 'stale_cleaned': {
      // Clear stale reference
      await db.updateConversation(conversation.id, { isolation_env_id: null }).catch(e => {
        if (!(toError(e) instanceof ConversationNotFoundError)) {
          getLog().error(
            { err: toError(e), conversationId: conversation.id },
            'stale_isolation_clear_failed'
          );
        }
      });
      const staleMsg = codebase
        ? 'Detected a stale isolated workspace reference and cleared it. Creating a new isolated workspace now.'
        : 'Detected a stale isolated workspace reference and cleared it. Continuing without an isolated workspace.';
      await platform.sendMessage(conversationId, staleMsg).catch(e => {
        getLog().error({ err: toError(e), conversationId }, 'stale_isolation_notice_failed');
      });
      // Retry without existing env (guard against infinite recursion)
      if (!codebase) return { status: 'none', cwd: conversation.cwd ?? '/workspace', env: null };
      if (_isRetry) {
        throw new Error(
          `Isolation resolution stuck in stale_cleaned loop for conversation ${conversation.id}`
        );
      }
      return validateAndResolveIsolation(
        { ...conversation, isolation_env_id: null },
        codebase,
        platform,
        conversationId,
        hints,
        true
      );
    }

    case 'none':
      return { status: 'none', cwd: result.cwd, env: null };

    case 'blocked':
      await platform.sendMessage(conversationId, result.userMessage);
      throw new IsolationBlockedError(
        'Isolation environment required but could not be created',
        result.reason
      );
  }
}

/**
 * Context for workflow routing - avoids passing many parameters
 */
export interface WorkflowRoutingContext {
  readonly platform: IPlatformAdapter;
  readonly conversationId: string;
  readonly cwd: string;
  readonly originalMessage: string;
  readonly conversationDbId: string;
  readonly codebaseId?: string;
  readonly availableWorkflows: readonly WorkflowDefinition[];
  /**
   * GitHub issue/PR context built from webhook events.
   * Contains formatted markdown with: issue title, author, labels, and body.
   * Passed to workflow executor for substitution into $CONTEXT variables.
   */
  readonly issueContext?: string;
  /**
   * Isolation environment context for consolidated startup message.
   */
  readonly isolationEnv?: {
    readonly branch_name: string;
  };
  /**
   * Hints for isolation environment (PR review context, etc.)
   */
  readonly isolationHints?: IsolationHints;
  /**
   * Per-user env overlay (CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN, JIRA_*, HOME, etc.)
   * built by the orchestrator from `UserCredsService.getEnvOverlay()`. Forwarded
   * to `executeWorkflow` so the worker run uses the requesting user's
   * credentials instead of the image-baked default. Undefined for paths with
   * no platform user identity (CLI, GitHub webhook before identity resolves).
   */
  readonly userEnvOverlay?: Record<string, string>;
  /**
   * Called once with the pre-created workflow_runs row id, before isolation
   * resolves. The HTTP layer races this against a short timeout to surface
   * the id in the dispatch response so polling-based callers (execute-dag)
   * don't race the cold-clone latency window.
   */
  readonly onWorkflowRunCreated?: (runId: string) => void;
}

/**
 * Dispatch a workflow to run in a background worker conversation (web platform only).
 * Creates a hidden worker conversation, sets up event bridging from worker to parent,
 * and fires-and-forgets the workflow execution.
 */
export async function dispatchBackgroundWorkflow(
  ctx: WorkflowRoutingContext,
  workflow: WorkflowDefinition,
  isolationContext?: {
    branchName?: string;
    isPrReview?: boolean;
    prSha?: string;
    prBranch?: string;
  }
): Promise<void> {
  // 1. Generate worker conversation ID
  const workerPlatformId = `web-worker-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // 2. Create worker conversation in DB
  const workerConv = await db.getOrCreateConversation('web', workerPlatformId);
  await db.updateConversation(workerConv.id, {
    cwd: ctx.cwd,
    codebase_id: ctx.codebaseId ?? null,
    hidden: true,
  });

  // 3. Pre-create workflow run row BEFORE isolation work starts.
  //
  // Isolation on a cold workspace (e.g. a multi-GB repo first invocation)
  // can take >90s — longer than the 90s polling deadline that
  // execute-dag waits for the row to materialize. Inserting here, before
  // the worktree fetch/sync, makes the row queryable in ms and lets the
  // HTTP dispatch response return the id synchronously. `working_path`
  // is filled in once isolation resolves below.
  //
  // The row's lock-token semantics (deduping concurrent dispatches by
  // working_path) only kick in once working_path is set — until then the
  // row is just a queued claim on this workerConv.
  const workflowDeps = createWorkflowDeps();
  let preCreatedRun: Awaited<ReturnType<typeof workflowDeps.store.createWorkflowRun>> | undefined;
  try {
    preCreatedRun = await workflowDeps.store.createWorkflowRun({
      workflow_name: workflow.name,
      conversation_id: workerConv.id,
      codebase_id: ctx.codebaseId,
      user_message: ctx.originalMessage,
      // working_path intentionally unset — patched after isolation resolves
      metadata: ctx.issueContext ? { github_context: ctx.issueContext } : {},
      parent_conversation_id: ctx.conversationDbId,
    });
    ctx.onWorkflowRunCreated?.(preCreatedRun.id);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName: workflow.name }, 'pre_create_workflow_run_failed');
    // Non-fatal: executeWorkflow will create its own row as fallback. The
    // dispatch response then surfaces no runId; callers fall back to polling.
  }

  // 4. Resolve isolation for this worker (each background workflow gets its own worktree).
  // Isolation failure is fatal — never run a workflow in a shared/parent worktree.
  let workerCwd: string;
  try {
    if (ctx.codebaseId) {
      const codebase = await getCodebase(ctx.codebaseId);
      if (!codebase) {
        throw new Error(
          `Cannot dispatch workflow "${workflow.name}": codebase ${ctx.codebaseId} not found`
        );
      }
      // ctx.userEnvOverlay carries the per-user HOME + GH_TOKEN built by the
      // dispatcher's `buildUserEnvOverlayForWorkflow`. Threading it into
      // `hints.gitEnv` lets the worktree provider's syncWorkspace consult
      // the credential helper at <userHome>/.gitconfig — without it, this
      // background path silently used the server's default HOME and fetches
      // failed with "could not read Username for 'https://github.com'".
      // See FIX_GH_CREDS.md.
      const result = await validateAndResolveIsolation(
        workerConv,
        codebase,
        ctx.platform,
        workerPlatformId,
        {
          workflowType: 'thread',
          workflowId: workerPlatformId,
          gitEnv: ctx.userEnvOverlay ? { ...process.env, ...ctx.userEnvOverlay } : undefined,
        }
      );
      workerCwd = result.cwd;
      await db.updateConversation(workerConv.id, { cwd: workerCwd }).catch((e: unknown) => {
        getLog().warn(
          { err: toError(e), workerPlatformId },
          'orchestrator.worker_cwd_persist_failed'
        );
      });
    } else {
      // No codebase — run in parent's cwd (no isolation needed for non-repo workflows)
      workerCwd = ctx.cwd;
    }
  } catch (isolationError) {
    // Isolation failed after we already inserted the run row. Mark the run
    // failed so it doesn't sit as `pending` until the 5-min stale window,
    // and surface the failure consistently with foreground paths.
    if (preCreatedRun) {
      await workflowDeps.store
        .failWorkflowRun(preCreatedRun.id, toError(isolationError).message)
        .catch((cleanupErr: unknown) => {
          getLog().warn(
            { err: toError(cleanupErr), preCreatedRunId: preCreatedRun?.id },
            'orchestrator.background_isolation_failure_cleanup_failed'
          );
        });
    }
    throw isolationError;
  }

  // 5. Patch working_path now that isolation resolved. The row was inserted
  // with working_path: null in step 3; setting it here completes the
  // lock-token claim used by getActiveWorkflowRunByPath / findResumableRun.
  if (preCreatedRun) {
    await workflowDeps.store
      .updateWorkflowRun(preCreatedRun.id, { working_path: workerCwd })
      .catch((updateErr: unknown) => {
        getLog().warn(
          { err: toError(updateErr), preCreatedRunId: preCreatedRun?.id, workerCwd },
          'orchestrator.background_working_path_patch_failed'
        );
      });
    preCreatedRun = { ...preCreatedRun, working_path: workerCwd };
  }

  // 6. Notify parent chat that workflow is dispatching
  await ctx.platform.sendMessage(
    ctx.conversationId,
    `🚀 Dispatching workflow: **${workflow.name}** (background)`,
    {
      category: 'workflow_dispatch_status',
      segment: 'new',
      workflowDispatch: { workerConversationId: workerPlatformId, workflowName: workflow.name },
    }
  );

  // Narrow to web adapter for web-specific operations
  const webAdapter = isWebAdapter(ctx.platform) ? ctx.platform : null;

  // Send structured dispatch event for Web UI
  if (webAdapter) {
    await webAdapter.sendStructuredEvent(ctx.conversationId, {
      type: 'workflow_dispatch',
      workerConversationId: workerPlatformId,
      workflowName: workflow.name,
    });
  }

  // 7. Set up DB ID mapping for worker (needed for message persistence)
  if (webAdapter) {
    webAdapter.setConversationDbId(workerPlatformId, workerConv.id);
  }

  // Set up event bridge (worker events → parent SSE stream)
  let unsubscribeBridge: (() => void) | undefined;
  if (webAdapter) {
    unsubscribeBridge = webAdapter.setupEventBridge(workerPlatformId, ctx.conversationId);
  }

  // 8. Fire-and-forget: run workflow in background
  void (async (): Promise<void> => {
    try {
      try {
        const result = await executeWorkflow(
          workflowDeps,
          ctx.platform,
          workerPlatformId,
          workerCwd,
          workflow,
          ctx.originalMessage,
          workerConv.id,
          ctx.codebaseId,
          ctx.issueContext,
          isolationContext,
          ctx.conversationDbId,
          preCreatedRun,
          ctx.userEnvOverlay
        );
        // Surface workflow output to parent conversation as a result card
        if ('paused' in result) {
          // Paused workflows (approval gates) — no result card yet
        } else if (result.success && result.summary) {
          try {
            await ctx.platform.sendMessage(ctx.conversationId, result.summary, {
              category: 'workflow_result',
              segment: 'new',
              workflowResult: {
                workflowName: workflow.name,
                runId: result.workflowRunId,
              },
            });
          } catch (surfaceError) {
            getLog().warn(
              { err: toError(surfaceError), conversationId: ctx.conversationId },
              'workflow_output_surface_failed'
            );
          }
        } else if (!result.success && result.workflowRunId) {
          // Surface failure as a result card so the chat shows status + "View full logs"
          try {
            await ctx.platform.sendMessage(
              ctx.conversationId,
              `Workflow **${workflow.name}** failed: ${result.error}`,
              {
                category: 'workflow_result',
                segment: 'new',
                workflowResult: {
                  workflowName: workflow.name,
                  runId: result.workflowRunId,
                },
              }
            );
          } catch (surfaceError) {
            getLog().warn(
              { err: toError(surfaceError), conversationId: ctx.conversationId },
              'workflow_output_surface_failed'
            );
          }
        }
      } catch (error) {
        const err = toError(error);
        getLog().error(
          {
            err,
            workflowName: workflow.name,
            workerConversationId: workerPlatformId,
          },
          'background_workflow_failed'
        );
        // Surface error to parent conversation — include workflowResult metadata when
        // we have a pre-created run ID so the chat renders a result card with "View full logs"
        const failureRunId = preCreatedRun?.id;
        const failureMessage = `Workflow **${workflow.name}** failed: ${err.message}`;
        await ctx.platform
          .sendMessage(
            ctx.conversationId,
            failureMessage,
            failureRunId
              ? {
                  category: 'workflow_result',
                  segment: 'new',
                  workflowResult: { workflowName: workflow.name, runId: failureRunId },
                }
              : undefined
          )
          .catch((sendErr: unknown) => {
            getLog().error({ err: toError(sendErr) }, 'background_workflow_notify_failed');
          });
      } finally {
        // Clean up event bridge
        if (unsubscribeBridge) {
          unsubscribeBridge();
        }
        if (webAdapter) {
          webAdapter.removeOutputCallback(workerPlatformId);
          await webAdapter.emitLockEvent(workerPlatformId, false);
        }
      }
    } catch (outerError) {
      getLog().error({ err: toError(outerError) }, 'background_workflow_unhandled_error');
    }
  })();
}

/**
 * Wraps command content with execution context to signal the AI should execute immediately.
 * @param commandName - The name of the command being invoked (e.g., 'create-pr')
 * @param content - The command template content after variable substitution
 * @returns The content wrapped with instructions that tell the AI to execute immediately
 *          without asking for confirmation (used for explicit user command invocations)
 */
export function wrapCommandForExecution(commandName: string, content: string): string {
  return `The user invoked the \`/${commandName}\` command. Execute the following instructions immediately without asking for confirmation:

---

${content}

---

Remember: The user already decided to run this command. Take action now.`;
}
