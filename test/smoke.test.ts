// Package smoke test. Unlike the unit suites, this loads the real
// hook module with no module-boundary mocks and exercises the installable
// contract OMP relies on:
//
//   1. The module's default export registers `agent_end` and `tool_call`
//      subscribers on a plain ExtensionAPI-shaped double (and nothing else).
//   2. Invoking those handlers while Bark configuration is missing
//      everywhere — the BARK_* environment variables are cleared for the
//      calls and both the project and user config layers point at an empty
//      temporary directory — resolves without throwing, performs no network
//      request, and returns without touching the events. The disabled
//      configuration surfaces as key-free logger warnings instead of sends.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import barkNotifier from "../hooks/post/bark-notifier.ts";
import type { SmokeLogRecord } from "../src/types/smoke-log-record.ts";
import type { SmokePiDouble } from "../src/types/smoke-pi-double.ts";

test("Bun test harness is available", () => {
  expect(typeof Bun.version).toBe("string");
});


// A minimal ExtensionAPI double: records registrations, captures the
// handlers by event name, and collects logger calls — the hook never needs
// anything else.
function makePi(): SmokePiDouble {
  const events: string[] = [];
  const logs: SmokeLogRecord[] = [];
  const pi: SmokePiDouble = {
    events,
    logs,
    handlers: {},
    pi: {
      on() {},
      logger: {
        warn(message: string) {
          logs.push({ level: "warn", message });
        },
        error(message: string) {
          logs.push({ level: "error", message });
        },
        info() {},
        debug() {},
      },
    },
  };
  pi.pi.on = (event, handler) => {
    events.push(event);
    pi.handlers[event] = handler;
  };
  return pi;
}

test("loads the real hook, registers agent_end and tool_call, and resolves without a Bark request when configuration is missing", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "omp-bark-notifier-"));
  const pi = makePi();

  try {
    // The real default export, loaded at the top of this file.
    barkNotifier(pi.pi as never);
    expect(pi.events).toEqual(["agent_end", "tool_call"]);
    expect(typeof pi.handlers["agent_end"]).toBe("function");
    expect(typeof pi.handlers["tool_call"]).toBe("function");

    // Hide every possible configuration source for the invocation: clear the
    // BARK_* environment variables and redirect the user/project config
    // layers (os.homedir() and ctx.cwd) to the empty temporary directory.
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("BARK_")) {
        saved.set(key, value);
        delete process.env[key];
      }
    }
    for (const key of ["HOME", "USERPROFILE"]) {
      saved.set(key, process.env[key]);
      process.env[key] = tempDir;
    }

    try {
      const event = {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Finished the task" }], stopReason: "stop" },
        ],
      };
      let result: unknown = "not invoked";
      let threw: unknown = null;
      try {
        result = await pi.handlers["agent_end"]!(event, { cwd: tempDir, hasUI: true });
      } catch (error) {
        threw = error;
      }

      // Missing configuration must disable notification without throwing and
      // without any delivery attempt: the handler resolves, returns nothing,
      // leaves the event untouched, and reports the key-free reason.
      expect(threw).toBeNull();
      expect(result).toBeUndefined();
      expect(event).toEqual({
        messages: [
          { role: "assistant", content: [{ type: "text", text: "Finished the task" }], stopReason: "stop" },
        ],
      });
      expect(pi.logs).toHaveLength(1);
      expect(pi.logs[0]).toEqual({
        level: "warn",
        message: 'Bark notification disabled: Missing required configuration: "serverUrl"',
      });

      // The ask-tool subscriber follows the same contract: an ask tool_call
      // with missing configuration warns key-free and never throws.
      let askThrew: unknown = null;
      try {
        await pi.handlers["tool_call"]!(
          {
            type: "tool_call",
            toolName: "ask",
            toolCallId: "call_ask_01",
            input: { questions: [{ question: "Proceed?" }] },
          },
          { cwd: tempDir, hasUI: true },
        );
      } catch (error) {
        askThrew = error;
      }
      expect(askThrew).toBeNull();
      expect(pi.logs).toHaveLength(2);
      expect(pi.logs[1]).toEqual({
        level: "warn",
        message: 'Bark notification disabled: Missing required configuration: "serverUrl"',
      });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
