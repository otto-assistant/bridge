# `--no-message` Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--no-message` flag to `kimaki send` that creates a Discord thread where the agent's response is the first visible message — no starter message, no attachment.

**Architecture:** CLI creates thread with invisible starter message, calls opencode SDK directly (session.create + session.promptAsync), registers thread↔session in DB, signals bot via IPC to start event listener. Bot picks up IPC, creates runtime, streams agent response.

**Tech Stack:** TypeScript, opencode SDK, Discord.js REST, Prisma/SQLite IPC, vitest

**Design doc:** `docs/plans/2026-04-09-no-message-design.md`

---

### Task 1: Add `start_thread_listener` IPC type to Prisma schema

**Files:**
- Modify: `cli/schema.prisma` (enum `ipc_request_type`)
- Regenerate: `cli/src/generated/client.ts` (via `pnpm generate`)

**Step 1: Add enum value**

In `cli/schema.prisma`, add `start_thread_listener` to the `ipc_request_type` enum:

```prisma
enum ipc_request_type {
  file_upload
  action_buttons
  start_thread_listener
}
```

**Step 2: Regenerate Prisma client**

```bash
cd cli && pnpm generate
```

Expected: Prisma client regenerated, no errors.

**Step 3: Type-check**

```bash
cd cli && npx tsc --noEmit 2>&1 | grep 'cli/src/' || echo "Clean"
```

Expected: Clean (no new type errors in cli/src/).

**Step 4: Commit**

```bash
git add cli/schema.prisma cli/src/generated/ cli/src/schema.sql
git commit -m "feat: add start_thread_listener IPC type for --no-message"
```

---

### Task 2: Add `--no-message` flag to CLI with validation

**Files:**
- Modify: `cli/src/cli.ts` (send command)

**Step 1: Add flag definition**

Find the `.option('--silent-prompt', ...)` block in the send command and add after it:

```typescript
  .option(
    '--no-message',
    'Create thread without visible prompt message (agent responds first)',
  )
```

**Step 2: Destructure the option**

Find where `silentPrompt` is destructured from options and add `noMessage`:

```typescript
const {
  // ...existing options...
  silentPrompt,
  noMessage,
  // ...
} = options
```

**Step 3: Add validation rules**

Find the existing validation block (where `silentPrompt && notifyOnly` is checked) and add:

```typescript
if (noMessage && notifyOnly) {
  cliLogger.error('Cannot use --no-message with --notify-only')
  process.exit(EXIT_NO_RESTART)
}

if (noMessage && wait) {
  cliLogger.error('Cannot use --no-message with --wait (CLI does not stream responses)')
  process.exit(EXIT_NO_RESTART)
}

if (noMessage && silentPrompt) {
  cliLogger.error('Cannot use --no-message with --silent-prompt (no-message already hides everything)')
  process.exit(EXIT_NO_RESTART)
}

if (noMessage && existingThreadMode) {
  cliLogger.error('Cannot use --no-message with --thread/--session (thread already exists)')
  process.exit(EXIT_NO_RESTART)
}
```

**Step 4: Type-check**

```bash
cd cli && npx tsc --noEmit 2>&1 | grep 'cli/src/' || echo "Clean"
```

**Step 5: Commit**

```bash
git add cli/src/cli.ts
git commit -m "feat: add --no-message flag with validation"
```

---

### Task 3: Implement `--no-message` code path in CLI send command

**Files:**
- Modify: `cli/src/cli.ts` (send command, new branch for noMessage)

**Step 1: Add imports**

At the top of `cli.ts`, add to existing imports:

```typescript
import {
  initializeOpencodeForDirectory,
  buildSessionPermissions,
} from './opencode.js'
import { setThreadSession, createIpcRequest } from './database.js'
import { getOpencodeSystemMessage } from './session-handler/system-message-builder.js'
import { getOpencodePromptContext } from './session-handler/prompt-context.js'
```

Note: Exact import paths may vary — verify actual file locations with `grep -r 'export.*getOpencodeSystemMessage\|export.*getOpencodePromptContext' cli/src/`.

**Step 2: Add the noMessage branch**

Find the main send flow after validation (around the `if (sendAt)` block). Before the existing thread creation logic, add a new branch:

```typescript
if (noMessage) {
  // ── --no-message: CLI creates thread + calls opencode SDK directly ──
  
  const threadName = name || prompt.slice(0, 80).replace(/\n/g, ' ')
  
  // 1. Create invisible starter message
  const starterMessage = await rest.post(Routes.channelMessages(channelId), {
    body: {
      content: '\u200B', // zero-width space
      flags: 4096,       // SUPPRESS_EMBEDS
    },
  }) as { id: string }
  
  // 2. Create thread from starter message
  const threadData = await rest.post(
    Routes.threads(channelId, starterMessage.id),
    {
      body: {
        name: threadName,
        auto_archive_duration: 1440,
      },
    },
  ) as any
  
  const threadId = threadData.id
  
  // 3. Add user to thread (if --user provided)
  if (userId) {
    await rest.put(Routes.threadMembers(threadId, userId))
  }
  
  // 4. Initialize opencode + create session
  const directory = projectDirectory!
  const getClientResult = await initializeOpencodeForDirectory(directory)
  if (getClientResult instanceof Error) {
    cliLogger.error(`Failed to initialize opencode: ${getClientResult.message}`)
    process.exit(EXIT_NO_RESTART)
  }
  const getClient = getClientResult
  
  const sessionPermissions = buildSessionPermissions({ directory })
  const sessionResponse = await getClient().session.create({
    directory,
    permission: sessionPermissions,
  })
  const sessionId = sessionResponse.data.id
  
  // 5. Register thread↔session mapping
  await setThreadSession(threadId, sessionId)
  
  // 6. Build system message and prompt context
  // Minimal context — full context requires channel topic, guild, etc.
  const parts = [{ type: 'text' as const, text: prompt }]
  
  // 7. Send prompt to opencode
  await getClient().session.promptAsync({
    sessionID: sessionId,
    directory,
    parts,
    ...(agent ? { agent } : {}),
  })
  
  // 8. Signal bot to start listener via IPC
  await createIpcRequest({
    type: 'start_thread_listener',
    sessionId,
    threadId,
    payload: JSON.stringify({
      channelId,
      appId: appId || '',
      projectDirectory: directory,
      agent: agent || null,
      model: options.model || null,
    }),
  })
  
  // 9. Delete starter message
  await rest.delete(Routes.channelMessage(channelId, starterMessage.id))
  
  // 10. Print success
  const threadUrl = `https://discord.com/channels/${threadData.guild_id}/${threadId}`
  cliLogger.log(`Thread created (no-message mode): ${threadUrl}`)
  process.exit(0)
}
```

**Step 3: Type-check**

```bash
cd cli && npx tsc --noEmit 2>&1 | grep 'cli/src/' || echo "Clean"
```

May need to adjust import paths and function signatures based on actual exports. Use `grep` to verify.

**Step 4: Commit**

```bash
git add cli/src/cli.ts
git commit -m "feat: implement --no-message CLI→SDK code path"
```

---

### Task 4: Handle `start_thread_listener` IPC in bot

**Files:**
- Modify: `cli/src/ipc-polling.ts` (new case in dispatchRequest switch)
- Modify: `cli/src/session-handler/thread-session-runtime.ts` (new factory)

**Step 1: Add dispatch case in `ipc-polling.ts`**

In the `dispatchRequest` function's switch statement, add a new case before `default`:

```typescript
case 'start_thread_listener': {
  const parsed = errore.try({
    try: () =>
      JSON.parse(req.payload) as {
        channelId: string
        appId: string
        projectDirectory: string
        agent: string | null
        model: string | null
      },
    catch: (e) =>
      new IpcDispatchError({
        requestId: req.id,
        reason: 'Invalid payload JSON',
        cause: e,
      }),
  })
  if (parsed instanceof Error) {
    await completeIpcRequest({
      id: req.id,
      response: JSON.stringify({ error: parsed.message }),
    })
    return parsed
  }

  const thread = await discordClient.channels
    .fetch(req.thread_id)
    .catch(
      (e) =>
        new IpcDispatchError({
          requestId: req.id,
          reason: 'Thread fetch failed',
          cause: e,
        }),
    )
  if (thread instanceof Error || !thread?.isThread()) {
    await completeIpcRequest({
      id: req.id,
      response: JSON.stringify({ error: 'Thread not found' }),
    })
    return thread instanceof Error ? thread : new IpcDispatchError({
      requestId: req.id,
      reason: 'Channel is not a thread',
    })
  }

  // Create runtime for this thread and start event listener.
  // The session already exists (created by CLI) — just subscribe to events.
  try {
    const { getOrCreateRuntime } = await import('./discord-bot.js')
    const runtime = await getOrCreateRuntime({
      threadId: req.thread_id,
      thread,
      projectDirectory: parsed.projectDirectory,
      sdkDirectory: parsed.projectDirectory,
      channelId: parsed.channelId,
      appId: parsed.appId,
    })
    // Start listening for opencode events (agent response streaming)
    void runtime.startEventListener()
    
    await completeIpcRequest({
      id: req.id,
      response: JSON.stringify({ ok: true }),
    })
  } catch (e) {
    await completeIpcRequest({
      id: req.id,
      response: JSON.stringify({
        error: e instanceof Error ? e.message : 'Failed to start listener',
      }),
    })
    return new IpcDispatchError({
      requestId: req.id,
      reason: 'Runtime creation failed',
      cause: e,
    })
  }
  return
}
```

**Note:** `getOrCreateRuntime` is currently a local function in `discord-bot.ts`. It needs to be exported, or the IPC handler needs a different way to access the runtime map. Check the actual export structure and adjust.

**Step 2: Export `getOrCreateRuntime` from `discord-bot.ts`** (if not already exported)

Find `getOrCreateRuntime` or equivalent function in `discord-bot.ts` and ensure it's exported. If it captures local state (runtimes Map), export a wrapper function instead:

```typescript
export async function createRuntimeForIpcThread(opts: {
  threadId: string
  thread: ThreadChannel
  projectDirectory: string
  channelId: string
  appId: string
}) {
  return getOrCreateRuntime({
    threadId: opts.threadId,
    thread: opts.thread,
    projectDirectory: opts.projectDirectory,
    sdkDirectory: opts.projectDirectory,
    channelId: opts.channelId,
    appId: opts.appId,
  })
}
```

**Step 3: Type-check**

```bash
cd cli && npx tsc --noEmit 2>&1 | grep 'cli/src/' || echo "Clean"
```

**Step 4: Commit**

```bash
git add cli/src/ipc-polling.ts cli/src/discord-bot.ts
git commit -m "feat: handle start_thread_listener IPC in bot"
```

---

### Task 5: Add `noMessage` to scheduled task payload

**Files:**
- Modify: `cli/src/task-schedule.ts` (payload type + parser)
- Modify: `cli/src/task-runner.ts` (executeChannelScheduledTask)

**Step 1: Update payload type in `task-schedule.ts`**

In the `channel` kind of `ScheduledTaskPayload`, add:

```typescript
noMessage: boolean
```

**Step 2: Update parser**

In `parseScheduledTaskPayload` for the `channel` kind, add:

```typescript
const noMessage = parsed.noMessage === true
```

And include `noMessage` in the returned object.

**Step 3: Update task runner**

In `executeChannelScheduledTask` in `task-runner.ts`, check `payload.noMessage`. If true, use the same CLI→SDK flow as the immediate send (factor out a shared function or duplicate the logic).

For the first iteration, scheduled tasks with `--no-message` can post a minimal message with zero-width space (simpler than the CLI→SDK path) and mark a `TODO` for full SDK integration.

**Step 4: Pass `noMessage` from CLI**

In `cli.ts`, where the scheduled task payload is built, add:

```typescript
noMessage: Boolean(noMessage),
```

**Step 5: Type-check**

```bash
cd cli && npx tsc --noEmit 2>&1 | grep 'cli/src/' || echo "Clean"
```

**Step 6: Commit**

```bash
git add cli/src/task-schedule.ts cli/src/task-runner.ts cli/src/cli.ts
git commit -m "feat: add noMessage to scheduled task payload"
```

---

### Task 6: Manual integration test

**Step 1: Build and install globally**

```bash
cd cli && pnpm generate && npx tsc
sudo npm install -g /data/projects/bridge/cli --prefix /usr
```

**Step 2: Test --no-message with --user**

```bash
kimaki send --channel 1489141474737262643 --no-message --user "SerhiiD" --name "No message test" --prompt "Напиши 'test OK' і все."
```

Expected:
- New thread created in #otto channel
- User added to thread (visible in sidebar)
- No starter message with prompt text
- Agent response is first visible message

**Step 3: Test incompatible flag combinations**

```bash
kimaki send --channel 1489141474737262643 --no-message --notify-only -p "test"
# Expected: error "Cannot use --no-message with --notify-only"

kimaki send --channel 1489141474737262643 --no-message --wait -p "test"
# Expected: error "Cannot use --no-message with --wait"
```

**Step 4: Commit**

```bash
git add -A
git commit -m "test: manual integration test for --no-message"
```

---

### Task 7: Update documentation

**Files:**
- Modify: `OTTO_AGENTS.md` (add --no-message to features table)
- Modify: `cli/src/system-message.ts` (add --no-message to system prompt docs)
- Modify: `cli/src/system-message.test.ts` (snapshot update)

**Step 1: Update OTTO_AGENTS.md features table**

Add new row:

```markdown
| `--no-message` | `feat/silent-prompt` | cli.ts, ipc-polling.ts, task-schedule.ts, task-runner.ts | CLI calls opencode SDK directly, agent responds first in thread |
```

**Step 2: Update system message docs**

In `system-message.ts`, find the `--send-at` options list and add:

```markdown
- `--no-message` to create a thread where the agent's response is the first visible message (no starter message with prompt text)
```

**Step 3: Update snapshot**

```bash
cd cli && pnpm test -u --run
```

**Step 4: Commit**

```bash
git add OTTO_AGENTS.md cli/src/system-message.ts cli/src/system-message.test.ts
git commit -m "docs: add --no-message to documentation and system prompt"
```
