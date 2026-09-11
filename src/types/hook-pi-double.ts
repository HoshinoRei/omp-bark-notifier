import type { HookLogRecord } from "./hook-log-record";

/**
 * Minimal OMP extension API double used by the hook test suite.
 */
export interface HookPiDouble {
  // Minimal extension API object passed to the hook.
  pi: {
    // Registers an event handler (agent_end, tool_call).
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
    // Minimal logger consumed by the hook.
    logger: {
      // Records a warning message with optional context.
      warn(message: string, context?: Record<string, unknown>): void;
      // Records an error message with optional context.
      error(message: string, context?: Record<string, unknown>): void;
      // Accepts informational messages.
      info(..._args: unknown[]): void;
      // Accepts debug messages.
      debug(..._args: unknown[]): void;
    };
  };
  // Event names registered by the hook, in registration order.
  events: string[];
  // Registered event handlers by event name.
  handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>;
  // Warning and error logs recorded by the double.
  logs: HookLogRecord[];
}
