import type { AgentEndLikeEvent } from "./types/agent-end-like-event";
import type { TaskNotification } from "./types/task-notification";
import type { TaskStatus } from "./types/task-status";
import type { TemplateStatus } from "./types/task-status";

const FALLBACK_MESSAGE: Record<TaskStatus, string> = {
  completed: "Agent task completed",
  failed: "Agent task failed",
  aborted: "Agent task aborted",
};

/**
 * Cast a runtime value to a plain record when it is a non-null object,
 * otherwise null — guards transcript fields that may hold any JSON shape.
 *
 * @param {unknown} value - Runtime value taken from a transcript entry.
 * @returns {Record<string, unknown> | null} `value` as a record when it is
 *   a non-null object, otherwise null.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The transcript `messages` array of an agent_end event, or an empty
 * array when absent so downstream scans stay null-safe.
 *
 * @param {AgentEndLikeEvent} event - The `agent_end`-shaped event payload.
 * @returns {unknown[]} The transcript entries, or `[]` when the event has
 *   no `messages` array.
 */
function asMessageList(event: AgentEndLikeEvent): unknown[] {
  return event && Array.isArray(event.messages) ? event.messages : [];
}

/**
 * The newest assistant message in the transcript, if any: scans `messages`
 * from the end and returns the first entry whose `role` is "assistant";
 * returns null when no assistant message exists.
 *
 * @param {unknown[]} messages - Transcript entries, newest last.
 * @returns {Record<string, unknown> | null} The newest assistant message,
 *   or null when none exists.
 */
function lastAssistantMessage(messages: unknown[]): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = asRecord(messages[i]);
    if (message !== null && message.role === "assistant") return message;
  }
  return null;
}

/**
 * Flattened text of one assistant message: a string `content`, or its
 * `type: "text"` content blocks joined with newlines (plain-string blocks
 * are accepted too). Non-text blocks (thinking, toolCall, image) are
 * ignored. Returns null when the message carries no text — whitespace-only
 * counts as no text.
 *
 * @param {Record<string, unknown>} message - One transcript message entry.
 * @returns {string | null} The joined assistant text, or null when the
 *   message carries no text.
 */
function textOfMessage(message: Record<string, unknown>): string | null {
  const content = message.content;
  let text: string | null = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else {
        const record = asRecord(block);
        if (record !== null && record.type === "text" && typeof record.text === "string") {
          parts.push(record.text);
        }
      }
    }
    if (parts.length > 0) text = parts.join("\n");
  }
  if (text === null) return null;
  return text.trim() === "" ? null : text;
}

/**
 * The text of the newest assistant message that actually carries text,
 * scanning the transcript from the end; null when none does. This is the
 * message rendered into the `{message}` template variable, or the fallback
 * when absent.
 *
 * @param {unknown[]} messages - Transcript entries, newest last.
 * @returns {string | null} The newest non-empty assistant text, or null
 *   when no assistant message has any.
 */
export function lastAssistantText(messages: unknown[]): string | null {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = asRecord(list[i]);
    if (message !== null && message.role === "assistant") {
      const text = textOfMessage(message);
      if (text !== null) return text;
    }
  }
  return null;
}

/**
 * Classify a task outcome from explicit terminal markers on the newest
 * assistant message: `stopReason === "aborted"` -> aborted; `stopReason
 * === "error"` or a non-empty `errorMessage` -> failed; anything else
 * (including a recoverable tool error) -> completed.
 *
 * @param {AgentEndLikeEvent} event - The `agent_end`-shaped event payload.
 * @returns {TaskStatus} "aborted", "failed", or "completed".
 */
export function classifyTask(event: AgentEndLikeEvent): TaskStatus {
  const message = lastAssistantMessage(asMessageList(event));
  if (message === null) return "completed";
  if (message.stopReason === "aborted") return "aborted";
  const hasErrorMessage =
    typeof message.errorMessage === "string" && message.errorMessage.trim() !== "";
  if (message.stopReason === "error" || hasErrorMessage) return "failed";
  return "completed";
}

/**
 * Decide whether a settle's status is listed in the `statuses` filter.
 * Main-agent settles check their classified outcome directly. Subagent
 * settles match the flat `subagent` entry (every outcome) or a compound
 * `subagent:<outcome>` entry for that specific outcome, so subagent
 * pushes can be toggled as a whole or per outcome.
 *
 * @param {TemplateStatus[]} statuses - The configured `statuses` filter.
 * @param {TemplateStatus} status - The classified outcome of the settle.
 * @param {boolean} isSubagent - True when the event came from an OMP
 *   subagent session rather than the main agent.
 * @returns {boolean} True when the settle's status is listed.
 */
export function isStatusListed(
  statuses: TemplateStatus[],
  status: TemplateStatus,
  isSubagent: boolean,
): boolean {
  if (!isSubagent) return statuses.includes(status);
  return (
    statuses.includes("subagent") ||
    ((status === "completed" || status === "failed" || status === "aborted") &&
      statuses.includes(`subagent:${status}`))
  );
}
 
/**
 * Single deterministic pass: every exact `{status}`/`{cwd}`/`{message}`
 * occurrence in the template is replaced with its value. Text introduced
 * by a replacement is never rescanned and unknown `{placeholders}` are
 * preserved so configuration mistakes stay visible.
 *
 * @param {string} template - Template text holding `{status}`/`{cwd}`/
 *   `{message}` placeholders.
 * @param {{ status: TemplateStatus; cwd: string; message: string }} values -
 *   Substitution values for each placeholder.
 * @returns {string} The template with every known placeholder replaced;
 *   unknown placeholders are left untouched.
 */
function renderTemplate(
  template: string,
  values: { status: TemplateStatus; cwd: string; message: string },
): string {
  return template.replace(/\{(status|cwd|message)\}/g, (_whole: string, key: string) => {
    if (key === "status") return values.status;
    if (key === "cwd") return values.cwd;
    return values.message;
  });
}

/**
 * Render the Bark notification for an agent_end event: classify its
 * status, take the newest assistant text (or a status-specific fallback),
 * and apply the configured title/body templates. Returns null when
 * `willContinue` is true — OMP already scheduled an automatic
 * continuation, so a notification would be premature.
 *
 * @param {AgentEndLikeEvent} event - The `agent_end`-shaped event payload.
 * @param {string} cwd - Project directory rendered into `{cwd}`.
 * @param {string} titleTemplate - Title template with `{status}`/`{cwd}`/
 *   `{message}` placeholders.
 * @param {string} bodyTemplate - Body template with the same placeholders.
 * @returns {TaskNotification | null} The rendered notification, or null
 *   when `willContinue` is true.
 */
export function renderNotification(
  event: AgentEndLikeEvent,
  cwd: string,
  titleTemplate: string,
  bodyTemplate: string,
): TaskNotification | null {
  if (event.willContinue === true) return null;
  const status = classifyTask(event);
  const message = lastAssistantText(asMessageList(event)) ?? FALLBACK_MESSAGE[status];
  const values = { status, cwd, message };
  return {
    status,
    message,
    title: renderTemplate(titleTemplate, values),
    body: renderTemplate(bodyTemplate, values),
  };
}
/**
 * The joined text of the `questions` array carried by an `ask` tool_call
 * event: each entry's `question` field (or the entry itself when it is a
 * plain string), keeping only non-empty text. Returns null when no
 * question text can be extracted.
 *
 * @param {unknown} input - The `input` payload of a `tool_call` event.
 * @returns {string | null} The questions joined with newlines, or null
 *   when there is nothing to render.
 */
function askQuestionText(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null || !Array.isArray(record.questions)) return null;
  const parts: string[] = [];
  for (const item of record.questions) {
    if (typeof item === "string") {
      if (item.trim() !== "") parts.push(item);
      continue;
    }
    const question = asRecord(item);
    if (
      question !== null &&
      typeof question.question === "string" &&
      question.question.trim() !== ""
    ) {
      parts.push(question.question);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Render the Bark notification for an `ask` tool_call: joins the question
 * text and applies the configured ask title/body templates with status
 * `waiting`. Returns null when the tool_call carries no extractable
 * question text.
 *
 * @param {unknown} input - The `input` payload of a `tool_call` event.
 * @param {string} cwd - Project directory rendered into `{cwd}`.
 * @param {string} titleTemplate - Ask title template with `{status}`/
 *   `{cwd}`/`{message}` placeholders.
 * @param {string} bodyTemplate - Ask body template with the same
 *   placeholders.
 * @returns {TaskNotification | null} The rendered notification, or null
 *   when no question text is present.
 */
export function renderAskNotification(
  input: unknown,
  cwd: string,
  titleTemplate: string,
  bodyTemplate: string,
): TaskNotification | null {
  const message = askQuestionText(input);
  if (message === null) return null;
  const values = { status: "waiting" as const, cwd, message };
  return {
    status: "waiting",
    message,
    title: renderTemplate(titleTemplate, values),
    body: renderTemplate(bodyTemplate, values),
  };
}
