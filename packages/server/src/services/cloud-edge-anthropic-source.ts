/**
 * HTTP-backed `IAnthropicCredsSource` that proxies every operation to
 * cloud-edge's `/internal/archon/*` endpoints. Wired in only when
 * `CLOUD_EDGE_URL` + `CLOUD_EDGE_BEARER_TOKEN` are present in the
 * environment — local dev / CLI fall through to the legacy store-backed
 * UserCredsService path.
 *
 * Anthropic rotates the refresh_token on every refresh, so two stores
 * cannot both stay valid. cloud-edge owns the chain; archon is a
 * read-mostly consumer that calls the HTTP endpoints for fetch /
 * upsert / list / select.
 */
import { createLogger } from '@archon/paths';
import type {
  AnthropicFetchResult,
  AnthropicLabelsResult,
  AnthropicUpsertResult,
  IAnthropicCredsSource,
} from '@archon/core';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cloud-edge-anthropic-source');
  return cachedLog;
}

export interface CloudEdgeAnthropicSourceOptions {
  /** Base URL of cloud-edge, e.g. `https://llmworkers-dev.vesselhaven.com`. */
  cloudEdgeUrl: string;
  /** Bearer token authenticating internal archon → cloud-edge calls. */
  bearerToken: string;
  /** Slack workspace ID this archon deployment talks to. */
  teamId: string;
  /** Test seam — defaults to global `fetch`. */
  fetch?: typeof fetch;
}

interface ReadResponseBody {
  label: string;
  account_email?: string;
  subscription_type?: string;
  credentials_json: string;
  creds_version?: number;
}

interface UpsertResponseBody {
  created: boolean;
  label: string;
  secret_arn: string;
}

interface LabelEntry {
  label: string;
  account_email?: string;
  subscription_type?: string;
  creds_version?: number;
  created_at?: string;
}

interface ListLabelsResponseBody {
  archon_cred_label: string | null;
  labels: LabelEntry[];
}

export class CloudEdgeAnthropicSource implements IAnthropicCredsSource {
  private readonly cloudEdgeUrl: string;
  private readonly bearerToken: string;
  private readonly teamId: string;
  private readonly httpFetch: typeof fetch;

  constructor(opts: CloudEdgeAnthropicSourceOptions) {
    this.cloudEdgeUrl = opts.cloudEdgeUrl.replace(/\/+$/, '');
    this.bearerToken = opts.bearerToken;
    this.teamId = opts.teamId;
    this.httpFetch = opts.fetch ?? globalThis.fetch;
    if (!this.cloudEdgeUrl) throw new Error('CloudEdgeAnthropicSource: cloudEdgeUrl is required');
    if (!this.bearerToken) throw new Error('CloudEdgeAnthropicSource: bearerToken is required');
    if (!this.teamId) throw new Error('CloudEdgeAnthropicSource: teamId is required');
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      'Content-Type': 'application/json',
    };
  }

  async fetch(slackUserId: string): Promise<AnthropicFetchResult | null> {
    const res = await this.httpFetch(`${this.cloudEdgeUrl}/internal/archon/anthropic-creds`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ team_id: this.teamId, slack_user_id: slackUserId }),
    });
    if (res.status === 404) return null;
    if (res.status === 410) {
      // Refresh chain dead. Surface as "no creds" so the workflow asks
      // the user to re-upload — the design doc deliberately treats this
      // the same as never-linked at the caller surface.
      getLog().warn({ slackUserId }, 'cloud-edge-source.invalid_grant');
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`cloud-edge fetch failed: status=${res.status} body=${body.slice(0, 200)}`);
    }
    const body = (await res.json()) as ReadResponseBody;
    return {
      credsJson: body.credentials_json,
      label: body.label,
      accountEmail: body.account_email,
      subscriptionType: body.subscription_type,
      credsVersion: body.creds_version,
    };
  }

  async upsert(slackUserId: string, rawJson: string, label?: string): Promise<AnthropicUpsertResult> {
    const res = await this.httpFetch(`${this.cloudEdgeUrl}/internal/archon/anthropic-creds/upsert`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        team_id: this.teamId,
        slack_user_id: slackUserId,
        credentials_json: rawJson,
        ...(label ? { label } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`cloud-edge upsert failed: status=${res.status} body=${body.slice(0, 200)}`);
    }
    const body = (await res.json()) as UpsertResponseBody;
    return { created: body.created, label: body.label };
  }

  async listLabels(slackUserId: string): Promise<AnthropicLabelsResult> {
    const url = new URL(`${this.cloudEdgeUrl}/internal/archon/anthropic-creds/labels`);
    url.searchParams.set('team_id', this.teamId);
    url.searchParams.set('slack_user_id', slackUserId);
    const res = await this.httpFetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`cloud-edge listLabels failed: status=${res.status} body=${body.slice(0, 200)}`);
    }
    const body = (await res.json()) as ListLabelsResponseBody;
    return {
      archonCredLabel: body.archon_cred_label,
      labels: body.labels.map(l => ({
        label: l.label,
        accountEmail: l.account_email,
        subscriptionType: l.subscription_type,
        credsVersion: l.creds_version,
        createdAt: l.created_at,
      })),
    };
  }

  async setArchonCredLabel(slackUserId: string, label: string | null): Promise<void> {
    const res = await this.httpFetch(`${this.cloudEdgeUrl}/internal/archon/user-prefs/archon-cred-label`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ team_id: this.teamId, slack_user_id: slackUserId, label }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`cloud-edge setArchonCredLabel failed: status=${res.status} body=${body.slice(0, 200)}`);
    }
  }
}
