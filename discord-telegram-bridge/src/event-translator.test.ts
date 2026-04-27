import { describe, test, expect } from 'vitest'
import { translateMessageCreate, buildMainChannel } from './event-translator.js'
import type { NormalizedTelegramMessage, CachedTelegramUser } from './types.js'

const defaultAuthor: CachedTelegramUser = {
  id: 123456789,
  firstName: 'Test',
  username: 'testuser',
  isBot: false,
}

function makeMessage(overrides: Partial<NormalizedTelegramMessage> = {}): NormalizedTelegramMessage {
  return {
    messageId: 42,
    chatId: -1001234567890,
    chatType: 'supergroup',
    date: 1700000000,
    text: 'Hello world',
    ...overrides,
  }
}

describe('translateMessageCreate', () => {
  test('translates a simple text message', () => {
    const result = translateMessageCreate({
      message: makeMessage(),
      guildId: '-1001234567890',
      author: defaultAuthor,
    })

    expect(result).not.toBeNull()
    expect(result!.eventName).toBe('MESSAGE_CREATE')
    expect(result!.data.content).toBe('Hello world')
    expect(result!.data.author.id).toBe('123456789')
    expect(result!.data.author.username).toBe('testuser')
    expect(result!.data.guild_id).toBe('-1001234567890')
  })

  test('translates a message in a topic thread', () => {
    const result = translateMessageCreate({
      message: makeMessage({ threadId: 100 }),
      guildId: '-1001234567890',
      author: defaultAuthor,
    })

    expect(result).not.toBeNull()
    // Channel ID should be an encoded thread ID (20+ digits)
    expect(result!.data.channel_id).toMatch(/^\d{20,}$/)
  })

  test('translates a message with a document attachment', () => {
    const result = translateMessageCreate({
      message: makeMessage({
        text: undefined,
        document: {
          fileId: 'file123',
          fileUniqueId: 'unique123',
          fileName: 'test.pdf',
          mimeType: 'application/pdf',
          fileSize: 1024,
        },
      }),
      guildId: '-1001234567890',
      author: defaultAuthor,
    })

    expect(result).not.toBeNull()
    expect(result!.data.content).toBe('')
    expect(result!.data.attachments).toHaveLength(1)
    expect(result!.data.attachments[0]!.filename).toBe('test.pdf')
  })

  test('returns null for messages with no text and no media', () => {
    const result = translateMessageCreate({
      message: makeMessage({ text: undefined }),
      guildId: '-1001234567890',
      author: defaultAuthor,
    })

    expect(result).toBeNull()
  })
})

describe('buildMainChannel', () => {
  test('builds a GuildText channel', () => {
    const channel = buildMainChannel({
      chatId: -1001234567890,
      chatTitle: 'My Group',
      guildId: '-1001234567890',
    })

    expect(channel.id).toBe('-1001234567890')
    expect(channel.name).toBe('My Group')
    if ('guild_id' in channel) {
      expect(channel.guild_id).toBe('-1001234567890')
    }
  })

  test('uses default name when no title', () => {
    const channel = buildMainChannel({
      chatId: -1001234567890,
      guildId: '-1001234567890',
    })

    expect(channel.name).toBe('telegram-chat')
  })
})
