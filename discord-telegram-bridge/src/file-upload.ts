// Handles file uploads from Discord to Telegram.
// Downloads Discord attachment URLs and re-uploads via Telegram Bot API.

import type { TelegramBotClient } from './telegram-client.js'

export interface DiscordAttachment {
  id: string
  filename: string
  size: number
  url: string
  data?: Blob
  proxy_url?: string
  content_type?: string
}

/**
 * Upload Discord attachments to a Telegram chat/thread.
 * Downloads each file from Discord's CDN and re-uploads via Telegram.
 */
export async function uploadAttachmentsToTelegram({
  telegram,
  attachments,
  chatId,
  messageThreadId,
}: {
  telegram: TelegramBotClient
  attachments: DiscordAttachment[]
  chatId: number
  messageThreadId?: number
}): Promise<void> {
  for (const attachment of attachments) {
    await uploadSingleFile({
      telegram,
      attachment,
      chatId,
      messageThreadId,
    })
  }
}

async function uploadSingleFile({
  telegram,
  attachment,
  chatId,
  messageThreadId,
}: {
  telegram: TelegramBotClient
  attachment: DiscordAttachment
  chatId: number
  messageThreadId?: number
}): Promise<void> {
  const fileBlob = await resolveAttachmentBlob(attachment)

  const isImage = attachment.content_type?.startsWith('image/') ?? false

  if (isImage) {
    await telegram.sendPhoto({
      chatId,
      photo: fileBlob,
      filename: attachment.filename,
      messageThreadId,
    })
  } else {
    await telegram.sendDocument({
      chatId,
      document: fileBlob,
      filename: attachment.filename,
      messageThreadId,
    })
  }
}

async function resolveAttachmentBlob(
  attachment: DiscordAttachment,
): Promise<Blob> {
  if (attachment.data) {
    return attachment.data
  }

  const response = await fetch(attachment.url)
  if (!response.ok) {
    throw new Error(
      `Failed to download attachment ${attachment.filename}: ${response.status}`,
    )
  }
  return await response.blob()
}
