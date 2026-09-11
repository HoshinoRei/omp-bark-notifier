// The `zz-` filename prefix is deliberate: Bun's test runner evaluates every
// matching test file in one shared module registry, in filename order, so a
// `mock.module` registration here would replace src/config and src/notify for
// every file evaluated afterwards. Renamed to sort last, this suite's mocks
// cannot reach the sibling suites — config.test.ts, notify.test.ts, and
// smoke.test.ts all bind the real modules first — and this file's own lazy
// hook import still runs after its top-level mock registrations.

import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { BarkNotifierConfig } from "../src/types/bark-notifier-config.ts";
import type { ConfigSource } from "../src/types/config-source.ts";
import type { AgentEndLikeEvent } from "../src/types/agent-end-like-event.ts";
import type { LoadResult } from "../src/types/load-result.ts";
import type { TaskNotification } from "../src/types/task-notification.ts";
import type { HookLogRecord } from "../src/types/hook-log-record.ts";
import type { HookPiDouble } from "../src/types/hook-pi-double.ts";

const CWD = "/work/project";
const SERVER_URL = "https://bark.example.test";
const DEVICE_KEY = "device-key-abc";

const ACTIVE_CONFIG: BarkNotifierConfig = {
  serverUrl: SERVER_URL,
  key: DEVICE_KEY,
  group: "ci",
  titleTemplate: "OMP task {status}",
  bodyTemplate: "{message}\n\nProject: {cwd}",
  askTitleTemplate: "OMP task waiting for your input",
  askBodyTemplate: "{message}\n\nProject: {cwd}",
  statuses: ["completed", "failed", "aborted", "waiting"],
};


// --- Module-boundary doubles -------------------------------------------------

let configResult: LoadResult;
let configLookupError: Error | null = null;
let deliveryError: Error | null = null;
let sentNotifications: TaskNotification[] = [];
let sentConfigs: BarkNotifierConfig[] = [];
let configSources: Array<Pick<ConfigSource, "cwd" | "env">> = [];

mock.module("../src/config", () => ({
  loadConfig: async (source: ConfigSource): Promise<LoadResult> => {
    configSources.push({ cwd: source.cwd, env: source.env });
    if (configLookupError) throw configLookupError;
    return configResult;
  },
}));

mock.module("../src/notify", () => ({
  sendBarkNotification: async (
    notification: TaskNotification,
    config: BarkNotifierConfig,
  ): Promise<void> => {
    if (deliveryError) throw deliveryError;
    sentNotifications.push(notification);
    sentConfigs.push(config);
  },
}));

let barkNotifier: (pi: unknown) => void;

// --- Fake OMP ExtensionAPI ---------------------------------------------------

type RegisteredHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function makePi(): HookPiDouble {
  const events: string[] = [];
  const logs: HookLogRecord[] = [];
  const pi = {
    pi: {
      on: (_event: string, _registered: RegisteredHandler) => {},
      logger: {
        warn(message: string, context?: Record<string, unknown>) {
          logs.push({ level: "warn", message, context });
        },
        error(message: string, context?: Record<string, unknown>) {
          logs.push({ level: "error", message, context });
        },
        info() {},
        debug() {},
      },
    },
    events,
    handlers: {} as Record<string, RegisteredHandler>,
    logs,
  };
  // Bind `on` after construction so the closure mutates the same `handlers`
  // object the tests read (a plain captured variable would stay empty).
  pi.pi.on = (event, registered) => {
    pi.events.push(event);
    pi.handlers[event] = registered;
  };
  return pi;
}

// Registers the factory and asserts the exact registration contract.
function installHandler(): HookPiDouble {
  const pi = makePi();
  barkNotifier(pi.pi);
  expect(pi.events).toEqual(["agent_end", "tool_call"]);
  return pi;
}

// proving the handler never lets an error escape. `hasUI` mirrors the OMP
// context of the session that settled: true for the main agent (TUI), false
// for headless subagent sessions.
async function fire(pi: HookPiDouble, event: AgentEndLikeEvent, hasUI = true): Promise<void> {
  const handler = pi.handlers["agent_end"];
  expect(handler).toBeDefined();
  await handler!(event, { cwd: CWD, hasUI });
}

// Invokes the registered `tool_call` handler for the given tool event.
async function fireToolCall(pi: HookPiDouble, event: Record<string, unknown>): Promise<void> {
  const handler = pi.handlers["tool_call"];
  expect(handler).toBeDefined();
  await handler!(event, { cwd: CWD, hasUI: true });
}

// --- Event fixtures (mirror the typed OMP payload shapes) ---------------------

function textBlock(text: string): { type: string; text: string } {
  return { type: "text", text };
}

function assistantMessage(options: {
  content?: unknown[];
  stopReason?: string;
  errorMessage?: string;
} = {}): Record<string, unknown> {
  const { content = [], stopReason = "stop", errorMessage } = options;
  const message: Record<string, unknown> = { role: "assistant", content, stopReason };
  if (errorMessage !== undefined) message.errorMessage = errorMessage;
  return message;
}

describe("barkNotifier hook factory", () => {
  beforeAll(async () => {
    // The hook module is loaded lazily on purpose: `mock.module` must be
    // registered above before the hook's dependency graph (src/config,
    // src/notify) is first evaluated, which a static top-level import would
    // defeat. This exercises the module-loading boundary the mocks require.
    const loaded = await import("../hooks/post/bark-notifier.ts");
    barkNotifier = loaded.default as (pi: unknown) => void;
  });

  beforeEach(() => {
    configResult = { config: ACTIVE_CONFIG };
    configLookupError = null;
    deliveryError = null;
    sentNotifications = [];
    sentConfigs = [];
    configSources = [];
  });

  test("registers agent_end and tool_call handlers and no turn_end", () => {
    const pi = installHandler();
    expect(pi.events).toEqual(["agent_end", "tool_call"]);
    expect(typeof pi.handlers["agent_end"]).toBe("function");
    expect(typeof pi.handlers["tool_call"]).toBe("function");
    expect(pi.events).not.toContain("turn_end");
  });

  test("renders and sends a completed task notification", async () => {
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("Implemented the feature")] })],
    });

    expect(sentNotifications).toEqual([
      {
        status: "completed",
        message: "Implemented the feature",
        title: "OMP task completed",
        body: "Implemented the feature\n\nProject: /work/project",
      },
    ]);
    expect(sentConfigs[0]).toBe(ACTIVE_CONFIG);
    // Configuration is resolved per event beneath ctx.cwd with the process env.
    expect(configSources).toHaveLength(1);
    expect(configSources[0]!.cwd).toBe(CWD);
    expect(configSources[0]!.env).toBe(process.env);
    expect(pi.logs).toEqual([]);
  });

  test("renders and sends a failed task notification", async () => {
    const pi = installHandler();
    await fire(pi, {
      messages: [
        assistantMessage({
          content: [textBlock("The build broke")],
          stopReason: "error",
          errorMessage: "exit status 1",
        }),
      ],
    });

    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0]).toMatchObject({
      status: "failed",
      message: "The build broke",
      title: "OMP task failed",
    });
    expect(sentNotifications[0]!.body).toBe("The build broke\n\nProject: /work/project");
    expect(pi.logs).toEqual([]);
  });

  test("renders and sends an aborted task notification", async () => {
    const pi = installHandler();
    await fire(pi, {
      messages: [
        assistantMessage({ content: [], stopReason: "aborted", errorMessage: "Request was aborted" }),
      ],
    });

    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0]).toMatchObject({
      status: "aborted",
      message: "Agent task aborted",
      title: "OMP task aborted",
    });
    expect(pi.logs).toEqual([]);
  });

  test("does not send when the event schedules an automatic continuation", async () => {
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("will resume")] })],
      willContinue: true,
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toEqual([]);
  });

  test("does not send when configuration is missing and warns with the reason", async () => {
    configResult = { config: null, reason: 'Missing required configuration: "key"' };
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("done")] })],
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toHaveLength(1);
    expect(pi.logs[0]).toEqual({
      level: "warn",
      message: 'Bark notification disabled: Missing required configuration: "key"',
    });
  });

  test("logs a rejected delivery without escaping and never logs the key", async () => {
    deliveryError = new Error(`push to ${SERVER_URL} refused for key ${DEVICE_KEY}`);
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("done")] })],
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toHaveLength(1);
    expect(pi.logs[0]!.level).toBe("error");
    expect(pi.logs[0]!.message).toBe("Bark notification delivery failed");
    expect(pi.logs[0]!.context).toMatchObject({ origin: SERVER_URL });
    // The key must not appear anywhere in the logged arguments; the error
    // text that embedded it is redacted instead.
    const logged = JSON.stringify(pi.logs);
    expect(logged).not.toContain(DEVICE_KEY);
    expect(String(pi.logs[0]!.context!.error)).toContain("[redacted]");
  });
  test("never logs the key or the raw URL when the server URL is malformed", async () => {
    const malformedServerUrl = `bark ${DEVICE_KEY} at https://`;
    deliveryError = new Error("connection refused");
    configResult = {
      config: { ...ACTIVE_CONFIG, serverUrl: malformedServerUrl },
    };
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("done")] })],
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toHaveLength(1);
    expect(pi.logs[0]!.level).toBe("error");
    expect(pi.logs[0]!.message).toBe("Bark notification delivery failed");
    // The unparseable URL (which embeds the device key) is replaced by a
    // fixed label, never logged raw.
    expect(pi.logs[0]!.context).toMatchObject({
      origin: "(unparseable server url)",
    });
    // Every logged argument excludes both the device key and the raw URL.
    const logged = JSON.stringify(pi.logs);
    expect(logged).not.toContain(DEVICE_KEY);
    expect(logged).not.toContain(malformedServerUrl);
  });

  test("redacts the key when it sits inside a valid server URL origin", async () => {
    // The URL parses, so the origin is derived — but a well-formed hostname
    // can still embed the device key, and the derived origin is logged.
    const keyedServerUrl = `https://${DEVICE_KEY}.bark.example.test/push/${DEVICE_KEY}`;
    deliveryError = new Error("connection refused");
    configResult = {
      config: { ...ACTIVE_CONFIG, serverUrl: keyedServerUrl },
    };
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("done")] })],
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toHaveLength(1);
    expect(pi.logs[0]!.level).toBe("error");
    expect(pi.logs[0]!.message).toBe("Bark notification delivery failed");
    // The derived origin is logged but the key within it is redacted.
    expect(pi.logs[0]!.context).toMatchObject({
      origin: "https://[redacted].bark.example.test",
    });
    // The device key must not appear anywhere in the logged arguments.
    const logged = JSON.stringify(pi.logs);
    expect(logged).not.toContain(DEVICE_KEY);
  });

  test("redacts a mixed-case key embedded in a hostname after normalization", async () => {
    // `new URL(serverUrl).origin` lowercases the hostname, so a key that
    // contains uppercase letters no longer matches a case-sensitive redaction;
    // the derived origin is logged only with the key redacted.
    const mixedCaseKey = "DeviceKeyAbC";
    const keyedServerUrl = `https://${mixedCaseKey}.bark.example.test/push/${mixedCaseKey}`;
    deliveryError = new Error("connection refused");
    configResult = {
      config: { ...ACTIVE_CONFIG, key: mixedCaseKey, serverUrl: keyedServerUrl },
    };
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("done")] })],
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toHaveLength(1);
    expect(pi.logs[0]!.level).toBe("error");
    expect(pi.logs[0]!.message).toBe("Bark notification delivery failed");
    // The normalized (lowercased) origin is logged with the key redacted.
    expect(pi.logs[0]!.context).toMatchObject({
      origin: "https://[redacted].bark.example.test",
    });
    // Neither the original mixed-case key nor its lowercased form may appear
    // anywhere in the serialized logs.
    const logged = JSON.stringify(pi.logs);
    expect(logged).not.toContain(mixedCaseKey);
    expect(logged).not.toContain(mixedCaseKey.toLowerCase());
  });

  test("contains a configuration lookup failure without escaping the handler", async () => {
    configLookupError = new Error("readdir boom");
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("done")] })],
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toHaveLength(1);
    expect(pi.logs[0]!.level).toBe("error");
    expect(pi.logs[0]!.context).toMatchObject({ error: "readdir boom" });
  });

  test("sends a waiting notification when the ask tool blocks for user input", async () => {
    const pi = installHandler();
    await fireToolCall(pi, {
      type: "tool_call",
      toolName: "ask",
      toolCallId: "call_ask_01",
      input: {
        questions: [
          { id: "db", question: "SQLite or PostgreSQL?" },
          { id: "auth", question: "Which auth method?" },
        ],
      },
    });

    expect(sentNotifications).toEqual([
      {
        status: "waiting",
        message: "SQLite or PostgreSQL?\nWhich auth method?",
        title: "OMP task waiting for your input",
        body: "SQLite or PostgreSQL?\nWhich auth method?\n\nProject: /work/project",
      },
    ]);
    expect(sentConfigs[0]).toBe(ACTIVE_CONFIG);
    expect(configSources).toHaveLength(1);
    expect(configSources[0]!.cwd).toBe(CWD);
    expect(pi.logs).toEqual([]);
  });

  test("does not send for non-ask tool calls", async () => {
    const pi = installHandler();
    await fireToolCall(pi, {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "call_bash_01",
      input: { command: "echo hi" },
    });

    expect(sentNotifications).toEqual([]);
    expect(configSources).toEqual([]);
    expect(pi.logs).toEqual([]);
  });

  test("does not send for an ask call without extractable questions", async () => {
    const pi = installHandler();
    await fireToolCall(pi, {
      type: "tool_call",
      toolName: "ask",
      toolCallId: "call_ask_02",
      input: { questions: [] },
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toEqual([]);
  });

  test("does not send for ask when statuses excludes waiting", async () => {
    configResult = {
      config: { ...ACTIVE_CONFIG, statuses: ["completed", "failed", "aborted"] },
    };
    const pi = installHandler();
    await fireToolCall(pi, {
      type: "tool_call",
      toolName: "ask",
      toolCallId: "call_ask_03",
      input: { questions: [{ question: "Proceed?" }] },
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toEqual([]);
  });

  test("does not send a final notification for a status excluded by the statuses filter", async () => {
    configResult = {
      config: { ...ACTIVE_CONFIG, statuses: ["failed", "aborted"] },
    };
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("done")] })],
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toEqual([]);
  });

  test("does not send a subagent settle when statuses excludes subagent", async () => {
    // OMP subagent sessions run headless (ctx.hasUI false); the default
    // statuses list only `subagent:failed`, so a completed settle stays
    // silent — only subagent failures push out of the box.
    const pi = installHandler();
    await fire(
      pi,
      {
        messages: [assistantMessage({ content: [textBlock("scout finished")] })],
      },
      false,
    );

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toEqual([]);
  });

  test("does not send a subagent settle when only its outcome status is listed", async () => {
    // Listing the classified outcome alone is not enough: a subagent settle
    // pushes only when a subagent entry matches (flat `subagent` or the
    // matching `subagent:<outcome>`).
    configResult = {
      config: { ...ACTIVE_CONFIG, statuses: ["completed", "failed", "aborted", "waiting"] },
    };
    const pi = installHandler();
    await fire(
      pi,
      {
        messages: [assistantMessage({ content: [textBlock("scout finished")] })],
      },
      false,
    );

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toEqual([]);
  });

  test("sends a subagent settle when statuses includes subagent", async () => {
    configResult = {
      config: { ...ACTIVE_CONFIG, statuses: ["completed", "failed", "aborted", "waiting", "subagent"] },
    };
    const pi = installHandler();
    await fire(
      pi,
      {
        messages: [assistantMessage({ content: [textBlock("scout finished")] })],
      },
      false,
    );

    expect(sentNotifications).toHaveLength(1);
    // The rendered notification carries the subagent's real outcome.
    expect(sentNotifications[0]).toMatchObject({
      status: "completed",
      message: "scout finished",
      title: "OMP task completed",
    });
    expect(pi.logs).toEqual([]);
  });

  test("renders the real outcome of an opted-in failed subagent settle", async () => {
    configResult = {
      config: { ...ACTIVE_CONFIG, statuses: ["subagent"] },
    };
    const pi = installHandler();
    await fire(
      pi,
      {
        messages: [
          assistantMessage({
            content: [textBlock("worker crashed")],
            stopReason: "error",
            errorMessage: "boom",
          }),
        ],
      },
      false,
    );

    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0]).toMatchObject({
      status: "failed",
      title: "OMP task failed",
    });
    expect(pi.logs).toEqual([]);
  });

  test("does not send a main-agent settle when statuses lists only subagent", async () => {
    // The `subagent` status gates only subagent settles; the main agent's
    // outcome status must still be listed.
    configResult = {
      config: { ...ACTIVE_CONFIG, statuses: ["subagent"] },
    };
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("main done")] })],
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toEqual([]);
  });

  test("sends a subagent settle matching a compound subagent status", async () => {
    configResult = {
      config: { ...ACTIVE_CONFIG, statuses: ["subagent:failed"] },
    };
    const pi = installHandler();
    await fire(
      pi,
      {
        messages: [
          assistantMessage({
            content: [textBlock("worker crashed")],
            stopReason: "error",
            errorMessage: "boom",
          }),
        ],
      },
      false,
    );

    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0]).toMatchObject({
      status: "failed",
      title: "OMP task failed",
    });
    expect(pi.logs).toEqual([]);
  });

  test("does not send a subagent settle for a compound status of another outcome", async () => {
    configResult = {
      config: { ...ACTIVE_CONFIG, statuses: ["subagent:failed"] },
    };
    const pi = installHandler();
    await fire(
      pi,
      {
        messages: [assistantMessage({ content: [textBlock("scout finished")] })],
      },
      false,
    );

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toEqual([]);
  });

  test("does not send a main-agent settle when statuses lists only a compound subagent status", async () => {
    configResult = {
      config: { ...ACTIVE_CONFIG, statuses: ["subagent:failed"] },
    };
    const pi = installHandler();
    await fire(pi, {
      messages: [assistantMessage({ content: [textBlock("main done")] })],
    });

    expect(sentNotifications).toEqual([]);
    expect(pi.logs).toEqual([]);
  });

});
