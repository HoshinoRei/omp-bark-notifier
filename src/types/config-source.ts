/**
 * Supplies filesystem and environment inputs to configuration resolution.
 */
export interface ConfigSource {
  // Current OMP project directory used to resolve project configuration.
  cwd: string;
  // Optional environment map; defaults to an empty map.
  env?: Record<string, string | undefined>;
  // Optional user home directory override used to resolve user configuration.
  homeDir?: string;
  // Optional async file reader injection for isolated tests.
  readFile?: (path: string) => Promise<string>;
}
