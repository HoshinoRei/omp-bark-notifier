# Repository Guidelines

## Project Overview

`omp-bark-notifier` is an installable **agent_end hook for oh-my-pi**: when an agent task settles, it sends a [Bark](https://github.com/Finb/Bark) push notification to iOS. It is an npm package (`omp-bark-notifier`, version 0.1.1, branch `main`); releases publish it to the public npm registry.

- Fires on `agent_end` (final settles) and on `tool_call` **only** for the `ask` tool — never `turn_end`, other tool calls, or tool failures.
- At most **one push per final settle**; `willContinue === true` suppresses it. At most one `waiting` push per `ask` call.
- Subagent settles (OMP runs them headless, `ctx.hasUI === false`) push when the flat `subagent` entry or a matching `subagent:<outcome>` entry is listed in `statuses` — by default only `subagent:failed` is listed, so failed subagent settles push while other subagent outcomes stay silent; the main agent's settles keep their classified outcomes.
- The hook handlers **never throw, never mutate the events, never return a continuation** (the `tool_call` handler never returns a block result).
- The device key is **never logged**; all diagnostics redact it.

## Architecture & Data Flow

Three-layer split; the only OMP-boundary file is the hook, everything else is plain TS.

```
OMP fires agent_end(AgentEndEvent, ExtensionContext) / tool_call(ToolCallEvent, ExtensionContext)
  → hooks/post/bark-notifier.ts        OMP boundary: registers pi.on('agent_end', …) and
                                        pi.on('tool_call', …) (ask tool only), shared `deliver`
                                        pipeline, contains ALL failures, redacts key in every log
  → src/config.ts    loadConfig({cwd, env})  layered config resolution (incl. ask settings)
  → src/message.ts   renderNotification(event, cwd, templates)  pure classification + rendering;
                     renderAskNotification(input, cwd, templates)  ask questions → `waiting` push
  → src/notify.ts    sendBarkNotification()  Bark SDK delivery (only SDK-importing module)
```

- **hooks/post/bark-notifier.ts** — default export `barkNotifier(pi: ExtensionAPI)` factory; failure-contained handlers: `config: null` → warn + return; `renderNotification`/`renderAskNotification` return `null` → silent return; SDK errors → log via `pi.logger` with `redact()` on the key and `serverOrigin()` (scheme+host only, `'(unparseable server url)'` fallback). Subscribes `agent_end` (final settles; subagent settles, detected via `ctx.hasUI === false`, push when `statuses` lists `subagent` or the matching `subagent:<outcome>` — the default list includes `subagent:failed`) and `tool_call` (only `toolName === "ask"`, skipped when `statuses` excludes `"waiting"`).
- **src/config.ts** — `loadConfig()` merges, in precedence order: `~/.omp/bark-notifier.json` → `<cwd>/.omp/bark-notifier.json` → `BARK_*` env vars (`BARK_SERVER_URL`, `BARK_KEY`, `BARK_GROUP`, `BARK_TITLE_TEMPLATE`, `BARK_BODY_TEMPLATE`, `BARK_ASK_TITLE_TEMPLATE`, `BARK_ASK_BODY_TEMPLATE`, `BARK_STATUSES`). File reads go through an injectable `ReadFileImpl` (default: `node:fs/promises`). `statuses` (default `completed`/`failed`/`waiting`/`subagent:failed`; `aborted` and the other `subagent`/`subagent:<outcome>` entries are opt-in) is the only array file setting; `BARK_STATUSES` is comma-separated; unknown entries dropped, duplicates collapsed, empty array = no pushes at all, all-unknown value = default.
- **src/message.ts** — pure logic: `classifyTask()` (explicit `stopReason === 'aborted'` → aborted; `stopReason === 'error'` or non-empty `errorMessage` → failed; else completed; a tool `isError` alone does **not** fail — recoverable; final assistant message wins), `lastAssistantText()`, `renderNotification()` (returns `null` when `willContinue === true`), `renderAskNotification()` (joins `input.questions` text → `waiting` status; `null` when no question text). `renderTemplate()` is single-pass: replaces `{status}`/`{cwd}`/`{message}`, unknown placeholders survive verbatim. Defaults: title `OMP task {status}`, body `{message}\n\nProject: {cwd}`, ask title `OMP task waiting for your input`, ask body `{message}\n\nProject: {cwd}`.
- **src/notify.ts** — `sendBarkNotification()` (optional sender param, defaults to a private SDK-backed sender: `BarkClient(serverUrl)` + `BarkMessageBuilder` `.title/.body/.deviceKey/.group` → `client.push`).

## Key Directories

| Path | Purpose |
|---|---|
| `src/` | Pure logic + injected seams; one module per concern (config, message, notify) |
| `src/types/` | 13 type/interface files: data models (`task-status`, `task-notification`, `agent-end-like-event`, `bark-notifier-config`, `hook-log-record`, `smoke-log-record`), injected-seam contracts (`bark-sender`, `read-file-impl`, `config-source`), result unions (`load-result`, `file-layer-result`), test doubles (`smoke-pi-double`, `hook-pi-double`) |
| `hooks/post/` | Installable OMP extension entry (`bark-notifier.ts`) — referenced by `omp.extensions` in package.json |
| `test/` | `bun:test` suites, one per src module |
| `docs/superpowers/` | SDD design specs + implementation plans — local working files, excluded from git (see `.gitignore`); not part of the published repo |
| `.superpowers/sdd/` | SDD ledger (task briefs/reports; dir-level `.gitignore = *` — untracked working files) |

## Development Commands

There is **no build pipeline**: `tsconfig.json` has `noEmit: true`, and oh-my-pi loads `./hooks/post/bark-notifier.ts` directly from TS source (Bun runs TS natively).

```bash
bun install   # deps (the Bark SDK dependency is a direct tarball URL on npm.jsr.io)
bun test      # the only npm script; runs all test/*.test.ts
bun test test/message.test.ts   # single suite
```

No lint, format, or typecheck scripts exist — no formatter/linter is configured (`.vscode/settings.json` has no format-on-save). Typechecking is editor-driven (`tsc --noEmit`).

## Code Conventions & Common Patterns

- **Module style**: ESM TypeScript — `type: module`, `ESNext` target/module, `moduleResolution: bundler`, `verbatimModuleSyntax` (use `import type` for type-only imports), `allowImportingTsExtensions`.
- **tsconfig** pins `"types": ["node", "bun"]` explicitly — required workaround for TS 6.0 dropping automatic `@types/*` inclusion; do not remove.
- **JSDoc on every exported function**: purpose + `@param` + `@returns`. Match existing style exactly when adding functions.
- **Naming**: camelCase functions (`classifyTask`, `loadConfig`, `sendBarkNotification`), PascalCase interfaces, single-word/lowercase file names (`notify.ts`, `message.ts`, `config.ts`).
- **Error handling**: expected failures return **discriminated-union result objects**, never throw — `LoadResult: { config } | { config: null, reason }`, `FileLayerResult: { layer } | { disabled }`. Only unexpected SDK rejections propagate, and the hook boundary catches and logs them.
- **Dependency injection**: seams are typed in `src/types/` (`BarkSender`, `ReadFileImpl`, `ConfigSource`) with real implementations as defaults; tests inject plain objects or fakes.
- **Security**: redact the Bark device key from every log line; log server origin without path/query.
- **New types go under `src/types/`** — one file per type.
- **Commits**: conventional commits (`fix:`, `feat:`, …), one commit per logical change.

## Important Files

| File | Role |
|---|---|
| `package.json` | `omp.extensions: ["./hooks/post/bark-notifier.ts"]`; dep `@hoshinorei/bark-sdk` (direct tarball URL, `https://npm.jsr.io/…/0.8.0.tgz`; `files` enumerates shipped sources, excluding the test doubles); devDeps `@oh-my-pi/pi-coding-agent` (ExtensionAPI types), `@types/bun` |
| `tsconfig.json` | Typecheck-only; `types: ["node", "bun"]`, strict, noEmit |
| `hooks/post/bark-notifier.ts` | Entry point / OMP boundary |
| `src/config.ts`, `src/message.ts`, `src/notify.ts` | Core modules |
| `README.md` | Install (`omp install ./omp-bark-notifier` or `omp --hook /abs/path/…/bark-notifier.ts` — must be absolute), config precedence, env vars, templates |
| `docs/superpowers/specs/2026-09-04-omp-bark-notifier-design.md` | Approved design contract (runtime, event contract, classification semantics, non-goals) — local-only, excluded from git |

## Runtime/Tooling Preferences

- **Bun only** (≥ 1.3.14): `bun test`, `bun install`, native TS execution. No Node scripts.
- Package manager: **Bun** (`bun.lock`, text v1).
- Registries: ambient `registry.npmmirror.com`; the Bark SDK dependency resolves from `npm.jsr.io` by direct tarball URL.
- Dev machine is Windows; repo uses LF endings — expect harmless LF→CRLF warnings on edited TS files.
- Per SDD briefs: skip formatters/linters/project-wide suites during implementation.

## Testing & QA

- Framework: **`bun:test`**, run via `bun test`; assertions are `expect`-only (`toBe/toEqual/toMatchObject/toContain/rejects.toThrow`). No vitest/jest.
- Layout: `<unit>.test.ts` per src module — `message.test.ts` (~19 tests, typed event fixtures), `notify.test.ts`, `config.test.ts`; plus:
  - **`zz-hook.test.ts`** — the `zz-` prefix is **deliberate and must be kept** for hook-level suites: it sorts last so its top-level `mock.module()` registrations (shared module registry, filename evaluation order) can't poison sibling suites that bind real modules first. Asserts the two-subscriber contract (`agent_end` + `tool_call`), the ask-notification paths (send, non-ask skip, question-less skip, `statuses`-without-`waiting` skip, missing-config warn), and the subagent-settle paths (non-failed default skip, outcome-only skip, `subagent` opt-in send, main-agent unaffected).
  - **`smoke.test.ts`** — real hook, no mocks: clears `BARK_*` env, redirects `HOME`/`USERPROFILE` to a `mkdtemp` dir, fires both handlers, asserts no throw / no send / key-free warns; env restored in `finally`.
- Mocking tiers: (1) param injection (`makeReadFile()` path→content stub asserting call order), (2) fake sender (`recordingSender()`) and `globalThis.fetch` stub cast `as unknown as typeof fetch` with `afterEach` restore, (3) `mock.module()` for module-boundary isolation with lazy `await import()` in `beforeAll`.
- Test doubles (`HookPiDouble`/`SmokePiDouble` in `src/types/`) are plain objects implementing an ExtensionAPI-like surface (`pi.on` captures handlers by event name into `handlers`, `logger` records warn/error).
- Expectations: each src module has per-file coverage; full suite ~69 tests. Feature work is test-first per the SDD plan (failing tests → implement → focused `bun test` → conventional commit).
