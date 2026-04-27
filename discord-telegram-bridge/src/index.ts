// Public exports for discord-telegram-bridge.
// Runtime-specific implementations live in dedicated files.

export type { TelegramBridgeConfig } from './types.js'
export {
  encodeThreadId,
  decodeThreadId,
  isThreadChannelId,
  resolveTelegramTarget,
  resolveDiscordChannelId,
  telegramDateToIso,
} from './id-converter.js'
export { markdownToTelegramHtml, telegramHtmlToMarkdown } from './format-converter.js'
export {
  componentsToInlineKeyboard,
  extractTextFromComponents,
  encodeCallbackData,
  decodeCallbackData,
} from './component-converter.js'
export { TelegramBridge } from './node-bridge.js'
export { createBridgeApp, createServer } from './server.js'
export { TelegramBotClient, TelegramApiError } from './telegram-client.js'
