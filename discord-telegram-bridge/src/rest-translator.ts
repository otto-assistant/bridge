// Translates Discord REST API calls into Telegram Bot API calls.
// Each function takes Discord-shaped request data and calls the
// appropriate Telegram method, then returns a Discord-shaped response.

import {
  ChannelType,
  GuildMemberFlags,
  MessageType,
  PermissionFlagsBits,
  RoleFlags,
  ThreadMemberFlags,
} from 'discord-api-types/v10'
import type {
  APIAttachment,
  APIMessage,
  APIUser,
  APIChannel,
  APIGuildMember,
  APIRole,
  APIThreadMember,
} from 'discord-api-types/v10'
import type { TelegramBotClient, TelegramBotUser, TelegramChat, TelegramChatMember } from './telegram-client.js'
import { resolveTelegramTarget, encodeThreadId, decodeThreadId, isThreadChannelId } from './id-converter.js'
import { markdownToTelegramHtml } from './format-converter.js'
import { componentsToInlineKeyboard, extractTextFromComponents } from './component-converter.js'
import type { DiscordAttachment } from './file-upload.js'

// ---- Messages ----

/**
 * POST /channels/:id/messages -> Telegram sendMessage
 */
export async function postMessage({
  telegram,
  channelId,
  body,
  botUserId,
  guildId,
}: {
  telegram: TelegramBotClient
  channelId: string
  body: {
    content?: string
    embeds?: unknown[]
    components?: unknown[]
    attachments?: DiscordAttachment[]
  }
  botUserId: string
  guildId: string
}): Promise<APIMessage> {
  const { chatId, messageThreadId } = resolveTelegramTarget(channelId)

  // Upload file attachments first
  if (body.attachments && body.attachments.length > 0) {
    const { uploadAttachmentsToTelegram } = await import('./file-upload.js')
    await uploadAttachmentsToTelegram({
      telegram,
      attachments: body.attachments,
      chatId,
      messageThreadId,
    })
  }

  // Build text content
  const textParts: string[] = []

  if (body.content) {
    textParts.push(markdownToTelegramHtml(body.content))
  }

  // Extract text from Components V2 structures
  if (body.components && body.components.length > 0) {
    const componentText = extractTextFromComponents(body.components)
    if (componentText) {
      textParts.push(componentText)
    }
  }

  const text = textParts.join('\n') || ' '

  // Build inline keyboard from components
  const replyMarkup = body.components
    ? componentsToInlineKeyboard(body.components)
    : undefined

  const result = await telegram.sendMessage({
    chatId,
    text,
    messageThreadId,
    replyMarkup,
  })

  return buildApiMessage({
    messageId: result.message_id.toString(),
    channelId,
    date: result.date,
    content: body.content ?? '',
    botUserId,
    guildId,
  })
}

/**
 * PATCH /channels/:id/messages/:mid -> Telegram editMessageText
 */
export async function editMessage({
  telegram,
  channelId,
  messageId,
  body,
  botUserId,
  guildId,
}: {
  telegram: TelegramBotClient
  channelId: string
  messageId: string
  body: { content?: string; components?: unknown[] }
  botUserId: string
  guildId: string
}): Promise<APIMessage> {
  const { chatId } = resolveTelegramTarget(channelId)
  const telegramMessageId = parseInt(messageId, 10)
  if (!Number.isFinite(telegramMessageId)) {
    throw new Error(`Invalid Telegram message ID: ${messageId}`)
  }

  const textParts: string[] = []

  if (body.content) {
    textParts.push(markdownToTelegramHtml(body.content))
  }

  if (body.components && body.components.length > 0) {
    const componentText = extractTextFromComponents(body.components)
    if (componentText) {
      textParts.push(componentText)
    }
  }

  const text = textParts.join('\n') || ' '

  const replyMarkup = body.components
    ? componentsToInlineKeyboard(body.components)
    : undefined

  await telegram.editMessageText({
    chatId,
    messageId: telegramMessageId,
    text,
    replyMarkup,
  })

  return buildApiMessage({
    messageId,
    channelId,
    date: Math.floor(Date.now() / 1000),
    content: body.content ?? '',
    botUserId,
    guildId,
  })
}

/**
 * DELETE /channels/:id/messages/:mid -> Telegram deleteMessage
 */
export async function deleteMessage({
  telegram,
  channelId,
  messageId,
}: {
  telegram: TelegramBotClient
  channelId: string
  messageId: string
}): Promise<void> {
  const { chatId } = resolveTelegramTarget(channelId)
  const telegramMessageId = parseInt(messageId, 10)
  if (!Number.isFinite(telegramMessageId)) {
    throw new Error(`Invalid Telegram message ID: ${messageId}`)
  }

  await telegram.deleteMessage({ chatId, messageId: telegramMessageId })
}

// ---- Threads ----

/**
 * POST /channels/:id/threads -> Create a topic in a Telegram supergroup.
 * Returns a Discord thread channel object.
 */
export async function createThread({
  telegram,
  parentChannelId,
  body,
  botUserId,
  guildId,
}: {
  telegram: TelegramBotClient
  parentChannelId: string
  body: { name?: string }
  botUserId: string
  guildId: string
}): Promise<APIChannel> {
  const { chatId } = resolveTelegramTarget(parentChannelId)

  // In Telegram, creating a topic requires the chat to be a forum supergroup.
  // We send a message to create a new topic.
  const result = await telegram.sendMessage({
    chatId,
    text: body.name ?? 'New Thread',
  })

  const topicMessageId = result.message_id
  const threadId = encodeThreadId(chatId, topicMessageId)

  return {
    id: threadId,
    type: ChannelType.PublicThread,
    name: body.name ?? `topic-${topicMessageId}`,
    guild_id: guildId,
    parent_id: parentChannelId,
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
 * POST /channels/:id/messages/:mid/threads -> Create a thread from a message.
 * In Telegram, this creates a reply thread.
 */
export async function createThreadFromMessage({
  telegram,
  parentChannelId,
  messageId,
  body,
  botUserId,
  guildId,
}: {
  telegram: TelegramBotClient
  parentChannelId: string
  messageId: string
  body: { name?: string }
  botUserId: string
  guildId: string
}): Promise<APIChannel> {
  const { chatId } = resolveTelegramTarget(parentChannelId)
  const telegramMessageId = parseInt(messageId, 10)

  // Reply to the message to create a "thread" context
  const result = await telegram.sendMessage({
    chatId,
    text: body.name ?? 'New Thread',
    replyToMessageId: Number.isFinite(telegramMessageId) ? telegramMessageId : undefined,
  })

  const topicMessageId = result.message_id
  const threadId = encodeThreadId(chatId, topicMessageId)

  return {
    id: threadId,
    type: ChannelType.PublicThread,
    name: body.name ?? `topic-${topicMessageId}`,
    guild_id: guildId,
    parent_id: parentChannelId,
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

// ---- Channels ----

/**
 * GET /channels/:id -> Telegram getChat
 */
export async function getChannel({
  telegram,
  channelId,
  guildId,
}: {
  telegram: TelegramBotClient
  channelId: string
  guildId: string
}): Promise<APIChannel> {
  if (isThreadChannelId(channelId)) {
    // For thread channels, return a synthetic thread channel
    const { chatId, topicMessageId } = decodeThreadId(channelId)
    return {
      id: channelId,
      type: ChannelType.PublicThread,
      name: `topic-${topicMessageId}`,
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

  const chatId = Number(channelId)
  const chat = await telegram.getChat({ chatId })

  return {
    id: chatId.toString(),
    type: ChannelType.GuildText,
    name: chat.title ?? 'telegram-chat',
    guild_id: guildId,
    position: 0,
  }
}

/**
 * PATCH /channels/:id -> Telegram setChatTitle (if name provided)
 */
export async function updateChannel({
  telegram,
  channelId,
  body,
  guildId,
}: {
  telegram: TelegramBotClient
  channelId: string
  body: { name?: string }
  guildId: string
}): Promise<APIChannel> {
  // Telegram doesn't support renaming individual channels from bot API easily
  // Return the current channel state
  return getChannel({ telegram, channelId, guildId })
}

// ---- Guild/Members ----

/**
 * Get bot user info as Discord APIUser.
 */
export async function getUser({
  telegram,
  userId,
}: {
  telegram: TelegramBotClient
  userId: string
}): Promise<APIUser> {
  const chatId = Number(userId)
  if (Number.isFinite(chatId) && chatId !== 0) {
    // Try to get as chat member
    try {
      const member = await telegram.getChatMember({ chatId, userId: chatId })
      return telegramUserToDiscordUser(member.user)
    } catch {
      // Fall through to bot user
    }
  }

  // Return bot user
  const botUser = await telegram.getMe()
  return telegramUserToDiscordUser({
    id: botUser.id,
    is_bot: botUser.is_bot,
    first_name: botUser.first_name,
    username: botUser.username,
  })
}

/**
 * List guild members -> Telegram chat administrators + members.
 */
export async function listGuildMembers({
  telegram,
  chatId,
}: {
  telegram: TelegramBotClient
  chatId: number
}): Promise<APIGuildMember[]> {
  const admins = await telegram.getChatAdministrators({ chatId })
  return admins.map((admin) => {
    return telegramMemberToDiscordMember(admin)
  })
}

/**
 * Get a specific guild member.
 */
export async function getGuildMember({
  telegram,
  chatId,
  userId,
}: {
  telegram: TelegramBotClient
  chatId: number
  userId: number
}): Promise<APIGuildMember> {
  const member = await telegram.getChatMember({ chatId, userId })
  return telegramMemberToDiscordMember(member)
}

/**
 * List guild roles -> synthetic roles based on Telegram admin status.
 */
export async function listGuildRoles({
  telegram,
  chatId,
}: {
  telegram: TelegramBotClient
  chatId: number
}): Promise<APIRole[]> {
  return [
    {
      id: 'admin',
      name: 'Admin',
      permissions: PermissionFlagsBits.Administrator.toString(),
      position: 1,
      color: 0,
      hoist: false,
      managed: false,
      mentionable: false,
      flags: RoleFlags.InPrompt,
    },
    {
      id: 'member',
      name: 'Member',
      permissions: '0',
      position: 0,
      color: 0,
      hoist: false,
      managed: false,
      mentionable: false,
      flags: RoleFlags.InPrompt,
    },
  ]
}

/**
 * Get thread members -> synthetic list with bot.
 */
export async function listThreadMembers({
  telegram,
  threadChannelId,
  botUserId,
}: {
  telegram: TelegramBotClient
  threadChannelId: string
  botUserId: string
}): Promise<APIThreadMember[]> {
  // Telegram doesn't have thread member tracking
  // Return just the bot as a member
  return [
    {
      id: botUserId,
      user_id: botUserId,
      join_timestamp: new Date().toISOString(),
      flags: ThreadMemberFlags.HasInteracted,
    },
  ]
}

// ---- Helpers ----

function buildApiMessage({
  messageId,
  channelId,
  date,
  content,
  botUserId,
  guildId,
}: {
  messageId: string
  channelId: string
  date: number
  content: string
  botUserId: string
  guildId: string
}): APIMessage & { guild_id: string } {
  return {
    id: messageId,
    channel_id: channelId,
    author: {
      id: botUserId,
      username: 'telegram-bot',
      discriminator: '0',
      avatar: null,
      bot: true,
      global_name: 'Telegram Bot',
    },
    content,
    timestamp: new Date(date * 1000).toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: MessageType.Default,
    guild_id: guildId,
  }
}

function telegramUserToDiscordUser(user: {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
}): APIUser {
  return {
    id: user.id.toString(),
    username: user.username ?? user.first_name,
    discriminator: '0',
    avatar: null,
    bot: user.is_bot,
    global_name: [user.first_name, user.last_name].filter(Boolean).join(' '),
  }
}

function telegramMemberToDiscordMember(member: TelegramChatMember): APIGuildMember {
  return {
    user: telegramUserToDiscordUser(member.user),
    roles: member.status === 'administrator' || member.status === 'creator' ? ['admin'] : ['member'],
    joined_at: new Date().toISOString(),
    deaf: false,
    mute: false,
    flags: GuildMemberFlags.CompletedOnboarding,
  }
}
