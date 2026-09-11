import { describe, expect, test } from "bun:test";
import {
  classifyTask,
  isStatusListed,
  lastAssistantText,
  renderNotification,
  renderAskNotification,
} from "../src/message";
import type { AgentEndLikeEvent } from "../src/types/agent-end-like-event";
import type { TaskStatus } from "../src/types/task-status";

// Representative OMP assistant/tool-result message shapes (mirrors the typed
// `AgentMessage` payloads: role, content blocks, stopReason, errorMessage for
// assistants; isError for tool results).
function assistantMessage(options: {
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
} = {}): unknown {
  const { content = [], stopReason = "stop", errorMessage } = options;
  const message: Record<string, unknown> = {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    content,
    usage: { input: 0, output: 0 },
    timestamp: 1,
    stopReason,
  };
  if (errorMessage !== undefined) message.errorMessage = errorMessage;
  return message;
}

function toolResultMessage(options: { isError: boolean; text?: string }): unknown {
  const { isError, text = isError ? "tool failed" : "tool succeeded" } = options;
  return {
    role: "toolResult",
    toolCallId: "toolu_01",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError,
    timestamp: 2,
  };
}

const textBlock = (text: string) => ({ type: "text", text });
const thinkingBlock = (thinking: string) => ({ type: "thinking", thinking });
const toolCallBlock = () => ({
  type: "toolCall",
  id: "call_01",
  name: "bash",
  arguments: { command: "echo hi" },
});

function eventOf(messages: unknown[], willContinue?: boolean): AgentEndLikeEvent {
  return willContinue === undefined ? { messages } : { messages, willContinue };
}

describe("classifyTask", () => {
  test("falls back to completed without an explicit failure marker", () => {
    const event = eventOf([assistantMessage({ content: [textBlock("done")] })]);
    expect(classifyTask(event)).toBe("completed");
  });

  test("classifies an empty transcript as completed", () => {
    expect(classifyTask(eventOf([]))).toBe("completed");
  });

  test("classifies a length stop reason as completed", () => {
    const event = eventOf([
      assistantMessage({ content: [textBlock("ran out of budget")], stopReason: "length" }),
    ]);
    expect(classifyTask(event)).toBe("completed");
  });

  test("classifies an explicit error stop marker as failed", () => {
    const event = eventOf([
      assistantMessage({
        content: [],
        stopReason: "error",
        errorMessage: "Provider returned an error stop reason",
      }),
    ]);
    expect(classifyTask(event)).toBe("failed");
  });

  test("classifies a non-empty errorMessage as failed even without stopReason", () => {
    // Loosely-typed payload: the explicit error marker is the errorMessage.
    const event = eventOf([
      { role: "assistant", content: [], errorMessage: "rate limit exceeded" },
    ]);
    expect(classifyTask(event)).toBe("failed");
  });

  test("classifies an explicit abort stop marker as aborted", () => {
    const event = eventOf([
      assistantMessage({
        content: [],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      }),
    ]);
    expect(classifyTask(event)).toBe("aborted");
  });

  test("does not treat a recoverable tool error as task failure", () => {
    const event = eventOf([
      assistantMessage({
        content: [textBlock("running the build"), toolCallBlock()],
        stopReason: "toolUse",
      }),
      toolResultMessage({ isError: true, text: "exit code 1" }),
      assistantMessage({ content: [textBlock("recovered and finished")] }),
    ]);
    expect(classifyTask(event)).toBe("completed");
  });

  test("does not treat a trailing errored tool result as task failure", () => {
    // The agent's final turn requested a tool whose result errored; no
    // assistant-level failure marker exists, so the task is not failed.
    const event = eventOf([
      assistantMessage({ content: [textBlock("one moment")], stopReason: "stop" }),
      assistantMessage({ content: [toolCallBlock()], stopReason: "toolUse" }),
      toolResultMessage({ isError: true }),
    ]);
    expect(classifyTask(event)).toBe("completed");
  });

  test("classifies by the final assistant message only", () => {
    // An earlier errored generation was superseded by a completed retry.
    const event = eventOf([
      assistantMessage({ content: [], stopReason: "error", errorMessage: "stream failed" }),
      assistantMessage({ content: [textBlock("retry succeeded")] }),
    ]);
    expect(classifyTask(event)).toBe("completed");
  });
});

describe("lastAssistantText", () => {
  test("extracts the text of the last assistant message", () => {
    const messages = [
      assistantMessage({ content: [textBlock("first")] }),
      assistantMessage({ content: [textBlock("second")] }),
      toolResultMessage({ isError: false }),
      assistantMessage({ content: [textBlock("final context")] }),
      toolResultMessage({ isError: false }),
    ];
    expect(lastAssistantText(messages)).toBe("final context");
  });

  test("skips trailing text-less assistant messages and returns earlier text", () => {
    const messages = [
      assistantMessage({ content: [textBlock("first words")] }),
      assistantMessage({ content: [toolCallBlock()], stopReason: "toolUse" }),
    ];
    expect(lastAssistantText(messages)).toBe("first words");
  });

  test("flattens text blocks and ignores non-text blocks", () => {
    const messages = [
      assistantMessage({
        content: [
          thinkingBlock("reasoning"),
          textBlock("alpha"),
          toolCallBlock(),
          textBlock("omega"),
        ],
      }),
    ];
    expect(lastAssistantText(messages)).toBe("alpha\nomega");
  });

  test("preserves multiline text and leading/trailing whitespace", () => {
    const messages = [
      assistantMessage({ content: [textBlock("\n  line1\nline2\nline3\n  ") ] }),
    ];
    expect(lastAssistantText(messages)).toBe("\n  line1\nline2\nline3\n  ");
  });

  test("returns null when no assistant text exists", () => {
    expect(lastAssistantText([])).toBeNull();
    expect(lastAssistantText([toolResultMessage({ isError: true })])).toBeNull();
    expect(
      lastAssistantText([assistantMessage({ content: [thinkingBlock("only thinking")] })]),
    ).toBeNull();
    expect(
      lastAssistantText([assistantMessage({ content: [textBlock("   ")] })]),
    ).toBeNull();
  });
});

describe("renderNotification", () => {
  test("renders the full final assistant context", () => {
    const event = eventOf([
      assistantMessage({ content: [textBlock("first")] }),
      assistantMessage({ content: [textBlock("final context")] }),
    ]);
    expect(renderNotification(event, "C:/repo", "{status}", "{message}|{cwd}|{unknown}"))
      .toEqual({
        status: "completed",
        message: "final context",
        title: "completed",
        body: "final context|C:/repo|{unknown}",
      });
  });

  test("replaces every supported variable in both templates", () => {
    const event = eventOf([
      assistantMessage({ content: [textBlock("task done")] }),
    ]);
    const notification = renderNotification(
      event,
      "/work/project",
      "OMP {status} {status}",
      "{message} in {cwd}",
    );
    expect(notification).toEqual({
      status: "completed",
      message: "task done",
      title: "OMP completed completed",
      body: "task done in /work/project",
    });
  });

  test("renders multiline assistant text and the default body template shape", () => {
    const event = eventOf([
      assistantMessage({ content: [textBlock("line1\nline2")] }),
    ]);
    const notification = renderNotification(event, "/repo", "OMP task {status}", "{message}\n\nProject: {cwd}");
    expect(notification?.title).toBe("OMP task completed");
    expect(notification?.body).toBe("line1\nline2\n\nProject: /repo");
  });
  test("preserves assistant text whitespace in the notification message", () => {
    const event = eventOf([
      assistantMessage({ content: [textBlock("  wrapped text\nwith a tail  ")] }),
    ]);
    const notification = renderNotification(event, "/repo", "{status}", "{message}");
    expect(notification).toEqual({
      status: "completed",
      message: "  wrapped text\nwith a tail  ",
      title: "completed",
      body: "  wrapped text\nwith a tail  ",
    });
  });

  test("does not rescan text introduced by a replacement", () => {
    // The assistant text contains a literal {status}; the single-pass render
    // substitutes it once into {message} and must not replace it again.
    const event = eventOf([
      assistantMessage({ content: [textBlock("read the {status} report")] }),
    ]);
    const notification = renderNotification(event, "/repo", "{status}", "{message}");
    expect(notification?.body).toBe("read the {status} report");
  });

  test("uses a status-specific fallback message when no assistant text exists", () => {
    const cases: Array<{ event: AgentEndLikeEvent; status: TaskStatus; fallback: string }> = [
      { event: eventOf([]), status: "completed", fallback: "Agent task completed" },
      {
        event: eventOf([
          assistantMessage({ content: [], stopReason: "error", errorMessage: "boom" }),
        ]),
        status: "failed",
        fallback: "Agent task failed",
      },
      {
        event: eventOf([
          assistantMessage({ content: [], stopReason: "aborted", errorMessage: "Request was aborted" }),
        ]),
        status: "aborted",
        fallback: "Agent task aborted",
      },
    ];
    for (const { event, status, fallback } of cases) {
      const notification = renderNotification(event, "/repo", "{status}", "{message}");
      expect(notification).toEqual({ status, message: fallback, title: status, body: fallback });
    }
  });

  test("renders a failed task whose final message carries only an errorMessage", () => {
    const event = eventOf([
      { role: "assistant", content: [], errorMessage: "rate limit exceeded" },
    ]);
    const notification = renderNotification(
      event,
      "/repo",
      "OMP {status}",
      "{message}",
    );
    expect(notification).toEqual({
      status: "failed",
      message: "Agent task failed",
      title: "OMP failed",
      body: "Agent task failed",
    });
  });

  test("does not notify an automatic continuation", () => {
    const event = eventOf([], true);
    expect(renderNotification(event, "/repo", "title", "body")).toBeNull();
  });
});

describe("renderAskNotification", () => {
  test("renders joined questions with the default template shape", () => {
    const notification = renderAskNotification(
      { questions: [{ id: "db", question: "SQLite or PostgreSQL?" }, { question: "Which auth?" }] },
      "/work/project",
      "OMP task waiting for your input",
      "{message}\n\nProject: {cwd}",
    );
    expect(notification).toEqual({
      status: "waiting",
      message: "SQLite or PostgreSQL?\nWhich auth?",
      title: "OMP task waiting for your input",
      body: "SQLite or PostgreSQL?\nWhich auth?\n\nProject: /work/project",
    });
  });

  test("accepts plain-string question items", () => {
    const notification = renderAskNotification(
      { questions: ["SQLite or PostgreSQL?", "Which auth?"] },
      "/repo",
      "ask {status}",
      "{message}",
    );
    expect(notification).toEqual({
      status: "waiting",
      message: "SQLite or PostgreSQL?\nWhich auth?",
      title: "ask waiting",
      body: "SQLite or PostgreSQL?\nWhich auth?",
    });
  });

  test("replaces every supported variable and preserves unknown placeholders", () => {
    const notification = renderAskNotification(
      { questions: [{ question: "Proceed?" }] },
      "/repo",
      "{status} {unknown}",
      "{message} in {cwd}",
    );
    expect(notification).toEqual({
      status: "waiting",
      message: "Proceed?",
      title: "waiting {unknown}",
      body: "Proceed? in /repo",
    });
  });

  test("returns null without extractable questions", () => {
    const cases: unknown[] = [
      null,
      "not an object",
      {},
      { questions: [] },
      { questions: "not an array" },
      { questions: [{ label: "no question field" }] },
      { questions: [{ question: "   " }] },
      { questions: ["  "] },
    ];
    for (const input of cases) {
      expect(renderAskNotification(input, "/repo", "ask {status}", "{message}")).toBeNull();
    }
  });
});

describe("isStatusListed", () => {
  const ALL = ["completed", "failed", "aborted", "waiting"] as const;

  test("main-agent settles check their classified outcome directly", () => {
    expect(isStatusListed([...ALL], "completed", false)).toBe(true);
    expect(isStatusListed([...ALL], "failed", false)).toBe(true);
    expect(isStatusListed(["failed", "aborted"], "completed", false)).toBe(false);
  });

  test("the flat subagent entry lists every subagent outcome", () => {
    for (const outcome of ["completed", "failed", "aborted"] as const) {
      expect(isStatusListed(["subagent"], outcome, true)).toBe(true);
    }
  });

  test("a compound subagent entry lists only that outcome", () => {
    expect(isStatusListed(["subagent:failed"], "failed", true)).toBe(true);
    expect(isStatusListed(["subagent:failed"], "completed", true)).toBe(false);
    expect(isStatusListed(["subagent:aborted"], "failed", true)).toBe(false);
  });

  test("subagent settles never match by their outcome alone", () => {
    expect(isStatusListed(["completed", "failed", "aborted", "waiting"], "completed", true)).toBe(false);
  });

  test("subagent entries never affect main-agent settles", () => {
    expect(isStatusListed(["subagent", "subagent:failed"], "completed", false)).toBe(false);
  });
});
