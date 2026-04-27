// Translates Telegram updates into Discord Gateway dispatch payloads.
// Each function takes a Telegram event and returns a Discord-shaped object
// that can be broadcast via the Gateway.

import {
  ChannelType,
  GatewayDispatchEvents,
  GuildMemberFlags,
  MessageType,
} from 'discord-api-types/v10'
import type {
  APIAttachment,
  APIChannel,
  APIMessage,
  APIUser,
  APIGuildMember,
} from 'discord-api-types/v10'
import {
  resolveDiscordChannelId,
  encodeThreadId,
  telegramDateToIso,
} from './id-converter.js'
import { telegramHtmlToMarkdown } from './format-converter.js'
import type {
  NormalizedTelegramMessage,
  NormalizedTelegramCallbackQuery,
  CachedTelegramUser,
} from './types.js'

const DISCORD_DEFAULT_DISCRIMINATOR = '0'

/**
 * Translate a Telegram incoming message into a Discord MESSAGE_CREATE payload.
 */
export function translateMessageCreate({
  message,
  guildId,
  author,
}: {
  message: NormalizedTelegramMessage
  guildId: string
  author: CachedTelegramUser
}): { eventName: string; data: APIMessage & { guild_id: string } } | null {
  const content = extractTextContent(message)
  if (content === null) {
    return null
  }

  const channelId = resolveDiscordChannelId({
    chatId: message.chatId,
    messageThreadId: message.threadId,
  })
  const messageId = message.messageId.toString()
  const markdownContent = telegramHtmlToMarkdown(content)

  const apiUser: APIUser = {
    id: author.id.toString(),
    username: author.username ?? author.firstName,
    discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
    avatar: null,
    bot: author.isBot,
    global_name: author.firstName,
  }

  const apiMessage: APIMessage & { guild_id: string } = {
    id: messageId,
    channel_id: channelId,
    author: apiUser,
    content: markdownContent,
    timestamp: telegramDateToIso(message.date),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: mapTelegramFilesToDiscordAttachments(message),
    embeds: [],
    pinned: false,
    type: MessageType.Default,
    guild_id: guildId,
  }

  return {
    eventName: GatewayDispatchEvents.MessageCreate,
    data: apiMessage,
  }
}

/**
 * Translate a Telegram edited message into a Discord MESSAGE_UPDATE payload.
 */
export function translateMessageUpdate({
  message,
  guildId,
  author,
}: {
  message: NormalizedTelegramMessage
  guildId: string
  author: CachedTelegramUser
}): { eventName: string; data: APIMessage & { guild_id: string } } | null {
  const content = extractTextContent(message)
  if (content === null) {
    return null
  }

  const channelId = resolveDiscordChannelId({
    chatId: message.chatId,
    messageThreadId: message.threadId,
  })
  const messageId = message.messageId.toString()
  const markdownContent = telegramHtmlToMarkdown(content)

  const apiUser: APIUser = {
    id: author.id.toString(),
    username: author.username ?? author.firstName,
    discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
    avatar: null,
    bot: author.isBot,
    global_name: author.firstName,
  }

  const apiMessage: APIMessage & { guild_id: string } = {
    id: messageId,
    channel_id: channelId,
    author: apiUser,
    content: markdownContent,
    timestamp: telegramDateToIso(message.date),
    edited_timestamp: message.editDate ? telegramDateToIso(message.editDate) : null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: mapTelegramFilesToDiscordAttachments(message),
    embeds: [],
    pinned: false,
    type: MessageType.Default,
    guild_id: guildId,
  }

  return {
    eventName: GatewayDispatchEvents.MessageUpdate,
    data: apiMessage,
  }
}

/**
 * Build a Discord APIChannel object for a Telegram topic thread.
 */
export function buildThreadChannel({
  chatId,
  topicMessageId,
  guildId,
  name,
}: {
  chatId: number
  topicMessageId: number
  guildId: string
  name?: string
}): APIChannel {
  const threadId = encodeThreadId(chatId, topicMessageId)
  return {
    id: threadId,
    type: ChannelType.PublicThread,
    name: name ?? `topic-${topicMessageId}`,
    guild_id: guildId,
    parent_id: chatId.toString(),
    message_count: 0,
    member_count: 0,
    thread_metadata: {
      archived: false,
      auto_archive_duration: 1440,
      archive_timestamp: new Date().toISOString(),
      locked: false,
    },
  }
}

/**
 * Build a Discord APIChannel for the main Telegram chat.
 */
export function buildMainChannel({
  chatId,
  chatTitle,
  guildId,
  isForum,
}: {
  chatId: number
  chatTitle?: string
  guildId: string
  isForum?: boolean
}): APIChannel {
  return {
    id: chatId.toString(),
    type: ChannelType.GuildText,
    name: chatTitle ?? 'telegram-chat',
    guild_id: guildId,
    position: 0,
  }
}

/**
 * Build a Discord APIGuildMember from a Telegram user.
 */
export function buildGuildMember({
  user,
}: {
  user: CachedTelegramUser
}): APIGuildMember {
  return {
    user: {
      id: user.id.toString(),
      username: user.username ?? user.firstName,
      discriminator: DISCORD_DEFAULT_DISCRIMINATOR,
      avatar: null,
      bot: user.isBot,
      global_name: user.firstName,
    },
    roles: [],
    joined_at: new Date().toISOString(),
    deaf: false,
    mute: false,
    flags: GuildMemberFlags.CompletedOnboarding,
  }
}

// ---- Helpers ----

function extractTextContent(message: NormalizedTelegramMessage): string | null {
  // Telegram messages may have text, caption (for media), or no text at all
  const text = message.text ?? message.caption
  if (!text) {
    // Media-only messages still get forwarded as content-less messages
    if (message.document || message.photo || message.voice || message.video || message.audio || message.sticker) {
      return ''
    }
    return null
  }
  return text
}

function mapTelegramFilesToDiscordAttachments(
  message: NormalizedTelegramMessage,
): APIAttachment[] {
  const attachments: APIAttachment[] = []

  if (message.document) {
    attachments.push({
      id: message.document.fileId,
      filename: message.document.fileName ?? 'document',
      size: message.document.fileSize ?? 0,
      url: `telegram://file/${message.document.fileId}`,
      proxy_url: `telegram://file/${message.document.fileId}`,
      content_type: message.document.mimeType,
    })
  }

  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]!
    attachments.push({
      id: largest.fileId,
      filename: 'photo.jpg',
      size: largest.fileSize ?? 0,
      url: `telegram://file/${largest.fileId}`,
      proxy_url: `telegram://file/${largest.fileId}`,
      content_type: 'image/jpeg',
    })
  }

  if (message.voice) {
    attachments.push({
      id: message.voice.fileId,
      filename: 'voice.ogg',
      size: message.voice.fileSize ?? 0,
      url: `telegram://file/${message.voice.fileId}`,
      proxy_url: `telegram://file/${message.voice.fileId}`,
      content_type: message.voice.mimeType ?? 'audio/ogg',
    })
  }

  return attachments
}
