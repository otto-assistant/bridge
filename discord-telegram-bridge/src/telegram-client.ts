// Telegram Bot API client with long polling and REST methods.
// Provides a high-level interface for all Telegram Bot API calls used by the bridge.

import type {
  NormalizedTelegramUpdate,
  NormalizedTelegramMessage,
  NormalizedTelegramCallbackQuery,
  NormalizedTelegramEntity,
  NormalizedTelegramFile,
  NormalizedTelegramPhotoSize,
  NormalizedTelegramSticker,
} from './types.js'

export class TelegramBotClient {
  private readonly token: string
  private readonly baseUrl: string
  private polling = false
  private lastUpdateId = 0
  private pollTimeout: ReturnType<typeof setTimeout> | null = null
  private updateHandler: ((updates: NormalizedTelegramUpdate[]) => void) | null = null

  constructor(token: string) {
    this.token = token
    this.baseUrl = `https://api.telegram.org/bot${token}`
  }

  /** Set the handler for incoming updates (called on each poll cycle). */
  onUpdate(handler: (updates: NormalizedTelegramUpdate[]) => void): void {
    this.updateHandler = handler
  }

  /** Start long polling for updates. */
  startPolling(): void {
    if (this.polling) {
      return
    }
    this.polling = true
    void this.poll()
  }

  /** Stop long polling. */
  stopPolling(): void {
    this.polling = false
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout)
      this.pollTimeout = null
    }
  }

  // ---- Bot API methods ----

  /** Get bot information. */
  async getMe(): Promise<TelegramBotUser> {
    const result = await this.apiCall('getMe')
    return result as TelegramBotUser
  }

  /** Send a text message. */
  async sendMessage(params: {
    chatId: number
    text: string
    messageThreadId?: number
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2'
    replyToMessageId?: number
    replyMarkup?: unknown
    disableNotification?: boolean
  }): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      text: params.text,
      parse_mode: params.parseMode ?? 'HTML',
    }
    if (params.messageThreadId) {
      body.message_thread_id = params.messageThreadId
    }
    if (params.replyToMessageId) {
      body.reply_to_message_id = params.replyToMessageId
    }
    if (params.replyMarkup) {
      body.reply_markup = params.replyMarkup
    }
    if (params.disableNotification) {
      body.disable_notification = true
    }
    const result = await this.apiCall('sendMessage', body)
    return result as TelegramMessage
  }

  /** Edit a message's text or caption. */
  async editMessageText(params: {
    chatId: number
    messageId: number
    text: string
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2'
    replyMarkup?: unknown
  }): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      message_id: params.messageId,
      text: params.text,
      parse_mode: params.parseMode ?? 'HTML',
    }
    if (params.replyMarkup) {
      body.reply_markup = params.replyMarkup
    }
    const result = await this.apiCall('editMessageText', body)
    // Telegram returns true if the message wasn't modified, or the message object
    if (typeof result === 'boolean') {
      return {
        message_id: params.messageId,
        chat: { id: params.chatId, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: params.text,
      }
    }
    return result as TelegramMessage
  }

  /** Delete a message. */
  async deleteMessage(params: {
    chatId: number
    messageId: number
  }): Promise<boolean> {
    return this.apiCall('deleteMessage', {
      chat_id: params.chatId,
      message_id: params.messageId,
    }) as Promise<boolean>
  }

  /** Send a chat action (typing, etc). */
  async sendChatAction(params: {
    chatId: number
    action: 'typing' | 'upload_photo' | 'record_video' | 'upload_video' | 'record_voice' | 'upload_voice' | 'upload_document' | 'choose_sticker' | 'find_location' | 'record_video_note' | 'upload_video_note'
    messageThreadId?: number
  }): Promise<boolean> {
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      action: params.action,
    }
    if (params.messageThreadId) {
      body.message_thread_id = params.messageThreadId
    }
    return this.apiCall('sendChatAction', body) as Promise<boolean>
  }

  /** Get information about a chat. */
  async getChat(params: { chatId: number }): Promise<TelegramChat> {
    return this.apiCall('getChat', {
      chat_id: params.chatId,
    }) as Promise<TelegramChat>
  }

  /** Get a member of a chat. */
  async getChatMember(params: {
    chatId: number
    userId: number
  }): Promise<TelegramChatMember> {
    return this.apiCall('getChatMember', {
      chat_id: params.chatId,
      user_id: params.userId,
    }) as Promise<TelegramChatMember>
  }

  /** Get chat administrators. */
  async getChatAdministrators(params: {
    chatId: number
  }): Promise<TelegramChatMember[]> {
    return this.apiCall('getChatAdministrators', {
      chat_id: params.chatId,
    }) as Promise<TelegramChatMember[]>
  }

  /** Set bot commands. */
  async setMyCommands(params: {
    commands: Array<{ command: string; description: string }>
  }): Promise<boolean> {
    return this.apiCall('setMyCommands', {
      commands: params.commands,
    }) as Promise<boolean>
  }

  /** Get bot commands. */
  async getMyCommands(): Promise<Array<{ command: string; description: string }>> {
    return this.apiCall('getMyCommands') as Promise<Array<{ command: string; description: string }>>
  }

  /** Answer a callback query. */
  async answerCallbackQuery(params: {
    callbackQueryId: string
    text?: string
    showAlert?: boolean
  }): Promise<boolean> {
    return this.apiCall('answerCallbackQuery', {
      callback_query_id: params.callbackQueryId,
      text: params.text,
      show_alert: params.showAlert,
    }) as Promise<boolean>
  }

  /** Send a document. */
  async sendDocument(params: {
    chatId: number
    document: Blob
    filename: string
    caption?: string
    messageThreadId?: number
    replyMarkup?: unknown
  }): Promise<TelegramMessage> {
    const formData = new FormData()
    formData.set('chat_id', params.chatId.toString())
    formData.set('document', params.document, params.filename)
    if (params.caption) {
      formData.set('caption', params.caption)
      formData.set('parse_mode', 'HTML')
    }
    if (params.messageThreadId) {
      formData.set('message_thread_id', params.messageThreadId.toString())
    }
    if (params.replyMarkup) {
      formData.set('reply_markup', JSON.stringify(params.replyMarkup))
    }
    const result = await this.apiCallFormData('sendDocument', formData)
    return result as TelegramMessage
  }

  /** Send a photo. */
  async sendPhoto(params: {
    chatId: number
    photo: Blob
    filename?: string
    caption?: string
    messageThreadId?: number
    replyMarkup?: unknown
  }): Promise<TelegramMessage> {
    const formData = new FormData()
    formData.set('chat_id', params.chatId.toString())
    formData.set('photo', params.photo, params.filename ?? 'photo.jpg')
    if (params.caption) {
      formData.set('caption', params.caption)
      formData.set('parse_mode', 'HTML')
    }
    if (params.messageThreadId) {
      formData.set('message_thread_id', params.messageThreadId.toString())
    }
    if (params.replyMarkup) {
      formData.set('reply_markup', JSON.stringify(params.replyMarkup))
    }
    const result = await this.apiCallFormData('sendPhoto', formData)
    return result as TelegramMessage
  }

  // ---- Private methods ----

  private async poll(): Promise<void> {
    if (!this.polling) {
      return
    }

    try {
      const rawUpdates = await this.apiCall('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ['message', 'edited_message', 'callback_query', 'message_reaction'],
      }) as TelegramRawUpdate[]

      if (rawUpdates && rawUpdates.length > 0) {
        this.lastUpdateId = Math.max(
          ...rawUpdates.map((u) => u.update_id),
        )
        const normalized = rawUpdates.map(normalizeUpdate).filter(isTruthy)
        if (normalized.length > 0 && this.updateHandler) {
          this.updateHandler(normalized)
        }
      }
    } catch (error) {
      console.error('Telegram polling error:', error)
    }

    if (this.polling) {
      this.pollTimeout = setTimeout(() => {
        void this.poll()
      }, 1000)
    }
  }

  private async apiCall(method: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}/${method}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })

    const json = await response.json() as TelegramApiResponse
    if (!json.ok) {
      throw new TelegramApiError(
        json.description ?? 'Unknown Telegram API error',
        json.error_code,
      )
    }
    return json.result
  }

  private async apiCallFormData(method: string, formData: FormData): Promise<unknown> {
    const url = `${this.baseUrl}/${method}`
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    })

    const json = await response.json() as TelegramApiResponse
    if (!json.ok) {
      throw new TelegramApiError(
        json.description ?? 'Unknown Telegram API error',
        json.error_code,
      )
    }
    return json.result
  }
}

// ---- Telegram API response types (raw) ----

interface TelegramApiResponse {
  ok: boolean
  result?: unknown
  description?: string
  error_code?: number
}

export interface TelegramBotUser {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
  can_join_groups?: boolean
  can_read_all_group_messages?: boolean
  supports_inline_queries?: boolean
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
  is_forum?: boolean
}

export interface TelegramChatMember {
  user: {
    id: number
    is_bot: boolean
    first_name: string
    last_name?: string
    username?: string
  }
  status: 'creator' | 'administrator' | 'member' | 'left' | 'kicked' | 'restricted'
}

export interface TelegramMessage {
  message_id: number
  chat: {
    id: number
    type: string
    title?: string
    username?: string
    is_forum?: boolean
  }
  date: number
  from?: {
    id: number
    is_bot: boolean
    first_name: string
    last_name?: string
    username?: string
  }
  text?: string
  caption?: string
  message_thread_id?: number
  reply_to_message?: { message_id: number }
  forward_from?: {
    id: number
    first_name: string
    username?: string
  }
  edit_date?: number
  document?: {
    file_id: string
    file_unique_id: string
    file_name?: string
    mime_type?: string
    file_size?: number
  }
  photo?: Array<{
    file_id: string
    file_unique_id: string
    width: number
    height: number
    file_size?: number
  }>
  voice?: {
    file_id: string
    file_unique_id: string
    duration?: number
    mime_type?: string
    file_size?: number
  }
  entities?: Array<{
    type: string
    offset: number
    length: number
    url?: string
    user?: { id: number; first_name?: string; username?: string }
    language?: string
  }>
}

interface TelegramRawUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  callback_query?: {
    id: string
    from: {
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
    }
    message?: TelegramMessage
    chat_instance: string
    data?: string
    game_short_name?: string
  }
  message_reaction?: {
    chat: { id: number }
    message_id: number
    user?: { id: number; is_bot: boolean }
    date: number
    new_reaction: Array<{ type: string; emoji: string }>
  }
}

// ---- Normalization helpers ----

function normalizeUpdate(raw: TelegramRawUpdate): NormalizedTelegramUpdate | null {
  if (raw.message) {
    const message = normalizeMessage(raw.message)
    if (!message) {
      return null
    }
    return { type: 'message', updateId: raw.update_id, message }
  }

  if (raw.edited_message) {
    const message = normalizeMessage(raw.edited_message)
    if (!message) {
      return null
    }
    return { type: 'edited_message', updateId: raw.update_id, message }
  }

  if (raw.callback_query) {
    const query = normalizeCallbackQuery(raw.callback_query)
    return { type: 'callback_query', updateId: raw.update_id, query }
  }

  if (raw.message_reaction) {
    return {
      type: 'message_reaction',
      updateId: raw.update_id,
      reaction: {
        chatId: raw.message_reaction.chat.id,
        messageId: raw.message_reaction.message_id,
        user: raw.message_reaction.user
          ? { id: raw.message_reaction.user.id, isBot: raw.message_reaction.user.is_bot }
          : undefined,
        reactions: raw.message_reaction.new_reaction.map((r) => ({
          emoji: r.emoji,
          type: r.type as 'emoji' | 'custom_emoji',
        })),
        date: raw.message_reaction.date,
      },
    }
  }

  return null
}

function normalizeMessage(raw: TelegramMessage): NormalizedTelegramMessage | null {
  const chatType = raw.chat.type as NormalizedTelegramMessage['chatType']
  if (!chatType) {
    return null
  }

  return {
    messageId: raw.message_id,
    chatId: raw.chat.id,
    chatType,
    chatTitle: raw.chat.title,
    threadId: raw.message_thread_id,
    from: raw.from
      ? {
          id: raw.from.id,
          firstName: raw.from.first_name,
          lastName: raw.from.last_name,
          username: raw.from.username,
          isBot: raw.from.is_bot,
        }
      : undefined,
    date: raw.date,
    text: raw.text,
    caption: raw.caption,
    replyToMessageId: raw.reply_to_message?.message_id,
    forwardFrom: raw.forward_from
      ? { id: raw.forward_from.id, firstName: raw.forward_from.first_name, username: raw.forward_from.username }
      : undefined,
    editDate: raw.edit_date,
    document: raw.document
      ? {
          fileId: raw.document.file_id,
          fileUniqueId: raw.document.file_unique_id,
          fileName: raw.document.file_name,
          mimeType: raw.document.mime_type,
          fileSize: raw.document.file_size,
        }
      : undefined,
    photo: raw.photo?.map(normalizePhotoSize),
    entities: raw.entities?.map(normalizeEntity),
  }
}

function normalizePhotoSize(raw: NonNullable<TelegramMessage['photo']>[number]): NormalizedTelegramPhotoSize {
  return {
    fileId: raw.file_id,
    fileUniqueId: raw.file_unique_id,
    width: raw.width,
    height: raw.height,
    fileSize: raw.file_size,
  }
}

function normalizeEntity(raw: NonNullable<TelegramMessage['entities']>[number]): NormalizedTelegramEntity {
  return {
    type: raw.type as NormalizedTelegramEntity['type'],
    offset: raw.offset,
    length: raw.length,
    url: raw.url,
    user: raw.user
      ? { id: raw.user.id, firstName: raw.user.first_name, username: raw.user.username }
      : undefined,
    language: raw.language,
  }
}

function normalizeCallbackQuery(raw: NonNullable<TelegramRawUpdate['callback_query']>): NormalizedTelegramCallbackQuery {
  return {
    id: raw.id,
    from: {
      id: raw.from.id,
      firstName: raw.from.first_name,
      lastName: raw.from.last_name,
      username: raw.from.username,
      isBot: raw.from.is_bot,
    },
    message: raw.message ? normalizeMessage(raw.message) ?? undefined : undefined,
    chatInstance: raw.chat_instance,
    data: raw.data,
    gameShortName: raw.game_short_name,
  }
}

// ---- Error class ----

export class TelegramApiError extends Error {
  readonly code: number | undefined

  constructor(message: string, code?: number) {
    super(message)
    this.name = 'TelegramApiError'
    this.code = code
  }
}

function isTruthy<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}
