/**
 * Process-level "accepting new work" flag.
 *
 * Flipped to false by `POST /admin/drain` during a CodeDeploy blue/green
 * rollout. While in the draining state:
 *   - The Slack inbound socket is closed (handled in the route handler;
 *     not this module's concern). Outbound Slack `WebClient` posts still
 *     work so in-flight workflows can keep updating their threads.
 *   - The web adapter's "create new conversation" endpoint returns 503.
 *   - Existing conversations continue to function so users see their
 *     in-flight work to completion.
 *
 * The flag is in-process. ECS task replacement on blue-tear-down resets
 * it implicitly. There is no "undrain" route — once drained, the task is
 * expected to terminate on `terminationWaitTimeInMinutes`.
 */

let acceptingNewWork = true;

export function isAcceptingNewWork(): boolean {
  return acceptingNewWork;
}

export function setAcceptingNewWork(value: boolean): void {
  acceptingNewWork = value;
}

/** Test-only: reset to default. Do not call from production code paths. */
export function resetForTests(): void {
  acceptingNewWork = true;
}
