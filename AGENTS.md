# OpenCode Mobile - AGENTS.md

## Overview

Standalone React Native / Expo mobile client for opencode. Connects to an opencode server instance via HTTP + SSE for real-time updates. No dependency on any `@opencode-ai/*` npm packages — the SDK client is hand-rolled in `src/lib/sdk.ts`.

## Upstream Reference

The opencode server lives at https://github.com/anomalyco/opencode

Key files to reference when debugging API or event issues:

| What                  | Upstream Path                              | Why                                                                                    |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| API route definitions | `packages/opencode/src/server/`            | All HTTP endpoints the mobile SDK calls                                                |
| SSE event types       | `packages/opencode/src/session/`           | Event payloads for `session.status`, `message.*`, `permission.*`, `question.*`         |
| Permission handling   | `packages/opencode/src/permission/`        | Server-side permission ask/reply lifecycle                                             |
| Question handling     | `packages/opencode/src/question/`          | Server-side question ask/reply/reject lifecycle                                        |
| Session lifecycle     | `packages/opencode/src/session/session.ts` | Busy/idle transitions, abort, error states                                             |
| SDK (published)       | `packages/sdk/`                            | Published `@opencode-ai/sdk` — we don't use this, but useful for comparing type shapes |

### API Endpoints Used by Mobile

| Endpoint                    | Method    | Mobile SDK method              | Notes                                         |
| --------------------------- | --------- | ------------------------------ | --------------------------------------------- |
| `/global/health`            | GET       | `global.health()`              | Not in published SDK                          |
| `/global/event`             | GET (SSE) | `global.events(signal)`        | Uses `expo/fetch` for ReadableStream          |
| `/session`                  | GET       | `session.list(params)`         | Supports `?roots=true&limit=N`                |
| `/session`                  | POST      | `session.create(params)`       |                                               |
| `/session/:id`              | GET       | `session.get(id)`              |                                               |
| `/session/:id`              | PATCH     | `session.update(id, params)`   |                                               |
| `/session/:id`              | DELETE    | `session.delete(id)`           |                                               |
| `/session/:id/message`      | GET       | `session.messages(id, params)` | Supports `?limit=N`                           |
| `/session/:id/prompt_async` | POST      | `session.prompt(id, params)`   | Fire-and-forget; SSE drives updates           |
| `/session/:id/command`      | POST      | `session.command(id, params)`  | Slash commands                                |
| `/session/:id/abort`        | POST      | `session.abort(id)`            |                                               |
| `/session/:id/diff`         | GET       | `session.diff(id, messageID)`  |                                               |
| `/permission`               | GET       | `permission.list()`            | All pending permissions                       |
| `/permission/:id/reply`     | POST      | `permission.reply(id, reply)`  | Body: `{ reply: "once"\|"always"\|"reject" }` |
| `/question`                 | GET       | `question.list()`              | All pending questions                         |
| `/question/:id/reply`       | POST      | `question.reply(id, answers)`  | Body: `{ answers: string[][] }`               |
| `/question/:id/reject`      | POST      | `question.reject(id)`          |                                               |
| `/agent`                    | GET       | `agent.list()`                 |                                               |
| `/command`                  | GET       | `command.list()`               |                                               |
| `/provider`                 | GET       | `provider.list()`              | Includes model limits for context %           |
| `/config`                   | GET       | `config.get()`                 |                                               |
| `/project`                  | GET       | `project.list()`               |                                               |
| `/project/current`          | GET       | `project.current()`            |                                               |
| `/path`                     | GET       | `path.get()`                   |                                               |

### SSE Event Types

All events come through `/global/event`. The mobile app handles:

| Event                  | Payload                                                  | Mobile Behavior                                       |
| ---------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| `session.status`       | `{ sessionID, status: {type: "idle"\|"busy"\|"retry"} }` | Updates status indicator, clears sending flag on idle |
| `session.created`      | `{ info: Session }`                                      | Adds to session list                                  |
| `session.updated`      | `{ info: Session }`                                      | Updates session metadata (title, etc.)                |
| `session.error`        | `{ sessionID, error: {message} }`                        | Shows error, clears sending, fires notification       |
| `message.updated`      | `{ info: Message }`                                      | Replaces optimistic temp messages with real ones      |
| `message.part.updated` | `{ part: Part }`                                         | Live streaming of assistant output                    |
| `message.removed`      | `{ messageID }`                                          | Removes from UI (compaction)                          |
| `permission.asked`     | `{ id, sessionID, permission, patterns[], metadata }`    | Shows permission prompt, fires notification           |
| `permission.replied`   | `{ sessionID, requestID }`                               | Removes from pending                                  |
| `question.asked`       | `{ id, sessionID, questions[] }`                         | Shows question prompt, fires notification             |
| `question.replied`     | `{ sessionID, requestID }`                               | Removes from pending                                  |
| `question.rejected`    | `{ sessionID, requestID }`                               | Removes from pending                                  |

## Architecture

```
├── app/                    # Expo Router file-based routing
│   ├── (tabs)/             # Tab navigation (sessions, connections, settings)
│   ├── session/[id].tsx    # Chat screen
│   └── connection/         # Add/edit connection screens
├── src/
│   ├── components/         # Reusable UI components
│   │   ├── chat/           # Message bubble, prompts, status, session info
│   │   ├── markdown/       # Markdown renderer (wraps react-native-marked)
│   │   └── AuthGate.tsx    # Biometric auth gate
│   ├── lib/
│   │   ├── sdk.ts          # HTTP + SSE client for opencode server API
│   │   ├── types.ts        # Connection and settings types
│   │   ├── notifications.ts # Local notification system (category-based)
│   │   └── speech.ts       # Voice-to-text hook (expo-speech-recognition)
│   └── stores/             # Zustand state stores
│       ├── sessions.ts     # Session list, messages, parts, per-session sending state
│       ├── connections.ts  # Server connections, client lifecycle
│       ├── events.ts       # SSE event stream, status tracking, permissions, questions
│       ├── catalog.ts      # Agents, providers, commands, model selection
│       ├── settings.ts     # Persisted preferences (page size, notification categories)
│       └── auth.ts         # Biometric auth
```

## Key Patterns

- **SSE for real-time**: The `events.ts` store connects to `/global/event` and dispatches to other stores
- **SSE is source of truth**: `sessionStatus` from SSE always wins over optimistic `sending` flags
- **Per-session sending**: `sending: Record<string, boolean>` — not global, tracks each session independently
- **Optimistic removal with rollback**: Permission/question replies optimistically remove the prompt; on API failure, the snapshot is restored and an alert shown
- **Pending refetch on session entry**: `refreshPending()` calls `permission.list()` + `question.list()` when entering a session to recover missed SSE events
- **Fire-and-forget sends**: `sendMessage` posts to the API but doesn't await response; SSE events drive all UI updates
- **expo/fetch for SSE**: Must use `import { fetch as expoFetch } from "expo/fetch"` for SSE streaming — RN's default fetch doesn't support ReadableStream
- **Notification categories**: 4 independently togglable categories (permissions, questions, completed, errors) with no hardcoded strings — all driven from `categoryMeta` in `notifications.ts`
- **Dependency injection for notifications**: `notifications.configure(accessor)` avoids circular imports between notifications and settings store

## Style Guide

- Prefer `const` over `let`
- Avoid `else` statements, use early returns
- Prefer single-word variable names
- Avoid `try/catch` where possible
- Avoid `any` type
- Use Bun APIs where applicable (for scripts, not in RN runtime)

## Running

```bash
bun install
bun start        # Expo dev server
bun run ios      # iOS simulator (needs dev build for notifications/speech)
bun run android  # Android emulator
```

## Connecting

Run `opencode serve --hostname 0.0.0.0 --port 4096` on your machine, then add a connection in the app with your machine's local IP and port 4096.

## Dev Build (for full native features)

Notifications and speech recognition require a development build (not Expo Go):

```bash
npx expo install expo-dev-client
npx expo prebuild
npx expo run:ios        # Build and run on connected device
```
