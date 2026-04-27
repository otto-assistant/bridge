// Durable Object runtime for discord-telegram-bridge in Cloudflare Workers.
// Mirrors SlackBridgeDO architecture: Spiceflow app + GatewaySessionManager
// for Discord REST/Gateway protocol translation over Telegram Bot API.
//
// Key difference from Slack: Telegram uses long polling (getUpdates) instead
// of webhooks. The DO runs the polling loop via ctx.waitUntil + alarm.

import { DurableObject } from 'cloudflare:workers'
import {
  ChannelType,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildMFALevel,
  GuildNSFWLevel,
  GuildPremiumTier,
  GuildSystemChannelFlags,
  GuildVerificationLevel,
  Locale,
} from 'discord-api-types/v10'
import type {
  APIGuild,
  APIGuildMember,
  APIUser,
  GatewayGuildCreateDispatchData,
} from 'discord-api-types/v10'
import { createBridgeApp } from 'discord-telegram-bridge/src/server'
import {
  GatewaySessionManager,
  type GatewayClientSnapshot,
  type GatewaySocketTransport,
} from 'discord-slack-bridge/src/gateway-session-manager'
import { TelegramBotClient } from 'discord-telegram-bridge/src/telegram-client'
import {
  resolveGatewayClientFromCacheOrDb,
} from './gateway-client-kv.js'
import type { Env } from './env.js'

type BridgeRpcRequest = {
  clientId: string
  url: string
  path: string
  method: string
  headers: Array<[string, string]>
  body: string
}

type BridgeRpcResponse = {
  status: number
  headers: Array<[string, string]>
  body: string
}

type GatewayState = {
  botUser: APIUser
  guilds: Array<{
    id: string
    apiGuild: APIGuild
    joinedAt: string
    members: APIGuildMember[]
    channels: GatewayGuildCreateDispatchData['channels']
  }>
}

type RuntimeState = {
  app: {
    handle: (request: Request) => Promise<Response>
  }
  gatewaySessionManager: GatewaySessionManager
  setPublicGatewayUrl: (url: string) => void
  telegram: TelegramBotClient
}

const TELEGRAM_POLL_INTERVAL_MS = 3000

export class TelegramBridgeDO extends DurableObject<Env> {
  private runtimePromise?: Promise<RuntimeState>
  private pollingEnabled = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    )
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/telegram/gateway' || url.pathname.startsWith('/telegram/gateway/')) {
      return this.handleGatewayUpgrade(request)
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  }

  async handleDiscordRest(
    request: BridgeRpcRequest,
  ): Promise<BridgeRpcResponse> {
    try {
      const runtime = await this.getRuntime({ clientId: request.clientId })
      runtime.setPublicGatewayUrl(
        buildGatewayWebSocketUrlFromRequestUrl(request.url),
      )
      const response = await runtime.app.handle(toRequest(request))
      return serializeResponse(response)
    } catch (cause) {
      return {
        status: 500,
        headers: [['content-type', 'application/json']],
        body: JSON.stringify({
          error: 'handleDiscordRest failed',
          details: String(cause),
        }),
      }
    }
  }

  async alarm(): Promise<void> {
    // Continue polling when alarm fires
    if (this.pollingEnabled) {
      await this.runPollingCycle()
    }
  }

  private async handleGatewayUpgrade(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'Expected websocket upgrade' }, { status: 426 })
    }

    const requestClientId = new URL(request.url).searchParams.get('clientId')
      ?? undefined
    const runtime = await this.getRuntime({ clientId: requestClientId })
    runtime.setPublicGatewayUrl(
      buildGatewayWebSocketUrlFromRequestUrl(request.url),
    )
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, ['gateway'])

    const transport: GatewaySocketTransport = {
      send: (payload) => {
        server.send(payload)
      },
      close: (code, reason) => {
        server.close(code, reason)
      },
      isOpen: () => {
        return true
      },
    }

    const clientId = runtime.gatewaySessionManager.registerClient(transport)
    writeSocketAttachment({
      ws: server,
      attachment: {
        role: 'gateway',
        gatewayClientId: clientId,
        snapshot: runtime.gatewaySessionManager.getClientSnapshot(clientId),
      },
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = readSocketAttachment(ws)
    if (!(attachment?.role === 'gateway' && attachment.gatewayClientId)) {
      return
    }

    const runtime = await this.getRuntime({})
    const rawMessage =
      typeof message === 'string' ? message : new TextDecoder().decode(message)
    await runtime.gatewaySessionManager.handleRawMessage({
      clientId: attachment.gatewayClientId,
      raw: rawMessage,
    })
    writeSocketAttachment({
      ws,
      attachment: {
        ...attachment,
        snapshot: runtime.gatewaySessionManager.getClientSnapshot(
          attachment.gatewayClientId,
        ),
      },
    })
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const attachment = readSocketAttachment(ws)
    if (!(attachment?.role === 'gateway' && attachment.gatewayClientId)) {
      return
    }
    const runtime = await this.getRuntime({})
    runtime.gatewaySessionManager.removeClient(attachment.gatewayClientId)
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const attachment = readSocketAttachment(ws)
    if (!(attachment?.role === 'gateway' && attachment.gatewayClientId)) {
      return
    }
    const runtime = await this.getRuntime({})
    runtime.gatewaySessionManager.removeClient(attachment.gatewayClientId)
  }

  private async getRuntime({
    clientId,
  }: {
    clientId?: string
  }): Promise<RuntimeState> {
    if (!this.runtimePromise) {
      this.runtimePromise = this.createRuntime({ clientId })
    }
    return this.runtimePromise
  }

  private async createRuntime({
    clientId,
  }: {
    clientId?: string
  }): Promise<RuntimeState> {
    if (!clientId) {
      throw new Error('Missing clientId while creating Telegram bridge runtime')
    }

    const gatewayClient = await resolveGatewayClientFromCacheOrDb({
      clientId,
      env: this.env,
    })
    if (gatewayClient instanceof Error) {
      throw gatewayClient
    }
    if (!gatewayClient) {
      throw new Error(`Unknown gateway client: ${clientId}`)
    }

    const telegramBotToken = gatewayClient.bot_token
    if (!telegramBotToken) {
      throw new Error(`Missing Telegram bot token for client ${clientId}`)
    }

    const chatId = Number(gatewayClient.guild_id)
    if (!Number.isFinite(chatId)) {
      throw new Error(`Invalid Telegram chat_id in guild_id: ${gatewayClient.guild_id}`)
    }

    const telegram = new TelegramBotClient(telegramBotToken)
    const botInfo = await telegram.getMe()
    const botUserId = botInfo.id
    const botUsername = botInfo.username ?? botInfo.first_name

    let publicGatewayUrl = 'wss://telegram-gateway.kimaki.dev/telegram/gateway'

    const gatewaySessionManager = new GatewaySessionManager({
      loadState: async () => {
        return loadGatewayState({
          telegram,
          chatId,
          botUserId,
          botUsername,
        })
      },
      expectedToken: telegramBotToken,
      workspaceId: chatId.toString(),
      authorize: async (context) => {
        const token = context.token
        const parsedToken = parseGatewayToken(token)
        if (!parsedToken) {
          return { allow: false }
        }

        if (parsedToken.clientId !== clientId) {
          return { allow: false }
        }

        const latestGatewayClient = await resolveGatewayClientFromCacheOrDb({
          clientId,
          env: this.env,
        })
        if (latestGatewayClient instanceof Error || !latestGatewayClient) {
          return { allow: false }
        }

        if (latestGatewayClient.secret !== parsedToken.secret) {
          return { allow: false }
        }

        return {
          allow: true,
          clientId,
          authorizedTeamIds: [latestGatewayClient.guild_id],
        }
      },
      gatewayUrlProvider: () => {
        return publicGatewayUrl
      },
    })

    const bridgeApp = createBridgeApp({
      telegram,
      botUserId,
      botUsername,
      botToken: telegramBotToken,
      chatId,
      port: 0,
    })

    bridgeApp.setGateway({
      broadcast: (event, data) => {
        gatewaySessionManager.broadcast(event, data)
      },
      broadcastMessageCreate: (message, guildId) => {
        gatewaySessionManager.broadcastMessageCreate(message, guildId)
      },
      close: () => {
        gatewaySessionManager.closeAll()
      },
    })

    this.restoreHibernatedGatewaySockets({ gatewaySessionManager })

    // Start Telegram long polling
    this.pollingEnabled = true
    telegram.startPolling()
    void this.scheduleNextPollingCycle()

    return {
      app: bridgeApp.app,
      gatewaySessionManager,
      setPublicGatewayUrl: (url) => {
        publicGatewayUrl = url
      },
      telegram,
    }
  }

  private async scheduleNextPollingCycle(): Promise<void> {
    // Use DO alarm for reliable polling even when no requests arrive.
    // Alarm fires are guaranteed by CF runtime; fallback to ctx.waitUntil
    // for immediate processing when the DO is already active.
    try {
      await this.ctx.storage.setAlarm(
        new Date(Date.now() + TELEGRAM_POLL_INTERVAL_MS),
      )
    } catch {
      // Alarm setting can fail if storage is temporarily unavailable
    }
  }

  private async runPollingCycle(): Promise<void> {
    const runtime = await this.getRuntime({}).catch(() => undefined)
    if (!runtime || !this.pollingEnabled) {
      return
    }

    // The TelegramBotClient handles its own polling internally via startPolling().
    // The alarm just ensures the DO stays warm. The actual update processing
    // happens in the TelegramBotClient's onUpdate callback (wired in createBridgeApp).
    await this.scheduleNextPollingCycle()
  }

  private restoreHibernatedGatewaySockets({
    gatewaySessionManager,
  }: {
    gatewaySessionManager: GatewaySessionManager
  }): void {
    const sockets = this.ctx.getWebSockets('gateway')
    for (const socket of sockets) {
      const attachment = readSocketAttachment(socket)
      if (!(attachment?.role === 'gateway' && attachment.gatewayClientId)) {
        continue
      }
      if (gatewaySessionManager.hasClient(attachment.gatewayClientId)) {
        continue
      }
      const transport = createGatewaySocketTransport(socket)
      gatewaySessionManager.hydrateClient({
        transport,
        clientId: attachment.gatewayClientId,
        snapshot: attachment.snapshot ?? {
          sessionId: crypto.randomUUID(),
          sequence: 0,
          identified: false,
          intents: 0,
        },
      })
    }
  }
}

type GatewaySocketAttachment = {
  role: 'gateway'
  gatewayClientId: string
  snapshot?: GatewayClientSnapshot
}

function createGatewaySocketTransport(ws: WebSocket): GatewaySocketTransport {
  return {
    send: (payload) => {
      ws.send(payload)
    },
    close: (code, reason) => {
      ws.close(code, reason)
    },
    isOpen: () => {
      return true
    },
  }
}

function readSocketAttachment(
  ws: WebSocket,
): GatewaySocketAttachment | undefined {
  const raw = ws.deserializeAttachment()
  if (!isRecord(raw)) {
    return undefined
  }
  if (raw.role !== 'gateway') {
    return undefined
  }
  const gatewayClientId = raw.gatewayClientId
  if (typeof gatewayClientId !== 'string') {
    return undefined
  }
  const snapshot = isGatewayClientSnapshot(raw.snapshot)
    ? raw.snapshot
    : undefined
  return {
    role: 'gateway',
    gatewayClientId,
    snapshot,
  }
}

function writeSocketAttachment({
  ws,
  attachment,
}: {
  ws: WebSocket
  attachment: GatewaySocketAttachment
}): void {
  ws.serializeAttachment(attachment)
}

function isGatewayClientSnapshot(
  value: unknown,
): value is GatewayClientSnapshot {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.sessionId === 'string' &&
    typeof value.sequence === 'number' &&
    typeof value.identified === 'boolean' &&
    typeof value.intents === 'number'
  )
}

async function loadGatewayState({
  telegram,
  chatId,
  botUserId,
  botUsername,
}: {
  telegram: TelegramBotClient
  chatId: number
  botUserId: number
  botUsername: string
}): Promise<GatewayState> {
  // Fetch chat info to get the supergroup name
  const chatInfo = await telegram.getChat({ chatId })
  const chatTitle = chatInfo.title ?? 'Telegram Chat'

  // Build a synthetic channel representing the main chat
  const channels: GatewayGuildCreateDispatchData['channels'] = [
    {
      id: chatId.toString(),
      type: ChannelType.GuildText,
      name: 'general',
      guild_id: chatId.toString(),
      topic: null,
      position: 0,
    },
  ]

  return {
    botUser: {
      id: botUserId.toString(),
      username: botUsername,
      discriminator: '0',
      avatar: null,
      global_name: botUsername,
    },
    guilds: [
      {
        id: chatId.toString(),
        apiGuild: buildGatewayGuild({
          chatId: chatId.toString(),
          chatName: chatTitle,
          botUserId: botUserId.toString(),
        }),
        joinedAt: new Date().toISOString(),
        members: [
          {
            user: {
              id: botUserId.toString(),
              username: botUsername,
              discriminator: '0',
              avatar: null,
              global_name: botUsername,
            },
            roles: [],
            joined_at: new Date().toISOString(),
            deaf: false,
            mute: false,
            flags: 8,
          },
        ],
        channels,
      },
    ],
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
    max_presences: 25_000,
    max_members: 500_000,
    vanity_url_code: null,
    description: null,
    banner: null,
    premium_tier: GuildPremiumTier.None,
    preferred_locale: Locale.EnglishUS,
    region: 'automatic',
    hub_type: null,
    incidents_data: null,
    public_updates_channel_id: null,
    nsfw_level: GuildNSFWLevel.Default,
    premium_progress_bar_enabled: false,
    stickers: [],
    safety_alerts_channel_id: null,
  }
}

function toRequest(request: BridgeRpcRequest): Request {
  const baseUrl = new URL(request.url)
  const requestUrl = new URL(request.path, baseUrl.origin)
  const init: RequestInit = {
    method: request.method,
    headers: new Headers(request.headers),
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
  }
  return new Request(requestUrl, init)
}

async function serializeResponse(response: Response): Promise<BridgeRpcResponse> {
  const headers: Array<[string, string]> = []
  response.headers.forEach((value, key) => {
    headers.push([key, value])
  })
  return {
    status: response.status,
    headers,
    body: await response.text(),
  }
}

function buildGatewayWebSocketUrlFromRequestUrl(requestUrl: string): string {
  const baseUrl = new URL(requestUrl)
  const protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return new URL('/telegram/gateway', `${protocol}//${baseUrl.host}`).toString()
}

function parseGatewayToken(
  token: string | undefined,
): {
  clientId: string
  secret: string
} | undefined {
  if (!token) {
    return undefined
  }
  const [clientId, secret, ...rest] = token.split(':')
  if (rest.length > 0) {
    return undefined
  }
  if (!clientId || !secret) {
    return undefined
  }
  return { clientId, secret }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
