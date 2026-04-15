# Session learnings: silent-prompt agent-first flow

Date: 2026-04-15
Branch: feat/silent-prompt

## Important discoveries

1. `--silent-prompt` with attachment-only starter message still leaks prompt metadata in Discord (shows `prompt.md` attachment block with filename, file size, and YAML marker). This does not satisfy fully silent UX.
2. Fully silent behavior requires **agent-first startup**: post an invisible Discord message (just the marker embed, no content, no attachment), create thread, enqueue prompt via SDK, create IPC `start_thread_listener` request, then delete the starter message. The bot's IPC polling picks up the request within 200ms and streams the response directly to the thread.
3. The IPC type `start_thread_listener` must be handled in `cli/src/ipc-polling.ts`; otherwise the bot never streams responses for agent-first threads.
4. In agent-first CLI flows, process-exit cleanup can kill the shared opencode server before Discord delivery. Guard this with `KIMAKI_SKIP_OPENCODE_PROCESS_CLEANUP=1` for the CLI handoff path. Always use try/finally to restore the env var.
5. On this host, making the fork default required replacing `/usr/bin/kimaki` with a symlink to `/data/projects/bridge/cli/bin.js` and restarting the bot.
6. **Scheduled task silent path** (`task-runner.ts`): the old code used `postMessageWithPromptAttachment` which showed the attachment metadata. The fix applies the same agent-first approach as `cli.ts` for `silentPrompt: true`: initialize opencode session, queue prompt, post invisible starter, create thread, delete starter, set thread-session mapping, create IPC request. Works for both `kind: "channel"` (new thread) and `kind: "thread"` (existing thread) tasks.
7. **IPC polling interval**: 200ms (from `startIpcPolling` in `ipc-polling.ts`). The IPC request is picked up almost immediately.
8. **`getBotTokenWithMode()`** from `database.ts` provides `appId` needed for the IPC `start_thread_listener` payload. It queries the database (not Discord API), so it's safe to call before the Discord client is ready.

## Verification checklist used

- `cd cli && npx tsc --noEmit`
- `cd cli && npx vitest run src/system-message.test.ts src/task-schedule.test.ts`
- Runtime smoke: `kimaki send --silent-prompt ...` and confirm thread creation + IPC listener startup in `~/.kimaki/kimaki.log`.
- For scheduled tasks: schedule a test task with `kimaki send --send-at <time> --silent-prompt ...` and verify the Discord thread shows no user message or attachment.
