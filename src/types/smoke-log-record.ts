/**
 * Captures one warning or error emitted by the smoke-test extension double.
 */
export interface SmokeLogRecord {
  // Logger level emitted by the hook.
  level: "warn" | "error";
  // Logger message emitted by the hook.
  message: string;
}
