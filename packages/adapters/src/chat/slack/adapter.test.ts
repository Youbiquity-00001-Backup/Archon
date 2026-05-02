/**
 * Unit tests for Slack adapter
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { Mock } from 'bun:test';

// Mock logger to suppress noisy output during tests
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Create mock functions
const mockPostMessage = mock(() => Promise.resolve(undefined));
const mockReplies = mock(() => Promise.resolve({ messages: [] }));
const mockEvent = mock(() => {});
const mockStart = mock(() => Promise.resolve(undefined));
const mockStop = mock(() => Promise.resolve(undefined));
// Captured slash-command registrations: name → Bolt handler. Tests fire them
// directly with a synthetic Bolt context to exercise the adapter's wrapping.
type BoltSlashHandler = (args: {
  command: { user_id: string; channel_name?: string; text?: string };
  ack: () => Promise<void>;
  respond: (response: { response_type?: string; text: string }) => Promise<void>;
}) => Promise<void>;
const slashRegistrations = new Map<string, BoltSlashHandler>();
const mockCommand = mock((name: string, handler: BoltSlashHandler) => {
  slashRegistrations.set(name, handler);
});

const mockApp = {
  client: {
    chat: {
      postMessage: mockPostMessage,
    },
    conversations: {
      replies: mockReplies,
    },
  },
  event: mockEvent,
  command: mockCommand,
  start: mockStart,
  stop: mockStop,
};

// Mock @slack/bolt
mock.module('@slack/bolt', () => ({
  App: mock(() => mockApp),
  LogLevel: {
    INFO: 'info',
  },
}));

import { SlackAdapter } from './adapter';
import type { SlackMessageEvent } from './types';

describe('SlackAdapter', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  describe('streaming mode configuration', () => {
    test('should return batch mode when configured', () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake', 'batch');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should default to batch mode', () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should return stream mode when explicitly configured', () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake', 'stream');
      expect(adapter.getStreamingMode()).toBe('stream');
    });
  });

  describe('platform type', () => {
    test('should return slack', () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      expect(adapter.getPlatformType()).toBe('slack');
    });
  });

  describe('thread detection', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
    });

    test('should detect thread when thread_ts differs from ts', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
        thread_ts: '1234567890.000001',
      };
      expect(adapter.isThread(event)).toBe(true);
    });

    test('should not detect thread when thread_ts equals ts', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
        thread_ts: '1234567890.123456',
      };
      expect(adapter.isThread(event)).toBe(false);
    });

    test('should not detect thread when thread_ts is undefined', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
      };
      expect(adapter.isThread(event)).toBe(false);
    });
  });

  describe('conversation ID', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
    });

    test('should return channel:thread_ts for thread messages', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
        thread_ts: '1234567890.000001',
      };
      expect(adapter.getConversationId(event)).toBe('C456:1234567890.000001');
    });

    test('should return channel:ts for non-thread messages', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
      };
      expect(adapter.getConversationId(event)).toBe('C456:1234567890.123456');
    });
  });

  describe('stripBotMention', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
    });

    test('should strip bot mention from start', () => {
      expect(adapter.stripBotMention('<@U1234ABCD> /clone https://github.com/test/repo')).toBe(
        '/clone https://github.com/test/repo'
      );
    });

    test('should strip multiple mentions', () => {
      expect(adapter.stripBotMention('<@U1234ABCD> <@W5678EFGH> hello')).toBe('<@W5678EFGH> hello');
    });

    test('should return unchanged if no mention', () => {
      expect(adapter.stripBotMention('/status')).toBe('/status');
    });

    test('should normalize Slack URL formatting', () => {
      expect(adapter.stripBotMention('<@U1234ABCD> /clone <https://github.com/test/repo>')).toBe(
        '/clone https://github.com/test/repo'
      );
    });

    test('should normalize Slack URL with label', () => {
      expect(
        adapter.stripBotMention(
          '<@U1234ABCD> check <https://github.com/test/repo|github.com/test/repo>'
        )
      ).toBe('check https://github.com/test/repo');
    });

    test('should normalize multiple URLs', () => {
      expect(
        adapter.stripBotMention(
          '<@U1234ABCD> compare <https://github.com/a> and <https://github.com/b>'
        )
      ).toBe('compare https://github.com/a and https://github.com/b');
    });
  });

  describe('parent conversation ID', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
    });

    test('should return parent conversation ID for thread messages', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
        thread_ts: '1234567890.000001',
      };
      expect(adapter.getParentConversationId(event)).toBe('C456:1234567890.000001');
    });

    test('should return null for non-thread messages', () => {
      const event: SlackMessageEvent = {
        text: 'test',
        user: 'U123',
        channel: 'C456',
        ts: '1234567890.123456',
      };
      expect(adapter.getParentConversationId(event)).toBe(null);
    });
  });

  describe('app instance', () => {
    test('should provide access to app instance', () => {
      const adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      const app = adapter.getApp();
      expect(app).toBeDefined();
      expect(app.client).toBeDefined();
    });
  });

  describe('thread creation (ensureThread)', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
    });

    test('should return original ID unchanged (threading via conversation ID pattern)', async () => {
      // Slack threading works via the "channel:ts" conversation ID pattern
      // No additional thread creation needed
      const result = await adapter.ensureThread('C123:1234567890.123456');
      expect(result).toBe('C123:1234567890.123456');
    });

    test('should work with thread conversation IDs', async () => {
      const result = await adapter.ensureThread('C123:1234567890.000001');
      expect(result).toBe('C123:1234567890.000001');
    });

    test('should work with channel-only IDs', async () => {
      // Edge case: if somehow only channel ID is passed
      const result = await adapter.ensureThread('C123');
      expect(result).toBe('C123');
    });
  });

  describe('message formatting', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      mockPostMessage.mockClear();
    });

    test('should send short messages with markdown block', async () => {
      await adapter.sendMessage('C123:1234.5678', '**Hello** world');

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: '1234.5678',
        blocks: [
          {
            type: 'markdown',
            text: '**Hello** world',
          },
        ],
        text: '**Hello** world',
      });
    });

    test('should send messages without thread_ts when not in thread', async () => {
      await adapter.sendMessage('C123', 'Hello');

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C123',
        thread_ts: undefined,
        blocks: [
          {
            type: 'markdown',
            text: 'Hello',
          },
        ],
        text: 'Hello',
      });
    });

    test('should truncate fallback text for long messages', async () => {
      const longMessage = 'a'.repeat(200);
      await adapter.sendMessage('C123', longMessage);

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'a'.repeat(150) + '...',
        })
      );
    });

    test('should fallback to plain text when markdown block fails', async () => {
      mockPostMessage
        .mockRejectedValueOnce(new Error('markdown block not supported'))
        .mockResolvedValueOnce(undefined);

      await adapter.sendMessage('C123', 'test message');

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
      // First call with markdown block
      expect(mockPostMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          blocks: expect.any(Array),
        })
      );
      // Second call plain text fallback
      expect(mockPostMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          text: 'test message',
        })
      );
      expect((mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[1][0]).not.toHaveProperty(
        'blocks'
      );
    });

    test('should split long messages into multiple markdown blocks', async () => {
      const paragraph1 = 'a'.repeat(10000);
      const paragraph2 = 'b'.repeat(10000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await adapter.sendMessage('C123', message);

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
      // Both calls should use markdown blocks
      expect((mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[0][0]).toHaveProperty(
        'blocks'
      );
      expect((mockPostMessage as Mock<typeof mockPostMessage>).mock.calls[1][0]).toHaveProperty(
        'blocks'
      );
    });

    test('should handle empty message without crashing', async () => {
      await adapter.sendMessage('C123', '');

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: [{ type: 'markdown', text: '' }],
        })
      );
    });
  });

  describe('slash commands (onSlashCommand + start wiring)', () => {
    let adapter: SlackAdapter;
    const ack = mock(async () => undefined);

    beforeEach(() => {
      adapter = new SlackAdapter('xoxb-fake', 'xapp-fake');
      slashRegistrations.clear();
      mockCommand.mockClear();
      ack.mockClear();
    });

    test('rejects names without a leading slash', () => {
      expect(() =>
        adapter.onSlashCommand('archon-creds', async () => ({ replyText: 'x' }))
      ).toThrow(/must start with/);
    });

    test('refuses duplicate registrations', () => {
      adapter.onSlashCommand('/archon-creds', async () => ({ replyText: 'x' }));
      expect(() =>
        adapter.onSlashCommand('/archon-creds', async () => ({ replyText: 'y' }))
      ).toThrow(/already registered/);
    });

    test('start() wires every registration into Bolt', async () => {
      adapter.onSlashCommand('/archon-creds', async () => ({ replyText: 'a' }));
      adapter.onSlashCommand('/archon-codebase', async () => ({ replyText: 'b' }));
      await adapter.start();
      expect(slashRegistrations.has('/archon-creds')).toBe(true);
      expect(slashRegistrations.has('/archon-codebase')).toBe(true);
    });

    test('handler reply is forwarded ephemerally by default', async () => {
      const handler = mock(async (uid: string, text: string, isDM: boolean) => {
        expect(uid).toBe('U_TEST');
        expect(text).toBe('anthropic abc');
        expect(isDM).toBe(true);
        return { replyText: 'ok' };
      });
      adapter.onSlashCommand('/archon-creds', handler);
      await adapter.start();

      const wired = slashRegistrations.get('/archon-creds');
      expect(wired).toBeDefined();
      const respond = mock(async () => undefined);
      await wired?.({
        command: {
          user_id: 'U_TEST',
          channel_name: 'directmessage',
          text: 'anthropic abc',
        },
        ack,
        respond,
      });
      expect(ack).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith({ response_type: 'ephemeral', text: 'ok' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('rejects unauthorized users when allowlist is configured', async () => {
      const original = process.env.SLACK_ALLOWED_USER_IDS;
      process.env.SLACK_ALLOWED_USER_IDS = 'U_AUTHED';
      try {
        const adapter2 = new SlackAdapter('xoxb-fake', 'xapp-fake');
        const handler = mock(async () => ({ replyText: 'should not fire' }));
        adapter2.onSlashCommand('/archon-creds', handler);
        await adapter2.start();
        const wired = slashRegistrations.get('/archon-creds');
        const respond = mock(async () => undefined);
        await wired?.({
          command: { user_id: 'U_OTHER', channel_name: 'directmessage', text: '' },
          ack,
          respond,
        });
        expect(handler).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringMatching(/not authorized/) })
        );
      } finally {
        if (original === undefined) delete process.env.SLACK_ALLOWED_USER_IDS;
        else process.env.SLACK_ALLOWED_USER_IDS = original;
      }
    });

    test('handler errors are logged and surfaced as a generic ephemeral reply', async () => {
      const handler = mock(async () => {
        throw new Error('boom');
      });
      adapter.onSlashCommand('/archon-creds', handler);
      await adapter.start();
      const wired = slashRegistrations.get('/archon-creds');
      const respond = mock(async () => undefined);
      await wired?.({
        command: { user_id: 'U_TEST', channel_name: 'directmessage', text: '' },
        ack,
        respond,
      });
      // The handler ran (and threw), but the user sees a generic message.
      expect(handler).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'ephemeral', text: expect.any(String) })
      );
    });
  });
});
