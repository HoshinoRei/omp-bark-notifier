// OMP `agent_end` + `tool_call` hook — the installable extension boundary of
// the Bark notifier. Registers two subscribers:
//   - `agent_end` — the task boundary. `turn_end`, non-ask tool calls, and
//     individual tool failures never notify.
//   - `tool_call` — but only for the `ask` tool: when the task blocks on a
//     question for the user, a "waiting for your input" notification is sent
//     so the push arrives while the dialog is open.
//
// The handlers delegate to the focused modules under `src/`:
//   - `loadConfig` resolves project/user/environment configuration beneath
//     `ctx.cwd` (process env included, so `BARK_*` variables take effect),
//   - `renderNotification` maps the final transcript plus `ctx.cwd` onto the
//     configured title/body templates (returning null for `willContinue`
//     events — OMP has scheduled an automatic continuation, so the settle is
//     not final),
//   - `renderAskNotification` maps an `ask` tool_call's questions onto the
//     configured ask templates (returning null when no question text exists),
//   - `sendBarkNotification` delivers through the SDK-backed Bark sender
//     (whose `@hoshinorei/bark-sdk` import stays inside src/notify).
//
// `subagent` settles — the flat `subagent` entry (every outcome) or a
// compound `subagent:<outcome>` (that outcome only) — push only when
// `statuses` lists them; the default list includes `subagent:failed`, so
// failed subagent settles push while other subagent outcomes stay silent.
// The main agent's settles keep their classified outcomes.
// This boundary contains every failure so it never changes OMP task
// outcomes: a disabled configuration logs its secret-free reason; a rejected
// delivery logs a redacted server origin plus error text — the device key is
// stripped from both — and never the raw server URL when it does not parse,
// since a malformed URL could embed the key; that case falls back to a fixed
// label.
// The handlers never throw, never mutate the event payloads, never return a
// continuation, and never touch UI surfaces.

import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@oh-my-pi/pi-coding-agent";
import type { BarkNotifierConfig } from "../../src/types/bark-notifier-config";
import type { LoadResult } from "../../src/types/load-result";
import type { TaskNotification } from "../../src/types/task-notification";
import { loadConfig } from "../../src/config";
import { isStatusListed, renderAskNotification, renderNotification } from "../../src/message";
import { sendBarkNotification } from "../../src/notify";


// Replacement inserted wherever the Bark device key appears in a log line,
// so no diagnostic ever leaks the key.
const REDACTION = "[redacted]";

// Fixed label standing in for the origin when `serverUrl` does not parse as
// an absolute URL; the raw value is never logged because a malformed URL can
// embed the Bark device key.
const UNPARSEABLE_ORIGIN = "(unparseable server url)";

/**
 * Register the OMP extension: an `agent_end` subscriber that renders and
 * sends at most one Bark notification per final task settle, and a
 * `tool_call` subscriber that sends a "waiting for your input"
 * notification when the `ask` tool blocks for the user.
 *
 * @param {ExtensionAPI} pi - The OMP extension API used to subscribe to
 *   events and to log errors.
 * @returns {void} Registers the subscribers; nothing is returned.
 */
export default function barkNotifier(pi: ExtensionAPI): void {
  // The `agent_end` handler: loads config under `ctx.cwd`, renders the
  // notification (skipping `willContinue` settles), and delivers it via
  // Bark. Every failure is caught and logged — never thrown, so OMP task
  // outcomes are never changed; the device key is redacted from all logs.
  pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext): Promise<void> =>
    deliver(pi, ctx, (config) => {
      const notification = renderNotification(
        event,
        ctx.cwd,
        config.titleTemplate,
        config.bodyTemplate,
      );
      if (notification === null) return null;
      // OMP subagent sessions run headless (`ctx.hasUI` is false), so their
      // settles match the flat `subagent` status (every outcome) or a
      // `subagent:<outcome>` entry; the main session checks its classified
      // outcome directly. The rendered notification always carries the real
      // outcome.
      return isStatusListed(config.statuses, notification.status, !ctx.hasUI)
        ? notification
        : null;
    }),
  );

  // The `tool_call` handler: only the `ask` tool notifies (its execution
  // blocks the agent loop while the dialog waits for the user). Every other
  // tool call returns immediately — the handler never blocks a tool and
  // never returns a result, so tool execution is unaffected.
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext): Promise<void> | undefined => {
    if (event.toolName !== "ask") return undefined;
    return deliver(pi, ctx, (config) => {
      if (!config.statuses.includes("waiting")) return null;
      return renderAskNotification(event.input, ctx.cwd, config.askTitleTemplate, config.askBodyTemplate);
    });
  });
}

/**
 * Shared delivery pipeline for both subscribers: resolve the configuration
 * beneath `ctx.cwd`, render the notification through the caller's `render`
 * callback, and deliver it via Bark. `render` returning null (a
 * `willContinue` settle, waiting excluded from statuses, or no question
 * text) sends nothing. Every failure is contained — logged through
 * `pi.logger` with the device key redacted — and never rethrown.
 *
 * @param {ExtensionAPI} pi - The OMP extension API used to log errors.
 * @param {ExtensionContext} ctx - Event context carrying `cwd`.
 * @param {(config: BarkNotifierConfig) => TaskNotification | null} render -
 *   Renders the notification from the resolved config; may also throw.
 * @returns {Promise<void>} Resolves after logging or delivery; never
 *   rejects.
 */
async function deliver(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  render: (config: BarkNotifierConfig) => TaskNotification | null,
): Promise<void> {
  let loaded: LoadResult;
  try {
    loaded = await loadConfig({ cwd: ctx.cwd, env: process.env });
  } catch (error) {
    pi.logger.error("Bark notification skipped: configuration lookup failed", {
      error: describeError(error),
    });
    return;
  }

  if (loaded.config === null) {
    pi.logger.warn(`Bark notification disabled: ${loaded.reason}`);
    return;
  }
  const config = loaded.config;

  let notification: TaskNotification | null;
  try {
    notification = render(config);
  } catch (error) {
    pi.logger.error("Bark notification skipped: message rendering failed", {
      error: redact(describeError(error), config.key),
    });
    return;
  }
  if (notification === null) {
    // Not a notifiable settle: OMP scheduled an automatic continuation, ask
    // notifications are disabled, or there is no question text.
    return;
  }

  try {
    await sendBarkNotification(notification, config);
  } catch (error) {
    pi.logger.error("Bark notification delivery failed", {
      origin: redact(serverOrigin(config.serverUrl), config.key),
      error: redact(describeError(error), config.key),
    });
  }
}

/**
 * Derive the URL origin (scheme + host), never a path/query that could
 * embed a key. Callers still pass the result through `redact`: a valid
 * hostname or port can itself contain the key. When the configured value
 * does not parse as an absolute URL, the fixed safe label is returned
 * instead of the raw text; the configured value is already trimmed and
 * non-empty.
 *
 * @param {string} serverUrl - The configured Bark server URL, already
 *   trimmed and non-empty.
 * @returns {string} Scheme + host origin, or `UNPARSEABLE_ORIGIN` when the
 *   value does not parse as an absolute URL.
 */
function serverOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return UNPARSEABLE_ORIGIN;
  }
}

/**
 * A human-readable, key-free rendering of a caught error: the error
 * message when it is non-empty, else the error name, else the stringified
 * value.
 *
 * @param {unknown} error - Value caught from a thrown or rejected
 *   operation.
 * @returns {string} A safe, loggable error description.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  return String(error);
}

/**
 * Never log the Bark device key: strip any occurrence of `secret` from
 * `text`. The match is case-insensitive so a secret survives URL
 * normalization — e.g. `new URL(serverUrl).origin` lowercases the hostname
 * that may embed the key — and metacharacters in the key are escaped so it
 * is matched as a literal.
 *
 * @param {string} text - Text to sanitize before logging.
 * @param {string} secret - The Bark device key to strip; a no-op when
 *   empty.
 * @returns {string} `text` with every occurrence of `secret` replaced by
 *   "[redacted]".
 */
function redact(text: string, secret: string): string {
  if (secret.length === 0) return text;
  const literal = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(literal, "gi"), REDACTION);
}
