import { describe, test, expect } from 'vitest'
import {
  ComponentType,
  ButtonStyle,
} from 'discord-api-types/v10'
import {
  componentsToInlineKeyboard,
  extractTextFromComponents,
  encodeCallbackData,
  decodeCallbackData,
} from './component-converter.js'

describe('encodeCallbackData', () => {
  test('encodes component type and custom id', () => {
    const data = encodeCallbackData({
      componentType: ComponentType.Button,
      customId: 'my-button',
    })
    expect(data).toBe('dtb:2:my-button')
  })

  test('truncates long custom IDs to fit 64 bytes', () => {
    const longId = 'a'.repeat(100)
    const data = encodeCallbackData({
      componentType: ComponentType.Button,
      customId: longId,
    })
    expect(data.length).toBeLessThanOrEqual(64)
  })
})

describe('decodeCallbackData', () => {
  test('decodes bridge-encoded callback data', () => {
    const decoded = decodeCallbackData('dtb:2:my-button')
    expect(decoded.componentType).toBe(ComponentType.Button)
    expect(decoded.customId).toBe('my-button')
  })

  test('returns raw data for non-encoded strings', () => {
    const decoded = decodeCallbackData('plain-data')
    expect(decoded.componentType).toBeUndefined()
    expect(decoded.customId).toBe('plain-data')
  })
})

describe('componentsToInlineKeyboard', () => {
  test('converts an ActionRow with buttons', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Primary,
            label: 'Click Me',
            custom_id: 'btn-1',
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            label: 'Delete',
            custom_id: 'btn-delete',
          },
        ],
      },
    ]

    const result = componentsToInlineKeyboard(components)
    expect(result).toBeDefined()
    expect(result!.inline_keyboard).toHaveLength(1)
    expect(result!.inline_keyboard[0]).toHaveLength(2)
    expect(result!.inline_keyboard[0]![0]!.text).toBe('Click Me')
    expect(result!.inline_keyboard[0]![0]!.callback_data).toBeDefined()
    expect(result!.inline_keyboard[0]![1]!.text).toBe('Delete')
  })

  test('converts link buttons with url', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Link,
            label: 'Open',
            url: 'https://example.com',
          },
        ],
      },
    ]

    const result = componentsToInlineKeyboard(components)
    expect(result).toBeDefined()
    expect(result!.inline_keyboard[0]![0]!.url).toBe('https://example.com')
  })

  test('converts StringSelect as one button per option', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: 'choose',
            options: [
              { label: 'Option A', value: 'a' },
              { label: 'Option B', value: 'b' },
              { label: 'Option C', value: 'c' },
            ],
          },
        ],
      },
    ]

    const result = componentsToInlineKeyboard(components)
    expect(result).toBeDefined()
    expect(result!.inline_keyboard[0]).toHaveLength(3)
    expect(result!.inline_keyboard[0]![0]!.text).toBe('Option A')
  })

  test('returns undefined for components without interactive elements', () => {
    const components = [
      {
        type: ComponentType.TextDisplay,
        content: 'Hello',
      },
    ]

    const result = componentsToInlineKeyboard(components)
    expect(result).toBeUndefined()
  })

  test('handles empty array', () => {
    const result = componentsToInlineKeyboard([])
    expect(result).toBeUndefined()
  })
})

describe('extractTextFromComponents', () => {
  test('extracts text from TextDisplay components', () => {
    const components = [
      {
        type: ComponentType.TextDisplay,
        content: '**Hello** world',
      },
    ]

    const text = extractTextFromComponents(components)
    expect(text).toContain('Hello')
    expect(text).toContain('world')
  })

  test('returns empty string for button-only components', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Primary,
            label: 'Click',
            custom_id: 'btn',
          },
        ],
      },
    ]

    const text = extractTextFromComponents(components)
    expect(text).toBe('')
  })
})
