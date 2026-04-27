import { describe, test, expect } from 'vitest'
import {
  encodeThreadId,
  decodeThreadId,
  isThreadChannelId,
  resolveTelegramTarget,
  resolveDiscordChannelId,
} from './id-converter.js'

describe('encodeThreadId', () => {
  test('encodes a supergroup chat_id + topic_message_id into a numeric string', () => {
    const id = encodeThreadId(-1001234567890, 42)
    expect(id).toMatch(/^\d{20,}$/)
  })

  test('produces unique IDs for different chat_ids with same topic', () => {
    const id1 = encodeThreadId(-1001234567890, 42)
    const id2 = encodeThreadId(-1009876543210, 42)
    expect(id1).not.toBe(id2)
  })

  test('produces unique IDs for same chat_id with different topics', () => {
    const id1 = encodeThreadId(-1001234567890, 1)
    const id2 = encodeThreadId(-1001234567890, 2)
    expect(id1).not.toBe(id2)
  })
})

describe('decodeThreadId', () => {
  test('roundtrips encode → decode for a supergroup', () => {
    const chatId = -1001234567890
    const topicMessageId = 42
    const encoded = encodeThreadId(chatId, topicMessageId)
    const decoded = decodeThreadId(encoded)
    expect(decoded.chatId).toBe(chatId)
    expect(decoded.topicMessageId).toBe(topicMessageId)
  })

  test('roundtrips for a positive chat_id (private chat)', () => {
    const chatId = 123456789
    const topicMessageId = 100
    const encoded = encodeThreadId(chatId, topicMessageId)
    const decoded = decodeThreadId(encoded)
    expect(decoded.chatId).toBe(chatId)
    expect(decoded.topicMessageId).toBe(topicMessageId)
  })

  test('throws for non-numeric ID', () => {
    expect(() => decodeThreadId('abc')).toThrow()
  })

  test('throws for short numeric ID', () => {
    expect(() => decodeThreadId('12345')).toThrow()
  })
})

describe('isThreadChannelId', () => {
  test('returns true for 20+ digit numeric strings', () => {
    expect(isThreadChannelId('12345678901234567890')).toBe(true)
    expect(isThreadChannelId('123456789012345678901')).toBe(true)
  })

  test('returns false for short numeric strings', () => {
    expect(isThreadChannelId('12345678901234567')).toBe(false)
  })

  test('returns false for non-numeric strings', () => {
    expect(isThreadChannelId('-1001234567890')).toBe(false)
    expect(isThreadChannelId('C12345678')).toBe(false)
  })
})

describe('resolveTelegramTarget', () => {
  test('decodes thread channel ID to chat_id + message_thread_id', () => {
    const chatId = -1001234567890
    const topicMessageId = 42
    const threadId = encodeThreadId(chatId, topicMessageId)
    const target = resolveTelegramTarget(threadId)
    expect(target.chatId).toBe(chatId)
    expect(target.messageThreadId).toBe(topicMessageId)
  })

  test('returns chat_id for regular channel ID', () => {
    const target = resolveTelegramTarget('-1001234567890')
    expect(target.chatId).toBe(-1001234567890)
    expect(target.messageThreadId).toBeUndefined()
  })

  test('returns chat_id for numeric channel ID', () => {
    const target = resolveTelegramTarget('123456789')
    expect(target.chatId).toBe(123456789)
    expect(target.messageThreadId).toBeUndefined()
  })
})

describe('resolveDiscordChannelId', () => {
  test('returns encoded thread ID when messageThreadId is present', () => {
    const result = resolveDiscordChannelId({ chatId: -1001234567890, messageThreadId: 42 })
    expect(isThreadChannelId(result)).toBe(true)
  })

  test('returns chat_id as string when no thread', () => {
    const result = resolveDiscordChannelId({ chatId: -1001234567890 })
    expect(result).toBe('-1001234567890')
  })
})
