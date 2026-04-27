// Simple typing coordinator for Telegram sendChatAction.
// Telegram typing indicator lasts ~5 seconds; must refresh periodically.

export interface TypingCoordinator {
  requestStart: ({ chatId, messageThreadId }: { chatId: number; messageThreadId?: number }) => void
  noteAssistantMessage: ({ chatId }: { chatId: number }) => void
  stopAll: () => void
}

interface ActiveTyping {
  chatId: number
  messageThreadId?: number
  intervalId: ReturnType<typeof setInterval>
}

export function createTypingCoordinator({
  sendChatAction,
  pulseIntervalMs = 5000,
}: {
  sendChatAction: (params: { chatId: number; messageThreadId?: number; action: 'typing' }) => Promise<void>
  pulseIntervalMs?: number
}): TypingCoordinator {
  const active = new Map<string, ActiveTyping>()

  function key(chatId: number, messageThreadId?: number): string {
    return `${chatId}:${messageThreadId ?? 0}`
  }

  function startTyping(chatId: number, messageThreadId?: number): void {
    const k = key(chatId, messageThreadId)
    if (active.has(k)) {
      return
    }

    // Send initial typing action immediately
    void sendChatAction({ chatId, messageThreadId, action: 'typing' })

    const intervalId = setInterval(() => {
      void sendChatAction({ chatId, messageThreadId, action: 'typing' })
    }, pulseIntervalMs)

    // Don't prevent process exit
    if (intervalId && typeof intervalId === 'object' && 'unref' in intervalId) {
      intervalId.unref()
    }

    active.set(k, { chatId, messageThreadId, intervalId })
  }

  function stopTyping(chatId: number, messageThreadId?: number): void {
    const k = key(chatId, messageThreadId)
    const entry = active.get(k)
    if (!entry) {
      return
    }
    clearInterval(entry.intervalId)
    active.delete(k)
  }

  return {
    requestStart: ({ chatId, messageThreadId }) => {
      startTyping(chatId, messageThreadId)
    },
    noteAssistantMessage: ({ chatId }) => {
      // Stop all typing for this chat (any thread)
      for (const [k, entry] of active.entries()) {
        if (entry.chatId === chatId) {
          clearInterval(entry.intervalId)
          active.delete(k)
        }
      }
    },
    stopAll: () => {
      for (const entry of active.values()) {
        clearInterval(entry.intervalId)
      }
      active.clear()
    },
  }
}
