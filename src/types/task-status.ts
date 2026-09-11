/**
 * Describes the terminal state of one OMP agent task.
 */
export type TaskStatus = "completed" | "failed" | "aborted";

/**
 * Status value rendered into the `{status}` template placeholder: the
 * terminal task statuses plus `waiting`, used when the task blocks on the
 * `ask` tool for user input, and the subagent statuses, used to filter
 * settles of OMP subagent sessions: the flat `subagent` covers every
 * outcome, while `subagent:<outcome>` covers a single outcome.
 */
export type TemplateStatus =
  | TaskStatus
  | "waiting"
  | "subagent"
  | `subagent:${TaskStatus}`;
