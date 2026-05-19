import { describe, test, expect } from 'bun:test';
import { CloudEdgeAnthropicSource } from './cloud-edge-anthropic-source';

function makeSource(handler: (req: Request) => Promise<Response> | Response): CloudEdgeAnthropicSource {
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const req = new Request(url, init);
    return Promise.resolve(handler(req));
  };
  return new CloudEdgeAnthropicSource({
    cloudEdgeUrl: 'https://example.test',
    bearerToken: 'sekrit',
    teamId: 'T1',
    fetch: fakeFetch as unknown as typeof fetch,
  });
}

describe('CloudEdgeAnthropicSource', () => {
  test('fetch: returns parsed result on 200', async () => {
    const source = makeSource(async req => {
      expect(req.url).toBe('https://example.test/internal/archon/anthropic-creds');
      expect(req.method).toBe('POST');
      expect(req.headers.get('authorization')).toBe('Bearer sekrit');
      const body = (await req.json()) as { team_id: string; slack_user_id: string };
      expect(body).toEqual({ team_id: 'T1', slack_user_id: 'U1' });
      return Response.json({
        label: 'personalmax',
        account_email: 'nathan@example.com',
        subscription_type: 'claude_max_5x',
        credentials_json: '{"claudeAiOauth":{}}',
        creds_version: 3,
      });
    });
    const result = await source.fetch('U1');
    expect(result).toEqual({
      credsJson: '{"claudeAiOauth":{}}',
      label: 'personalmax',
      accountEmail: 'nathan@example.com',
      subscriptionType: 'claude_max_5x',
      credsVersion: 3,
    });
  });

  test('fetch: returns null on 404', async () => {
    const source = makeSource(() => new Response('no_creds', { status: 404 }));
    expect(await source.fetch('U1')).toBeNull();
  });

  test('fetch: returns null on 410 (invalid_grant — treated like missing)', async () => {
    const source = makeSource(() => new Response('invalid_grant', { status: 410 }));
    expect(await source.fetch('U1')).toBeNull();
  });

  test('fetch: throws on 5xx', async () => {
    const source = makeSource(() => new Response('boom', { status: 503 }));
    await expect(source.fetch('U1')).rejects.toThrow(/status=503/);
  });

  test('upsert: forwards body and returns created flag', async () => {
    const source = makeSource(async req => {
      expect(req.url).toBe('https://example.test/internal/archon/anthropic-creds/upsert');
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({
        team_id: 'T1',
        slack_user_id: 'U1',
        credentials_json: '{"claudeAiOauth":{"accessToken":"x"}}',
        label: 'my-label',
      });
      return Response.json({ created: true, label: 'my-label', secret_arn: 'arn:aws:secretsmanager:...' });
    });
    const result = await source.upsert('U1', '{"claudeAiOauth":{"accessToken":"x"}}', 'my-label');
    expect(result).toEqual({ created: true, label: 'my-label' });
  });

  test('upsert: omits label when not provided', async () => {
    const source = makeSource(async req => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body.label).toBeUndefined();
      return Response.json({ created: false, label: 'U1', secret_arn: 'arn:...' });
    });
    await source.upsert('U1', '{"claudeAiOauth":{"accessToken":"x"}}');
  });

  test('listLabels: parses response and maps to camelCase', async () => {
    const source = makeSource(async req => {
      expect(req.url).toBe('https://example.test/internal/archon/anthropic-creds/labels?team_id=T1&slack_user_id=U1');
      expect(req.method).toBe('GET');
      return Response.json({
        archon_cred_label: 'personalmax',
        labels: [
          { label: 'personalmax', account_email: 'nathan@example.com', subscription_type: 'claude_max_5x' },
          { label: 'other', creds_version: 2 },
        ],
      });
    });
    const result = await source.listLabels('U1');
    expect(result.archonCredLabel).toBe('personalmax');
    expect(result.labels).toEqual([
      { label: 'personalmax', accountEmail: 'nathan@example.com', subscriptionType: 'claude_max_5x', credsVersion: undefined, createdAt: undefined },
      { label: 'other', accountEmail: undefined, subscriptionType: undefined, credsVersion: 2, createdAt: undefined },
    ]);
  });

  test('setArchonCredLabel: forwards label string', async () => {
    let calledWith: unknown = null;
    const source = makeSource(async req => {
      expect(req.url).toBe('https://example.test/internal/archon/user-prefs/archon-cred-label');
      calledWith = await req.json();
      return Response.json({ ok: true });
    });
    await source.setArchonCredLabel('U1', 'personalmax');
    expect(calledWith).toEqual({ team_id: 'T1', slack_user_id: 'U1', label: 'personalmax' });
  });

  test('setArchonCredLabel: forwards null to clear', async () => {
    let calledWith: unknown = null;
    const source = makeSource(async req => {
      calledWith = await req.json();
      return Response.json({ ok: true });
    });
    await source.setArchonCredLabel('U1', null);
    expect(calledWith).toEqual({ team_id: 'T1', slack_user_id: 'U1', label: null });
  });

  test('constructor: rejects missing url / bearer / teamId', () => {
    expect(
      () =>
        new CloudEdgeAnthropicSource({ cloudEdgeUrl: '', bearerToken: 'x', teamId: 'T1' })
    ).toThrow();
    expect(
      () =>
        new CloudEdgeAnthropicSource({ cloudEdgeUrl: 'https://x', bearerToken: '', teamId: 'T1' })
    ).toThrow();
    expect(
      () =>
        new CloudEdgeAnthropicSource({ cloudEdgeUrl: 'https://x', bearerToken: 'x', teamId: '' })
    ).toThrow();
  });

  test('constructor: strips trailing slash from cloudEdgeUrl', async () => {
    let observedUrl = '';
    const source = new CloudEdgeAnthropicSource({
      cloudEdgeUrl: 'https://example.test/',
      bearerToken: 'sekrit',
      teamId: 'T1',
      fetch: (async (input: RequestInfo | URL) => {
        observedUrl = typeof input === 'string' ? input : input.toString();
        return new Response(null, { status: 404 });
      }) as unknown as typeof fetch,
    });
    await source.fetch('U1');
    expect(observedUrl).toBe('https://example.test/internal/archon/anthropic-creds');
  });
});
