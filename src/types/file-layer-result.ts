import type { BarkNotifierConfig } from "./bark-notifier-config";

/**
 * Represents either a parsed configuration layer or a safe disable reason.
 */
export type FileLayerResult =
  | {
      // Parsed values contributed by this configuration file.
      layer: Partial<BarkNotifierConfig>;
    }
  | {
      // Safe explanation that loading is disabled.
      disabled: string;
    };
