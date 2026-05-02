/**
 * Remote Coding Agent - Main Entry Point
 * Multi-platform AI coding assistant (Telegram, Discord, Slack, GitHub, Gitea)
 */

// Strip CWD .env keys FIRST — before any application imports read process.env.
// Bun auto-loads .env/.env.local/.env.development/.env.production from CWD;
// when `bun run dev:server` is run from inside a target repo those keys leak
// into the server process. stripCwdEnv() removes them before ~/.archon/.env loads.
import '@archon/paths/strip-cwd-env-boot';

// Load environment variables — after CWD stripping, before application imports.
import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { BUNDLED_IS_BINARY, getArchonEnvPath } from '@archon/paths';

// In dev/source mode, load the repo root .env (platform tokens, API keys, etc.)
// import.meta.dir is frozen at build time, so skip in compiled binaries.
const envPath = BUNDLED_IS_BINARY ? undefined : resolve(import.meta.dir, '..', '..', '..', '.env');

if (envPath) {
  const dotenvResult = config({ path: envPath });
  if (dotenvResult.error) {
    // Use console.error since logger depends on env vars (LOG_LEVEL)
    console.error(`Failed to load .env from ${envPath}: ${dotenvResult.error.message}`);
    console.error('Hint: Copy .env.example to .env and configure your credentials.');
  }
}

// Load archon-owned env from ~/.archon/.env (user scope) and <cwd>/.archon/.env
// (repo scope, wins over user) with override: true. Keeps the server in sync
// with the CLI — see packages/paths/src/env-loader.ts and the three-path model
// (#1302 / #1303).
import { loadArchonEnv } from '@archon/paths/env-loader';
loadArchonEnv(process.cwd());

// CLAUDECODE=1 warning is emitted inside stripCwdEnv() (boot import above)
// BEFORE the marker is deleted from process.env. No duplicate warning here.

// Smart default: use Claude Code's built-in OAuth if no explicit credentials
if (
  !process.env.CLAUDE_API_KEY &&
  !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
  process.env.CLAUDE_USE_GLOBAL_AUTH === undefined
) {
  process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
}

import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';

// Bootstrap provider registry before any provider lookups
registerBuiltinProviders();
registerCommunityProviders();

import { OpenAPIHono } from '@hono/zod-openapi';
import { timingSafeEqual } from 'node:crypto';
import { validationErrorHook } from './routes/openapi-defaults';
import { setAcceptingNewWork } from './drain-state';
import {
  TelegramAdapter,
  GitHubAdapter,
  DiscordAdapter,
  SlackAdapter,
  anthropicCredsModal,
  CALLBACK_ANTHROPIC_CREDS,
  BLOCK_ANTHROPIC_CREDS_INPUT,
  ACTION_ANTHROPIC_CREDS_VALUE,
} from '@archon/adapters';
import { GiteaAdapter } from '@archon/adapters/community/forge/gitea';
import { GitLabAdapter } from '@archon/adapters/community/forge/gitlab';
import { WebAdapter } from './adapters/web';
import { MessagePersistence } from './adapters/web/persistence';
import { SSETransport } from './adapters/web/transport';
import { WorkflowEventBridge } from './adapters/web/workflow-bridge';
import { registerApiRoutes } from './routes/api';
import {
  handleMessage,
  pool,
  ConversationLockManager,
  classifyAndFormatError,
  startCleanupScheduler,
  stopCleanupScheduler,
  loadConfig,
  logConfig,
  getPort,
  UserCredsService,
  setUserCredsService,
  cloneRepository,
  codebaseDb,
} from '@archon/core';
import type { IPlatformAdapter } from '@archon/core';
import { InMemoryOAuthStateStore } from './oauth-state-store';
import { AwsSecretsManagerStore } from './services/aws-secrets-store';
import {
  buildGithubAuthorizeUrl,
  handleGithubOAuthCallback,
  handleGithubOAuthInitiate,
  type GithubOAuthConfig,
} from './auth-github';
import {
  createOidcMiddleware,
  getIdentity,
  parseAllowedSlackUserIds,
} from './middleware/oidc-identity';
import {
  createLogger,
  logArchonPaths,
  validateAppDefaultsPaths,
  shutdownTelemetry,
} from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server');
  return cachedLog;
}

/**
 * Creates an error handler for message processing failures.
 * Logs the error and attempts to send a user-friendly message to the platform.
 */
function createMessageErrorHandler(
  platform: string,
  adapter: IPlatformAdapter,
  conversationId: string
): (error: unknown) => Promise<void> {
  return async (error: unknown): Promise<void> => {
    getLog().error({ err: error, platform, conversationId }, 'message_processing_failed');
    try {
      const userMessage = classifyAndFormatError(error as Error);
      await adapter.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      getLog().error({ err: sendError, platform, conversationId }, 'error_message_send_failed');
    }
  };
}

/**
 * Handles unhandled promise rejections from the process.
 *
 * Exported for testability. Filters specifically for SDK cleanup races
 * ("Operation aborted" when the PostToolUse hook writes to a closed pipe after
 * a DAG node abort). Those are logged at error level but do not exit the process.
 * All other unhandled rejections are unexpected bugs — they are logged at fatal
 * level and the process exits immediately (Fail Fast principle).
 */
export function handleUnhandledRejection(reason: unknown): void {
  const message = (reason instanceof Error ? reason.message : String(reason)).toLowerCase();
  // SDK cleanup race: PostToolUse hook writes to a closed pipe after a DAG node
  // abort. Safe to absorb — these are transient artifacts, not application bugs.
  if (message.includes('operation aborted')) {
    getLog().error({ reason }, 'unhandled_rejection.sdk_cleanup_race');
    return;
  }
  // All other unhandled rejections are unexpected — crash loudly so they are
  // not silently swallowed (CLAUDE.md: "Fail Fast + Explicit Errors").
  getLog().fatal({ reason }, 'unhandled_rejection.fatal');
  process.exit(1);
}

export interface ServerOptions {
  /**
   * Override the web dist path (for CLI binary with downloaded web-dist).
   * Only effective in production mode (NODE_ENV=production or WEB_UI_DEV unset).
   */
  webDistPath?: string;
  /** Override the port. Range: 1–65535. */
  port?: number;
  /** Run in standalone web-only mode (no Telegram/Slack/GitHub/Discord adapters). */
  skipPlatformAdapters?: boolean;
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  getLog().info('server_starting');

  // Database auto-detected: SQLite (default) or PostgreSQL (if DATABASE_URL set)
  // No required environment variables - SQLite works out of the box

  // Validate AI assistant credentials (warn if missing, don't fail)
  // Using || intentionally: empty string should be treated as missing credential
  // CLAUDE_USE_GLOBAL_AUTH=true: Use Claude Code's built-in OAuth (from `claude /login`)
  const hasClaudeCredentials = Boolean(
    process.env.CLAUDE_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.CLAUDE_USE_GLOBAL_AUTH
  );
  const hasCodexCredentials = process.env.CODEX_ID_TOKEN && process.env.CODEX_ACCESS_TOKEN;

  if (!hasClaudeCredentials && !hasCodexCredentials) {
    getLog().fatal(
      {
        checked: {
          claude: ['CLAUDE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USE_GLOBAL_AUTH'],
          codex: ['CODEX_ID_TOKEN', 'CODEX_ACCESS_TOKEN'],
        },
        hints: [
          'Set CLAUDE_USE_GLOBAL_AUTH=true in .env (requires `claude /login` first)',
          'Or set CLAUDE_API_KEY in .env',
          'Or set CODEX_ID_TOKEN + CODEX_ACCESS_TOKEN in .env',
          'See .env.example for all options',
        ],
        envFile: BUNDLED_IS_BINARY ? getArchonEnvPath() : envPath,
      },
      'no_ai_credentials'
    );
    process.exit(1);
  }

  if (!hasClaudeCredentials) {
    getLog().warn(
      { checked: ['CLAUDE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USE_GLOBAL_AUTH'] },
      'claude_credentials_missing'
    );
  }
  if (!hasCodexCredentials) {
    getLog().warn(
      { checked: ['CODEX_ID_TOKEN', 'CODEX_ACCESS_TOKEN'] },
      'codex_credentials_missing'
    );
  }

  // Test database connection
  try {
    await pool.query('SELECT 1');
    getLog().info('database_connected');
  } catch (error) {
    getLog().fatal({ err: error }, 'database_connection_failed');
    process.exit(1);
  }

  const config = await loadConfig();
  logConfig(config);

  // Start cleanup scheduler
  startCleanupScheduler();

  // Note: orphaned-run cleanup intentionally NOT called at server startup.
  // Running it here killed parallel workflow runs from other processes
  // (CLI, adapters) by flipping their `running` rows to `failed` mid-flight.
  // Same lesson the CLI already learned — see packages/cli/src/cli.ts:256-258.
  // Per CLAUDE.md "No Autonomous Lifecycle Mutation Across Process Boundaries":
  // surface ambiguous state to users and provide a one-click action instead.
  // Users transition a stuck `running` row via the per-row Cancel/Abandon
  // buttons in the Web UI dashboard, or `archon workflow abandon <run-id>`.
  // (`archon workflow cleanup` is a separate command that deletes OLD terminal
  // rows for disk hygiene — it does not handle stuck `running` rows.)
  // See #1216.

  // Log Archon paths configuration
  logArchonPaths();

  // Validate app defaults paths (non-blocking, just logs warnings)
  await validateAppDefaultsPaths();

  // Initialize conversation lock manager
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_CONVERSATIONS ?? '10');
  const lockManager = new ConversationLockManager(maxConcurrent);
  getLog().info({ maxConcurrent }, 'lock_manager_initialized');

  // Patch 3 / Phase A.1: bootstrap the per-user creds service. Runs before
  // any platform adapter so the orchestrator's env-overlay lookup sees a
  // populated cache. `USER_CREDS_SECRET_PREFIX` selects AWS Secrets Manager
  // (production / staging); unset falls through to the in-memory store
  // (local dev, CLI, isolated tests). Same env-driven pattern as
  // `ALB_OIDC_REGION`.
  const userCredsPrefix = process.env.USER_CREDS_SECRET_PREFIX?.trim();
  const userCreds = userCredsPrefix
    ? new UserCredsService({ store: new AwsSecretsManagerStore({ prefix: userCredsPrefix }) })
    : new UserCredsService();
  getLog().info(
    { backend: userCredsPrefix ? 'aws-secrets-manager' : 'in-memory', prefix: userCredsPrefix },
    'user-creds.store_configured'
  );
  await userCreds.bootstrap();
  setUserCredsService(userCreds);

  // OAuth state store for `/archon-creds github`. Process-local; multi-task
  // deployments will route the callback to the same task that minted the
  // state because Phase A.1 is single-task. A.2 swaps for a shared store.
  const oauthStateStore = new InMemoryOAuthStateStore();

  // GitHub OAuth config — sourced from env vars in Phase A.1. Production
  // deployments hydrate these from Secrets Manager `<prefix>/github-app`
  // and inject via task definition env vars. Absent values disable the
  // flow gracefully (slash command returns a config-not-set message).
  const githubOAuthConfig: GithubOAuthConfig | null =
    process.env.GITHUB_OAUTH_CLIENT_ID &&
    process.env.GITHUB_OAUTH_CLIENT_SECRET &&
    process.env.OAUTH_CALLBACK_BASE
      ? {
          clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
          clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
          callbackBase: process.env.OAUTH_CALLBACK_BASE,
        }
      : null;
  if (!githubOAuthConfig) {
    getLog().info('github_oauth_disabled');
  }

  // Initialize web adapter (always enabled)
  // Note: Circular references between transport/persistence/workflowBridge are safe because:
  // - transport's cleanup callback references persistence/workflowBridge (declared after, but
  //   only invoked from a grace period timer — well after all constructors complete)
  // - persistence's emitEvent closure references transport.emit (same lazy pattern)
  const transport = new SSETransport(conversationId => {
    // Flush (not clear!) — the orchestrator/workflow may still be writing messages
    // even though the SSE stream disconnected. Clearing the dbId mapping would cause
    // all subsequent messages to be lost (never persisted to DB).
    void persistence.flush(conversationId).catch((e: unknown) => {
      getLog().error({ conversationId, err: e }, 'transport_cleanup_flush_failed');
    });
  });
  const persistence = new MessagePersistence((conversationId, event) =>
    transport.emit(conversationId, event)
  );
  const workflowBridge = new WorkflowEventBridge(transport);
  const webAdapter = new WebAdapter(transport, persistence, workflowBridge);
  await webAdapter.start();
  persistence.startPeriodicFlush();

  // Mutable — pushed to as each adapter starts, read by the /api/health endpoint.
  // Must be a live reference because Telegram starts after the HTTP listener begins
  // accepting requests, so a snapshot taken at registration time would miss it.
  const activePlatforms: string[] = ['Web'];

  // Platform adapters (skipped in CLI serve mode or when not configured)
  let github: GitHubAdapter | null = null;
  let gitea: GiteaAdapter | null = null;
  let gitlab: GitLabAdapter | null = null;
  let discord: DiscordAdapter | null = null;
  let slack: SlackAdapter | null = null;

  if (!opts.skipPlatformAdapters) {
    // Check that at least one platform is configured
    const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
    const hasDiscord = Boolean(process.env.DISCORD_BOT_TOKEN);
    const hasGitHub = Boolean(process.env.GITHUB_TOKEN && process.env.WEBHOOK_SECRET);
    const hasGitea = Boolean(
      process.env.GITEA_URL && process.env.GITEA_TOKEN && process.env.GITEA_WEBHOOK_SECRET
    );
    const hasGitLab = Boolean(process.env.GITLAB_TOKEN && process.env.GITLAB_WEBHOOK_SECRET);

    if (!hasTelegram && !hasDiscord && !hasGitHub && !hasGitea && !hasGitLab) {
      getLog().warn('no_platform_adapters_configured');
    }

    // Initialize GitHub adapter (conditional)
    if (process.env.GITHUB_TOKEN && process.env.WEBHOOK_SECRET) {
      const botMention =
        process.env.GITHUB_BOT_MENTION || process.env.BOT_DISPLAY_NAME || config.botName;
      github = new GitHubAdapter(
        process.env.GITHUB_TOKEN,
        process.env.WEBHOOK_SECRET,
        lockManager,
        botMention
      );
      await github.start();
      activePlatforms.push('GitHub');
    } else {
      getLog().info('github_adapter_skipped');
    }

    // Initialize Gitea adapter (conditional)
    if (process.env.GITEA_URL && process.env.GITEA_TOKEN && process.env.GITEA_WEBHOOK_SECRET) {
      const giteaBotMention =
        process.env.GITEA_BOT_MENTION || process.env.BOT_DISPLAY_NAME || config.botName;
      gitea = new GiteaAdapter(
        process.env.GITEA_URL,
        process.env.GITEA_TOKEN,
        process.env.GITEA_WEBHOOK_SECRET,
        lockManager,
        giteaBotMention
      );
      await gitea.start();
      activePlatforms.push('Gitea');
    } else {
      getLog().info('gitea_adapter_skipped');
    }

    // Initialize GitLab adapter (conditional)
    if (process.env.GITLAB_TOKEN && process.env.GITLAB_WEBHOOK_SECRET) {
      const gitlabBotMention =
        process.env.GITLAB_BOT_MENTION || process.env.BOT_DISPLAY_NAME || config.botName;
      gitlab = new GitLabAdapter(
        process.env.GITLAB_TOKEN,
        process.env.GITLAB_WEBHOOK_SECRET,
        lockManager,
        process.env.GITLAB_URL || undefined,
        gitlabBotMention
      );
      await gitlab.start();
      activePlatforms.push('GitLab');
    } else {
      getLog().info('gitlab_adapter_skipped');
    }

    // Initialize Discord adapter (conditional)
    if (process.env.DISCORD_BOT_TOKEN) {
      const discordStreamingMode = (process.env.DISCORD_STREAMING_MODE ?? 'batch') as
        | 'stream'
        | 'batch';
      discord = new DiscordAdapter(process.env.DISCORD_BOT_TOKEN, discordStreamingMode);
      const discordAdapter = discord; // Capture for use in callback

      // Register message handler
      discordAdapter.onMessage(async message => {
        // Get initial conversation ID
        let conversationId = discordAdapter.getConversationId(message);

        // Skip if no content
        if (!message.content) return;

        // Check if bot was mentioned (required for activation)
        // Exception: DMs don't require mention
        const isDM = !message.guild;
        if (!isDM && !discordAdapter.isBotMentioned(message)) {
          return; // Ignore messages that don't mention the bot
        }

        // Strip the bot mention from the message
        const content = discordAdapter.stripBotMention(message);
        if (!content) return; // Message was only a mention with no content

        // Ensure we're responding in a thread - creates one if needed
        conversationId = await discordAdapter.ensureThread(conversationId, message);

        // Check for thread context (now we're guaranteed to be in a thread if applicable)
        let threadContext: string | undefined;
        let parentConversationId: string | undefined;

        if (discordAdapter.isThread(message)) {
          // Fetch thread history for context (exclude current message)
          const history = await discordAdapter.fetchThreadHistory(message);
          if (history.length > 1) {
            threadContext = history.slice(0, -1).join('\n');
          }

          // Get parent channel ID for context inheritance
          parentConversationId = discordAdapter.getParentChannelId(message) ?? undefined;
        }

        // Fire-and-forget: handler returns immediately, processing happens async
        lockManager
          .acquireLock(conversationId, async () => {
            await handleMessage(discordAdapter, conversationId, content, {
              threadContext,
              parentConversationId,
              isolationHints: { workflowType: 'thread', workflowId: conversationId },
            });
          })
          .catch(createMessageErrorHandler('Discord', discordAdapter, conversationId));
      });

      // Don't let a Discord login failure (bad token, missing privileged
      // intents, etc.) bring down the whole server — users running
      // `archon serve` for the web UI shouldn't lose it because of an
      // unrelated bot misconfiguration. See #1365.
      try {
        await discord.start();
        activePlatforms.push('Discord');
      } catch (error) {
        const err = error as Error;
        const isPrivilegedIntentError = err.message?.includes('disallowed intents');
        const hint = isPrivilegedIntentError
          ? 'Enable "Message Content Intent" in the Discord Developer Portal ' +
            '(your application > Bot > Privileged Gateway Intents) and restart, ' +
            'or unset DISCORD_BOT_TOKEN if you do not want the Discord adapter.'
          : 'Verify DISCORD_BOT_TOKEN is valid, or unset it to disable the Discord adapter.';
        getLog().error({ err, hint }, 'discord.start_failed_continuing_without_adapter');
        discord = null;
      }
    } else {
      getLog().info('discord_adapter_skipped');
    }

    // Initialize Slack adapter (conditional)
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
      const slackStreamingMode = (process.env.SLACK_STREAMING_MODE ?? 'batch') as
        | 'stream'
        | 'batch';
      slack = new SlackAdapter(
        process.env.SLACK_BOT_TOKEN,
        process.env.SLACK_APP_TOKEN,
        slackStreamingMode
      );
      const slackAdapter = slack; // Capture for use in callback

      // Patch 3 / Phase A.1 slash commands. Registered before `start()` so
      // Bolt picks them up alongside the message handler. All replies are
      // ephemeral by default — these flows handle credentials, the user
      // never wants the channel to see them.

      slackAdapter.onSlashCommand('/archon-creds', async (slackUserId, text, isDM, triggerId) => {
        const [subRaw] = text.trim().split(/\s+/);
        const sub = (subRaw ?? '').toLowerCase();

        if (sub === 'anthropic') {
          if (!isDM) {
            return {
              replyText:
                'Run this in a DM with me — channels are public, your `.credentials.json` is not.',
            };
          }
          // Open the paste-credentials modal. Mirrors the cred-paste UX
          // in llm-slack-channel-bridge: keeps the JSON out of slash-
          // command text (which Slack logs and renders inline) and gives
          // us inline validation via response_action: errors. Empty
          // replyText so the slash command returns silently and the
          // modal is the user-visible action.
          const r = await slackAdapter.openView(triggerId, anthropicCredsModal());
          if (!r.ok) {
            return {
              replyText: `Couldn't open the credentials modal: \`${r.error ?? 'unknown'}\``,
            };
          }
          return { replyText: '' };
        }

        if (sub === 'github') {
          if (!githubOAuthConfig) {
            return {
              replyText:
                'GitHub OAuth is not configured on this Archon. Ask the operator to set ' +
                '`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `OAUTH_CALLBACK_BASE`.',
            };
          }
          const url = buildGithubAuthorizeUrl({
            config: githubOAuthConfig,
            stateStore: oauthStateStore,
            slackUserId,
          });
          return {
            replyText: `Click to link GitHub: <${url}|Authorize Archon> (link expires in 10 minutes).`,
          };
        }

        return {
          replyText: 'Usage: `/archon-creds anthropic` (opens a modal) or `/archon-creds github`.',
        };
      });

      // view_submission for the Connect Anthropic modal opened above.
      // Shape-validates inline (JSON.parse + claudeAiOauth.accessToken
      // check) so paste errors keep the modal open with a per-block
      // error. Persistence (which also re-validates and probes the
      // Anthropic API) runs fire-and-forget after the modal closes;
      // the result reaches the user via DM. Matches the cred-paste
      // flow in llm-slack-channel-bridge/packages/cloud-edge/src/
      // interactivity.ts.
      slackAdapter.onViewSubmission(CALLBACK_ANTHROPIC_CREDS, async (slackUserId, view) => {
        const raw =
          view.state.values?.[BLOCK_ANTHROPIC_CREDS_INPUT]?.[ACTION_ANTHROPIC_CREDS_VALUE]?.value ??
          '';
        const trimmed = raw.trim();
        if (!trimmed) {
          return {
            ok: false,
            errors: { [BLOCK_ANTHROPIC_CREDS_INPUT]: 'Paste a credentials.json blob.' },
          };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch (err) {
          return {
            ok: false,
            errors: {
              [BLOCK_ANTHROPIC_CREDS_INPUT]: `Not valid JSON: ${(err as Error).message}`,
            },
          };
        }
        const oauth =
          parsed && typeof parsed === 'object'
            ? ((parsed as Record<string, unknown>).claudeAiOauth as
                | Record<string, unknown>
                | undefined)
            : undefined;
        if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) {
          return {
            ok: false,
            errors: {
              [BLOCK_ANTHROPIC_CREDS_INPUT]:
                "JSON parsed but doesn't look like a credentials.json — expected " +
                '`claudeAiOauth.accessToken`. Run `claude /login` to refresh.',
            },
          };
        }

        // Close the modal now; persist + DM the user the outcome async.
        // upsertAnthropic re-validates and probes the Anthropic API,
        // which can take a couple of seconds — too slow to block the
        // view_submission ack window.
        void (async (): Promise<void> => {
          try {
            const result = await userCreds.upsertAnthropic(slackUserId, trimmed);
            await slackAdapter.sendMessage(slackUserId, result.replyText);
          } catch (err) {
            await slackAdapter.sendMessage(
              slackUserId,
              `Failed to save Anthropic credentials: ${(err as Error).message}`
            );
          }
        })();
        return { ok: true };
      });

      slackAdapter.onSlashCommand('/archon-codebase', async (slackUserId, text) => {
        const [sub, ...rest] = text.trim().split(/\s+/);
        const arg = rest.join(' ').trim();

        if (sub === 'add') {
          if (!arg) {
            return { replyText: 'Usage: `/archon-codebase add <owner/repo>`' };
          }
          const overlay = userCreds.getEnvOverlay(slackUserId);
          if (!overlay?.GH_TOKEN) {
            return {
              replyText:
                'You have not linked GitHub yet. Run `/archon-creds github` first, then retry.',
            };
          }
          const isUrl = arg.includes('://') || arg.startsWith('git@');
          const repoSpec = isUrl ? arg : `https://github.com/${arg}`;
          try {
            const result = await cloneRepository(repoSpec, {
              registeredBy: slackUserId,
              env: { HOME: overlay.HOME, GH_TOKEN: overlay.GH_TOKEN },
            });
            return {
              replyText: result.alreadyExisted
                ? `\`${result.name}\` is already registered (path: ${result.defaultCwd}).`
                : `Registered \`${result.name}\` (id: ${result.codebaseId}, ${String(result.commandCount)} commands loaded).`,
            };
          } catch (err) {
            const message = (err as Error).message ?? 'unknown error';
            return { replyText: `Could not register codebase: ${message}` };
          }
        }

        if (sub === 'list') {
          const codebases = await codebaseDb.listCodebases();
          if (codebases.length === 0) {
            return { replyText: 'No codebases registered yet.' };
          }
          const lines = codebases.map(cb => {
            const registrar = cb.registered_by_slack_user_id
              ? ` (registered by <@${cb.registered_by_slack_user_id}>)`
              : '';
            return `• \`${cb.name}\`${registrar}`;
          });
          return { replyText: lines.join('\n') };
        }

        if (sub === 'remove') {
          if (!arg) {
            return { replyText: 'Usage: `/archon-codebase remove <owner/repo>`' };
          }
          const codebase = await codebaseDb.findCodebaseByName(arg);
          if (!codebase) {
            return { replyText: `No codebase named \`${arg}\`.` };
          }
          // Strict: only the registrar (or operator-managed legacy rows with
          // null registrar) can remove. Cross-user removal is intentionally
          // rejected — same principle as the no-cross-user-borrowing rule.
          if (
            codebase.registered_by_slack_user_id &&
            codebase.registered_by_slack_user_id !== slackUserId
          ) {
            return {
              replyText: `\`${arg}\` was registered by another user; only they can remove it.`,
            };
          }
          await codebaseDb.deleteCodebase(codebase.id);
          return { replyText: `Removed \`${arg}\`.` };
        }

        return {
          replyText: 'Usage: `/archon-codebase add <owner/repo>` | `list` | `remove <owner/repo>`',
        };
      });

      // Register message handler
      slackAdapter.onMessage(async event => {
        const conversationId = slackAdapter.getConversationId(event);

        // Skip if no text
        if (!event.text) return;

        // Strip the bot mention from the message
        const content = slackAdapter.stripBotMention(event.text);
        if (!content) return; // Message was only a mention with no content

        // Check for thread context
        let threadContext: string | undefined;
        let parentConversationId: string | undefined;

        if (slackAdapter.isThread(event)) {
          // Fetch thread history for context (exclude current message)
          const history = await slackAdapter.fetchThreadHistory(event);
          if (history.length > 1) {
            threadContext = history.slice(0, -1).join('\n');
          }

          // Get parent conversation ID for context inheritance
          parentConversationId = slackAdapter.getParentConversationId(event) ?? undefined;
        }

        // Fire-and-forget: handler returns immediately, processing happens async
        lockManager
          .acquireLock(conversationId, async () => {
            await handleMessage(slackAdapter, conversationId, content, {
              threadContext,
              parentConversationId,
              isolationHints: { workflowType: 'thread', workflowId: conversationId },
              platformUserId: event.user || undefined,
            });
          })
          .catch(createMessageErrorHandler('Slack', slackAdapter, conversationId));
      });

      await slack.start();
      activePlatforms.push('Slack');
    } else {
      getLog().info('slack_adapter_skipped');
    }
  } else {
    getLog().info('platform_adapters_skipped');
  }

  // Setup Hono server
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const port = opts.port ?? (await getPort());

  // Global error handler for unhandled exceptions
  app.onError((err, c) => {
    getLog().error({ err, path: c.req.path, method: c.req.method }, 'unhandled_request_error');
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Patch 4 / Phase A.1: ALB OIDC identity enforcement on the Web UI API.
  // Wired only when `ALB_OIDC_REGION` is set — production deployments behind
  // ALB with the `authenticate-oidc` action. In local dev (env var unset)
  // the middleware is skipped entirely, so `bun run dev` does not require
  // a fake JWT. `SLACK_ALLOWED_USER_IDS` reuses the chat allowlist; an
  // empty allowlist means deny-all on the web tier (no implicit "open"
  // mode in production).
  //
  // Registration MUST come before `registerApiRoutes(...)` — Hono middleware
  // and routes execute in registration order, and route handlers do not
  // call `next()`, so middleware registered after routes never runs.
  // CORS still registers inside `registerApiRoutes` and runs second; the
  // OIDC middleware passes through CORS preflight (OPTIONS) on purpose so
  // the cors() handler downstream can answer those normally.
  if (process.env.ALB_OIDC_REGION) {
    const oidcMw = createOidcMiddleware({
      region: process.env.ALB_OIDC_REGION,
      allowedSlackUserIds: parseAllowedSlackUserIds(process.env.SLACK_ALLOWED_USER_IDS),
    });
    app.use('/api/*', oidcMw);
    getLog().info({ region: process.env.ALB_OIDC_REGION }, 'auth.oidc.middleware_enabled');
  } else {
    getLog().info('auth.oidc.middleware_disabled');
  }

  // Register Web UI API routes
  registerApiRoutes(app, webAdapter, lockManager, activePlatforms);

  // GitHub webhook endpoint
  if (github) {
    app.post('/webhooks/github', async c => {
      const eventType = c.req.header('x-github-event');
      const deliveryId = c.req.header('x-github-delivery');

      try {
        const signature = c.req.header('x-hub-signature-256');
        if (!signature) {
          return c.json({ error: 'Missing signature header' }, 400);
        }

        // CRITICAL: Use c.req.text() for raw body (signature verification)
        const payload = await c.req.text();

        // Process async (fire-and-forget for fast webhook response)
        // Note: github.handleWebhook() has internal error handling that notifies users
        // This catch is a fallback for truly unexpected errors (e.g., signature verification bugs)
        github.handleWebhook(payload, signature).catch((error: unknown) => {
          getLog().error({ err: error, eventType, deliveryId }, 'webhook_processing_error');
        });

        return c.text('OK', 200);
      } catch (error) {
        getLog().error({ err: error, eventType, deliveryId }, 'webhook_endpoint_error');
        return c.json({ error: 'Internal server error' }, 500);
      }
    });
    getLog().info('github_webhook_registered');
  }

  // Gitea webhook endpoint
  if (gitea) {
    app.post('/webhooks/gitea', async c => {
      const eventType = c.req.header('x-gitea-event');

      try {
        const signature = c.req.header('x-gitea-signature');
        if (!signature) {
          return c.json({ error: 'Missing signature header' }, 400);
        }

        // CRITICAL: Use c.req.text() for raw body (signature verification)
        const payload = await c.req.text();

        // Process async (fire-and-forget for fast webhook response)
        gitea.handleWebhook(payload, signature).catch((error: unknown) => {
          getLog().error({ err: error, eventType }, 'gitea_webhook_processing_error');
        });

        return c.text('OK', 200);
      } catch (error) {
        getLog().error({ err: error, eventType }, 'gitea_webhook_endpoint_error');
        return c.json({ error: 'Internal server error' }, 500);
      }
    });
    getLog().info('gitea_webhook_registered');
  }

  // GitLab webhook endpoint
  if (gitlab) {
    app.post('/webhooks/gitlab', async c => {
      const eventType = c.req.header('x-gitlab-event');

      try {
        const token = c.req.header('x-gitlab-token');
        if (!token) {
          return c.json({ error: 'Missing token header' }, 400);
        }

        const payload = await c.req.text();

        gitlab.handleWebhook(payload, token).catch((error: unknown) => {
          getLog().error({ err: error, eventType }, 'gitlab.webhook_processing_error');
        });

        return c.text('OK', 200);
      } catch (error) {
        getLog().error({ err: error, eventType }, 'gitlab.webhook_endpoint_error');
        return c.json({ error: 'Internal server error' }, 500);
      }
    });
    getLog().info('gitlab_webhook_registered');
  }

  // Patch 3 / Phase A.1: GitHub user-to-server OAuth callback. Registered
  // unconditionally so the URL is stable; if `githubOAuthConfig` is null
  // (operator hasn't set the env vars) the handler responds 503 explaining
  // the misconfiguration. The slash-command flow blocks earlier, so the only
  // way to hit a 503 here is by typing the URL directly.
  //
  // This route MUST stay in the ALB OIDC bypass list (Patch 4 infra) — the
  // GitHub redirect cannot carry a Slack OIDC cookie.
  app.get('/auth/github/callback', async c => {
    if (!githubOAuthConfig) {
      getLog().warn('auth.github.callback_no_config');
      return c.json({ error: 'github oauth not configured' }, 503);
    }
    return handleGithubOAuthCallback(c, {
      config: githubOAuthConfig,
      stateStore: oauthStateStore,
      userCreds,
    });
  });

  // /auth/github/initiate is the SPA's entry to the GitHub OAuth flow.
  // It needs the requesting Slack user id, which Patch 4's OIDC middleware
  // attaches via `c.set('identity', ...)`. When the middleware is disabled
  // (local dev), `getIdentity()` returns undefined and the handler 401s.
  // We deliberately do NOT apply the OIDC middleware to this route directly
  // — `/auth/github/initiate` is under `/auth/*`, not `/api/*`, but the
  // initiate flow always originates from the SPA so the user has an OIDC
  // session by the time the SPA fires this XHR. We re-verify here via
  // `getIdentity` rather than pretending the route is unauthenticated.
  if (process.env.ALB_OIDC_REGION) {
    const oidcMw = createOidcMiddleware({
      region: process.env.ALB_OIDC_REGION,
      allowedSlackUserIds: parseAllowedSlackUserIds(process.env.SLACK_ALLOWED_USER_IDS),
    });
    app.use('/auth/github/initiate', oidcMw);
  }

  app.get('/auth/github/initiate', async c => {
    if (!githubOAuthConfig) {
      return c.json({ error: 'github oauth not configured' }, 503);
    }
    return handleGithubOAuthInitiate(c, {
      config: githubOAuthConfig,
      stateStore: oauthStateStore,
      // OIDC middleware (when configured) attaches the verified Slack user
      // id; in local dev there is no middleware, so `getIdentity` returns
      // undefined and the handler 401s.
      resolveSlackUserId: async () => getIdentity(c)?.slackUserId ?? null,
    });
  });

  // Health check endpoints
  app.get('/health', c => {
    return c.json({ status: 'ok' });
  });

  app.get('/health/db', async c => {
    try {
      await pool.query('SELECT 1');
      return c.json({ status: 'ok', database: 'connected' });
    } catch (error) {
      getLog().error({ err: error }, 'health_check_db_failed');
      return c.json({ status: 'error', database: 'disconnected' }, 500);
    }
  });

  app.get('/health/concurrency', c => {
    const { active, queuedTotal, maxConcurrent } = lockManager.getStats();
    return c.json({ status: 'ok', active, queuedTotal, maxConcurrent });
  });

  // Drain endpoint — used by CodeDeploy AfterAllowTraffic during blue/green
  // rollouts. Flips the in-process acceptingNewWork flag and closes the Slack
  // inbound socket so blue tasks stop picking up new mentions while in-flight
  // workflows finish. Slack's WebClient stays alive (App.stop() only stops
  // the receiver), so existing-thread postMessage calls still work.
  //
  // Auth: Authorization: Bearer <ADMIN_DRAIN_SECRET>. Fails closed (503) if
  // the env var is unset.
  app.post('/admin/drain', c => {
    const secret = process.env.ADMIN_DRAIN_SECRET;
    if (!secret) {
      getLog().warn('admin.drain_misconfigured');
      return c.json({ error: 'admin drain not configured' }, 503);
    }
    const authz = c.req.header('Authorization') ?? '';
    const expected = `Bearer ${secret}`;
    const authzBuf = Buffer.from(authz);
    const expectedBuf = Buffer.from(expected);
    if (authzBuf.length !== expectedBuf.length || !timingSafeEqual(authzBuf, expectedBuf)) {
      getLog().warn('admin.drain_unauthorized');
      return c.json({ error: 'unauthorized' }, 401);
    }
    setAcceptingNewWork(false);
    slack?.stop();
    getLog().info('admin.drain_initiated');
    return c.json({ status: 'draining' });
  });

  // Serve web UI static files in production
  // Uses import.meta.dir for absolute path (CWD varies with bun --filter)
  if (process.env.NODE_ENV === 'production' || !process.env.WEB_UI_DEV) {
    const { serveStatic } = await import('hono/bun');
    const pathModule = await import('path');
    const webDistPath =
      opts.webDistPath ??
      pathModule.join(pathModule.dirname(pathModule.dirname(import.meta.dir)), 'web', 'dist');

    if (!existsSync(webDistPath)) {
      getLog().warn({ webDistPath }, 'web_dist_not_found');
    }

    app.use('/assets/*', serveStatic({ root: webDistPath }));
    app.use('/favicon.png', serveStatic({ root: webDistPath, path: 'favicon.png' }));
    // SPA fallback - serve index.html for unmatched routes (after all API routes)
    app.get('*', serveStatic({ root: webDistPath, path: 'index.html' }));
  }

  const hostname = process.env.HOST || '0.0.0.0';
  const server = Bun.serve({
    fetch: app.fetch,
    hostname,
    port,
    idleTimeout: 255, // Max value (seconds) - prevents SSE connections from being killed
  });
  getLog().info({ port: server.port, hostname }, 'server_listening');

  // Initialize Telegram adapter (conditional, skipped in CLI serve mode)
  let telegram: TelegramAdapter | null = null;
  if (!opts.skipPlatformAdapters && process.env.TELEGRAM_BOT_TOKEN) {
    const streamingMode = (process.env.TELEGRAM_STREAMING_MODE ?? 'stream') as 'stream' | 'batch';
    telegram = new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN, streamingMode);
    const telegramAdapter = telegram; // Capture for use in callback

    // Register message handler (auth is handled internally by adapter)
    telegramAdapter.onMessage(async ({ conversationId, message }) => {
      // Fire-and-forget: handler returns immediately, processing happens async
      lockManager
        .acquireLock(conversationId, async () => {
          await handleMessage(telegramAdapter, conversationId, message, {
            isolationHints: { workflowType: 'thread', workflowId: conversationId },
          });
        })
        .catch(createMessageErrorHandler('Telegram', telegramAdapter, conversationId));
    });

    try {
      await telegramAdapter.start();
      activePlatforms.push('Telegram');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      getLog().error({ err: error, errorType: error.constructor.name }, 'telegram.start_failed');
      telegram = null; // Don't include in active platforms or shutdown
    }
  } else if (!opts.skipPlatformAdapters) {
    getLog().info('telegram_adapter_skipped');
  }

  // Graceful shutdown
  const shutdown = (): void => {
    getLog().info('server_shutting_down');
    stopCleanupScheduler();
    persistence.stopPeriodicFlush();

    // Flush all buffered messages before stopping adapters
    persistence
      .flushAll()
      .catch((e: unknown) => {
        getLog().error({ err: e }, 'shutdown_flush_failed');
      })
      .then(async () => {
        // Stop adapters (these should not throw, but be defensive)
        try {
          telegram?.stop();
          discord?.stop();
          slack?.stop();
          gitea?.stop();
          gitlab?.stop();
          await webAdapter.stop();
        } catch (error) {
          getLog().error({ err: error }, 'adapter_stop_error');
        }

        // Flush queued telemetry events before pool closes the process.
        await shutdownTelemetry();

        return pool.end();
      })
      .then(() => {
        getLog().info('database_pool_closed');
        process.exit(0);
      })
      .catch((error: unknown) => {
        getLog().error({ err: error }, 'database_pool_close_failed');
        process.exit(1);
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Guard against SDK cleanup races: when a DAG node is aborted mid-execution,
  // the Claude Agent SDK's PostToolUse hook may be in-flight. After the hook
  // returns { continue: true }, handleControlRequest() tries to write() back to
  // the subprocess pipe — but the pipe is already closed (abort fired). The
  // write() throws "Operation aborted", which becomes an unhandled rejection
  // because it occurs AFTER the for-await generator loop exits (and thus outside
  // the try/catch in claude.ts). These are SDK cleanup races, not fatal app errors.
  process.on('unhandledRejection', handleUnhandledRejection);

  getLog().info({ activePlatforms, port }, 'server_ready');

  // Non-blocking: warn at startup if gh CLI auth is unavailable
  checkGhAuth().catch((err: unknown) => {
    getLog().debug({ err }, 'gh_auth.check_unexpected_error');
  });
}

/**
 * Run `gh auth status` and warn if it fails.
 * Helps diagnose expired tokens or missing auth before workflows fail.
 */
async function checkGhAuth(): Promise<void> {
  const { execFileAsync } = await import('@archon/git');
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    getLog().info('gh_auth.status_ok');
  } catch {
    getLog().warn(
      'gh_auth.status_failed — gh CLI is not authenticated. Workflows using gh commands may fail. ' +
        'Run `gh auth login` or set GH_TOKEN in .env to fix this.'
    );
  }
}

// Run the application when executed directly (not imported as a library)
if (import.meta.main) {
  startServer().catch(error => {
    getLog().fatal({ err: error }, 'startup_failed');
    process.exit(1);
  });
}
