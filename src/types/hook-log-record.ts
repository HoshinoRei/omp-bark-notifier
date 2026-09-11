/**
 * Captures one logger call emitted by the hook test double.
 */
export interface HookLogRecord {
  // Logger level emitted by the hook.
  level: "warn" | "error";
  // Logger message emitted by the hook.
  message: string;
  // Optional structured logger context.
  context?: Record<string, unknown>;
}
