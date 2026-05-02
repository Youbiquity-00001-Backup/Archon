/**
 * Slack platform adapter using @slack/bolt with Socket Mode
 * Handles message sending with markdown block formatting for AI responses
 */
import { App, LogLevel } from '@slack/bolt';
import type { View } from '@slack/types';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { createLogger } from '@archon/paths';
import { isSlackUserAuthorized } from './auth';
import { parseAllowedUserIds } from './auth';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import type { SlackMessageEvent } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.slack');
  return cachedLog;
}

const MAX_MARKDOWN_BLOCK_LENGTH = 12000; // Slack markdown block limit

/**
 * Slash-command callback invoked when a registered Slack slash command fires.
 * - `slackUserId` is the invoking user's Slack id (always present in Bolt's
 *   slash-command payload).
 * - `text` is the part after the command name, untrimmed verbatim.
 * - `isDM` is true iff the command was issued from the bot DM channel; some
 *   commands (notably `/archon-creds anthropic`) refuse to run in
 *   public channels for obvious reasons.
 * - `triggerId` is Slack's short-lived (3s) token for opening modals via
 *   `views.open`. Always present in Bolt's slash-command payload.
 *
 * Handler returns the reply text and whether it should be ephemeral
 * (visible only to the invoker). When `replyText` is omitted/empty the
 * adapter skips the `respond()` call — used by handlers that open a
 * modal instead of replying inline. Errors thrown by the handler are
 * caught, logged, and surfaced to the user as a generic ephemeral
 * message.
 */
export type SlashCommandHandler = (
  slackUserId: string,
  text: string,
  isDM: boolean,
  triggerId: string
) => Promise<{ replyText?: string; ephemeral?: boolean }>;

/**
 * Subset of a Slack `view` payload that view_submission handlers care
 * about. Modeled narrow on purpose so handlers don't grow accidental
 * dependencies on Bolt's full `ViewOutput` type.
 */
export interface ViewSubmissionPayload {
  state: {
    values: Record<string, Record<string, { value?: string | null }>>;
  };
  private_metadata?: string;
}

/**
 * Result returned by a view_submission handler:
 * - `{ ok: true }` closes the modal.
 * - `{ ok: false, errors }` keeps the modal open and shows inline
 *   validation errors keyed by `block_id` (matches Slack's
 *   `response_action: 'errors'` semantics).
 */
export type ViewSubmissionResult = { ok: true } | { ok: false; errors: Record<string, string> };

export type ViewSubmissionHandler = (
  slackUserId: string,
  view: ViewSubmissionPayload
) => Promise<ViewSubmissionResult>;

export class SlackAdapter implements IPlatformAdapter {
  private app: App;
  private streamingMode: 'stream' | 'batch';
  private messageHandler: ((event: SlackMessageEvent) => Promise<void>) | null = null;
  private allowedUserIds: string[];
  /**
   * Map of slash-command name (with leading slash) → handler. Registration
   * goes through `onSlashCommand()` so the adapter stays domain-agnostic
   * (same pattern as `onMessage()`). `start()` wires each entry into Bolt.
   */
  private slashHandlers = new Map<string, SlashCommandHandler>();
  /**
   * Map of modal `callback_id` → view_submission handler. Same lifecycle as
   * `slashHandlers`: register before `start()`, which wires each entry
   * into `app.view()`.
   */
  private viewHandlers = new Map<string, ViewSubmissionHandler>();

  constructor(botToken: string, appToken: string, mode: 'stream' | 'batch' = 'batch') {
    this.app = new App({
      token: botToken,
      socketMode: true,
      appToken: appToken,
      logLevel: LogLevel.INFO,
    });
    this.streamingMode = mode;

    // Parse Slack user whitelist (optional - empty = open access)
    this.allowedUserIds = parseAllowedUserIds(process.env.SLACK_ALLOWED_USER_IDS);
    if (this.allowedUserIds.length > 0) {
      getLog().info({ userCount: this.allowedUserIds.length }, 'slack.whitelist_enabled');
    } else {
      getLog().info('slack.whitelist_disabled');
    }

    getLog().info({ mode }, 'slack.adapter_initialized');
  }

  /**
   * Send a message to a Slack channel/thread
   * Uses markdown block for proper formatting of AI responses
   * Automatically splits messages longer than 12000 characters
   */
  async sendMessage(
    channelId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    getLog().debug({ channelId, messageLength: message.length }, 'slack.send_message');

    // Parse channelId - may include thread_ts as "channel:thread_ts"
    const [channel, threadTs] = channelId.includes(':')
      ? channelId.split(':')
      : [channelId, undefined];

    if (message.length <= MAX_MARKDOWN_BLOCK_LENGTH) {
      // Use markdown block for proper formatting
      await this.sendWithMarkdownBlock(channel, message, threadTs);
    } else {
      // Long message: split by paragraphs
      getLog().debug({ messageLength: message.length }, 'slack.message_splitting');
      const chunks = splitIntoParagraphChunks(message, MAX_MARKDOWN_BLOCK_LENGTH - 500);

      for (const chunk of chunks) {
        await this.sendWithMarkdownBlock(channel, chunk, threadTs);
      }
    }
  }

  /**
   * Send a message using Slack's markdown block for proper formatting
   * Falls back to plain text if block fails
   */
  private async sendWithMarkdownBlock(
    channel: string,
    message: string,
    threadTs?: string
  ): Promise<void> {
    try {
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks: [
          {
            type: 'markdown',
            text: message,
          },
        ],
        // Fallback text for notifications/accessibility
        text: message.substring(0, 150) + (message.length > 150 ? '...' : ''),
      });
      getLog().debug({ messageLength: message.length }, 'slack.markdown_block_sent');
    } catch (error) {
      // Fallback to plain text
      const err = error as Error;
      getLog().warn({ err, channel, threadTs }, 'slack.markdown_block_failed');
      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: message,
      });
    }
  }

  /**
   * Get the Bolt App instance
   */
  getApp(): App {
    return this.app;
  }

  /**
   * Get the configured streaming mode
   */
  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  /**
   * Get platform type
   */
  getPlatformType(): string {
    return 'slack';
  }

  /**
   * Check if a message is in a thread
   */
  isThread(event: SlackMessageEvent): boolean {
    return event.thread_ts !== undefined && event.thread_ts !== event.ts;
  }

  /**
   * Get parent conversation ID for a thread message
   * Returns null if not in a thread
   */
  getParentConversationId(event: SlackMessageEvent): string | null {
    if (this.isThread(event)) {
      // Parent conversation is the channel with the original message ts
      return `${event.channel}:${event.thread_ts}`;
    }
    return null;
  }

  /**
   * Fetch thread history (messages in the thread)
   * Returns messages in chronological order (oldest first)
   */
  async fetchThreadHistory(event: SlackMessageEvent): Promise<string[]> {
    if (!this.isThread(event) || !event.thread_ts) {
      return [];
    }

    try {
      const result = await this.app.client.conversations.replies({
        channel: event.channel,
        ts: event.thread_ts,
        limit: 100,
      });

      if (!result.messages) {
        return [];
      }

      // Messages are already in chronological order
      return result.messages.map(msg => {
        const author = msg.bot_id ? '[Bot]' : `<@${msg.user}>`;
        return `${author}: ${msg.text ?? ''}`;
      });
    } catch (error) {
      getLog().error({ err: error }, 'slack.thread_history_fetch_failed');
      return [];
    }
  }

  /**
   * Get conversation ID from Slack event
   * For threads: returns "channel:thread_ts" to maintain thread context
   * For non-threads: returns channel ID only
   */
  getConversationId(event: SlackMessageEvent): string {
    // If in a thread, use "channel:thread_ts" format
    // This ensures thread replies stay in the same conversation
    if (event.thread_ts) {
      return `${event.channel}:${event.thread_ts}`;
    }
    // If starting a new conversation in channel, use "channel:ts"
    // so future replies create a thread
    return `${event.channel}:${event.ts}`;
  }

  /**
   * Strip bot mention from message text and normalize Slack formatting
   */
  stripBotMention(text: string): string {
    // Slack mentions are <@USERID> format
    // Remove all user mentions at the start of the message
    let result = text.replace(/^<@[UW][A-Z0-9]+>\s*/g, '').trim();

    // Normalize Slack URL formatting: <https://example.com> -> https://example.com
    // Also handles URLs with labels: <https://example.com|example.com> -> https://example.com
    result = result.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]+)?>/g, '$1');

    return result;
  }

  /**
   * Ensure responses go to a thread.
   * For Slack, this is a no-op because:
   * 1. getConversationId() already returns "channel:ts" for non-thread messages
   * 2. sendMessage() parses this and uses ts as thread_ts
   * 3. This means all replies already go to threads
   *
   * @returns The original conversation ID (already thread-safe)
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    // Slack's conversation ID pattern already ensures threading:
    // - Non-thread: "channel:ts" → sendMessage uses ts as thread_ts
    // - In-thread: "channel:thread_ts" → sendMessage uses thread_ts
    // No additional work needed.
    return originalConversationId;
  }

  /**
   * Register a message handler for incoming messages
   * Must be called before start()
   */
  onMessage(handler: (event: SlackMessageEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Register a slash command handler.
   *
   * `name` is the full command including leading `/` (e.g. `/archon-creds`).
   * Must be called before `start()` — that's where the adapter wires Bolt's
   * `app.command()` so the receiver knows about the command.
   *
   * Authorization: the same allowlist used for messages is enforced before
   * the handler runs. Unauthorized invocations get a silent ephemeral reply
   * with no leakage of whether the bot is configured.
   */
  onSlashCommand(name: string, handler: SlashCommandHandler): void {
    if (!name.startsWith('/')) {
      throw new Error(`Slash command name must start with "/" — got "${name}"`);
    }
    if (this.slashHandlers.has(name)) {
      throw new Error(`Slash command already registered: ${name}`);
    }
    this.slashHandlers.set(name, handler);
  }

  /**
   * Open a Slack modal. Thin wrapper around `app.client.views.open` so
   * callers don't need to reach into Bolt. `trigger_id` from a slash
   * command / block_action is good for ~3 seconds, so the caller should
   * invoke this synchronously inside its handler.
   */
  async openView(triggerId: string, view: View): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await this.app.client.views.open({ trigger_id: triggerId, view });
      if (!r.ok) {
        getLog().warn({ error: r.error }, 'slack.views_open_failed');
        return { ok: false, error: r.error ?? 'unknown' };
      }
      return { ok: true };
    } catch (err) {
      getLog().error({ err }, 'slack.views_open_threw');
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Register a view_submission handler keyed by the modal's `callback_id`.
   * Must be called before `start()` — that's where the adapter wires
   * Bolt's `app.view()` so the receiver knows about it.
   *
   * Authorization uses the same allowlist as `onMessage`/`onSlashCommand`;
   * unauthorized submissions silently close the modal (empty `ack()`).
   */
  onViewSubmission(callbackId: string, handler: ViewSubmissionHandler): void {
    if (!callbackId) {
      throw new Error('View callback_id must be a non-empty string');
    }
    if (this.viewHandlers.has(callbackId)) {
      throw new Error(`View handler already registered: ${callbackId}`);
    }
    this.viewHandlers.set(callbackId, handler);
  }

  /**
   * Wire every registered view_submission handler into Bolt. Called from
   * `start()` exactly once.
   */
  private registerViewHandlersInternal(): void {
    for (const [callbackId, handler] of this.viewHandlers.entries()) {
      this.app.view(callbackId, async ({ ack, body, view }) => {
        const userId = body.user?.id ?? '';
        if (!isSlackUserAuthorized(userId, this.allowedUserIds)) {
          const masked = userId ? `${userId.slice(0, 4)}***` : 'unknown';
          getLog().info({ callbackId, maskedUserId: masked }, 'slack.unauthorized_view_submission');
          // Empty ack() closes the modal silently — same shape as the
          // success path so we don't leak whether a callback_id is wired.
          await ack();
          return;
        }
        try {
          const payload: ViewSubmissionPayload = {
            state: { values: view.state.values as ViewSubmissionPayload['state']['values'] },
            private_metadata: view.private_metadata,
          };
          const result = await handler(userId, payload);
          if (result.ok) {
            await ack();
          } else {
            await ack({ response_action: 'errors', errors: result.errors });
          }
        } catch (err) {
          getLog().error({ err, callbackId }, 'slack.view_submission_handler_failed');
          // Closing the modal silently on unexpected errors is the least
          // confusing outcome for the user — the alternative (sticky
          // modal with a generic error) blocks them from retrying.
          await ack();
        }
      });
    }
  }

  /**
   * Wire every registered slash-command handler into Bolt. Called from
   * `start()` exactly once; idempotent because `onSlashCommand()` rejects
   * duplicate names.
   */
  private registerSlashCommandsInternal(): void {
    for (const [name, handler] of this.slashHandlers.entries()) {
      this.app.command(name, async ({ command, ack, respond }) => {
        // Bolt requires ack within 3s; respond with the actual answer
        // separately so handlers can do real work without blocking ack.
        await ack();
        try {
          const userId = command.user_id;
          if (!isSlackUserAuthorized(userId, this.allowedUserIds)) {
            const masked = userId ? `${userId.slice(0, 4)}***` : 'unknown';
            getLog().info({ name, maskedUserId: masked }, 'slack.unauthorized_slash_command');
            await respond({
              response_type: 'ephemeral',
              text: 'You are not authorized to use this command.',
            });
            return;
          }
          const isDM = command.channel_name === 'directmessage';
          const text = command.text ?? '';
          const triggerId = command.trigger_id ?? '';
          const result = await handler(userId, text, isDM, triggerId);
          // Empty/missing replyText means the handler took some other
          // visible action (e.g. opened a modal via views.open) and
          // doesn't want a slash-command reply on top.
          if (result.replyText) {
            await respond({
              response_type: result.ephemeral === false ? 'in_channel' : 'ephemeral',
              text: result.replyText,
            });
          }
        } catch (err) {
          // Bolt will log this too, but a structured log line lives with our
          // other slack.* events for grep-ability.
          getLog().error({ err, name }, 'slack.slash_command_handler_failed');
          await respond({
            response_type: 'ephemeral',
            text: 'The command failed unexpectedly. Check server logs for details.',
          });
        }
      });
    }
  }

  /**
   * Start the bot (connects via Socket Mode)
   */
  async start(): Promise<void> {
    // Wire all registered slash commands into Bolt before the socket connects.
    // (Socket Mode picks up commands as the receiver dispatches them, so the
    // registration order vs. start() doesn't strictly matter — but doing it
    // here keeps the `onSlashCommand()` API symmetric with `onMessage()`.)
    this.registerSlashCommandsInternal();
    this.registerViewHandlersInternal();

    // Register app_mention event handler (when bot is @mentioned)
    this.app.event('app_mention', async ({ event }) => {
      // Authorization check
      const userId = event.user;
      if (!isSlackUserAuthorized(userId, this.allowedUserIds)) {
        const maskedId = userId ? `${userId.slice(0, 4)}***` : 'unknown';
        getLog().info({ maskedUserId: maskedId }, 'slack.unauthorized_message');
        return;
      }

      if (this.messageHandler && event.user) {
        const messageEvent: SlackMessageEvent = {
          text: event.text,
          user: event.user,
          channel: event.channel,
          ts: event.ts,
          thread_ts: event.thread_ts,
        };
        // Fire-and-forget - errors handled by caller
        void this.messageHandler(messageEvent);
      }
    });

    // Also handle direct messages (DMs don't require @mention)
    this.app.event('message', async ({ event }) => {
      // Only handle DM messages (channel type 'im')
      // Skip if this is a message in a channel (requires @mention via app_mention)
      // The 'channel_type' is on certain event subtypes
      const channelType = (event as { channel_type?: string }).channel_type;
      if (channelType !== 'im') {
        return;
      }

      // Skip bot messages to prevent loops
      if ('bot_id' in event && event.bot_id) {
        return;
      }

      // Authorization check
      const userId = 'user' in event ? event.user : undefined;
      if (!isSlackUserAuthorized(userId, this.allowedUserIds)) {
        const maskedId = userId ? `${userId.slice(0, 4)}***` : 'unknown';
        getLog().info({ maskedUserId: maskedId }, 'slack.unauthorized_dm');
        return;
      }

      if (this.messageHandler && 'text' in event && event.text) {
        const messageEvent: SlackMessageEvent = {
          text: event.text,
          user: userId ?? '',
          channel: event.channel,
          ts: event.ts,
          thread_ts: 'thread_ts' in event ? event.thread_ts : undefined,
        };
        void this.messageHandler(messageEvent);
      }
    });

    await this.app.start();
    getLog().info('slack.bot_started');
  }

  /**
   * Stop the bot gracefully
   */
  stop(): void {
    void this.app.stop();
    getLog().info('slack.bot_stopped');
  }
}
