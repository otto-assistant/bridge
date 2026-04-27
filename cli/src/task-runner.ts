// Scheduled task runner for executing due `send --send-at` jobs in the bot process.

import { Client, type REST, Routes } from "discord.js";
import { createDiscordRest } from "./discord-urls.js";
import YAML from "yaml";
import {
  claimScheduledTaskRunning,
  createIpcRequest,
  getIpcRequestById,
  getBotTokenWithMode,
  getDuePlannedScheduledTasks,
  markScheduledTaskCronRescheduled,
  markScheduledTaskCronRetry,
  markScheduledTaskFailed,
  markScheduledTaskOneShotCompleted,
  recoverStaleRunningScheduledTasks,
  setThreadSession,
  getAllTextChannelDirectories,
  type ScheduledTask,
} from "./database.js";
import { createLogger, formatErrorWithStack, LogPrefix } from "./logger.js";
import {
  buildSessionPermissions,
  initializeOpencodeForDirectory,
} from "./opencode.js";
import { notifyError } from "./sentry.js";
import type { ThreadStartMarker } from "./system-message.js";
import {
  type ScheduledTaskPayload,
  getNextCronRun,
  getPromptPreview,
  parseScheduledTaskPayload,
} from "./task-schedule.js";

const taskLogger = createLogger(LogPrefix.TASK);

async function waitForIpcRequestCompletion({
  requestId,
  timeoutMs = 4_000,
  pollMs = 100,
}: {
  requestId: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<true | Error> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const row = await getIpcRequestById({ id: requestId });
    if (row?.status === "completed") {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, pollMs);
    });
  }
  return new Error(`Timed out waiting for IPC request ${requestId} completion`);
}

type StartTaskRunnerOptions = {
  token: string;
  discordClient?: Client;
  pollIntervalMs?: number;
  staleRunningMs?: number;
  dueBatchSize?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMessageId(value: unknown): string | Error {
  if (!isRecord(value)) {
    return new Error("Discord response is not an object");
  }
  if (typeof value.id !== "string") {
    return new Error("Discord response is missing message ID");
  }
  return value.id;
}

async function executeThreadScheduledTask({
  rest,
  task,
  payload,
}: {
  rest: REST;
  task: ScheduledTask;
  payload: Extract<ScheduledTaskPayload, { kind: "thread" }>;
}): Promise<void | Error> {
  const marker: ThreadStartMarker = {
    start: true,
    scheduledKind: task.schedule_kind,
    scheduledTaskId: task.id,
    ...(payload.agent ? { agent: payload.agent } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.username ? { username: payload.username } : {}),
    ...(payload.userId ? { userId: payload.userId } : {}),
    ...(payload.permissions?.length
      ? { permissions: payload.permissions }
      : {}),
    ...(payload.injectionGuardPatterns?.length
      ? { injectionGuardPatterns: payload.injectionGuardPatterns }
      : {}),
  };
  const embed = [{ color: 0x2b2d31, footer: { text: YAML.stringify(marker) } }];
  // Newline between prefix and prompt so leading /command detection can
  // find the command on its own line.
  const prefixedPrompt = `» **kimaki-cli:**\n${payload.prompt}`;

  // Agent-first path for silent mode: initialize opencode directly and IPC the response
  if (payload.silentPrompt) {
    const botRow = await getBotTokenWithMode();
    const appId = botRow?.appId;
    if (!appId) {
      return new Error(`Cannot get bot appId for task ${task.id}`);
    }

    const projectDirectory =
      task.project_directory || `/home/ubuntu/.kimaki/projects/general`;

    const prevCleanup = process.env.KIMAKI_SKIP_OPENCODE_PROCESS_CLEANUP;
    process.env.KIMAKI_SKIP_OPENCODE_PROCESS_CLEANUP = "1";

    try {
      const getClient = await initializeOpencodeForDirectory(projectDirectory);
      if (getClient instanceof Error) {
        return new Error(`Failed to initialize opencode for task ${task.id}`, {
          cause: getClient,
        });
      }

      const registeredProjectDirs = await getAllTextChannelDirectories()
      const created = await getClient().session.create({
        directory: projectDirectory,
        permission: buildSessionPermissions({ directory: projectDirectory, extraAllowedDirectories: registeredProjectDirs }),
      });
      const sessionId = created.data?.id;
      if (!sessionId) {
        return new Error(
          `Failed to create opencode session for task ${task.id}`,
        );
      }

      // Post invisible starter with marker embed, then delete it
      const starterResult = await rest
        .post(Routes.channelMessages(payload.threadId), {
          body: { content: "", embeds: embed },
        })
        .catch((e) => {
          return new Error(`Failed to post starter for task ${task.id}`, {
            cause: e,
          });
        });
      if (starterResult instanceof Error) return starterResult;

      const starterId = parseMessageId(starterResult);
      if (starterId instanceof Error) return starterId;

      // Keep starter message to preserve valid thread-first message in Discord UI.

      // Persist thread -> session and IPC so bot streams the response
      await setThreadSession(payload.threadId, sessionId);
      const ipcRow = await createIpcRequest({
        type: "start_thread_listener",
        sessionId,
        threadId: payload.threadId,
        payload: JSON.stringify({
          channelId: payload.threadId,
          appId,
          projectDirectory,
        }),
      });

      const ipcReady = await waitForIpcRequestCompletion({
        requestId: ipcRow.id,
      });
      if (ipcReady instanceof Error) {
        return ipcReady;
      }

      // Submit prompt AFTER listener IPC request is created so short/fast
      // model responses are not missed before subscription is active.
      await getClient().session.promptAsync({
        sessionID: sessionId,
        directory: projectDirectory,
        parts: [{ type: "text" as const, text: payload.prompt }],
        ...(payload.agent ? { agent: payload.agent } : {}),
      });

      taskLogger.log(
        `[task ${task.id}] Agent-first thread session started (thread=${payload.threadId}, session=${sessionId})`,
      );
    } finally {
      if (prevCleanup === undefined) {
        delete process.env.KIMAKI_SKIP_OPENCODE_PROCESS_CLEANUP;
      } else {
        process.env.KIMAKI_SKIP_OPENCODE_PROCESS_CLEANUP = prevCleanup;
      }
    }

    return;
  }

  // Non-silent path: post prompt visibly
  const postResult = await rest
    .post(Routes.channelMessages(payload.threadId), {
      body: {
        content: prefixedPrompt,
        embeds: embed,
      },
    })
    .catch((error) => {
      return new Error(`Failed to post scheduled thread task ${task.id}`, {
        cause: error,
      });
    });

  if (postResult instanceof Error) {
    return postResult;
  }
}

async function executeChannelScheduledTask({
  rest,
  discordClient,
  task,
  payload,
}: {
  rest: REST;
  discordClient?: Client;
  task: ScheduledTask;
  payload: Extract<ScheduledTaskPayload, { kind: "channel" }>;
}): Promise<void | Error> {
  const marker: ThreadStartMarker | undefined = payload.notifyOnly
    ? undefined
    : {
        start: true,
        scheduledKind: task.schedule_kind,
        scheduledTaskId: task.id,
        ...(payload.worktreeName ? { worktree: payload.worktreeName } : {}),
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
        ...(payload.agent ? { agent: payload.agent } : {}),
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.username ? { username: payload.username } : {}),
        ...(payload.userId ? { userId: payload.userId } : {}),
        ...(payload.permissions?.length
          ? { permissions: payload.permissions }
          : {}),
        ...(payload.injectionGuardPatterns?.length
          ? { injectionGuardPatterns: payload.injectionGuardPatterns }
          : {}),
      };
  const embeds = marker
    ? [{ color: 0x2b2d31, footer: { text: YAML.stringify(marker) } }]
    : undefined;

  const threadName = (payload.name || getPromptPreview(payload.prompt)).slice(
    0,
    100,
  );

  /**
   * Agent-first path (silent, non-notify): the opencode session is created
   * here and the prompt is submitted via SDK. No Discord message shows the
   * user's prompt — the bot's IPC listener streams the response directly.
   */
  if (payload.silentPrompt && !payload.notifyOnly) {
    // 1. Get bot appId from stored credentials and project directory from task
    const botRow = await getBotTokenWithMode();
    const appId = botRow?.appId;
    if (!appId) {
      return new Error(`Cannot get bot appId for task ${task.id}`);
    }

    const projectDirectory =
      task.project_directory || `/home/ubuntu/.kimaki/projects/general`;

    // 2. Prevent CLI exit from killing the opencode server we are about to start
    const prevCleanup = process.env.KIMAKI_SKIP_OPENCODE_PROCESS_CLEANUP;
    process.env.KIMAKI_SKIP_OPENCODE_PROCESS_CLEANUP = "1";

    try {
      // 3. Initialize opencode (starts server if not already running)
      taskLogger.log(
        `[task ${task.id}] Initializing opencode for ${projectDirectory}`,
      );
      const getClient = await initializeOpencodeForDirectory(projectDirectory);
      if (getClient instanceof Error) {
        return new Error(`Failed to initialize opencode for task ${task.id}`, {
          cause: getClient,
        });
      }

      // 4. Create session and queue the prompt
      taskLogger.log(`[task ${task.id}] Creating opencode session`);
      const registeredProjectDirs2 = await getAllTextChannelDirectories()
      const created = await getClient().session.create({
        directory: projectDirectory,
        permission: buildSessionPermissions({ directory: projectDirectory, extraAllowedDirectories: registeredProjectDirs2 }),
      });
      const sessionId = created.data?.id;
      if (!sessionId) {
        return new Error(
          `Failed to create opencode session for task ${task.id}`,
        );
      }

      // 5. Post an invisible starter message (marker embed only — no content, no attachment)
      const starterResult = await rest
        .post(Routes.channelMessages(payload.channelId), {
          body: {
            content: "",
            embeds,
          },
        })
        .catch((error) => {
          return new Error(
            `Failed to create starter message for task ${task.id}`,
            {
              cause: error,
            },
          );
        });
      if (starterResult instanceof Error) {
        return starterResult;
      }

      const starterMessageId = parseMessageId(starterResult);
      if (starterMessageId instanceof Error) {
        return new Error(
          `Invalid starter message response for task ${task.id}`,
          {
            cause: starterMessageId,
          },
        );
      }

      // 6. Create thread from the invisible starter message
      taskLogger.log(`[task ${task.id}] Creating thread`);
      const threadResult = await rest
        .post(Routes.threads(payload.channelId, starterMessageId), {
          body: {
            name: threadName,
            auto_archive_duration: 1440,
          },
        })
        .catch((error) => {
          return new Error(`Failed to create thread for task ${task.id}`, {
            cause: error,
          });
        });
      if (threadResult instanceof Error) {
        return threadResult;
      }

      const threadIdResult = parseMessageId(threadResult);
      if (threadIdResult instanceof Error) {
        return new Error(`Invalid thread response for task ${task.id}`, {
          cause: threadIdResult,
        });
      }

      // 7. Persist thread -> session mapping so future messages route to this session
      await setThreadSession(threadIdResult, sessionId);

      // 8. Create IPC request so the bot's listener picks up this session
      const ipcRow = await createIpcRequest({
        type: "start_thread_listener",
        sessionId,
        threadId: threadIdResult,
        payload: JSON.stringify({
          channelId: payload.channelId,
          appId,
          projectDirectory,
        }),
      });

      const ipcReady = await waitForIpcRequestCompletion({
        requestId: ipcRow.id,
      });
      if (ipcReady instanceof Error) {
        return ipcReady;
      }

      // Submit prompt AFTER listener IPC request is created so short/fast
      // model responses are not missed before subscription is active.
      await getClient().session.promptAsync({
        sessionID: sessionId,
        directory: projectDirectory,
        parts: [{ type: "text" as const, text: payload.prompt }],
        ...(payload.agent ? { agent: payload.agent } : {}),
      });

      // 9. Add user to thread if specified
      if (payload.userId) {
        await rest
          .put(Routes.threadMembers(threadIdResult, payload.userId))
          .catch(() => {}); // Best-effort
      }

      taskLogger.log(
        `[task ${task.id}] Agent-first scheduled session started (thread=${threadIdResult}, session=${sessionId})`,
      );
    } finally {
      // Restore the env var so other task executions are unaffected
      if (prevCleanup === undefined) {
        delete process.env.KIMAKI_SKIP_OPENCODE_PROCESS_CLEANUP;
      } else {
        process.env.KIMAKI_SKIP_OPENCODE_PROCESS_CLEANUP = prevCleanup;
      }
    }

    return;
  }

  // Non-silent / notify-only path: post the prompt visibly and let the bot handle it
  const starterResult = await rest
    .post(Routes.channelMessages(payload.channelId), {
      body: {
        content: payload.notifyOnly ? "" : payload.prompt,
        embeds,
      },
    })
    .catch((error) => {
      return new Error(`Failed to create starter message for task ${task.id}`, {
        cause: error,
      });
    });

  if (starterResult instanceof Error) {
    return starterResult;
  }

  const starterMessageId = parseMessageId(starterResult);
  if (starterMessageId instanceof Error) {
    return new Error(`Invalid starter message response for task ${task.id}`, {
      cause: starterMessageId,
    });
  }

  const threadResult = await rest
    .post(Routes.threads(payload.channelId, starterMessageId), {
      body: {
        name: threadName,
        auto_archive_duration: 1440,
      },
    })
    .catch((error) => {
      return new Error(`Failed to create thread for task ${task.id}`, {
        cause: error,
      });
    });

  if (threadResult instanceof Error) {
    return threadResult;
  }

  if (!payload.userId) {
    return;
  }

  const threadIdResult = parseMessageId(threadResult);
  if (threadIdResult instanceof Error) {
    return new Error(`Invalid thread response for task ${task.id}`, {
      cause: threadIdResult,
    });
  }

  const addMemberResult = await rest
    .put(Routes.threadMembers(threadIdResult, payload.userId))
    .catch((error) => {
      return new Error(
        `Failed to add user to scheduled thread for task ${task.id}`,
        { cause: error },
      );
    });
  if (addMemberResult instanceof Error) {
    return addMemberResult;
  }
}

async function executeScheduledTask({
  rest,
  discordClient,
  task,
}: {
  rest: REST;
  discordClient?: Client;
  task: ScheduledTask;
}): Promise<void | Error> {
  const payloadResult = parseScheduledTaskPayload(task.payload_json);
  if (payloadResult instanceof Error) {
    return new Error(`Task ${task.id} has invalid payload`, {
      cause: payloadResult,
    });
  }

  if (payloadResult.kind === "thread") {
    return executeThreadScheduledTask({
      rest,
      task,
      payload: payloadResult,
    });
  }

  return executeChannelScheduledTask({
    rest,
    discordClient,
    task,
    payload: payloadResult,
  });
}

async function finalizeSuccessfulTask({
  task,
  completedAt,
}: {
  task: ScheduledTask;
  completedAt: Date;
}): Promise<void> {
  if (task.schedule_kind === "at") {
    await markScheduledTaskOneShotCompleted({ taskId: task.id, completedAt });
    return;
  }

  if (!task.cron_expr) {
    await markScheduledTaskFailed({
      taskId: task.id,
      failedAt: completedAt,
      errorMessage: "Missing cron expression on cron task",
    });
    return;
  }

  // Use stored timezone, falling back to UTC (not machine local) for consistency
  const timezone = task.timezone || "UTC";
  const nextRunResult = getNextCronRun({
    cronExpr: task.cron_expr,
    timezone,
    from: completedAt,
  });
  if (nextRunResult instanceof Error) {
    await markScheduledTaskFailed({
      taskId: task.id,
      failedAt: completedAt,
      errorMessage: nextRunResult.message,
    });
    return;
  }

  await markScheduledTaskCronRescheduled({
    taskId: task.id,
    completedAt,
    nextRunAt: nextRunResult,
  });
}

async function finalizeFailedTask({
  task,
  failedAt,
  error,
}: {
  task: ScheduledTask;
  failedAt: Date;
  error: Error;
}): Promise<void> {
  if (task.schedule_kind === "cron" && task.cron_expr) {
    // Use stored timezone, falling back to UTC (not machine local) for consistency
    const timezone = task.timezone || "UTC";
    const nextRunResult = getNextCronRun({
      cronExpr: task.cron_expr,
      timezone,
      from: failedAt,
    });
    if (!(nextRunResult instanceof Error)) {
      await markScheduledTaskCronRetry({
        taskId: task.id,
        failedAt,
        errorMessage: error.message,
        nextRunAt: nextRunResult,
      });
      return;
    }
  }

  await markScheduledTaskFailed({
    taskId: task.id,
    failedAt,
    errorMessage: error.message,
  });
}

async function processDueTask({
  rest,
  discordClient,
  task,
}: {
  rest: REST;
  discordClient?: Client;
  task: ScheduledTask;
}): Promise<void> {
  const startedAt = new Date();
  const claimed = await claimScheduledTaskRunning({
    taskId: task.id,
    startedAt,
  });
  if (!claimed) {
    return;
  }

  const executeResult = await executeScheduledTask({
    rest,
    discordClient,
    task,
  });
  const finishedAt = new Date();

  if (executeResult instanceof Error) {
    taskLogger.warn(
      `[task-runner] task ${task.id} failed: ${formatErrorWithStack(executeResult)}`,
    );
    await finalizeFailedTask({
      task,
      failedAt: finishedAt,
      error: executeResult,
    });
    return;
  }

  await finalizeSuccessfulTask({ task, completedAt: finishedAt });
}

async function runTaskRunnerTick({
  rest,
  discordClient,
  staleRunningMs,
  dueBatchSize,
}: {
  rest: REST;
  discordClient?: Client;
  staleRunningMs: number;
  dueBatchSize: number;
}): Promise<void> {
  const staleBefore = new Date(Date.now() - staleRunningMs);
  const recoveredCount = await recoverStaleRunningScheduledTasks({
    staleBefore,
  });
  if (recoveredCount > 0) {
    taskLogger.warn(
      `[task-runner] Recovered ${recoveredCount} stale running task(s)`,
    );
  }

  const dueTasks = await getDuePlannedScheduledTasks({
    now: new Date(),
    limit: dueBatchSize,
  });

  await dueTasks.reduce<Promise<void>>(async (previous, task) => {
    await previous;
    await processDueTask({ rest, discordClient, task });
  }, Promise.resolve());
}

export function startTaskRunner({
  token,
  discordClient,
  pollIntervalMs = 5_000,
  staleRunningMs = 120_000,
  dueBatchSize = 20,
}: StartTaskRunnerOptions): () => Promise<void> {
  const rest = createDiscordRest(token);
  let stopped = false;
  let ticking = false;
  let tickPromise: Promise<void> | null = null;

  const tick = async () => {
    if (stopped || ticking) {
      return;
    }

    ticking = true;
    const currentTickPromise = runTaskRunnerTick({
      rest,
      discordClient,
      staleRunningMs,
      dueBatchSize,
    }).catch((error) => {
      return new Error("Task runner tick failed", { cause: error });
    });
    tickPromise = currentTickPromise.then(() => {
      return;
    });
    const runResult = await currentTickPromise;
    if (runResult instanceof Error) {
      taskLogger.error(`[task-runner] ${formatErrorWithStack(runResult)}`);
      void notifyError(runResult, "Task runner tick failed");
    }
    ticking = false;
    tickPromise = null;
  };

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  void tick();

  taskLogger.log(`[task-runner] started (interval=${pollIntervalMs}ms)`);

  return async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
    if (tickPromise) {
      await tickPromise;
      tickPromise = null;
    }
    taskLogger.log("[task-runner] stopped");
  };
}
