/**
 * Slack modal view definitions.
 *
 * Constants and builder live together so the layout, callback_id, and
 * block_id strings stay in step with the view_submission handler that
 * consumes them. Mirrors the cred-paste modal in
 * llm-slack-channel-bridge/packages/cloud-edge/src/views.ts; we drop
 * the multi-credential `label` input because Archon's UserCredsService
 * stores one Anthropic cred per Slack user.
 */

import type { ModalView } from '@slack/types';

export const CALLBACK_ANTHROPIC_CREDS = 'archon_creds_anthropic';
export const BLOCK_ANTHROPIC_CREDS_INPUT = 'creds_input';
export const ACTION_ANTHROPIC_CREDS_VALUE = 'creds_value';

export function anthropicCredsModal(): ModalView {
  return {
    type: 'modal',
    callback_id: CALLBACK_ANTHROPIC_CREDS,
    title: { type: 'plain_text', text: 'Connect Anthropic' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'Paste the contents of your local `~/.claude/.credentials.json`. ' +
            'Run `claude /login` first if you need to refresh it — Archon will ' +
            'use the access token + refresh token from this blob and persist ' +
            'refreshes across restarts.',
        },
      },
      {
        type: 'input',
        block_id: BLOCK_ANTHROPIC_CREDS_INPUT,
        label: { type: 'plain_text', text: 'credentials.json' },
        element: {
          type: 'plain_text_input',
          action_id: ACTION_ANTHROPIC_CREDS_VALUE,
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: '{ "claudeAiOauth": { "accessToken": "...", "refreshToken": "..." } }',
          },
        },
      },
    ],
  };
}
