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

export const CALLBACK_JIRA_CREDS = 'archon_creds_jira';
export const BLOCK_JIRA_BASE_URL = 'jira_base_url';
export const ACTION_JIRA_BASE_URL = 'jira_base_url_value';
export const BLOCK_JIRA_EMAIL = 'jira_email';
export const ACTION_JIRA_EMAIL = 'jira_email_value';
export const BLOCK_JIRA_API_TOKEN = 'jira_api_token';
export const ACTION_JIRA_API_TOKEN = 'jira_api_token_value';

/**
 * Three-input modal for Jira Cloud PAT linking. Distinct from the
 * single-JSON-paste anthropic modal because users get base URL, email, and
 * API token as three separate values (from id.atlassian.com → Security →
 * API tokens), not as a single blob. Validation runs on submit:
 *  - All three fields non-empty
 *  - Base URL starts with `https://` and ends on a `*.atlassian.net` host
 * The view-submission handler also probes `/rest/api/3/myself` and DMs the
 * user the outcome (probe is too slow for the synchronous ack window).
 */
export function jiraCredsModal(): ModalView {
  return {
    type: 'modal',
    callback_id: CALLBACK_JIRA_CREDS,
    title: { type: 'plain_text', text: 'Connect Jira' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'Generate an API token at <https://id.atlassian.com/manage-profile/security/api-tokens|id.atlassian.com → Security → API tokens>, ' +
            'then paste your tenant URL, the Atlassian account email, and the token below. ' +
            "Archon stores all three and exposes them as `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` to your assistant's tools.",
        },
      },
      {
        type: 'input',
        block_id: BLOCK_JIRA_BASE_URL,
        label: { type: 'plain_text', text: 'Tenant URL' },
        element: {
          type: 'plain_text_input',
          action_id: ACTION_JIRA_BASE_URL,
          placeholder: { type: 'plain_text', text: 'https://acme.atlassian.net' },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_JIRA_EMAIL,
        label: { type: 'plain_text', text: 'Atlassian account email' },
        element: {
          type: 'plain_text_input',
          action_id: ACTION_JIRA_EMAIL,
          placeholder: { type: 'plain_text', text: 'you@example.com' },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_JIRA_API_TOKEN,
        label: { type: 'plain_text', text: 'API token' },
        element: {
          type: 'plain_text_input',
          action_id: ACTION_JIRA_API_TOKEN,
          placeholder: { type: 'plain_text', text: 'ATATT…' },
        },
      },
    ],
  };
}

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
