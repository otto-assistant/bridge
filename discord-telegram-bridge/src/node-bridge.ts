// Node runtime wrapper for discord-telegram-bridge.
// Keeps Node server lifecycle out of the package root exports.

import {
  createServer,
  startServer,
  stopServer,
  type ServerComponents,
} from './server.js'
import { TelegramBotClient } from './telegram-client.js'
import type { TelegramBridgeConfig } from './types.js'

export class TelegramBridge {
  /** Token that discord.js should use to connect to this bridge's gateway */
  readonly discordToken: string

  private _port: number
  private telegram: TelegramBotClient
  private config: TelegramBridgeConfig
  private server: ServerComponents | null = null
  private botUserId: number | null = null
  private botUsername: string | null = null

  constructor(config: TelegramBridgeConfig) {
    this.config = config
    this._port = config.port ?? 3720
    this.discordToken = config.discordToken ?? config.botToken
    this.telegram = new TelegramBotClient(config.botToken)
  }

  /** Actual bound port. Reflects OS-assigned port after start() when port=0. */
  get port(): number {
    return this._port
  }

  /** REST API base URL for discord.js (without /v10 — discord.js appends the version) */
  get restUrl(): string {
    return buildHttpUrl({
      baseUrl: this.resolvePublicBaseUrl(),
      path: '/api',
    })
  }

  /** Gateway WebSocket URL for discord.js */
  get gatewayUrl(): string {
    if (this.config.gatewayUrlOverride) {
      return this.config.gatewayUrlOverride
    }
    return buildWebSocketUrl({
      baseUrl: this.resolvePublicBaseUrl(),
      path: '/telegram/gateway',
    })
  }

  async start(): Promise<void> {
    const botInfo = await this.telegram.getMe()
    this.botUserId = botInfo.id
    this.botUsername = botInfo.username ?? botInfo.first_name

    this.server = await createServer({
      telegram: this.telegram,
      botUserId: this.botUserId,
      botUsername: this.botUsername,
      botToken: this.config.botToken,
      chatId: this.config.chatId,
      port: this._port,
      gatewayUrlOverride: this.config.gatewayUrlOverride,
      publicBaseUrl: this.config.publicBaseUrl,
      authorize: this.config.authorize,
    })

    await startServer(this.server, this._port)

    const addr = this.server.httpServer.address()
    if (typeof addr === 'object' && addr) {
      this._port = addr.port
      this.server.gateway.setPort?.(addr.port)
    }

    // Start Telegram polling
    this.telegram.startPolling()
  }

  async stop(): Promise<void> {
    this.telegram.stopPolling()
    if (!this.server) {
      return
    }
    await stopServer(this.server)
    this.server = null
  }

  private resolvePublicBaseUrl(): string {
    if (this.config.publicBaseUrl) {
      return this.config.publicBaseUrl
    }
    return `http://127.0.0.1:${this._port}`
  }
}

function buildHttpUrl({ baseUrl, path }: { baseUrl: string; path: string }): string {
  return new URL(path, baseUrl).toString()
}

function buildWebSocketUrl({ baseUrl, path }: { baseUrl: string; path: string }): string {
  const origin = new URL(baseUrl)
  const protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = new URL(path, `${protocol}//${origin.host}`)
  return url.toString()
}
