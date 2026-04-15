# Session learnings: silent-prompt agent-first flow

Date: 2026-04-15
Branch: feat/silent-prompt

## Important discoveries

1. `--silent-prompt` with attachment-only starter message still leaks prompt metadata in Discord and does not satisfy fully silent UX.
2. Fully silent behavior requires agent-first startup: create invisible starter message, create thread, enqueue prompt via SDK, start listener via IPC, then delete starter message.
3. The IPC type `start_thread_listener` must be handled in `cli/src/ipc-polling.ts`; otherwise the bot never streams responses for agent-first threads.
4. In agent-first CLI flows, process-exit cleanup can kill the shared opencode server before Discord delivery. Guard this with `KIMAKI_SKIP_OPENCODE_PROCESS_CLEANUP=1` for the CLI handoff path.
5. On this host, making the fork default required replacing `/usr/bin/kimaki` with a symlink to `/data/projects/bridge/cli/bin.js` and restarting the bot.

## Verification checklist used

- `cd cli && npx tsc --noEmit`
- `cd cli && npx vitest run src/system-message.test.ts src/task-schedule.test.ts`
- Runtime smoke: `kimaki send --silent-prompt ...` and confirm thread creation + IPC listener startup in `~/.kimaki/kimaki.log`.
