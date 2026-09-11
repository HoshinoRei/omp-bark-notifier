import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import type { TemplateStatus } from "../src/types/task-status";

const HOME_DIR = "/home/tester";
const CWD = "/work/project";

const USER_FILE = join(HOME_DIR, ".omp", "bark-notifier.json");
const PROJECT_FILE = join(CWD, ".omp", "bark-notifier.json");

const DEFAULT_TITLE_TEMPLATE = "OMP task {status}";
const DEFAULT_BODY_TEMPLATE = "{message}\n\nProject: {cwd}";
const DEFAULT_ASK_TITLE_TEMPLATE = "OMP task waiting for your input";
const DEFAULT_ASK_BODY_TEMPLATE = "{message}\n\nProject: {cwd}";
const DEFAULT_STATUSES: TemplateStatus[] = ["completed", "failed", "waiting", "subagent:failed"];

function missingFileError(path: string): Error & { code?: string } {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & {
    code?: string;
  };
  error.code = "ENOENT";
  return error;
}

// Stub file system: exact path -> content; any other path is missing.
function makeReadFile(files: Record<string, string>) {
  const calls: string[] = [];
  const impl = async (path: string) => {
    calls.push(path);
    if (Object.prototype.hasOwnProperty.call(files, path)) {
      return files[path];
    }
    throw missingFileError(path);
  };
  return { impl, calls };
}

describe("loadConfig", () => {
  test("environment overrides user and project values", async () => {
    const { impl } = makeReadFile({
      [USER_FILE]: JSON.stringify({
        serverUrl: "https://user.example",
        key: "user-key",
        group: "user-group",
        titleTemplate: "user {status}",
        bodyTemplate: "user {message}",
      }),
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        group: "project-group",
        titleTemplate: "project {status}",
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
      env: {
        BARK_SERVER_URL: "https://env.example",
        BARK_KEY: "env-key",
        BARK_GROUP: "env-group",
      },
    });

    expect(result).toEqual({
      config: {
        serverUrl: "https://env.example",
        key: "env-key",
        group: "env-group",
        titleTemplate: "project {status}",
        bodyTemplate: "user {message}",
        askTitleTemplate: DEFAULT_ASK_TITLE_TEMPLATE,
        askBodyTemplate: DEFAULT_ASK_BODY_TEMPLATE,
        statuses: DEFAULT_STATUSES,
      },
    });
  });

  test("project configuration overrides user configuration", async () => {
    const { impl, calls } = makeReadFile({
      [USER_FILE]: JSON.stringify({
        serverUrl: "https://user.example",
        key: "user-key",
        titleTemplate: "user {status}",
      }),
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        bodyTemplate: "project {message}",
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result).toEqual({
      config: {
        serverUrl: "https://project.example",
        key: "project-key",
        titleTemplate: "user {status}",
        bodyTemplate: "project {message}",
        askTitleTemplate: DEFAULT_ASK_TITLE_TEMPLATE,
        askBodyTemplate: DEFAULT_ASK_BODY_TEMPLATE,
        statuses: DEFAULT_STATUSES,
      },
    });
    // User file resolved before project file, both at the expected paths.
    expect(calls).toEqual([USER_FILE, PROJECT_FILE]);
  });

  test("absent configuration files are treated as empty", async () => {
    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: makeReadFile({}).impl,
    });

    expect(result).toEqual({
      config: null,
      reason: expect.stringContaining("serverUrl"),
    });
  });

  test("environment alone can satisfy required configuration", async () => {
    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: makeReadFile({}).impl,
      env: {
        BARK_SERVER_URL: "https://env.example",
        BARK_KEY: "env-key",
      },
    });

    expect(result).toEqual({
      config: {
        serverUrl: "https://env.example",
        key: "env-key",
        titleTemplate: DEFAULT_TITLE_TEMPLATE,
        bodyTemplate: DEFAULT_BODY_TEMPLATE,
        askTitleTemplate: DEFAULT_ASK_TITLE_TEMPLATE,
        askBodyTemplate: DEFAULT_ASK_BODY_TEMPLATE,
        statuses: DEFAULT_STATUSES,
      },
    });
  });

  test("malformed JSON disables configuration with a safe reason", async () => {
    const { impl } = makeReadFile({
      [USER_FILE]: JSON.stringify({
        serverUrl: "https://user.example",
        key: "user-key",
      }),
      [PROJECT_FILE]:
        '{"serverUrl": "https://project.example", "key": "super-secret-value",}',
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
      env: {
        BARK_SERVER_URL: "https://env.example",
        BARK_KEY: "env-key",
      },
    });

    expect(result).toEqual({
      config: null,
      reason: expect.stringContaining(PROJECT_FILE),
    });
    const reason = (result as { config: null; reason: string }).reason;
    expect(reason).toContain("JSON");
    expect(reason).not.toContain("super-secret-value");
  });

  test("non-object JSON file disables configuration", async () => {
    const { impl } = makeReadFile({
      [USER_FILE]: "[1, 2, 3]",
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
      env: {
        BARK_SERVER_URL: "https://env.example",
        BARK_KEY: "env-key",
      },
    });

    expect(result).toEqual({
      config: null,
      reason: expect.stringContaining(USER_FILE),
    });
  });

  test("whitespace-only serverUrl disables configuration", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({ serverUrl: "   ", key: "project-key" }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result).toEqual({
      config: null,
      reason: expect.stringContaining("serverUrl"),
    });
  });

  test("whitespace-only key disables configuration", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: " \t ",
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
      env: {
        BARK_SERVER_URL: "https://env.example",
      },
    });

    expect(result).toEqual({
      config: null,
      reason: expect.stringContaining("key"),
    });
  });

  test("whitespace-only environment key overrides a valid file key", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
      env: {
        BARK_KEY: "   ",
      },
    });

    expect(result).toEqual({
      config: null,
      reason: expect.stringContaining("key"),
    });
  });

    test("required values trimmed before validation", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "  https://project.example/  ",
        key: "  project-key  ",
      }),
    });


    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result).toEqual({
      config: {
        serverUrl: "https://project.example",
        key: "project-key",
        titleTemplate: DEFAULT_TITLE_TEMPLATE,
        
        bodyTemplate: DEFAULT_BODY_TEMPLATE,
        askTitleTemplate: DEFAULT_ASK_TITLE_TEMPLATE,
        askBodyTemplate: DEFAULT_ASK_BODY_TEMPLATE,
        statuses: DEFAULT_STATUSES,
      },
    });
  });

  test("trailing slashes are removed from serverUrl", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example///",
        key: "project-key",
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result).toEqual({
      config: {
        serverUrl: "https://project.example",
        key: "project-key",
        titleTemplate: DEFAULT_TITLE_TEMPLATE,
        bodyTemplate: DEFAULT_BODY_TEMPLATE,
        askTitleTemplate: DEFAULT_ASK_TITLE_TEMPLATE,
        askBodyTemplate: DEFAULT_ASK_BODY_TEMPLATE,
        statuses: DEFAULT_STATUSES,
      },
    });
  });

  test("environment serverUrl is trimmed and normalized", async () => {
    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: makeReadFile({}).impl,
      env: {
        BARK_SERVER_URL: " https://env.example/push/ ",
        BARK_KEY: " env-key ",
      },
    });

    expect(result).toEqual({
      config: {
        serverUrl: "https://env.example/push",
        key: "env-key",
        titleTemplate: DEFAULT_TITLE_TEMPLATE,
        bodyTemplate: DEFAULT_BODY_TEMPLATE,
        askTitleTemplate: DEFAULT_ASK_TITLE_TEMPLATE,
        askBodyTemplate: DEFAULT_ASK_BODY_TEMPLATE,
        statuses: DEFAULT_STATUSES,
      },
    });
  });

  test("template environment variables set both templates verbatim", async () => {
    const { impl } = makeReadFile({
      [USER_FILE]: JSON.stringify({
        serverUrl: "https://user.example",
        key: "user-key",
        titleTemplate: "user {status}",
        bodyTemplate: "user {message}",
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
      env: {
        BARK_SERVER_URL: "https://env.example",
        BARK_KEY: "env-key",
        BARK_TITLE_TEMPLATE: "status: {status}",
        BARK_BODY_TEMPLATE: "from {cwd}:\n{message}",
      },
    });

    expect(result).toEqual({
      config: {
        serverUrl: "https://env.example",
        key: "env-key",
        titleTemplate: "status: {status}",
        bodyTemplate: "from {cwd}:\n{message}",
        askTitleTemplate: DEFAULT_ASK_TITLE_TEMPLATE,
        askBodyTemplate: DEFAULT_ASK_BODY_TEMPLATE,
        statuses: DEFAULT_STATUSES,
      },
    });
  });

  test("defaults apply when optional fields are absent everywhere", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result).toEqual({
      config: {
        serverUrl: "https://project.example",
        key: "project-key",
        titleTemplate: DEFAULT_TITLE_TEMPLATE,
        bodyTemplate: DEFAULT_BODY_TEMPLATE,
        askTitleTemplate: DEFAULT_ASK_TITLE_TEMPLATE,
        askBodyTemplate: DEFAULT_ASK_BODY_TEMPLATE,
        statuses: DEFAULT_STATUSES,
      },
    });
  });

  test("a file can restrict notifications to waiting and set ask templates", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        statuses: ["waiting"],
        askTitleTemplate: "ask {status}",
        askBodyTemplate: "{message}",
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result).toEqual({
      config: {
        serverUrl: "https://project.example",
        key: "project-key",
        titleTemplate: DEFAULT_TITLE_TEMPLATE,
        bodyTemplate: DEFAULT_BODY_TEMPLATE,
        askTitleTemplate: "ask {status}",
        askBodyTemplate: "{message}",
        statuses: ["waiting"],
      },
    });
  });

  test("a legacy notifyOnAsk key in a file is ignored", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        notifyOnAsk: false,
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result.config?.statuses).toEqual(DEFAULT_STATUSES);
    expect(result.config).not.toHaveProperty("notifyOnAsk");
  });

  test("environment can restrict notifications to waiting and set ask templates", async () => {
    const { impl } = makeReadFile({
      [USER_FILE]: JSON.stringify({
        serverUrl: "https://user.example",
        key: "user-key",
        askTitleTemplate: "user ask",
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
      env: {
        BARK_SERVER_URL: "https://env.example",
        BARK_KEY: "env-key",
        BARK_STATUSES: "waiting",
        BARK_ASK_TITLE_TEMPLATE: "env ask",
        BARK_ASK_BODY_TEMPLATE: "env {message}",
      },
    });

    expect(result).toEqual({
      config: {
        serverUrl: "https://env.example",
        key: "env-key",
        titleTemplate: DEFAULT_TITLE_TEMPLATE,
        bodyTemplate: DEFAULT_BODY_TEMPLATE,
        askTitleTemplate: "env ask",
        askBodyTemplate: "env {message}",
        statuses: ["waiting"],
      },
    });
  });

  test("a file statuses list restricts which statuses notify", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        statuses: ["failed", "aborted"],
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result.config?.statuses).toEqual(["failed", "aborted"]);
  });

  test("the environment statuses variable parses comma-separated values", async () => {
    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: makeReadFile({}).impl,
      env: {
        BARK_SERVER_URL: "https://env.example",
        BARK_KEY: "env-key",
        BARK_STATUSES: "failed, waiting",
      },
    });

    expect(result.config?.statuses).toEqual(["failed", "waiting"]);
  });

  test("unknown statuses are dropped and duplicates are deduplicated", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        statuses: ["completed", "completed", "bogus", "FAILED", "waiting"],
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result.config?.statuses).toEqual(["completed", "waiting"]);
  });

  test("an empty statuses array suppresses every final  push", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        statuses: [],
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result.config?.statuses).toEqual([]);
  });

  test("an all-unknown statuses list falls back to the defaults", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        statuses: ["bogus"],
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result.config?.statuses).toEqual(DEFAULT_STATUSES);
  });

  test("a file statuses list including subagent keeps it", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        statuses: ["subagent", "completed"],
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result.config?.statuses).toEqual(["subagent", "completed"]);
  });

  test("the environment statuses variable accepts subagent", async () => {
    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: makeReadFile({}).impl,
      env: {
        BARK_SERVER_URL: "https://env.example",
        BARK_KEY: "env-key",
        BARK_STATUSES: "subagent,completed",
      },
    });

    expect(result.config?.statuses).toEqual(["subagent", "completed"]);
  });

  test("a file statuses list accepts compound subagent statuses", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        statuses: ["subagent:failed", "completed"],
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result.config?.statuses).toEqual(["subagent:failed", "completed"]);
  });

  test("the environment statuses variable accepts compound subagent statuses", async () => {
    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: makeReadFile({}).impl,
      env: {
        BARK_SERVER_URL: "https://env.example",
        BARK_KEY: "env-key",
        BARK_STATUSES: "subagent:failed,completed",
      },
    });

    expect(result.config?.statuses).toEqual(["subagent:failed", "completed"]);
  });

  test("an unknown compound subagent status is dropped", async () => {
    const { impl } = makeReadFile({
      [PROJECT_FILE]: JSON.stringify({
        serverUrl: "https://project.example",
        key: "project-key",
        statuses: ["subagent:bogus", "subagent"],
      }),
    });

    const result = await loadConfig({
      cwd: CWD,
      homeDir: HOME_DIR,
      readFile: impl,
    });

    expect(result.config?.statuses).toEqual(["subagent"]);
  });
});
