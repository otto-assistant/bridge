// Echo bot: smoke-tests discord-telegram-bridge round-trip.
// Telegram polling -> Discord Gateway event -> discord.js handler -> Discord REST -> Telegram sendMessage.
//
// Required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// Usage: cd discord-telegram-bridge && pnpm echo-bot

import { Client, GatewayIntentBits, type Message } from 'discord.js'
import { TelegramBridge } from '../src/node-bridge.ts'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

async function main(): Promise<void> {
  const botToken = requireEnv('TELEGRAM_BOT_TOKEN')
  const chatId = Number(requireEnv('TELEGRAM_CHAT_ID'))

  const bridge = new TelegramBridge({
    botToken,
    chatId,
  })

  await bridge.start()

  console.log(`Bridge started`)
  console.log(`  REST URL:     ${bridge.restUrl}`)
  console.log(`  Gateway URL:  ${bridge.gatewayUrl}`)
  console.log(`  Port:         ${bridge.port}`)

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    rest: { api: bridge.restUrl, version: '10' },
  })

  const readyPromise = new Promise<void>((resolve) => {
    client.once('ready', () => {
      resolve()
    })
  })

  await client.login(bridge.discordToken)
  await readyPromise

  const guild = client.guilds.cache.first()
  console.log(`Bot ready! Guild: ${guild?.name} (${guild?.id})`)

  client.on('messageCreate', (message) => {
    void handleMessageCreate({ client, message }).catch((error) => {
      console.error('messageCreate handler failed', error)
    })
  })

  console.log('\nEcho bot running. Press Ctrl+C to stop.\n')

  const shutdown = (): void => {
    console.log('\nShutting down...')
    client.destroy()
    void bridge.stop().then(() => {
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function handleMessageCreate({
  client,
  message,
}: {
  client: Client
  message: Message
}): Promise<void> {
  const isSelf = client.user && message.author.id === client.user.id
  if (isSelf || message.author.bot) {
    return
  }

  console.log(`[echo] "${message.content}" from ${message.author.username}`)

  try {
    await message.channel.send(`echo: ${message.content}`)
  } catch (error) {
    console.error('echo send failed', error)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
