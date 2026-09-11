# OMP Bark Notifier

[![npm version](https://img.shields.io/npm/v/omp-bark-notifier)](https://www.npmjs.com/package/omp-bark-notifier)

An installable OMP hook that sends one Bark push to your devices when an OMP agent task settles — with a distinct notification for `completed`, `failed`, and `aborted` outcomes. One task yields at most one push. When the task blocks on an `ask` question, the hook sends a separate "waiting for your input" push.

## Requirements

- Bun 1.3.14 or newer
- An OMP workspace
- A Bark server URL and the device key of the target device

## Installation

Install from npm:

```bash
omp install omp-bark-notifier
```

Or point OMP at the hook file directly (the path must be absolute):

```bash
omp --hook /absolute/path/to/omp-bark-notifier/hooks/post/bark-notifier.ts
```

## Configuration

Settings are read from, lowest to highest precedence:

1. Built-in defaults
2. User file — `~/.omp/bark-notifier.json`
3. Project file — `<cwd>/.omp/bark-notifier.json`
4. Environment variables

`serverUrl` and `key` are required. If either is missing, the hook logs a warning and sends nothing.

### Configuration files

`~/.omp/bark-notifier.json`:

```json
{
  "serverUrl": "https://bark.example.com",
  "key": "your-bark-device-key",
  "group": "personal",
  "titleTemplate": "OMP task {status}",
  "bodyTemplate": "{message}\n\nProject: {cwd}",
  "askTitleTemplate": "OMP task waiting for your input",
  "askBodyTemplate": "{message}\n\nProject: {cwd}",
  "statuses": ["completed", "failed", "waiting", "subagent:failed"]
}
```

A project-level `.omp/bark-notifier.json` in the session directory uses the same shape and overrides the user file.

### Environment variables

```bash
export BARK_SERVER_URL="https://bark.example.com"
export BARK_KEY="your-bark-device-key"
export BARK_GROUP="personal"
export BARK_TITLE_TEMPLATE="OMP task {status}"
export BARK_BODY_TEMPLATE="{message}\n\nProject: {cwd}"
export BARK_ASK_TITLE_TEMPLATE="OMP task waiting for your input"
export BARK_ASK_BODY_TEMPLATE="{message}\n\nProject: {cwd}"
export BARK_STATUSES="completed,failed,waiting,subagent:failed"
```

### Supported settings

| Setting | JSON key | Environment variable | Required |
| --- | --- | --- | --- |
| Bark server URL | `serverUrl` | `BARK_SERVER_URL` | yes |
| Device key | `key` | `BARK_KEY` | yes |
| Notification group | `group` | `BARK_GROUP` | no |
| Title template | `titleTemplate` | `BARK_TITLE_TEMPLATE` | no |
| Body template | `bodyTemplate` | `BARK_BODY_TEMPLATE` | no |
| Ask title template | `askTitleTemplate` | `BARK_ASK_TITLE_TEMPLATE` | no |
| Ask body template | `askBodyTemplate` | `BARK_ASK_BODY_TEMPLATE` | no |
| Notified statuses | `statuses` | `BARK_STATUSES` | no |

### Templates

Templates can use the variables `{status}`, `{cwd}`, and `{message}`. Unknown placeholders such as `{unknown}` are left as-is so mistakes stay visible.

Defaults:

- Title template: `OMP task {status}`
- Body template: `{message}\n\nProject: {cwd}`
- Ask title template: `OMP task waiting for your input`
- Ask body template: `{message}\n\nProject: {cwd}`

`statuses` filters which pushes fire. Allowed values: `completed`, `failed`, `aborted`, `waiting`, `subagent`, and `subagent:completed` / `subagent:failed` / `subagent:aborted` (comma-separated in `BARK_STATUSES`). The default is `["completed", "failed", "waiting", "subagent:failed"]`; `aborted` is opt-in because the person who cancelled already knows. An empty list means no pushes at all.

| Variable | Meaning |
| --- | --- |
| `{status}` | `completed`, `failed`, `aborted`, or `waiting` (ask notifications); a subagent push shows the subagent's real outcome |
| `{cwd}` | The session working directory |
| `{message}` | The latest assistant message text, or a fallback like `Agent task completed`; for ask notifications, the question text |

> **Security: never commit `key`.** Keep it in the `BARK_KEY` environment variable or in a config file that is not committed. The hook never logs the key.

## What gets notified

The final assistant message of the settled task maps to one status:

| Status | Condition |
| --- | --- |
| `completed` | No failure or abort marker on the final assistant message |
| `failed` | An explicit error stop reason or non-empty error message |
| `aborted` | An explicit abort/cancellation stop reason |

- At most one push per task settle; each `ask` wait sends at most one `waiting` push.
- Only the statuses listed in `statuses` notify. Failed subagent settles are included by default; other subagent outcomes are silent unless opted in.
- `turn_end` and tool events (except `ask`) never notify; automatic continuations don't notify until the task really ends.
- Bark delivery failures never affect the task outcome — the hook logs the error and never throws.
