// Stateless ID converter between Discord and Telegram ID formats.
//
// ## Why snowflake-compatible?
//
// discord.js parses message IDs and thread channel IDs as BigInt snowflakes
// internally. Non-numeric IDs cause `Cannot convert to BigInt` errors.
// Telegram message_id and chat_id are already numeric, so encoding is simpler
// than for Slack.
//
// ## Encoding scheme
//
//   Guild ID:   Telegram chat_id as string (e.g. "-1001234567890")
//               discord.js does NOT parse these as snowflakes in tested paths.
//   Channel ID: Telegram chat_id as string (same as guild — 1:1 mapping)
//   User ID:    Telegram user_id as string (numeric, e.g. "123456789")
//   Message ID: Telegram message_id as string (numeric, already BigInt-safe)
//   Thread ID:  reversible encoding of chat_id + topic_message_id:
//               {topic_mid_abs_10}{chat_id_abs_10}{chat_id_len_2}
//               Always positive numeric, 20+ digits.

/**
 * Encode a Telegram chat_id + topic message_id into a Discord thread channel ID.
 * Format: {topic_mid_10}{chat_id_abs_10}{chat_id_len_2}
 *
 * chat_id is stored as absolute value (stripped leading minus) because
// supergroup IDs are negative (e.g. -1001234567890).
// The original sign is recovered from the length prefix since all supergroup
// chat_ids start with -100.
 */
export function encodeThreadId(chatId: number, topicMessageId: number): string {
  const chatAbs = Math.abs(chatId).toString()
  const chatLen = chatAbs.length.toString().padStart(2, '0')
  const topicStr = topicMessageId.toString().padStart(10, '0')
  return `${topicStr}${chatAbs}${chatLen}`
}

/**
 * Decode a Discord thread channel ID back to Telegram chat_id + topic_message_id.
 * No runtime map needed — chat_id is encoded in the ID.
 */
export function decodeThreadId(threadChannelId: string): {
  chatId: number
  topicMessageId: number
} {
  if (!/^\d{20,}$/.test(threadChannelId)) {
    throw new Error(`Invalid thread channel ID: ${threadChannelId}`)
  }

  const chatLen = parseInt(threadChannelId.slice(-2), 10)
  const chatAbs = threadChannelId.slice(-(2 + chatLen), -2)
  const topicStr = threadChannelId.slice(0, -(2 + chatLen))

  // Telegram supergroup chat_ids are negative: -100xxxxxxxxxx
  // Absolute values always start with 100 for supergroups.
  const chatId = chatAbs.startsWith('100')
    ? -parseInt(chatAbs, 10)
    : parseInt(chatAbs, 10)

  return {
    chatId,
    topicMessageId: parseInt(topicStr, 10),
  }
}

/**
 * Check if a Discord channel ID represents a Telegram topic thread.
 * Thread IDs are pure numeric with 20+ digits.
 */
export function isThreadChannelId(id: string): boolean {
  return /^\d{20,}$/.test(id)
}

/**
 * Resolve where to send a Telegram message given a Discord channel ID.
 * For thread channels (20+ digit numeric), decodes the embedded chat_id
 * and topic_message_id. For regular channels, returns the chat_id.
 */
export function resolveTelegramTarget(discordChannelId: string): {
  chatId: number
  messageThreadId?: number
} {
  if (isThreadChannelId(discordChannelId)) {
    const { chatId, topicMessageId } = decodeThreadId(discordChannelId)
    return { chatId, messageThreadId: topicMessageId }
  }

  // Regular chat ID (may be numeric string, possibly negative)
  const parsed = Number(discordChannelId)
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Cannot resolve Telegram target for channel ID: ${discordChannelId}`,
    )
  }
  return { chatId: parsed }
}

/**
 * Determine the Discord channel_id for an incoming Telegram message.
 * If the message is in a topic (has message_thread_id), returns encoded
 * thread channel ID. Otherwise returns the chat_id as string.
 */
export function resolveDiscordChannelId({
  chatId,
  messageThreadId,
}: {
  chatId: number
  messageThreadId?: number
}): string {
  if (messageThreadId) {
    return encodeThreadId(chatId, messageThreadId)
  }
  return chatId.toString()
}

/**
 * Convert a Telegram timestamp (Unix seconds) to an ISO 8601 string.
 */
export function telegramDateToIso(date: number): string {
  return new Date(date * 1000).toISOString()
}
