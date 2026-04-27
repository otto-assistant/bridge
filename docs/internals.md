---
title: Internals
description: How Otto works under the hood — SQLite, lock port, channel metadata, voice processing, and more.
---

# Internals

**SQLite Database** — Otto stores state in `<data-dir>/discord-sessions.db` (default: `~/.otto/discord-sessions.db`). This maps Discord threads to OpenCode sessions, channels to directories, and stores your bot credentials. Use `--data-dir` to change the location.

**Lock Port** — Otto enforces single-instance behavior by binding a lock port. By default, the port is derived from `--data-dir`; set `OTTO_LOCK_PORT=<port>` to override it when running an additional Otto process on the same machine.

**OpenCode Servers** — When you message a channel, Otto spawns (or reuses) an OpenCode server for that project directory. The server handles the actual AI coding session.

**Channel Metadata** — Each channel's topic contains XML metadata linking it to a directory and bot:

```xml
<kimaki><directory>/path/to/project</directory><app>bot_id</app></kimaki>
```

**Voice Processing** — Voice features run in a worker thread. Audio flows: Discord Opus > Decoder > Downsample (48kHz to 16kHz) > Gemini API > Response > Upsample > Opus > Discord.

**Log File** — Otto writes logs to `<data-dir>/otto.log` (default: `~/.otto/otto.log`). The log file is reset on every bot startup, so it only contains logs from the current run. Read this file to debug internal issues, session failures, or unexpected behavior.

**Graceful Restart** — Send `SIGUSR2` to restart the bot with new code without losing connections.
