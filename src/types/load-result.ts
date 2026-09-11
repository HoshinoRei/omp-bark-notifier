import type { BarkNotifierConfig } from "./bark-notifier-config";

/**
 * Represents successful Bark configuration loading or a disabled result.
 */
export type LoadResult =
  | {
      // Resolved configuration when notification delivery is enabled.
      config: BarkNotifierConfig;
    }
  | {
      // `null` indicates that delivery is disabled.
      config: null;
      // Safe explanation for why notification delivery is disabled.
      reason: string;
    };
