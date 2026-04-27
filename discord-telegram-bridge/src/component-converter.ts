// Converts Discord message components to Telegram InlineKeyboardMarkup.
//
// Supported Discord components:
//   ActionRow → InlineKeyboard row (array of buttons)
//   Button    → InlineKeyboardButton (url or callback)
//   StringSelect → one InlineKeyboardButton per option (callback_data)
//   TextDisplay  → plain text (Telegram has no Block Kit equivalent)
//   Section      → plain text + button accessory
//   Container    → pass through children
//   Separator    → newline separator
//
// Telegram InlineKeyboardMarkup is a 2D array of InlineKeyboardButton.
// Each row is an array of buttons. callback_data is limited to 64 bytes.

import {
  ComponentType,
  ButtonStyle,
} from 'discord-api-types/v10'
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIStringSelectComponent,
  APIComponentInMessageActionRow,
  APITextDisplayComponent,
  APISectionComponent,
  APIContainerComponent,
} from 'discord-api-types/v10'
import { markdownToTelegramHtml } from './format-converter.js'

// ---- Telegram InlineKeyboard types ----

export interface TelegramInlineKeyboardButton {
  text: string
  url?: string
  callback_data?: string
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][]
}

// callback_data prefix for bridge-encoded actions
const CALLBACK_PREFIX = 'dtb'
// Max callback_data length (Telegram limit: 64 bytes)
const MAX_CALLBACK_DATA = 64

/**
 * Encode component metadata into a Telegram callback_data string.
 * Format: dtb:{componentType}:{customId}
 */
export function encodeCallbackData({
  componentType,
  customId,
}: {
  componentType: number
  customId: string
}): string {
  const encoded = `${CALLBACK_PREFIX}:${componentType}:${customId}`
  if (encoded.length > MAX_CALLBACK_DATA) {
    // Truncate customId to fit within 64 bytes
    const overhead = `${CALLBACK_PREFIX}:${componentType}:`.length
    const truncated = customId.slice(0, MAX_CALLBACK_DATA - overhead)
    return `${CALLBACK_PREFIX}:${componentType}:${truncated}`
  }
  return encoded
}

/**
 * Decode a Telegram callback_data string back to component metadata.
 */
export function decodeCallbackData(data: string): {
  componentType?: number
  customId: string
} {
  const parts = data.split(':')
  if (parts.length < 3 || parts[0] !== CALLBACK_PREFIX) {
    return { customId: data }
  }

  const componentType = Number.parseInt(parts[1] ?? '', 10)
  if (!Number.isFinite(componentType)) {
    return { customId: data }
  }

  return {
    componentType,
    customId: parts.slice(2).join(':'),
  }
}

/**
 * Convert Discord components to Telegram InlineKeyboardMarkup.
 * Returns undefined if no interactive components are present.
 */
export function componentsToInlineKeyboard(
  components: unknown[],
): TelegramInlineKeyboardMarkup | undefined {
  const rows: TelegramInlineKeyboardButton[][] = []

  for (const component of components) {
    const convertedRows = convertComponent(component)
    rows.push(...convertedRows)
  }

  if (rows.length === 0) {
    return undefined
  }

  return { inline_keyboard: rows }
}

/**
 * Extract text content from Discord Components V2 structures.
 * Returns the plain text content that should be sent as Telegram message text.
 */
export function extractTextFromComponents(components: unknown[]): string {
  const parts: string[] = []

  for (const component of components) {
    const text = extractText(component)
    if (text) {
      parts.push(text)
    }
  }

  return parts.join('\n')
}

// ---- Component converters ----

function convertComponent(component: unknown): TelegramInlineKeyboardButton[][] {
  if (!isTypeObject(component)) {
    return []
  }

  switch (component.type) {
    case ComponentType.ActionRow: {
      return [convertActionRow(component as APIActionRowComponent<APIComponentInMessageActionRow>)]
    }
    case ComponentType.Section: {
      return convertSection(component as APISectionComponent)
    }
    case ComponentType.Container: {
      return convertContainer(component as APIContainerComponent)
    }
    // TextDisplay and Separator have no interactive elements
    default: {
      return []
    }
  }
}

function convertActionRow(
  row: APIActionRowComponent<APIComponentInMessageActionRow>,
): TelegramInlineKeyboardButton[] {
  const buttons: TelegramInlineKeyboardButton[] = []

  for (const child of row.components) {
    if (child.type === ComponentType.Button) {
      const btn = convertButton(child)
      if (btn) {
        buttons.push(btn)
      }
      continue
    }

    if (child.type === ComponentType.StringSelect) {
      const selectButtons = convertStringSelect(child)
      buttons.push(...selectButtons)
    }
  }

  return buttons
}

function convertButton(button: APIButtonComponent): TelegramInlineKeyboardButton | null {
  // Link button
  if (button.style === ButtonStyle.Link && 'url' in button && button.url) {
    return {
      text: labelFromButton(button),
      url: button.url,
    }
  }

  // Premium buttons not supported
  if (button.style === ButtonStyle.Premium) {
    return null
  }

  // Interactive button with custom_id
  if (!('custom_id' in button) || typeof button.custom_id !== 'string') {
    return null
  }

  return {
    text: labelFromButton(button),
    callback_data: encodeCallbackData({
      componentType: ComponentType.Button,
      customId: button.custom_id,
    }),
  }
}

function convertStringSelect(select: APIStringSelectComponent): TelegramInlineKeyboardButton[] {
  // Each option becomes a separate callback button
  return select.options.map((opt) => {
    return {
      text: opt.label.length > 20 ? `${opt.label.slice(0, 17)}...` : opt.label,
      callback_data: encodeCallbackData({
        componentType: ComponentType.StringSelect,
        customId: `${select.custom_id}:${opt.value}`,
      }),
    }
  })
}

function convertSection(component: APISectionComponent): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = []

  // If section has a button accessory, add it as a row
  if (
    component.accessory &&
    component.accessory.type === ComponentType.Button
  ) {
    const btn = convertButton(component.accessory)
    if (btn) {
      rows.push([btn])
    }
  }

  return rows
}

function convertContainer(component: APIContainerComponent): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = []
  const children = Array.isArray(component.components) ? component.components : []

  for (const child of children) {
    rows.push(...convertComponent(child))
  }

  return rows
}

// ---- Text extraction ----

function extractText(component: unknown): string {
  if (!isTypeObject(component)) {
    return ''
  }

  switch (component.type) {
    case ComponentType.TextDisplay: {
      const td = component as APITextDisplayComponent
      return markdownToTelegramHtml(td.content)
    }
    case ComponentType.Separator: {
      return '\n---\n'
    }
    case ComponentType.Section: {
      const section = component as APISectionComponent
      return section.components
        .map((c) => {
          if (isTextDisplayComponent(c)) {
            return markdownToTelegramHtml(c.content)
          }
          return ''
        })
        .filter((s) => s.length > 0)
        .join('\n')
    }
    case ComponentType.Container: {
      const container = component as APIContainerComponent
      const children = Array.isArray(container.components) ? container.components : []
      return children.map(extractText).filter((s) => s.length > 0).join('\n')
    }
    case ComponentType.ActionRow: {
      // ActionRow is buttons only, no text content
      return ''
    }
    default: {
      return ''
    }
  }
}

// ---- Type guards ----

function isTypeObject(value: unknown): value is { type: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'number'
  )
}

function isTextDisplayComponent(value: unknown): value is APITextDisplayComponent {
  return isTypeObject(value) && value.type === ComponentType.TextDisplay
}

function labelFromButton(button: APIButtonComponent): string {
  if ('label' in button && typeof button.label === 'string') {
    return button.label
  }
  if ('emoji' in button && button.emoji) {
    if (typeof button.emoji.name === 'string') {
      return button.emoji.name
    }
  }
  return 'button'
}
