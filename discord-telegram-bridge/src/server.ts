// HTTP server for the discord-telegram-bridge.
// Exposes two sets of routes on the same port:
//   1. /api/v10/* — Discord REST routes consumed by discord.js
//   2. Internal update receiver for Telegram polling
//
// Also hosts the WebSocket gateway at /telegram/gateway for discord.js Gateway.

import http from 'node:http'
import { Spiceflow } from 'spiceflow'
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  ComponentType,
  GatewayDispatchEvents,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildMFALevel,
  GuildNSFWLevel,
  GuildPremiumTier,
  GuildSystemChannelFlags,
  GuildVerificationLevel,
  InteractionResponseType,
  InteractionType,
  Locale,
  MessageType,
} from 'discord-api-types/v10'
import type {
  APIApplicationCommand,
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIUser,
  GatewayGuildCreateDispatchData,
} from 'discord-api-types/v10'
import { TelegramBridgeGateway, type GatewayEmitter, type GatewayState } from './gateway.js'
import * as rest from './rest-translator.js'
import * as events from './event-translator.js'
import { TelegramBotClient } from './telegram-client.js'
import { isThreadChannelId, resolveTelegramTarget, encodeThreadId, decodeThreadId, resolveDiscordChannelId } from './id-converter.js'
import { createTypingCoordinator } from './typing-coordinator.js'
import { decodeCallbackData } from './component-converter.js'
import type {
  BridgeAuthorizeCallback,
  CachedTelegramUser,
  NormalizedTelegramMessage,
  NormalizedTelegramUpdate,
  PendingInteraction,
} from './types.js'

export interface ServerConfig {
  telegram: TelegramBotClient
  botUserId: number
  botUsername: string
  botToken: string
  chatId: number
  port: number
  gatewayUrlOverride?: string
  publicBaseUrl?: string
  authorize?: BridgeAuthorizeCallback
}

export interface ServerComponents {
  httpServer: http.Server
  gateway: GatewayEmitter
  app: Spiceflow
}

export interface BridgeAppComponents {
  app: Spiceflow
  loadGatewayState: () => Promise<GatewayState>
  setGateway: (gateway: GatewayEmitter) => void
}

// User cache: avoids hitting Telegram getChatMember on every inbound event.
const USER_CACHE_TTL_MS = 60 * 60 * 1000
const USER_CACHE_MAX = 500

export function createBridgeApp(config: ServerConfig): BridgeAppComponents {
  const {
    telegram,
    botUserId,
    botUsername,
    chatId,
    port,
    authorize,
  } = config

  let gateway: GatewayEmitter = createNoopGatewayEmitter()

  const pendingInteractions = new Map<string, PendingInteraction>()
  const applicationCommandRegistry = new Map<string, APIApplicationCommand[]>()
  const knownThreadChannels = new Set<string>()

  const userCache = new Map<string, { user: CachedTelegramUser; expiresAt: number }>()

  const typingCoordinator = createTypingCoordinator({
    sendChatAction: async ({ chatId: cId, messageThreadId, action }) => {
      await telegram.sendChatAction({ chatId: cId, messageThreadId, action })
    },
  })

  const app = new Spiceflow({ basePath: '' }).onError(({ error }) => {
    if (error instanceof Response) {
      return error
    }
    return errorJsonResponse({
      status: 500,
      error: 'internal_server_error',
      message: error instanceof Error ? error.message : 'Unknown error',
    })
  })

  // ---- Telegram Update Handler ----

  // Set up polling handler
  telegram.onUpdate((updates) => {
    for (const update of updates) {
      void handleTelegramUpdate(update)
    }
  })

  async function handleTelegramUpdate(update: NormalizedTelegramUpdate): Promise<void> {
    if (update.type === 'message') {
      // Check if message is a bot command (starts with /)
      const isCommand = update.message.entities?.some(
        (e) => e.type === 'bot_command' && e.offset === 0,
      )
      if (isCommand && update.message.text) {
        await handleSlashCommand(update.message)
        return
      }

      const author = await lookupUser(update.message.from?.id ?? botUserId)
      const translated = events.translateMessageCreate({
        message: update.message,
        guildId: chatId.toString(),
        author,
      })
      if (translated) {
        gateway.broadcast(translated.eventName, translated.data)
      }
      return
    }

    if (update.type === 'edited_message') {
      const author = await lookupUser(update.message.from?.id ?? botUserId)
      const translated = events.translateMessageUpdate({
        message: update.message,
        guildId: chatId.toString(),
        author,
      })
      if (translated) {
        gateway.broadcast(translated.eventName, translated.data)
      }
      return
    }

    if (update.type === 'callback_query') {
      await handleCallbackQuery(update.query)
      return
    }

    // message_reaction and other update types ignored for now
  }

  async function handleCallbackQuery(query: import('./types.js').NormalizedTelegramCallbackQuery): Promise<void> {
    // Answer the callback query to remove the loading spinner
    await telegram.answerCallbackQuery({
      callbackQueryId: query.id,
    })

    if (!query.data) {
      return
    }

    const decoded = decodeCallbackData(query.data)
    const interactionId = crypto.randomUUID()
    const interactionToken = crypto.randomUUID()

    const channelId = query.message
      ? (() => {
          const { resolveDiscordChannelId } = requireIdConverter()
          return resolveDiscordChannelId({
            chatId: query.message.chatId,
            messageThreadId: query.message.threadId,
          })
        })()
      : chatId.toString()

    pendingInteractions.set(interactionId, {
      id: interactionId,
      token: interactionToken,
      channelId,
      guildId: chatId.toString(),
      acknowledged: false,
      telegramChatId: query.message?.chatId ?? chatId,
      telegramMessageId: query.message?.messageId,
    })

    // Broadcast as INTERACTION_CREATE (component interaction)
    const componentType = decoded.componentType ?? ComponentType.Button
    gateway.broadcast(GatewayDispatchEvents.InteractionCreate, {
      id: interactionId,
      application_id: botUserId.toString(),
      type: InteractionType.MessageComponent,
      token: interactionToken,
      version: 1,
      entitlements: [],
      channel_id: channelId,
      guild_id: chatId.toString(),
      member: {
        user: {
          id: query.from.id.toString(),
          username: query.from.username ?? query.from.firstName,
          discriminator: '0',
          avatar: null,
        },
        roles: [],
        joined_at: new Date().toISOString(),
        deaf: false,
        mute: false,
      },
      data: {
        custom_id: decoded.customId,
        component_type: componentType,
      },
      message: query.message
        ? {
            id: query.message.messageId.toString(),
            channel_id: channelId,
            author: {
              id: botUserId.toString(),
              username: botUsername,
              discriminator: '0',
              avatar: null,
              bot: true,
            },
            content: '',
            timestamp: new Date(query.message.date * 1000).toISOString(),
            edited_timestamp: null,
            tts: false,
            mention_everyone: false,
            mentions: [],
            mention_roles: [],
            attachments: [],
            embeds: [],
            pinned: false,
            type: MessageType.Default,
            guild_id: chatId.toString(),
          }
        : undefined,
    })
  }

  async function handleSlashCommand(message: NormalizedTelegramMessage): Promise<void> {
    if (!message.text) {
      return
    }

    // Parse /command[@bot] args...
    const text = message.text
    const entity = message.entities?.find(
      (e) => e.type === 'bot_command' && e.offset === 0,
    )
    if (!entity) {
      return
    }

    const commandPart = text.slice(0, entity.length)
    // Remove @botname suffix if present
    const commandName = commandPart.split('@')[0]?.replace('/', '') ?? ''
    const args = text.slice(entity.length).trim()

    const interactionId = crypto.randomUUID()
    const interactionToken = crypto.randomUUID()

    const channelId = resolveDiscordChannelId({
      chatId: message.chatId,
      messageThreadId: message.threadId,
    })

    // Find matching registered command
    const allCommands = [...applicationCommandRegistry.values()].flat()
    const matchedCommand = allCommands.find(
      (cmd) => (cmd as unknown as Record<string, unknown>).name === commandName,
    )

    if (!matchedCommand) {
      // Unknown command — still send as message so the bot can respond
      const author = await lookupUser(message.from?.id ?? botUserId)
      const translated = events.translateMessageCreate({
        message,
        guildId: chatId.toString(),
        author,
      })
      if (translated) {
        gateway.broadcast(translated.eventName, translated.data)
      }
      return
    }

    pendingInteractions.set(interactionId, {
      id: interactionId,
      token: interactionToken,
      channelId,
      guildId: chatId.toString(),
      acknowledged: false,
      telegramChatId: message.chatId,
      telegramMessageId: message.messageId,
    })

    const author = message.from
    gateway.broadcast(GatewayDispatchEvents.InteractionCreate, {
      id: interactionId,
      application_id: botUserId.toString(),
      type: InteractionType.ApplicationCommand,
      token: interactionToken,
      version: 1,
      entitlements: [],
      channel_id: channelId,
      guild_id: chatId.toString(),
      member: {
        user: author
          ? {
              id: author.id.toString(),
              username: author.username ?? author.firstName,
              discriminator: '0',
              avatar: null,
            }
          : {
              id: botUserId.toString(),
              username: botUsername,
              discriminator: '0',
              avatar: null,
            },
        roles: [],
        joined_at: new Date().toISOString(),
        deaf: false,
        mute: false,
      },
      data: {
        id: (matchedCommand as unknown as Record<string, unknown>).id ?? interactionId,
        name: commandName,
        type: ApplicationCommandType.ChatInput,
        options: args ? [{ name: 'input', type: ApplicationCommandOptionType.String, value: args }] : [],
      },
    })
  }

  // ---- Discord REST Routes ----

  // GET /api/v10/gateway/bot
  app.get('/api/v10/gateway/bot', ({ request }) => {
    const gatewayUrl = resolveGatewayUrl({
      request,
      gatewayUrlOverride: config.gatewayUrlOverride,
      publicBaseUrl: config.publicBaseUrl,
      port,
    })
    return Response.json({
      url: gatewayUrl,
      shards: 1,
      session_start_limit: {
        total: 1000,
        remaining: 999,
        reset_after: 14400000,
        max_concurrency: 1,
      },
    })
  })

  // GET /api/v10/users/@me
  app.get('/api/v10/users/@me', async () => {
    const user = await rest.getUser({ telegram, userId: botUserId.toString() })
    return withRateLimitHeaders(Response.json(user))
  })

  // GET /api/v10/users/:user_id
  app.get('/api/v10/users/:user_id', async ({ params }) => {
    const userId = readString(params, 'user_id')
    if (!userId) {
      return errorJsonResponse({ status: 400, error: 'missing_user_id' })
    }
    const user = await rest.getUser({ telegram, userId })
    return withRateLimitHeaders(Response.json(user))
  })

  // GET /api/v10/applications/@me
  app.get('/api/v10/applications/@me', () => {
    return withRateLimitHeaders(
      Response.json({
        id: botUserId.toString(),
        name: botUsername,
        bot: { id: botUserId.toString(), username: botUsername },
      }),
    )
  })

  // PUT /api/v10/applications/:application_id/commands
  app.put('/api/v10/applications/:application_id/commands', async ({ params, request }) => {
    const applicationId = readString(params, 'application_id')
    if (!applicationId) {
      return errorJsonResponse({ status: 400, error: 'missing_application_id' })
    }
    const commands = normalizeApplicationCommandsBody(await request.json())
    const key = applicationId
    applicationCommandRegistry.set(key, commands as unknown as APIApplicationCommand[])

    // Register commands with Telegram
    await telegram.setMyCommands({
      commands: commands.map((cmd) => ({
        command: cmd.name,
        description: cmd.description ?? '',
      })),
    })

    return withRateLimitHeaders(Response.json(commands))
  })

  // GET /api/v10/applications/:application_id/commands
  app.get('/api/v10/applications/:application_id/commands', async ({ params }) => {
    const applicationId = readString(params, 'application_id')
    if (!applicationId) {
      return errorJsonResponse({ status: 400, error: 'missing_application_id' })
    }
    const commands = applicationCommandRegistry.get(applicationId) ?? []
    return withRateLimitHeaders(Response.json(commands))
  })

  // PUT /api/v10/applications/:application_id/guilds/:guild_id/commands
  app.put('/api/v10/applications/:application_id/guilds/:guild_id/commands', async ({ params, request }) => {
    const applicationId = readString(params, 'application_id')
    const guildId = readString(params, 'guild_id')
    if (!(applicationId && guildId)) {
      return errorJsonResponse({ status: 400, error: 'missing_application_or_guild_id' })
    }
    const commands = normalizeApplicationCommandsBody(await request.json())
    const key = `${applicationId}:${guildId}`
    applicationCommandRegistry.set(key, commands as unknown as APIApplicationCommand[])

    // Register commands with Telegram (guild-scoped use same setMyCommands since
    // Telegram doesn't support per-chat command registration)
    await telegram.setMyCommands({
      commands: commands.map((cmd) => ({
        command: cmd.name,
        description: cmd.description ?? '',
      })),
    })

    return withRateLimitHeaders(Response.json(commands))
  })

  // GET /api/v10/applications/:application_id/guilds/:guild_id/commands
  app.get('/api/v10/applications/:application_id/guilds/:guild_id/commands', async ({ params }) => {
    const applicationId = readString(params, 'application_id')
    const guildId = readString(params, 'guild_id')
    if (!(applicationId && guildId)) {
      return errorJsonResponse({ status: 400, error: 'missing_application_or_guild_id' })
    }
    const key = `${applicationId}:${guildId}`
    const commands = applicationCommandRegistry.get(key) ?? []
    return withRateLimitHeaders(Response.json(commands))
  })

  // GET /api/v10/applications/:application_id/guilds/:guild_id/commands/:command_id
  app.get('/api/v10/applications/:application_id/guilds/:guild_id/commands/:command_id', async ({ params }) => {
    const applicationId = readString(params, 'application_id')
    const guildId = readString(params, 'guild_id')
    const commandId = readString(params, 'command_id')
    if (!(applicationId && guildId)) {
      return errorJsonResponse({ status: 400, error: 'missing_application_or_guild_id' })
    }
    const key = `${applicationId}:${guildId}`
    const commands = applicationCommandRegistry.get(key) ?? []
    const command = commands.find((c) => (c as unknown as Record<string, unknown>).id === commandId)
    if (!command) {
      return errorJsonResponse({ status: 404, error: 'unknown_command' })
    }
    return withRateLimitHeaders(Response.json(command))
  })

  // POST /api/v10/channels/:channel_id/messages
  app.post('/api/v10/channels/:channel_id/messages', async ({ params, request }) => {
    const body = await normalizePostMessageRequestBody(request)
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    const message = await rest.postMessage({
      telegram,
      channelId,
      body,
      botUserId: botUserId.toString(),
      guildId: chatId.toString(),
    })

    if (isThreadChannelId(channelId)) {
      const target = resolveTelegramTarget(channelId)
      typingCoordinator.noteAssistantMessage({ chatId: target.chatId })
    }

    return withRateLimitHeaders(Response.json(message))
  })

  // PATCH /api/v10/channels/:channel_id/messages/:message_id
  app.patch('/api/v10/channels/:channel_id/messages/:message_id', async ({ params, request }) => {
    const body = normalizeEditMessageBody(await request.json())
    const channelId = readString(params, 'channel_id')
    const messageId = readString(params, 'message_id')
    if (!(channelId && messageId)) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_or_message_id' })
    }
    const message = await rest.editMessage({
      telegram,
      channelId,
      messageId,
      body,
      botUserId: botUserId.toString(),
      guildId: chatId.toString(),
    })
    return withRateLimitHeaders(Response.json(message))
  })

  // DELETE /api/v10/channels/:channel_id/messages/:message_id
  app.delete('/api/v10/channels/:channel_id/messages/:message_id', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    const messageId = readString(params, 'message_id')
    if (!(channelId && messageId)) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_or_message_id' })
    }
    await rest.deleteMessage({ telegram, channelId, messageId })
    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // POST /api/v10/channels/:channel_id/typing
  app.post('/api/v10/channels/:channel_id/typing', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    const target = resolveTelegramTarget(channelId)
    typingCoordinator.requestStart({
      chatId: target.chatId,
      messageThreadId: target.messageThreadId,
    })
    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // GET /api/v10/channels/:channel_id
  app.get('/api/v10/channels/:channel_id', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    const channel = await rest.getChannel({
      telegram,
      channelId,
      guildId: chatId.toString(),
    })
    return withRateLimitHeaders(Response.json(channel))
  })

  // PATCH /api/v10/channels/:channel_id
  app.patch('/api/v10/channels/:channel_id', async ({ params, request }) => {
    const body = normalizePatchChannelBody(await request.json())
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    const channel = await rest.updateChannel({
      telegram,
      channelId,
      body,
      guildId: chatId.toString(),
    })
    return withRateLimitHeaders(Response.json(channel))
  })

  // POST /api/v10/channels/:channel_id/threads
  app.post('/api/v10/channels/:channel_id/threads', async ({ params, request }) => {
    const body = normalizeCreateThreadBody(await request.json())
    const parentChannelId = readString(params, 'channel_id')
    if (!parentChannelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    const thread = await rest.createThread({
      telegram,
      parentChannelId,
      body,
      botUserId: botUserId.toString(),
      guildId: chatId.toString(),
    })
    knownThreadChannels.add(thread.id)
    gateway.broadcast(GatewayDispatchEvents.ThreadCreate, {
      ...thread,
      newly_created: true,
    })
    return withRateLimitHeaders(Response.json(thread))
  })

  // POST /api/v10/channels/:channel_id/messages/:message_id/threads
  app.post('/api/v10/channels/:channel_id/messages/:message_id/threads', async ({ params, request }) => {
    const body = normalizeCreateThreadBody(await request.json())
    const parentChannelId = readString(params, 'channel_id')
    const messageId = readString(params, 'message_id')
    if (!(parentChannelId && messageId)) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_or_message_id' })
    }
    const thread = await rest.createThreadFromMessage({
      telegram,
      parentChannelId,
      messageId,
      body,
      botUserId: botUserId.toString(),
      guildId: chatId.toString(),
    })
    knownThreadChannels.add(thread.id)
    gateway.broadcast(GatewayDispatchEvents.ThreadCreate, {
      ...thread,
      newly_created: true,
    })
    return withRateLimitHeaders(Response.json(thread))
  })

  // GET /api/v10/channels/:channel_id/thread-members
  app.get('/api/v10/channels/:channel_id/thread-members', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    const members = await rest.listThreadMembers({
      telegram,
      threadChannelId: channelId,
      botUserId: botUserId.toString(),
    })
    return withRateLimitHeaders(Response.json(members))
  })

  // GET /api/v10/channels/:channel_id/thread-members/@me
  app.get('/api/v10/channels/:channel_id/thread-members/@me', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    return withRateLimitHeaders(Response.json([{
      id: botUserId.toString(),
      user_id: botUserId.toString(),
      join_timestamp: new Date().toISOString(),
      flags: 0,
    }]))
  })

  // PUT /api/v10/channels/:channel_id/thread-members/@me
  app.put('/api/v10/channels/:channel_id/thread-members/@me', () => {
    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // DELETE /api/v10/channels/:channel_id/thread-members/@me
  app.delete('/api/v10/channels/:channel_id/thread-members/@me', () => {
    // Telegram bots can't leave topics the same way
    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // PUT /api/v10/channels/:channel_id/thread-members/:user_id
  app.put('/api/v10/channels/:channel_id/thread-members/:user_id', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    const userId = readString(params, 'user_id')
    if (!(channelId && userId)) {
      return errorJsonResponse({ status: 400, error: 'missing_thread_member_route_params' })
    }
    // Telegram doesn't have thread member joins — accept silently
    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // GET /api/v10/guilds/:guild_id
  app.get('/api/v10/guilds/:guild_id', ({ params }) => {
    return withRateLimitHeaders(
      Response.json({
        id: chatId.toString(),
        name: 'Telegram Chat',
        owner_id: botUserId.toString(),
        roles: [],
        emojis: [],
        features: [],
        verification_level: GuildVerificationLevel.None,
        default_message_notifications: GuildDefaultMessageNotifications.AllMessages,
        explicit_content_filter: GuildExplicitContentFilter.Disabled,
        mfa_level: GuildMFALevel.None,
        system_channel_flags: GuildSystemChannelFlags.SuppressJoinNotifications,
        premium_tier: GuildPremiumTier.None,
        nsfw_level: GuildNSFWLevel.Default,
      }),
    )
  })

  // GET /api/v10/guilds/:guild_id/channels
  app.get('/api/v10/guilds/:guild_id/channels', async () => {
    const chatInfo = await telegram.getChat({ chatId })
    const channel: APIChannel = {
      id: chatId.toString(),
      type: ChannelType.GuildText,
      name: chatInfo.title ?? 'telegram-chat',
      guild_id: chatId.toString(),
      position: 0,
    }
    return withRateLimitHeaders(Response.json([channel]))
  })

  // POST /api/v10/guilds/:guild_id/channels
  app.post('/api/v10/guilds/:guild_id/channels', async ({ request }) => {
    const body = normalizeCreateGuildChannelBody(await request.json())
    // Telegram has a single chat; creating channels isn't meaningful.
    // Return a synthetic channel to keep discord.js happy.
    const syntheticId = chatId.toString()
    const channel: APIChannel = {
      id: syntheticId,
      type: ChannelType.GuildText,
      name: body.name ?? 'telegram-chat',
      guild_id: chatId.toString(),
      position: 0,
    }
    return withRateLimitHeaders(Response.json(channel))
  })

  // GET /api/v10/guilds/:guild_id/members
  app.get('/api/v10/guilds/:guild_id/members', async () => {
    const members = await rest.listGuildMembers({ telegram, chatId })
    return withRateLimitHeaders(Response.json(members))
  })

  // GET /api/v10/guilds/:guild_id/members/:uid
  app.get('/api/v10/guilds/:guild_id/members/:uid', async ({ params }) => {
    const uid = readString(params, 'uid')
    if (!uid) {
      return errorJsonResponse({ status: 400, error: 'missing_uid' })
    }
    const member = await rest.getGuildMember({
      telegram,
      chatId,
      userId: Number(uid),
    })
    return withRateLimitHeaders(Response.json(member))
  })

  // GET /api/v10/guilds/:guild_id/roles
  app.get('/api/v10/guilds/:guild_id/roles', async () => {
    const roles = await rest.listGuildRoles({ telegram, chatId })
    return withRateLimitHeaders(Response.json(roles))
  })

  // GET /api/v10/guilds/:guild_id/threads/active
  app.get('/api/v10/guilds/:guild_id/threads/active', async ({ params }) => {
    const guildId = readString(params, 'guild_id')
    if (!guildId) {
      return errorJsonResponse({ status: 400, error: 'missing_guild_id' })
    }
    // Telegram doesn't have an "active threads" API.
    // Return known threads tracked from createThread calls.
    const threads: APIChannel[] = []
    for (const threadId of knownThreadChannels) {
      const { chatId: cId, topicMessageId } = decodeThreadId(threadId)
      threads.push({
        id: threadId,
        type: ChannelType.PublicThread,
        name: `topic-${topicMessageId}`,
        guild_id: guildId,
        parent_id: cId.toString(),
        message_count: 0,
        member_count: 0,
        thread_metadata: {
          archived: false,
          auto_archive_duration: 1440,
          archive_timestamp: new Date().toISOString(),
          locked: false,
        },
      })
    }
    return withRateLimitHeaders(Response.json({
      threads,
      members: threads.map((t) => ({
        id: botUserId.toString(),
        user_id: botUserId.toString(),
        join_timestamp: new Date().toISOString(),
        flags: 0,
      })),
      has_more: false,
    }))
  })

  // GET /api/v10/channels/:channel_id/messages
  app.get('/api/v10/channels/:channel_id/messages', async ({ params }) => {
    const channelId = readString(params, 'channel_id')
    if (!channelId) {
      return errorJsonResponse({ status: 400, error: 'missing_channel_id' })
    }
    // Telegram message history requires separate getUpdates logic.
    // Return empty array — discord.js typically fetches this for cache warm-up.
    return withRateLimitHeaders(Response.json([]))
  })

  // POST /api/v10/interactions/:interaction_id/:interaction_token/callback
  app.post('/api/v10/interactions/:interaction_id/:interaction_token/callback', async ({ params, request }) => {
    const body = normalizeInteractionCallbackBody(await request.json())
    const interactionId = readString(params, 'interaction_id')
    const interactionToken = readString(params, 'interaction_token')
    if (!(interactionId && interactionToken)) {
      return errorJsonResponse({ status: 400, error: 'missing_interaction_route_params' })
    }

    const pending = pendingInteractions.get(interactionId)
    if (!pending) {
      return errorJsonResponse({ status: 404, error: 'unknown_interaction' })
    }
    if (pending.token !== interactionToken) {
      return errorJsonResponse({ status: 401, error: 'invalid_interaction_token' })
    }

    pending.acknowledged = true

    // CHANNEL_MESSAGE_WITH_SOURCE
    if (body.type === InteractionResponseType.ChannelMessageWithSource && body.data) {
      const message = await rest.postMessage({
        telegram,
        channelId: pending.channelId,
        body: { content: body.data.content },
        botUserId: botUserId.toString(),
        guildId: chatId.toString(),
      })
      gateway.broadcastMessageCreate(message, chatId.toString())
    }

    // UPDATE_MESSAGE — edit the source message
    if (body.type === InteractionResponseType.UpdateMessage && body.data && pending.telegramMessageId) {
      const editBody: { content?: string; components?: unknown[] } = {}
      if (body.data.content) {
        editBody.content = body.data.content
      }
      if (body.data.components) {
        editBody.components = body.data.components
      }
      const message = await rest.editMessage({
        telegram,
        channelId: pending.channelId,
        messageId: pending.telegramMessageId.toString(),
        body: editBody,
        botUserId: botUserId.toString(),
        guildId: chatId.toString(),
      })
      gateway.broadcast(GatewayDispatchEvents.MessageUpdate, {
        ...message,
        guild_id: chatId.toString(),
      })
    }

    // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    if (body.type === 5) {
      // Acknowledged, response comes later
    }

    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // POST /api/v10/webhooks/:webhook_id/:webhook_token (follow-up message)
  app.post('/api/v10/webhooks/:webhook_id/:webhook_token', async ({ params, request }) => {
    const body = await normalizePostMessageRequestBody(request)
    const webhookToken = readString(params, 'webhook_token')
    if (!webhookToken) {
      return errorJsonResponse({ status: 400, error: 'missing_webhook_token' })
    }
    const pending = [...pendingInteractions.values()].find(
      (p) => p.token === webhookToken,
    )
    if (!pending) {
      return errorJsonResponse({ status: 404, error: 'unknown_webhook_token' })
    }

    const message = await rest.postMessage({
      telegram,
      channelId: pending.channelId,
      body,
      botUserId: botUserId.toString(),
      guildId: chatId.toString(),
    })
    if (isThreadChannelId(pending.channelId)) {
      typingCoordinator.noteAssistantMessage({
        chatId: resolveTelegramTarget(pending.channelId).chatId,
      })
    }
    return withRateLimitHeaders(Response.json(message))
  })

  // PATCH /api/v10/webhooks/:webhook_id/:webhook_token/messages/:message_id
  app.patch('/api/v10/webhooks/:webhook_id/:webhook_token/messages/:message_id', async ({ params, request }) => {
    const body = normalizeWebhookBody(await request.json())
    const webhookToken = readString(params, 'webhook_token')
    const rawMessageId = readString(params, 'message_id')
    if (!webhookToken) {
      return errorJsonResponse({ status: 400, error: 'missing_webhook_token' })
    }
    const pending = [...pendingInteractions.values()].find((entry) => {
      return entry.token === webhookToken
    })
    if (!pending) {
      return errorJsonResponse({ status: 404, error: 'unknown_webhook_token' })
    }

    // Resolve which message to edit: @original → source message, otherwise use ID
    const resolvedMessageId = rawMessageId === '@original'
      ? pending.telegramMessageId?.toString()
      : rawMessageId
    if (!resolvedMessageId) {
      return errorJsonResponse({ status: 400, error: 'no_source_message_for_webhook_update' })
    }

    const message = await rest.editMessage({
      telegram,
      channelId: pending.channelId,
      messageId: resolvedMessageId,
      body: { content: body.content },
      botUserId: botUserId.toString(),
      guildId: chatId.toString(),
    })
    if (isThreadChannelId(pending.channelId)) {
      typingCoordinator.noteAssistantMessage({
        chatId: resolveTelegramTarget(pending.channelId).chatId,
      })
    }
    return withRateLimitHeaders(Response.json(message))
  })

  // DELETE /api/v10/webhooks/:webhook_id/:webhook_token/messages/:message_id
  app.delete('/api/v10/webhooks/:webhook_id/:webhook_token/messages/:message_id', async ({ params }) => {
    const webhookToken = readString(params, 'webhook_token')
    const rawMessageId = readString(params, 'message_id')
    if (!webhookToken) {
      return errorJsonResponse({ status: 400, error: 'missing_webhook_token' })
    }
    const pending = [...pendingInteractions.values()].find((entry) => {
      return entry.token === webhookToken
    })
    if (!pending) {
      return errorJsonResponse({ status: 404, error: 'unknown_webhook_token' })
    }

    const resolvedMessageId = rawMessageId === '@original'
      ? pending.telegramMessageId?.toString()
      : rawMessageId
    if (resolvedMessageId) {
      await rest.deleteMessage({
        telegram,
        channelId: pending.channelId,
        messageId: resolvedMessageId,
      })
    }
    return withRateLimitHeaders(new Response(null, { status: 204 }))
  })

  // ---- User cache ----

  async function lookupUser(userId: number): Promise<CachedTelegramUser> {
    const key = userId.toString()
    const cached = userCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.user
    }

    try {
      const member = await telegram.getChatMember({
        chatId,
        userId,
      })
      const user: CachedTelegramUser = {
        id: member.user.id,
        firstName: member.user.first_name,
        lastName: member.user.last_name,
        username: member.user.username,
        isBot: member.user.is_bot,
      }

      // Evict oldest if cache is full
      if (userCache.size >= USER_CACHE_MAX) {
        const firstKey = userCache.keys().next().value
        if (firstKey) {
          userCache.delete(firstKey)
        }
      }

      userCache.set(key, {
        user,
        expiresAt: Date.now() + USER_CACHE_TTL_MS,
      })
      return user
    } catch {
      return {
        id: userId,
        firstName: userId.toString(),
        isBot: false,
      }
    }
  }

  // ---- Gateway state loader ----

  const loadGatewayState = async (): Promise<GatewayState> => {
    const chatInfo = await telegram.getChat({ chatId })
    const botInfo = await telegram.getMe()

    const botUser: APIUser = {
      id: botInfo.id.toString(),
      username: botInfo.username ?? botInfo.first_name,
      discriminator: '0',
      avatar: null,
      bot: true,
      global_name: botInfo.first_name,
    }

    const apiGuild = buildGatewayGuild({
      chatId: chatId.toString(),
      chatName: chatInfo.title ?? 'Telegram Chat',
      botUserId: botUserId.toString(),
    })

    let guildMembers: APIGuildMember[] = []
    try {
      guildMembers = await rest.listGuildMembers({ telegram, chatId })
    } catch {
      // If we can't list members, just use bot
    }

    const channel = events.buildMainChannel({
      chatId,
      chatTitle: chatInfo.title,
      guildId: chatId.toString(),
      isForum: chatInfo.is_forum,
    })

    return {
      botUser,
      guilds: [
        {
          id: chatId.toString(),
          apiGuild,
          joinedAt: new Date().toISOString(),
          members: guildMembers,
          channels: [channel] as GatewayGuildCreateDispatchData['channels'],
        },
      ],
    }
  }

  return {
    app,
    loadGatewayState,
    setGateway: (gw: GatewayEmitter) => {
      gateway = gw
    },
  }
}

export async function createServer(config: ServerConfig): Promise<ServerComponents> {
  const bridgeApp = createBridgeApp(config)
  const httpServer = http.createServer()
  const gw = new TelegramBridgeGateway({
    httpServer,
    port: config.port,
    loadState: bridgeApp.loadGatewayState,
    expectedToken: config.botToken,
    gatewayUrlOverride: config.gatewayUrlOverride,
    authorize: config.authorize,
    chatId: config.chatId.toString(),
  })

  // Mount Spicefly on the HTTP server
  httpServer.on('request', (req, res) => {
    void bridgeApp.app.handleForNode(req, res)
  })

  return {
    httpServer,
    gateway: gw,
    app: bridgeApp.app,
  }
}

export async function startServer(components: ServerComponents, port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    components.httpServer.listen(port, () => resolve())
  })
}

export async function stopServer(components: ServerComponents): Promise<void> {
  components.gateway.close()
  await new Promise<void>((resolve) => {
    components.httpServer.close(() => resolve())
  })
}

// ---- Helpers ----

function createNoopGatewayEmitter(): GatewayEmitter {
  return {
    broadcast: () => {},
    broadcastMessageCreate: () => {},
    close: () => {},
  }
}

function resolveGatewayUrl({
  request,
  gatewayUrlOverride,
  publicBaseUrl,
  port,
}: {
  request: Request
  gatewayUrlOverride?: string
  publicBaseUrl?: string
  port: number
}): string {
  if (gatewayUrlOverride) {
    return gatewayUrlOverride
  }
  const host = request.headers.get('host')
  if (host) {
    const protocol = request.headers.get('x-forwarded-proto') ?? 'http'
    const wsProtocol = protocol === 'https' ? 'wss' : 'ws'
    return `${wsProtocol}://${host}/telegram/gateway`
  }
  if (publicBaseUrl) {
    const origin = new URL(publicBaseUrl)
    const wsProtocol = origin.protocol === 'https:' ? 'wss' : 'ws'
    return `${wsProtocol}://${origin.host}/telegram/gateway`
  }
  return `ws://127.0.0.1:${port}/telegram/gateway`
}

function readString(obj: unknown, key: string): string | undefined {
  if (typeof obj === 'object' && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

function errorJsonResponse({
  status,
  error,
  message,
  code,
}: {
  status: number
  error: string
  message?: string
  code?: number
}): Response {
  return Response.json(
    { message: message ?? error, code, errors: [{ message: error }] },
    { status },
  )
}

function withRateLimitHeaders(response: Response): Response {
  response.headers.set('x-ratelimit-limit', '30')
  response.headers.set('x-ratelimit-remaining', '29')
  response.headers.set('x-ratelimit-reset', Math.ceil(Date.now() / 1000 + 1).toString())
  return response
}

type NormalizedPostMessageBody = {
  content?: string
  embeds?: unknown[]
  components?: unknown[]
  attachments?: import('./file-upload.js').DiscordAttachment[]
}

async function normalizePostMessageRequestBody(request: Request): Promise<NormalizedPostMessageBody> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const payloadJson = formData.get('payload_json')
    if (typeof payloadJson === 'string') {
      return JSON.parse(payloadJson) as NormalizedPostMessageBody
    }
    return {}
  }
  return (await request.json()) as NormalizedPostMessageBody
}

function normalizeEditMessageBody(body: unknown): { content?: string; components?: unknown[] } {
  if (typeof body !== 'object' || body === null) {
    return {}
  }
  const b = body as Record<string, unknown>
  return {
    content: typeof b.content === 'string' ? b.content : undefined,
    components: Array.isArray(b.components) ? b.components : undefined,
  }
}

function normalizePatchChannelBody(body: unknown): { name?: string } {
  if (typeof body !== 'object' || body === null) {
    return {}
  }
  const b = body as Record<string, unknown>
  return {
    name: typeof b.name === 'string' ? b.name : undefined,
  }
}

function normalizeCreateThreadBody(body: unknown): { name?: string } {
  if (typeof body !== 'object' || body === null) {
    return {}
  }
  const b = body as Record<string, unknown>
  return {
    name: typeof b.name === 'string' ? b.name : undefined,
  }
}

function normalizeInteractionCallbackBody(body: unknown): {
  type: number
  data?: { content?: string; components?: unknown[] }
} {
  if (typeof body !== 'object' || body === null) {
    return { type: 0 }
  }
  const b = body as Record<string, unknown>
  return {
    type: typeof b.type === 'number' ? b.type : 0,
    data: b.data && typeof b.data === 'object'
      ? {
          content: typeof (b.data as Record<string, unknown>).content === 'string'
            ? (b.data as Record<string, unknown>).content as string
            : undefined,
          components: Array.isArray((b.data as Record<string, unknown>).components)
            ? (b.data as Record<string, unknown>).components as unknown[]
            : undefined,
        }
      : undefined,
  }
}

function normalizeApplicationCommandsBody(body: unknown): Array<{
  name: string
  description?: string
  options?: unknown[]
}> {
  if (!Array.isArray(body)) {
    return []
  }
  return body.map((cmd) => {
    const c = cmd as Record<string, unknown>
    return {
      name: typeof c.name === 'string' ? c.name : '',
      description: typeof c.description === 'string' ? c.description : '',
      options: Array.isArray(c.options) ? c.options : [],
    }
  })
}

function normalizeCreateGuildChannelBody(body: unknown): { name?: string; type?: number } {
  if (typeof body !== 'object' || body === null) {
    return {}
  }
  const b = body as Record<string, unknown>
  return {
    name: typeof b.name === 'string' ? b.name : undefined,
    type: typeof b.type === 'number' ? b.type : undefined,
  }
}

function normalizeWebhookBody(body: unknown): { content?: string } {
  if (typeof body !== 'object' || body === null) {
    return {}
  }
  const b = body as Record<string, unknown>
  return {
    content: typeof b.content === 'string' ? b.content : undefined,
  }
}

function requireIdConverter() {
  // Inline the import to avoid top-level circular dependency issues
  return {
    resolveDiscordChannelId: (params: { chatId: number; messageThreadId?: number }) => {
      const { chatId: cId, messageThreadId } = params
      if (messageThreadId) {
        return encodeThreadId(cId, messageThreadId)
      }
      return cId.toString()
    },
  }
}

function buildGatewayGuild({
  chatId,
  chatName,
  botUserId,
}: {
  chatId: string
  chatName: string
  botUserId: string
}): APIGuild {
  return {
    id: chatId,
    name: chatName,
    icon: null,
    splash: null,
    discovery_splash: null,
    owner_id: botUserId,
    afk_channel_id: null,
    afk_timeout: 300,
    verification_level: GuildVerificationLevel.None,
    default_message_notifications: GuildDefaultMessageNotifications.AllMessages,
    explicit_content_filter: GuildExplicitContentFilter.Disabled,
    roles: [],
    emojis: [],
    features: [],
    mfa_level: GuildMFALevel.None,
    application_id: null,
    system_channel_id: null,
    system_channel_flags: GuildSystemChannelFlags.SuppressJoinNotifications,
    rules_channel_id: null,
    vanity_url_code: null,
    description: null,
    banner: null,
    premium_tier: GuildPremiumTier.None,
    premium_subscription_count: 0,
    preferred_locale: Locale.EnglishUS,
    public_updates_channel_id: null,
    nsfw_level: GuildNSFWLevel.Default,
    max_video_channel_users: 0,
    max_stage_video_channel_users: 0,
    premium_progress_bar_enabled: false,
    safety_alerts_channel_id: null,
    stickers: [],
    region: '',
    hub_type: null,
    incidents_data: null,
  }
}
