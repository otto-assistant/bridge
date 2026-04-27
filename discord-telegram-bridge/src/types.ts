// Shared types for the discord-telegram-bridge adapter.

export interface TelegramBridgeConfig {
  /** Telegram bot token (e.g. "123456:ABC-DEF1234...") */
  botToken: string
  /** Optional Discord-facing client token (for gateway identify). */
  discordToken?: string
  /** Telegram chat ID to use as the "guild" (supergroup, e.g. -1001234567890) */
  chatId: number
  /** Port to listen on. Default 3720. */
  port?: number
  /** Override gateway URL returned by GET /gateway/bot. */
  gatewayUrlOverride?: string
  /** Optional public base URL for REST/Gateway/Webhook URLs. */
  publicBaseUrl?: string
  /** Optional authorization callback for REST/Gateway. */
  authorize?: BridgeAuthorizeCallback
  /** Use webhook mode instead of long polling. */
  webhookMode?: boolean
}

export type BridgeAuthorizeKind =
  | 'gateway-identify'
  | 'rest'

export interface BridgeAuthorizeContext {
  kind: BridgeAuthorizeKind
  token?: string
  request?: Request
  path?: string
  method?: string
}

export interface BridgeAuthorizeResult {
  allow: boolean
  clientId?: string
}

export type BridgeAuthorizeCallback = (
  context: BridgeAuthorizeContext,
) => Promise<BridgeAuthorizeResult>

// ---- Normalized Telegram events ----

/** A normalized Telegram message (from getUpdates or webhook). */
export interface NormalizedTelegramMessage {
  messageId: number
  chatId: number
  chatType: 'private' | 'group' | 'supergroup' | 'channel'
  chatTitle?: string
  threadId?: number
  from?: {
    id: number
    firstName?: string
    lastName?: string
    username?: string
    isBot: boolean
  }
  date: number
  text?: string
  caption?: string
  replyToMessageId?: number
  forwardFrom?: {
    id: number
    firstName?: string
    username?: string
  }
  editDate?: number
  document?: NormalizedTelegramFile
  photo?: NormalizedTelegramPhotoSize[]
  voice?: NormalizedTelegramFile
  video?: NormalizedTelegramFile
  audio?: NormalizedTelegramFile
  sticker?: NormalizedTelegramSticker
  entities?: NormalizedTelegramEntity[]
}

export interface NormalizedTelegramFile {
  fileId: string
  fileUniqueId: string
  fileName?: string
  mimeType?: string
  fileSize?: number
}

export interface NormalizedTelegramPhotoSize {
  fileId: string
  fileUniqueId: string
  width: number
  height: number
  fileSize?: number
}

export interface NormalizedTelegramSticker {
  fileId: string
  fileUniqueId: string
  width: number
  height: number
  emoji?: string
  setName?: string
  isAnimated?: boolean
  isVideo?: boolean
}

export interface NormalizedTelegramEntity {
  type:
    | 'mention'
    | 'hashtag'
    | 'bot_command'
    | 'url'
    | 'email'
    | 'phone_number'
    | 'bold'
    | 'italic'
    | 'code'
    | 'pre'
    | 'text_link'
    | 'text_mention'
    | 'underline'
    | 'strikethrough'
    | 'spoiler'
    | 'blockquote'
    | 'expandable_blockquote'
  offset: number
  length: number
  url?: string
  user?: { id: number; firstName?: string; username?: string }
  language?: string
}

export interface NormalizedTelegramCallbackQuery {
  id: string
  from: {
    id: number
    firstName?: string
    lastName?: string
    username?: string
    isBot: boolean
  }
  message?: NormalizedTelegramMessage
  chatInstance: string
  data?: string
  gameShortName?: string
}

export interface NormalizedTelegramMessageReaction {
  chatId: number
  messageId: number
  user?: {
    id: number
    isBot: boolean
  }
  reactions: Array<{
    emoji: string
    type: 'emoji' | 'custom_emoji'
  }>
  date: number
}

export type NormalizedTelegramUpdate =
  | { type: 'message'; updateId: number; message: NormalizedTelegramMessage }
  | { type: 'edited_message'; updateId: number; message: NormalizedTelegramMessage }
  | { type: 'callback_query'; updateId: number; query: NormalizedTelegramCallbackQuery }
  | { type: 'message_reaction'; updateId: number; reaction: NormalizedTelegramMessageReaction }

// ---- Cached user info ----

export interface CachedTelegramUser {
  id: number
  firstName: string
  lastName?: string
  username?: string
  isBot: boolean
}

// ---- Pending interaction ----

/** Pending interaction waiting for discord.js to respond via callback. */
export interface PendingInteraction {
  id: string
  token: string
  channelId: string
  guildId: string
  acknowledged: boolean
  /** Telegram chat ID for sending responses. */
  telegramChatId: number
  /** Telegram message ID for editing the source message. */
  telegramMessageId?: number
}
