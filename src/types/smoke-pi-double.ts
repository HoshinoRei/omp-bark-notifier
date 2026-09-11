import type { SmokeLogRecord } from "./smoke-log-record";

/**
 * Minimal OMP extension API double used by the smoke test.
 */
export interface SmokePiDouble {
  // Event names registered by the hook.
  events: string[];
  // Warning and error logs recorded by the double.
  logs: SmokeLogRecord[];
  // Registered event handlers by event name.
  handlers: Record<string, (event: unknown, ctx: { cwd: string; hasUI?: boolean }) => unknown>;
  // Minimal extension API object passed to the hook.
  pi: {
    // Registers an event handler (agent_end, tool_call).
    on(event: string, handler: (event: unknown, ctx: { cwd: string; hasUI?: boolean }) => unknown): void;
    // Minimal logger consumed by the hook.
    logger: {
      // Records a warning message.
      warn(message: string): void;
      // Records an error message.
      error(message: string): void;
      // Accepts informational messages.
      info(..._args: unknown[]): void;
      // Accepts debug messages.
      debug(..._args: unknown[]): void;
    };
  };
}
