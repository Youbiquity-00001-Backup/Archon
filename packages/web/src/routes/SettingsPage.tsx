import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { Header } from '@/components/layout/Header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getConfig,
  getHealth,
  listCodebases,
  listProviders,
  addCodebase,
  getCodebaseInput,
  deleteCodebase,
  updateAssistantConfig,
  getCodebaseEnvVars,
  setCodebaseEnvVar,
  deleteCodebaseEnvVar,
  getIdentity,
  getConnections,
  getAnthropicLabels,
  uploadAnthropicCreds,
  selectAnthropicLabel,
  linkJira,
} from '@/lib/api';
import type {
  SafeConfigResponse,
  CodebaseResponse,
  ProviderDefaults,
  ProviderInfo,
  IdentityResponse,
  ConnectionsResponse,
  AnthropicConnection,
  AnthropicLabelsResponse,
  JiraConnection,
} from '@/lib/api';

const selectClass =
  'h-9 rounded-md border border-border bg-surface-elevated text-text-primary px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring [&>option]:bg-surface-elevated [&>option]:text-text-primary';

function SystemHealthSection({
  health,
  database,
}: {
  health:
    | {
        status: string;
        adapter: string;
        concurrency: { active: number; queuedTotal: number; maxConcurrent: number };
        runningWorkflows: number;
        version?: string;
      }
    | undefined;
  database: string | undefined;
}): React.ReactElement {
  const gitCommit = import.meta.env.VITE_GIT_COMMIT as string;
  return (
    <Card>
      <CardHeader>
        <CardTitle>System Health</CardTitle>
      </CardHeader>
      <CardContent>
        {!health ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <span className="text-muted-foreground">Status: </span>
              <Badge variant={health.status === 'ok' ? 'default' : 'destructive'}>
                {health.status}
              </Badge>
            </div>
            <div>
              <span className="text-muted-foreground">Adapter: </span>
              <span className="font-medium">{health.adapter}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Database: </span>
              <span className="font-medium">{database ?? 'unknown'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Active: </span>
              <span className="font-medium">
                {health.concurrency.active}/{health.concurrency.maxConcurrent}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Queued: </span>
              <span className="font-medium">{health.concurrency.queuedTotal}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Workflows: </span>
              <span className="font-medium">{health.runningWorkflows}</span>
            </div>
            {health.version && (
              <div>
                <span className="text-muted-foreground">Version: </span>
                <span className="font-medium">{health.version}</span>
              </div>
            )}
            {gitCommit && gitCommit !== 'unknown' && (
              <div>
                <span className="text-muted-foreground">Commit: </span>
                <span className="font-medium font-mono">{gitCommit}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EnvVarsPanel({ codebaseId }: { codebaseId: string }): React.ReactElement {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const { data: envVars } = useQuery({
    queryKey: ['codebaseEnvVars', codebaseId],
    queryFn: () => getCodebaseEnvVars(codebaseId),
  });

  const [mutationError, setMutationError] = useState<string | null>(null);

  const setMutation = useMutation({
    mutationFn: (data: { key: string; value: string }) => setCodebaseEnvVar(codebaseId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebaseEnvVars', codebaseId] });
      if (editingKey) {
        setEditingKey(null);
        setEditValue('');
      } else {
        setNewKey('');
        setNewValue('');
      }
      setMutationError(null);
    },
    onError: (err: Error) => {
      setMutationError(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => deleteCodebaseEnvVar(codebaseId, key),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebaseEnvVars', codebaseId] });
      setMutationError(null);
    },
    onError: (err: Error) => {
      setMutationError(err.message);
    },
  });

  function handleAdd(e: React.FormEvent): void {
    e.preventDefault();
    if (newKey.trim() && newValue !== '') {
      setMutation.mutate({ key: newKey.trim(), value: newValue });
    }
  }

  function handleEditSave(key: string): void {
    if (editValue !== '') {
      setMutation.mutate({ key, value: editValue });
    }
  }

  const keys = envVars ?? [];

  return (
    <div className="mt-2 pl-2 border-l border-border space-y-2">
      {mutationError && <div className="text-xs text-destructive">{mutationError}</div>}
      {keys.length === 0 ? (
        <div className="text-xs text-muted-foreground">No env vars set.</div>
      ) : (
        <div className="space-y-1">
          {keys.map(key => (
            <div key={key} className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono text-text-primary truncate flex-1">{key}</span>
                <span className="text-muted-foreground">= ------</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 text-xs"
                  onClick={() => {
                    if (editingKey === key) {
                      setEditingKey(null);
                      setEditValue('');
                    } else {
                      setEditingKey(key);
                      setEditValue('');
                    }
                  }}
                >
                  {editingKey === key ? 'Cancel' : 'Edit'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 text-xs"
                  onClick={() => {
                    deleteMutation.mutate(key);
                  }}
                  disabled={deleteMutation.isPending}
                >
                  Remove
                </Button>
              </div>
              {editingKey === key && (
                <div className="flex gap-1 pl-2">
                  <Input
                    value={editValue}
                    onChange={e => {
                      setEditValue(e.target.value);
                    }}
                    placeholder="new value"
                    className="flex-1 h-7 text-xs"
                    autoFocus
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleEditSave(key);
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      handleEditSave(key);
                    }}
                    disabled={setMutation.isPending}
                  >
                    Save
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={handleAdd} className="flex gap-1">
        <Input
          value={newKey}
          onChange={e => {
            setNewKey(e.target.value);
          }}
          placeholder="KEY"
          className="flex-1 h-7 text-xs font-mono"
        />
        <Input
          value={newValue}
          onChange={e => {
            setNewValue(e.target.value);
          }}
          placeholder="value"
          className="flex-1 h-7 text-xs"
        />
        <Button type="submit" size="sm" className="h-7 text-xs" disabled={setMutation.isPending}>
          Add
        </Button>
      </form>
    </div>
  );
}

/**
 * Anthropic credentials panel (Phase 5 / cloud-edge unification).
 *
 * Replaces the Slack-only paste flow. Users upload `credentials.json`
 * directly here; the archon backend forwards to cloud-edge so cloud-edge
 * stays the single source of truth (Anthropic rotates the refresh_token
 * on every refresh — two stores cannot both stay valid). The label
 * picker writes `UserPreferencesRow.archon_cred_label` via the
 * cloud-edge HTTP API.
 */
function AnthropicConnectionPanel({
  summary,
}: {
  summary: AnthropicConnection;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<AnthropicLabelsResponse | null>({
    queryKey: ['connections', 'anthropic', 'labels'],
    queryFn: async () => {
      try {
        return await getAnthropicLabels();
      } catch (err) {
        if ((err as Error & { status?: number }).status === 503) return null;
        throw err;
      }
    },
    staleTime: 30 * 1000,
  });

  const [pasted, setPasted] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteSuccess, setPasteSuccess] = useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: async (args: { credentials_json: string; label?: string }) =>
      uploadAnthropicCreds(args),
    onSuccess: result => {
      setPasted('');
      setLabelInput('');
      setPasteError(null);
      setPasteSuccess(result.message);
      void queryClient.invalidateQueries({ queryKey: ['connections', 'anthropic', 'labels'] });
      void queryClient.invalidateQueries({ queryKey: ['auth', 'connections'] });
    },
    onError: err => {
      setPasteSuccess(null);
      setPasteError(err instanceof Error ? err.message : 'Upload failed');
    },
  });

  const selectMutation = useMutation({
    mutationFn: async (label: string | null) => selectAnthropicLabel(label),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['connections', 'anthropic', 'labels'] });
    },
  });

  const handleUpload = (e: React.FormEvent): void => {
    e.preventDefault();
    setPasteError(null);
    setPasteSuccess(null);
    if (!pasted.trim()) {
      setPasteError('Paste a credentials.json blob.');
      return;
    }
    uploadMutation.mutate({
      credentials_json: pasted.trim(),
      ...(labelInput.trim() ? { label: labelInput.trim() } : {}),
    });
  };

  const labels = data?.labels ?? [];
  const archonCredLabel = data?.archon_cred_label ?? null;

  return (
    <div className="space-y-3">
      <div className="font-medium">Anthropic</div>

      {summary.linked && (
        <div className="text-xs text-muted-foreground">
          Linked{summary.accountEmail ? ` as ${summary.accountEmail}` : ''}
          {archonCredLabel ? ` (using label "${archonCredLabel}")` : ''}
        </div>
      )}
      {!summary.linked && (
        <div className="text-xs text-muted-foreground">
          Not linked yet — paste your <code>~/.claude/.credentials.json</code> below.
        </div>
      )}

      {labels.length > 0 && (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Archon credentials (used across all archon repos for you)
          </label>
          <select
            className={selectClass}
            value={archonCredLabel ?? '__default__'}
            disabled={selectMutation.isPending}
            onChange={e => {
              const v = e.target.value;
              selectMutation.mutate(v === '__default__' ? null : v);
            }}
          >
            <option value="__default__">Use my default Anthropic creds</option>
            {labels.map(l => (
              <option key={l.label} value={l.label}>
                {l.label}
                {l.accountEmail ? ` — ${l.accountEmail}` : ''}
                {l.subscriptionType ? ` (${l.subscriptionType})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <form onSubmit={handleUpload} className="space-y-2">
        <label className="text-xs text-muted-foreground">
          Paste <code>~/.claude/.credentials.json</code> contents
        </label>
        <textarea
          value={pasted}
          onChange={e => {
            setPasted(e.target.value);
          }}
          disabled={uploadMutation.isPending}
          rows={6}
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-md border border-border bg-surface-elevated text-text-primary p-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder='{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}'
        />
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Label (optional — defaults to your Slack user id)
          </label>
          <Input
            value={labelInput}
            onChange={e => {
              setLabelInput(e.target.value);
            }}
            disabled={uploadMutation.isPending}
            placeholder="e.g. personal-max"
            className="text-xs"
          />
        </div>
        {pasteError && <div className="text-xs text-destructive">{pasteError}</div>}
        {pasteSuccess && <div className="text-xs text-emerald-500">{pasteSuccess}</div>}
        <Button type="submit" size="sm" disabled={uploadMutation.isPending}>
          {uploadMutation.isPending ? 'Saving…' : 'Save credentials'}
        </Button>
      </form>

      {isLoading && labels.length === 0 && (
        <div className="text-xs text-muted-foreground">Loading labels…</div>
      )}
      {error && (
        <div className="text-xs text-destructive">
          Could not load labels: {error instanceof Error ? error.message : String(error)}
        </div>
      )}
    </div>
  );
}

/**
 * Jira credentials panel — in-page form to link an Atlassian API token.
 * Backend validates URL shape + probes /rest/api/3/myself before
 * persisting; the Slack-side `/archon-creds jira` modal stays as an
 * alternate entry point. No probe is performed in the SPA — the
 * server runs it (probes can take a couple seconds and need network
 * egress) and reports the outcome via the response.
 */
function JiraConnectionPanel({
  summary,
}: {
  summary: JiraConnection;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const linkMutation = useMutation({
    mutationFn: async (args: { base_url: string; email: string; api_token: string }) =>
      linkJira(args),
    onSuccess: result => {
      setBaseUrl('');
      setEmail('');
      setApiToken('');
      setFormError(null);
      setFormSuccess(result.message);
      void queryClient.invalidateQueries({ queryKey: ['auth', 'connections'] });
    },
    onError: err => {
      setFormSuccess(null);
      setFormError(err instanceof Error ? err.message : 'Link failed');
    },
  });

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    const trimmedBase = baseUrl.trim();
    const trimmedEmail = email.trim();
    const trimmedToken = apiToken.trim();
    if (!trimmedBase || !trimmedEmail || !trimmedToken) {
      setFormError('All three fields are required.');
      return;
    }
    linkMutation.mutate({
      base_url: trimmedBase,
      email: trimmedEmail,
      api_token: trimmedToken,
    });
  };

  return (
    <div className="space-y-3">
      <div className="font-medium">Jira</div>

      {summary.linked ? (
        <div className="text-xs text-muted-foreground">
          Linked as <span className="font-mono">{summary.email}</span> on{' '}
          <span className="font-mono">{summary.baseUrl}</span>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Not linked yet — fill in the form below. Generate an API token at{' '}
          <a
            href="https://id.atlassian.com/manage-profile/security/api-tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            id.atlassian.com → Security → API tokens
          </a>
          .
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Jira Cloud URL (must end with <code>.atlassian.net</code>)
          </label>
          <Input
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            disabled={linkMutation.isPending}
            placeholder="https://acme.atlassian.net"
            className="text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Atlassian account email</label>
          <Input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            disabled={linkMutation.isPending}
            placeholder="you@example.com"
            className="text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">API token</label>
          <Input
            type="password"
            value={apiToken}
            onChange={e => setApiToken(e.target.value)}
            disabled={linkMutation.isPending}
            placeholder="ATATT3xFfGF0..."
            className="text-xs"
            autoComplete="off"
          />
        </div>
        {formError && <div className="text-xs text-destructive">{formError}</div>}
        {formSuccess && <div className="text-xs text-emerald-500">{formSuccess}</div>}
        <Button type="submit" size="sm" disabled={linkMutation.isPending}>
          {linkMutation.isPending ? 'Linking…' : summary.linked ? 'Replace credentials' : 'Link Jira'}
        </Button>
      </form>
    </div>
  );
}

/**
 * Per-user account connections (Phase A.1 / Phase 5). Anthropic uses an
 * in-page form (cloud-edge owns the chain); Jira uses an in-page form
 * (validated + probed server-side); GitHub uses `/auth/github/initiate`.
 */
function AccountConnectionsSection(): React.ReactElement {
  const { data, isLoading, error } = useQuery<ConnectionsResponse | null>({
    queryKey: ['auth', 'connections'],
    queryFn: getConnections,
    staleTime: 30 * 1000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>My Connections</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {error && (
          <div className="text-destructive">
            {error instanceof Error ? error.message : 'Failed to load connections'}
          </div>
        )}
        {!isLoading && !error && !data && (
          <div className="text-muted-foreground">
            Sign-in required. In dev mode (no ALB OIDC), this section stays empty.
          </div>
        )}

        {data && (
          <>
            <AnthropicConnectionPanel summary={data.anthropic} />

            <div>
              <div className="font-medium">GitHub</div>
              {data.github.linked ? (
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    Linked as <span className="font-mono">{data.github.login}</span>
                    {data.github.installationId
                      ? ` (installation #${String(data.github.installationId)})`
                      : ''}
                  </div>
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    title="Re-run the OAuth flow to refresh this link"
                  >
                    <a href="/auth/github/initiate">Re-link GitHub</a>
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Not linked.</div>
                  <Button asChild variant="default" size="sm" className="text-xs">
                    <a href="/auth/github/initiate">Link GitHub</a>
                  </Button>
                </div>
              )}
            </div>

            <JiraConnectionPanel summary={data.jira} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectsSection(): React.ReactElement {
  const queryClient = useQueryClient();
  const [addValue, setAddValue] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [expandedEnvVars, setExpandedEnvVars] = useState<string | null>(null);

  const { data: codebases } = useQuery({
    queryKey: ['codebases'],
    queryFn: listCodebases,
  });

  // Identity drives the registrar-only Remove guard. In dev (no OIDC
  // middleware) the query returns null and we treat every row as
  // removable — the backend is the actual authority and would also
  // skip the check, so the UI matches.
  const { data: identity } = useQuery<IdentityResponse | null>({
    queryKey: ['auth', 'identity'],
    queryFn: getIdentity,
    staleTime: 5 * 60 * 1000,
  });
  const currentUid = identity?.slackUserId ?? null;

  const addMutation = useMutation({
    mutationFn: (value: string) => addCodebase(getCodebaseInput(value)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebases'] });
      setAddValue('');
      setShowAdd(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCodebase(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['codebases'] });
    },
  });

  function handleAddSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (addValue.trim()) {
      addMutation.mutate(addValue.trim());
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Projects</CardTitle>
      </CardHeader>
      <CardContent>
        {!codebases || codebases.length === 0 ? (
          <div className="text-sm text-muted-foreground">No projects registered.</div>
        ) : (
          <div className="space-y-2">
            {codebases.map((cb: CodebaseResponse) => {
              // Remove allowed when:
              //  - we don't know the current user (dev mode \u2192 backend has
              //    no enforcement either, so the button is consistent), OR
              //  - the codebase has no registrar attribution (legacy row
              //    or registered before Patch 3), OR
              //  - the current user IS the registrar.
              const canRemove =
                currentUid === null ||
                cb.registered_by_slack_user_id === null ||
                cb.registered_by_slack_user_id === currentUid;
              return (
                <div key={cb.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{cb.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{cb.default_cwd}</div>
                      {cb.registered_by_slack_user_id && (
                        <div className="text-xs text-muted-foreground truncate">
                          Registered by{' '}
                          <span className="font-mono">{cb.registered_by_slack_user_id}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs"
                        onClick={() => {
                          setExpandedEnvVars(expandedEnvVars === cb.id ? null : cb.id);
                        }}
                      >
                        Env Vars {expandedEnvVars === cb.id ? '\u25B2' : '\u25BC'}
                      </Button>
                      {canRemove && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            deleteMutation.mutate(cb.id);
                          }}
                          disabled={deleteMutation.isPending}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                  {expandedEnvVars === cb.id && <EnvVarsPanel codebaseId={cb.id} />}
                </div>
              );
            })}
          </div>
        )}

        {showAdd ? (
          <form onSubmit={handleAddSubmit} className="mt-3 flex gap-2">
            <Input
              value={addValue}
              onChange={e => {
                setAddValue(e.target.value);
              }}
              placeholder="GitHub URL or local path"
              className="flex-1"
            />
            <Button type="submit" size="sm" disabled={addMutation.isPending}>
              Add
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowAdd(false);
                setAddValue('');
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              setShowAdd(true);
            }}
          >
            + Add Project
          </Button>
        )}

        {addMutation.isError && (
          <div className="mt-2 text-sm text-destructive">
            {addMutation.error instanceof Error
              ? addMutation.error.message
              : 'Failed to add project'}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AssistantConfigSection({ config }: { config: SafeConfigResponse }): React.ReactElement {
  const queryClient = useQueryClient();
  const { data: providers } = useQuery({
    queryKey: ['providers'],
    queryFn: listProviders,
    staleTime: 5 * 60 * 1000,
  });
  const [assistant, setAssistant] = useState<string>(config.assistant);
  const [assistantSettings, setAssistantSettings] = useState<Record<string, ProviderDefaults>>(
    config.assistants
  );
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const normalizedConfigSettings = JSON.stringify(config.assistants);
  const normalizedAssistantSettings = JSON.stringify(assistantSettings);
  const hasChanges =
    assistant !== config.assistant || normalizedAssistantSettings !== normalizedConfigSettings;

  useEffect(() => {
    setAssistant(config.assistant);
    setAssistantSettings(config.assistants);
  }, [config]);

  function getProviderSettings(providerId: string): ProviderDefaults {
    return assistantSettings[providerId] ?? {};
  }

  function updateProviderSettings(providerId: string, updates: ProviderDefaults): void {
    setAssistantSettings(current => ({
      ...current,
      [providerId]: {
        ...(current[providerId] ?? {}),
        ...updates,
      },
    }));
  }

  const allProviderEntries: ProviderInfo[] = [
    ...(providers ?? []),
    ...Object.keys(config.assistants)
      .filter(providerId => !(providers ?? []).some(provider => provider.id === providerId))
      .map(
        providerId =>
          ({
            id: providerId,
            displayName: providerId,
            capabilities: {},
            builtIn: false,
          }) satisfies ProviderInfo
      ),
  ];

  const mutation = useMutation({
    mutationFn: updateAssistantConfig,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      setSaveMsg({ type: 'success', text: 'Settings saved.' });
      setTimeout(() => {
        setSaveMsg(null);
      }, 3000);
    },
    onError: (err: Error) => {
      setSaveMsg({ type: 'error', text: err.message });
    },
  });

  function handleSave(): void {
    mutation.mutate({
      assistant,
      assistants: assistantSettings,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assistant Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm">
            <label htmlFor="default-assistant">Default Assistant</label>
            <select
              id="default-assistant"
              value={assistant}
              onChange={e => {
                setAssistant(e.target.value);
              }}
              className={selectClass}
            >
              {allProviderEntries.map(p => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-4 border-t pt-4">
            {allProviderEntries.map(provider => {
              const providerSettings = getProviderSettings(provider.id);

              if (provider.id === 'claude') {
                return (
                  <div
                    key={provider.id}
                    className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm"
                  >
                    <div className="font-medium">{provider.displayName}</div>
                    <div className="text-muted-foreground">Built-in provider settings</div>

                    <label htmlFor="claude-model">Model</label>
                    <select
                      id="claude-model"
                      value={(providerSettings.model as string | undefined) ?? 'sonnet'}
                      onChange={e => {
                        updateProviderSettings('claude', { model: e.target.value });
                      }}
                      className={selectClass}
                    >
                      <option value="sonnet">sonnet</option>
                      <option value="opus">opus</option>
                      <option value="haiku">haiku</option>
                    </select>
                  </div>
                );
              }

              if (provider.id === 'codex') {
                return (
                  <div
                    key={provider.id}
                    className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm"
                  >
                    <div className="font-medium">{provider.displayName}</div>
                    <div className="text-muted-foreground">Built-in provider settings</div>

                    <label htmlFor="codex-model">Model</label>
                    <Input
                      id="codex-model"
                      value={(providerSettings.model as string | undefined) ?? ''}
                      onChange={e => {
                        updateProviderSettings('codex', { model: e.target.value });
                      }}
                      placeholder="gpt-5.3-codex"
                    />

                    <label htmlFor="reasoning">Reasoning Effort</label>
                    <select
                      id="reasoning"
                      value={
                        (providerSettings.modelReasoningEffort as string | undefined) ?? 'medium'
                      }
                      onChange={e => {
                        updateProviderSettings('codex', {
                          modelReasoningEffort: e.target.value,
                        });
                      }}
                      className={selectClass}
                    >
                      <option value="minimal">minimal</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                    </select>

                    <label htmlFor="web-search">Web Search</label>
                    <select
                      id="web-search"
                      value={(providerSettings.webSearchMode as string | undefined) ?? 'disabled'}
                      onChange={e => {
                        updateProviderSettings('codex', { webSearchMode: e.target.value });
                      }}
                      className={selectClass}
                    >
                      <option value="disabled">disabled</option>
                      <option value="cached">cached</option>
                      <option value="live">live</option>
                    </select>
                  </div>
                );
              }

              return (
                <div key={provider.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="font-medium">{provider.displayName}</div>
                  <div className="mt-1 text-muted-foreground">
                    Provider-specific settings are stored generically for Phase 2. This provider
                    does not have a dedicated editor yet.
                  </div>
                  {Object.keys(providerSettings).length > 0 && (
                    <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">
                      {JSON.stringify(providerSettings, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
              {mutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            {saveMsg && (
              <span
                className={`text-sm ${saveMsg.type === 'success' ? 'text-green-500' : 'text-destructive'}`}
              >
                {saveMsg.text}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PlatformConnectionsSection({
  activePlatforms,
}: {
  activePlatforms: string[] | undefined;
}): React.ReactElement {
  const active = new Set(activePlatforms ?? []);
  const platforms = [
    { name: 'Web', connected: active.has('Web') },
    { name: 'Slack', connected: active.has('Slack') },
    { name: 'Telegram', connected: active.has('Telegram') },
    { name: 'Discord', connected: active.has('Discord') },
    { name: 'GitHub', connected: active.has('GitHub') },
    { name: 'Gitea', connected: active.has('Gitea') },
    { name: 'GitLab', connected: active.has('GitLab') },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform Connections</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {platforms.map(p => (
            <div key={p.name} className="flex items-center justify-between text-sm">
              <span>{p.name}</span>
              <Badge variant={p.connected ? 'default' : 'secondary'}>
                {p.connected ? 'Connected' : 'Not configured'}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ConcurrencySection({
  health,
}: {
  health: { concurrency: { active: number; maxConcurrent: number } } | undefined;
}): React.ReactElement {
  const active = health?.concurrency.active ?? 0;
  const max = health?.concurrency.maxConcurrent ?? 1;
  const pct = max > 0 ? Math.min((active / max) * 100, 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Concurrency</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${String(pct)}%` }}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {active} / {max} concurrent conversations
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function SettingsPage(): React.ReactElement {
  const {
    data: configData,
    isLoading: configLoading,
    error: configError,
  } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
  });

  const {
    data: health,
    isLoading: healthLoading,
    error: healthError,
  } = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
  });

  const isLoading = configLoading || healthLoading;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header title="Settings" />
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-5xl space-y-6">
          {(configError || healthError) && (
            <div className="text-sm text-destructive">
              Failed to load settings:{' '}
              {((): string => {
                const err = configError ?? healthError;
                return err instanceof Error ? err.message : 'Unknown error';
              })()}
              . Check that the server is running.
            </div>
          )}

          {isLoading && <div className="text-sm text-muted-foreground">Loading settings...</div>}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <SystemHealthSection health={health} database={configData?.database} />
            <ConcurrencySection health={health} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {configData && <AssistantConfigSection config={configData.config} />}
            <PlatformConnectionsSection activePlatforms={health?.activePlatforms} />
          </div>

          <AccountConnectionsSection />

          <ProjectsSection />
        </div>
      </div>
    </div>
  );
}
