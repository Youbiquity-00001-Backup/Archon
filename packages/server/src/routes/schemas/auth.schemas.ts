/**
 * Zod schemas for the auth-aware API surface added in Phase A.1:
 *  - GET /api/auth/identity   — current OIDC identity (Slack uid + cosmetic claims)
 *  - GET /api/auth/connections — per-user link status for Anthropic + GitHub
 *
 * Both shapes are deliberately public-safe: they never carry tokens or
 * other cred material. The Settings → Connections SPA page is the primary
 * consumer; the registrar-only Remove guard on the Projects page also
 * reads `/api/auth/identity`.
 */
import { z } from '@hono/zod-openapi';

/** Response for `GET /api/auth/identity`. Never includes tokens or session ids. */
export const identityResponseSchema = z
  .object({
    /** Slack user id, the `U…` half of the OIDC `sub` claim. */
    slackUserId: z.string(),
    /** Email claim from Slack OIDC userinfo, when present. */
    email: z.string().optional(),
    /** Display name claim, when present. */
    displayName: z.string().optional(),
  })
  .openapi('IdentityResponse');

/** Anthropic section of the connections payload. Linked iff `linked === true`. */
const anthropicConnectionSchema = z
  .union([
    z.object({ linked: z.literal(false) }),
    z.object({
      linked: z.literal(true),
      /** Account email captured at upsert time; absent for legacy uploads. */
      accountEmail: z.string().optional(),
    }),
  ])
  .openapi('AnthropicConnection');

/** GitHub section. */
const githubConnectionSchema = z
  .union([
    z.object({ linked: z.literal(false) }),
    z.object({
      linked: z.literal(true),
      login: z.string(),
      installationId: z.number().optional(),
    }),
  ])
  .openapi('GithubConnection');

/** Jira section. PAT-style cred — no token material in the response. */
const jiraConnectionSchema = z
  .union([
    z.object({ linked: z.literal(false) }),
    z.object({
      linked: z.literal(true),
      /** Tenant base URL captured at upsert time. */
      baseUrl: z.string(),
      /** Atlassian account email captured at upsert time. */
      email: z.string(),
    }),
  ])
  .openapi('JiraConnection');

/** Response for `GET /api/auth/connections`. */
export const connectionsResponseSchema = z
  .object({
    anthropic: anthropicConnectionSchema,
    github: githubConnectionSchema,
    jira: jiraConnectionSchema,
  })
  .openapi('ConnectionsResponse');
