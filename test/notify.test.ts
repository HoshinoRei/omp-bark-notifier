// Delivery-adapter tests. Network-free by construction:
//   - the public forwarding behavior is exercised with an injected fake
//     `BarkSender` (never a real client),
//   - the SDK-backed default sender is exercised through
//     `sendBarkNotification()` against a stubbed `globalThis.fetch`, so no
//     Bark server is ever contacted.
//
// `sendBarkNotification` deliberately propagates a sender rejection instead of
// swallowing it: the OMP hook boundary (`hooks/post/bark-notifier.ts`) wraps
// delivery in try/catch so a rejected sender is contained there (logged, never
// escaping the `agent_end` handler). The last describe block pins that
// documented contract.

import { afterEach, describe, expect, test } from "bun:test";
import type { BarkNotifierConfig } from "../src/types/bark-notifier-config";
import type { BarkSender } from "../src/types/bark-sender";
import type { TaskNotification } from "../src/types/task-notification";
import { sendBarkNotification } from "../src/notify";

const notification: TaskNotification = {
  status: "completed",
  message: "Implemented the Bark adapter",
  title: "OMP task completed",
  body: "Implemented the Bark adapter\n\nProject: /work/demo",
};

const configWithGroup: BarkNotifierConfig = {
  serverUrl: "https://bark.example.test",
  key: "device-token-abc",
  group: "ci",
  titleTemplate: "OMP task {status}",
  bodyTemplate: "{message}\n\nProject: {cwd}",
  askTitleTemplate: "OMP task waiting for your input",
  askBodyTemplate: "{message}\n\nProject: {cwd}",
  statuses: ["completed", "failed", "aborted"],
};

const configWithoutGroup: BarkNotifierConfig = {
  serverUrl: "https://bark.example.test",
  key: "device-token-abc",
  titleTemplate: "OMP task {status}",
  bodyTemplate: "{message}",
  askTitleTemplate: "OMP task waiting for your input",
  askBodyTemplate: "{message}\n\nProject: {cwd}",
  statuses: ["completed", "failed", "aborted"],
};

function recordingSender(options: { rejectWith?: Error } = {}): {
  sender: BarkSender;
  calls: Array<{ notification: TaskNotification; config: BarkNotifierConfig }>;
} {
  const calls: Array<{ notification: TaskNotification; config: BarkNotifierConfig }> = [];
  const sender: BarkSender = {
    async send(callNotification, callConfig) {
      calls.push({ notification: callNotification, config: callConfig });
      if (options.rejectWith !== undefined) throw options.rejectWith;
    },
  };
  return { sender, calls };
}

describe("sendBarkNotification", () => {
  test("forwards every notification and config value to the injected sender, including the optional group", async () => {
    const { sender, calls } = recordingSender();

    await sendBarkNotification(notification, configWithGroup, sender);

    expect(calls).toHaveLength(1);
    expect(calls[0].notification).toEqual(notification);
    expect(calls[0].notification.title).toBe("OMP task completed");
    expect(calls[0].notification.body).toContain("Project: /work/demo");
    expect(calls[0].config).toEqual(configWithGroup);
    expect(calls[0].config.serverUrl).toBe("https://bark.example.test");
    expect(calls[0].config.key).toBe("device-token-abc");
    expect(calls[0].config.group).toBe("ci");
  });

  test("sends once and resolves when the config has no optional group", async () => {
    const { sender, calls } = recordingSender();

    await sendBarkNotification(notification, configWithoutGroup, sender);

    expect(calls).toHaveLength(1);
    expect(calls[0].config.group).toBeUndefined();
  });

  test("propagates a rejected sender so the hook boundary can contain it", async () => {
    const failure = new Error("push failed: server unreachable");
    const { sender, calls } = recordingSender({ rejectWith: failure });

    await expect(sendBarkNotification(notification, configWithGroup, sender)).rejects.toThrow(
      "push failed: server unreachable",
    );

    // The full payload reached the sender before the rejection surfaced.
    expect(calls).toHaveLength(1);
    expect(calls[0].notification.title).toBe("OMP task completed");
    expect(calls[0].config.group).toBe("ci");
  });
});

describe("SDK-backed default sender", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("pushes the notification and group to the configured server through the SDK", async () => {
    let requestedUrl = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ code: 200, message: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await sendBarkNotification(notification, configWithGroup);

    expect(requestedUrl).toBe("https://bark.example.test/push");
    expect(requestInit?.method).toBe("POST");
    const payload = JSON.parse(String(requestInit?.body)) as Record<string, string>;
    expect(payload.title).toBe("OMP task completed");
    expect(payload.body).toContain("Project: /work/demo");
    expect(payload.device_key).toBe("device-token-abc");
    expect(payload.group).toBe("ci");
  });

  test("omits the group field when the config has none", async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ code: 200, message: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await sendBarkNotification(notification, configWithoutGroup);

    const payload = JSON.parse(String(requestInit?.body)) as Record<string, string>;
    expect(payload.title).toBe("OMP task completed");
    expect(payload.device_key).toBe("device-token-abc");
    expect(payload).not.toHaveProperty("group");
  });
});
