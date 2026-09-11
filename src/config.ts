import { readFile as readFileFromFs } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { BarkNotifierConfig } from "./types/bark-notifier-config";
import type { ConfigSource } from "./types/config-source";
import type { FileLayerResult } from "./types/file-layer-result";
import type { LoadResult } from "./types/load-result";
import type { ReadFileImpl } from "./types/read-file-impl";
import type { TemplateStatus } from "./types/task-status";


/**
 * Resolve the Bark notifier configuration across the layered sources —
 * user file, project file, then environment variables — in ascending
 * precedence. Each file layer is loaded independently and merged over
 * the previous one. Any disabled layer (malformed/unreadable file) fails
 * the whole load with a secret-free reason; otherwise the merged raw
 * layer is validated and finalized into a `LoadResult`.
 *
 * @param {ConfigSource} source - Filesystem and env inputs: `cwd` is
 *   required; `env`, `homeDir`, and `readFile` are optional overrides.
 * @returns {Promise<LoadResult>} The validated config, or a disabled
 *   result carrying a secret-free reason.
 */
export async function loadConfig(source: ConfigSource): Promise<LoadResult> {
  const homeDir = source.homeDir ?? homedir();
  const readImpl = source.readFile ?? defaultReadFile;
  const env = source.env ?? {};

  const userResult = await loadFileLayer(join(homeDir, ".omp", CONFIG_FILE_NAME), readImpl);
  if ("disabled" in userResult) {
    return { config: null, reason: userResult.disabled };
  }

  const projectResult = await loadFileLayer(join(source.cwd, ".omp", CONFIG_FILE_NAME), readImpl);
  if ("disabled" in projectResult) {
    return { config: null, reason: projectResult.disabled };
  }

  const envLayer: Partial<BarkNotifierConfig> = {};
  for (const [variable, field] of Object.entries(ENV_FIELD_MAP)) {
    const value = env[variable];
    if (value !== undefined) {
      // Env values are strings; `statuses` expects a comma-separated string
      // that `resolveStatuses` parses. The field was chosen from the static
      // map, so write through a record cast.
      (envLayer as Record<string, unknown>)[field] = value;
    }
  }

  return finalize({
    ...userResult.layer,
    ...projectResult.layer,
    ...envLayer,
  });
}

const CONFIG_FILE_NAME = "bark-notifier.json";
const DEFAULT_TITLE_TEMPLATE = "OMP task {status}";
const DEFAULT_BODY_TEMPLATE = "{message}\n\nProject: {cwd}";
const DEFAULT_ASK_TITLE_TEMPLATE = "OMP task waiting for your input";
const DEFAULT_ASK_BODY_TEMPLATE = "{message}\n\nProject: {cwd}";
// Default push set: task completion/failure and ask waits, plus failed
// subagent settles — a failure a delegated task often absorbs silently.
// `aborted` is user-initiated (the person cancelling already knows) and
// other subagent outcomes are opt-in via `subagent` / `subagent:<outcome>`.
const DEFAULT_STATUSES: TemplateStatus[] = ["completed", "failed", "waiting", "subagent:failed"];

const ENV_FIELD_MAP: Record<string, keyof BarkNotifierConfig> = {
  BARK_SERVER_URL: "serverUrl",
  BARK_KEY: "key",
  BARK_GROUP: "group",
  BARK_TITLE_TEMPLATE: "titleTemplate",
  BARK_BODY_TEMPLATE: "bodyTemplate",
  BARK_ASK_TITLE_TEMPLATE: "askTitleTemplate",
  BARK_ASK_BODY_TEMPLATE: "askBodyTemplate",
  BARK_STATUSES: "statuses",
};

const CONFIG_FIELDS: ReadonlyArray<keyof BarkNotifierConfig> = [
  "serverUrl",
  "key",
  "group",
  "titleTemplate",
  "bodyTemplate",
  "askTitleTemplate",
  "askBodyTemplate",
  "statuses",
];


/**
 * Default file reader backed by `node:fs/promises`; injectable through
 * `ConfigSource.readFile` so tests can avoid real disk access.
 *
 * @param {string} path - Absolute path of the configuration file.
 * @returns {Promise<string>} The file contents as UTF-8 text.
 */
const defaultReadFile: ReadFileImpl = (path) => readFileFromFs(path, "utf8");


/**
 * Load and parse one configuration file into a file layer. Missing files
 * contribute an empty layer; a file that exists but cannot be read, or
 * whose content is not a JSON object, disables the layer with a reason.
 * Only the recognized string fields of the parsed object are kept.
 *
 * @param {string} path - Absolute path of the configuration file.
 * @param {ReadFileImpl} readImpl - Reader that returns UTF-8 text or
 *   throws.
 * @returns {Promise<FileLayerResult>} The parsed layer, or a disabled
 *   result with a safe reason.
 */
async function loadFileLayer(
  path: string,
  readImpl: ReadFileImpl,
): Promise<FileLayerResult> {
  const text = await readOptionalFile(path, readImpl);
  if (text === null) {
    // Missing files are empty.
    return { layer: {} };
  }
  if (typeof text === "object") {
    return { disabled: text.disabled };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { disabled: `Invalid JSON in configuration file: ${path}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { disabled: `Configuration file ${path} is not a JSON object` };
  }

  const candidate = parsed as Record<string, unknown>;
  const layer: Partial<BarkNotifierConfig> = {};
  for (const field of CONFIG_FIELDS) {
    const value = candidate[field];
    // `statuses` accepts arrays of strings; every other recognized field
    // must be a string and other types are ignored. The field comes from
    // the static CONFIG_FIELDS list, so write through a record cast.
    const accepted =
      field === "statuses"
        ? Array.isArray(value) && value.every((item) => typeof item === "string")
        : typeof value === "string";
    if (accepted) {
      (layer as Record<string, unknown>)[field] = value;
    }
  }
  return { layer };
}

/**
 * Read a file through `readImpl`, returning null when it does not exist
 * (ENOENT), its text when readable, or a disabled reason when it exists
 * but cannot be read.
 *
 * @param {string} path - Absolute path of the configuration file.
 * @param {ReadFileImpl} readImpl - Reader that returns UTF-8 text or
 *   throws.
 * @returns {Promise<string | null | { disabled: string }>} The file text,
 *   null for a missing file, or a disabled reason on read failure.
 */
async function readOptionalFile(
  path: string,
  readImpl: ReadFileImpl,
): Promise<string | null | { disabled: string }> {
  try {
    return await readImpl(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }
    return { disabled: `Could not read configuration file: ${path}` };
  }
}

/**
 * True when `error` is an object carrying the given error `code` — the
 * shape Node error objects expose (e.g. `ENOENT`).
 *
 * @param {unknown} error - Value caught from a rejected read.
 * @param {string} code - Error code to test for, e.g. "ENOENT".
 * @returns {boolean} True when `error` is an object whose `code` strictly
 *   equals `code`.
 */
function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Validate and finalize the merged raw layer into a `LoadResult`:
 * trims and requires `serverUrl` and `key` (failing with a reason when
 * missing or empty), strips trailing slashes from `serverUrl`, defaults
 * the title/body templates and the statuses filter, and keeps `group`
 * only when set.
 *
 * @param {Partial<BarkNotifierConfig>} raw - Merged values from all
 *   layers, lowest precedence first.
 * @returns {LoadResult} The validated config, or a disabled result with a
 *   reason when a required field is missing or empty.
 */
function finalize(raw: Partial<BarkNotifierConfig>): LoadResult {
  const serverUrl = raw.serverUrl?.trim();
  if (serverUrl === undefined) {
    return { config: null, reason: `Missing required configuration: "serverUrl"` };
  }
  if (serverUrl.length === 0) {
    return { config: null, reason: `Required configuration "serverUrl" is empty after trimming` };
  }

  const key = raw.key?.trim();
  if (key === undefined) {
    return { config: null, reason: `Missing required configuration: "key"` };
  }
  if (key.length === 0) {
    return { config: null, reason: `Required configuration "key" is empty after trimming` };
  }

  const config: BarkNotifierConfig = {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    key,
    titleTemplate: raw.titleTemplate ?? DEFAULT_TITLE_TEMPLATE,
    bodyTemplate: raw.bodyTemplate ?? DEFAULT_BODY_TEMPLATE,
    askTitleTemplate: raw.askTitleTemplate ?? DEFAULT_ASK_TITLE_TEMPLATE,
    askBodyTemplate: raw.askBodyTemplate ?? DEFAULT_ASK_BODY_TEMPLATE,
    statuses: resolveStatuses(raw.statuses) ?? DEFAULT_STATUSES,
  };
  if (raw.group !== undefined) {
    config.group = raw.group;
  }
  return { config };
}

/**
 * Resolve the `statuses` filter from its layered raw value: config files
 * provide an array of strings, `BARK_STATUSES` a comma-separated string.
 * Only the eight known statuses are kept, duplicates are removed, and an
 * explicit empty file array means "no pushes at all". A value that yields
 * no known status (typo, empty env string) resolves to undefined so the
 * default statuses list applies.
 *
 * @param {string[] | string | undefined} value - Raw value from a file
 *   layer or the `BARK_STATUSES` environment variable.
 * @returns {TemplateStatus[] | undefined} The filtered status list, or
 *   undefined when nothing known was provided.
 */
function resolveStatuses(value: string[] | string | undefined): TemplateStatus[] | undefined {
  if (Array.isArray(value) && value.length === 0) return [];
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const statuses: TemplateStatus[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (
      (trimmed === "completed" ||
        trimmed === "failed" ||
        trimmed === "aborted" ||
        trimmed === "waiting" ||
        trimmed === "subagent" ||
        trimmed === "subagent:completed" ||
        trimmed === "subagent:failed" ||
        trimmed === "subagent:aborted") &&
      !statuses.includes(trimmed)
    ) {
      statuses.push(trimmed);
    }
  }
  return statuses.length > 0 ? statuses : undefined;
}
