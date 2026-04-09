# Design: `--no-message` — Agent Responds First

**Date**: 2026-04-09  
**Branch**: `feat/no-message` (from `feat/silent-prompt`)  
**Status**: Approved

## Problem

When `kimaki send` creates a new thread, it posts a **starter message** containing the prompt text (or `» **Scheduled task**` with `--silent-prompt` + `prompt.md` attachment). The user wants the agent's response to be the **first visible message** in the thread — no starter message, no attachment.

## Current Flow

```
kimaki send → posts Discord message (with embed marker)
           → creates thread from message
           → bot ThreadCreate handler picks up
           → parses embed marker → enqueueIncoming()
           → ensureSession() → session.create() + session.promptAsync()
           → agent response streamed to thread
```

The CLI **never calls opencode SDK** — it only posts Discord messages and relies on the bot to handle everything.

## Proposed Flow

```
kimaki send --no-message --channel <id> "prompt"
│
├─ 1. CLI creates Discord thread (starter message = "\u200B", suppress embeds)
│
├─ 2. CLI calls opencode SDK directly:
│     initializeOpencodeForDirectory(directory)
│     → getClient().session.create({ directory, permission })
│     → getClient().session.promptAsync({ sessionID, parts, system, model, agent })
│
├─ 3. CLI registers thread↔session mapping:
│     setThreadSession(threadId, sessionId)
│
├─ 4. CLI signals bot via IPC (ipc_requests table):
│     type: 'start_thread_listener'
│     body: { threadId, sessionId, channelId, appId }
│
└─ 5. Bot picks up IPC → creates ThreadSessionRuntime for threadId
      → startEventListener() subscribes to opencode SSE
      → streams agent response to Discord thread
```

The agent's response becomes the first visible message in the thread.

## Key Design Decisions

### Why CLI calls SDK directly (not through bot)

1. **Bot cannot create thread without starter message** — Discord REST API requires content for `startThread`. CLI already has REST access.
2. **Session creation is fast** — opencode SDK calls take <1s. No need to proxy through bot.
3. **Separation of concerns** — CLI owns thread creation + session bootstrap; bot owns event streaming + message relay.

### Why IPC for handoff (not DB polling)

The bot already polls `ipc_requests` table every few seconds for file uploads. Adding a new IPC type (`start_thread_listener`) reuses this mechanism with zero new infrastructure.

### Why `--no-message` (not modifying `--silent-prompt`)

- `--silent-prompt` hides text but shows attachment — different goal.
- `--no-message` eliminates the visible message entirely — orthogonal feature.
- Both can be used independently. `--no-message` implies no visible prompt, making `--silent-prompt` redundant when combined.

## New IPC Type

```typescript
// Added to existing IPC dispatch in ipc-polling.ts
type IpcStartThreadListener = {
  type: 'start_thread_listener'
  threadId: string
  sessionId: string
  channelId: string
  appId: string
  projectDirectory: string
}
```

The bot's IPC polling loop handles this type by:
1. Looking up the Discord thread by `threadId`
2. Creating a `ThreadSessionRuntime` (new factory method)
3. Calling `startEventListener()` — which subscribes to opencode SSE for that session
4. The runtime streams agent output to the thread as usual

## Thread Creation Details

Discord requires a starter message to create a thread. The minimal viable approach:

```typescript
// Post invisible starter message
const msg = await rest.post(Routes.channelMessages(channelId), {
  body: {
    content: '\u200B',  // zero-width space
    flags: 4096,         // SUPPRESS_EMBEDS — hide from chat
  }
})

// Create thread from that message
const thread = await rest.post(Routes.threads(channelId, msg.id), {
  body: { name: threadName, auto_archive_duration: 1440 }
})
```

The zero-width space + `SUPPRESS_EMBEDS` flag makes the starter message nearly invisible. Discord clients show an empty message that collapses visually.

### Alternative: Delete starter message after session starts

After `session.promptAsync()` succeeds, CLI could delete the starter message:

```typescript
await rest.delete(Routes.channelMessage(channelId, starterMessage.id))
```

This removes it entirely. Some Discord clients may show a brief "deleted message" flash. We'll implement this as the default behavior for `--no-message`.

## CLI Implementation

### New code path in `cli.ts` (send command)

When `--no-message` is set:

```
1. Resolve channel + project directory (same as current)
2. Create thread via REST (zero-width space + SUPPRESS_EMBEDS)
3. Add user to thread (if --user provided)
4. Call opencode SDK:
   a. initializeOpencodeForDirectory(directory)
   b. session.create({ directory, permission })
   c. session.promptAsync({ sessionID, parts, system, model, agent })
5. setThreadSession(threadId, sessionId) in DB
6. Insert IPC request: start_thread_listener
7. Delete starter message via REST
8. Print success + thread URL
```

### System message construction

CLI must build the system message and prompt context that the bot normally builds. This includes:
- `getOpencodeSystemMessage()` — session metadata, channel info, guild info
- `getOpencodePromptContext()` — username, thread ID, worktree info

These functions are in `session-handler/` modules. CLI will import them directly (same process, same package).

### Session permissions

CLI calls `buildSessionPermissions({ directory, originalRepoDirectory })` (already exported from `opencode.ts`) to construct the same permission rules the bot uses.

## Files Changed

| File | Change |
|------|--------|
| `cli/src/cli.ts` | New `--no-message` flag + CLI→SDK code path in send command |
| `cli/src/ipc-polling.ts` | Handle `start_thread_listener` IPC type → create runtime + listener |
| `cli/src/session-handler/thread-session-runtime.ts` | New factory `createFromIpc()` — creates runtime without enqueueIncoming |
| `cli/src/task-runner.ts` | Support `--no-message` for scheduled tasks (same CLI→SDK flow) |
| `cli/src/task-schedule.ts` | Add `noMessage: boolean` to payload types + parser |

## Compatibility

| Flag combination | Valid? | Behavior |
|------------------|--------|----------|
| `--no-message` alone | Yes | Agent responds first, no visible prompt |
| `--no-message --send-at` | Yes | Scheduled task with no visible prompt |
| `--no-message --user` | Yes | User added to thread, agent responds first |
| `--no-message --agent build` | Yes | Uses specified agent |
| `--no-message --worktree` | Yes | Creates worktree, agent responds first |
| `--no-message --notify-only` | **Error** | Incompatible — notify-only has no session |
| `--no-message --wait` | **Error** | CLI can't wait — it doesn't stream responses |
| `--no-message --silent-prompt` | **Error** | Redundant — no-message already hides everything |
| `--no-message --thread` | **Error** | Thread already exists, can't control starter message |

## Open Questions

- **Race condition**: What if the agent responds before the bot starts listening? Opencode buffers events — the listener will receive historical events on connect. No data loss.
- **Error handling**: If `session.promptAsync` fails in CLI, we should post an error message to the thread so the user sees it.
- **System message**: CLI needs channel topic, guild ID, etc. for the full system message. It has bot token + REST access, so it can fetch these via API.
