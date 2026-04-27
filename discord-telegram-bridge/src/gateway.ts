// Discord Gateway WebSocket server for the Telegram bridge.
// Reuses gateway-session-manager for Hello -> Identify -> Ready -> GUILD_CREATE
// protocol. The bridge pushes translated Telegram events via broadcast().

import type http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type {
  APIGuild,
  APIGuildMember,
  APIUser,
  APIMessage,
} from 'discord-api-types/v10'
import type { GatewayGuildCreateDispatchData } from 'discord-api-types/v10'
import {
  GatewaySessionManager,
  type GatewaySocketTransport,
} from './gateway-session-manager.js'
import type { BridgeAuthorizeCallback } from './types.js'

interface ConnectedClient {
  ws: WebSocket
  id: string
}

export interface GatewayGuildState {
  id: string
  apiGuild: APIGuild
  joinedAt: string
  members: APIGuildMember[]
  channels: GatewayGuildCreateDispatchData['channels']
}

export interface GatewayState {
  botUser: APIUser
  guilds: GatewayGuildState[]
}

export interface GatewayEmitter {
  broadcast<T>(event: string, data: T): void
  broadcastMessageCreate(message: APIMessage, guildId: string): void
  close(): void
  setPort?(port: number): void
}

export class TelegramBridgeGateway {
  wss: WebSocketServer
  clients: ConnectedClient[] = []
  private sessionManager: GatewaySessionManager
  private port: number
  private expectedToken: string
  private gatewayUrlOverride?: string
  private authorize?: BridgeAuthorizeCallback
  private chatId: string

  constructor({
    httpServer,
    port,
    loadState,
    expectedToken,
    gatewayUrlOverride,
    authorize,
    chatId,
  }: {
    httpServer: http.Server
    port: number
    loadState: () => Promise<GatewayState>
    expectedToken: string
    gatewayUrlOverride?: string
    authorize?: BridgeAuthorizeCallback
    chatId: string
  }) {
    this.port = port
    this.expectedToken = expectedToken
    this.gatewayUrlOverride = gatewayUrlOverride
    this.authorize = authorize
    this.chatId = chatId
    this.sessionManager = new GatewaySessionManager({
      loadState,
      expectedToken,
      workspaceId: chatId,
      authorize: authorize
        ? (ctx) => {
            return authorize({
              kind: ctx.kind === 'gateway-identify' ? 'gateway-identify' : 'rest',
              token: ctx.token,
            })
          }
        : undefined,
      gatewayUrlProvider: () => {
        return this.gatewayUrlOverride ?? `ws://127.0.0.1:${this.port}/telegram/gateway`
      },
    })
    this.wss = new WebSocketServer({ noServer: true })
    this.wss.on('connection', (ws) => {
      this.handleConnection(ws)
    })
    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(
        request.url ?? '/',
        `http://${request.headers.host}`,
      ).pathname
      if (pathname === '/telegram/gateway' || pathname === '/telegram/gateway/') {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request)
        })
      } else {
        socket.destroy()
      }
    })
  }

  broadcast<T>(event: string, data: T): void {
    this.sessionManager.broadcast(event, data)
  }

  broadcastMessageCreate(message: APIMessage, guildId: string): void {
    this.sessionManager.broadcastMessageCreate(message, guildId)
  }

  setPort(port: number): void {
    this.port = port
  }

  close(): void {
    this.sessionManager.closeAll()
    for (const client of this.clients) {
      client.ws.close()
    }
    this.clients = []
    this.wss.close()
  }

  private handleConnection(ws: WebSocket): void {
    const transport: GatewaySocketTransport = {
      send: (payload) => {
        if (ws.readyState !== WebSocket.OPEN) {
          return
        }
        ws.send(payload)
      },
      close: (code, reason) => {
        ws.close(code, reason)
      },
      isOpen: () => {
        return ws.readyState === WebSocket.OPEN
      },
    }

    const id = this.sessionManager.registerClient(transport)
    const client: ConnectedClient = { ws, id }
    this.clients.push(client)

    ws.on('message', (raw) => {
      void this.sessionManager.handleRawMessage({
        clientId: client.id,
        raw: raw.toString(),
      })
    })

    ws.on('close', () => {
      this.sessionManager.removeClient(client.id)
      const idx = this.clients.indexOf(client)
      if (idx !== -1) {
        this.clients.splice(idx, 1)
      }
    })
  }
}
