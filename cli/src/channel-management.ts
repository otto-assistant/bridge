// Discord channel and category management.
// Creates and manages Otto project channels (text + voice pairs),
// extracts channel metadata from topic tags, and ensures category structure.

import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type TextChannel,
} from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  getChannelDirectory,
  setChannelDirectory,
  findChannelsByDirectory,
} from './database.js'
import { getProjectsDir } from './config.js'
import { execAsync } from './worktrees.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.CHANNEL)

// Legacy category names kept for backward-compat lookup on existing servers.
// New categories are created with the current "Otto" / "Otto Audio" names.
const CATEGORY_NAME = 'Otto'
const CATEGORY_NAME_AUDIO = 'Otto Audio'
const LEGACY_CATEGORY_NAME = 'Kimaki'
const LEGACY_CATEGORY_NAME_AUDIO = 'Kimaki Audio'

export async function ensureOttoCategory(
  guild: Guild,
  botName?: string,
): Promise<CategoryChannel> {
  // Skip appending bot name if it's already "otto" to avoid "Otto otto"
  const isOttoBot = botName?.toLowerCase() === 'otto'
  const categoryName = botName && !isOttoBot ? `${CATEGORY_NAME} ${botName}` : CATEGORY_NAME
  // Legacy names to check when looking up existing categories on older servers
  const isKimakiBot = botName?.toLowerCase() === 'kimaki'
  const legacyCategoryName =
    botName && !isKimakiBot ? `${LEGACY_CATEGORY_NAME} ${botName}` : LEGACY_CATEGORY_NAME

  const existingCategory = guild.channels.cache.find(
    (channel): channel is CategoryChannel => {
      if (channel.type !== ChannelType.GuildCategory) {
        return false
      }
      const name = channel.name.toLowerCase()
      return (
        name === categoryName.toLowerCase() ||
        name === legacyCategoryName.toLowerCase()
      )
    },
  )

  if (existingCategory) {
    return existingCategory
  }

  return guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
  })
}

// Keep old export name as an alias for any callers that haven't been updated yet
export const ensureKimakiCategory = ensureOttoCategory

export async function ensureOttoAudioCategory(
  guild: Guild,
  botName?: string,
): Promise<CategoryChannel> {
  // Skip appending bot name if it's already "otto" to avoid "Otto Audio otto"
  const isOttoBot = botName?.toLowerCase() === 'otto'
  const categoryName =
    botName && !isOttoBot ? `${CATEGORY_NAME_AUDIO} ${botName}` : CATEGORY_NAME_AUDIO
  const isKimakiBot = botName?.toLowerCase() === 'kimaki'
  const legacyCategoryName =
    botName && !isKimakiBot
      ? `${LEGACY_CATEGORY_NAME_AUDIO} ${botName}`
      : LEGACY_CATEGORY_NAME_AUDIO

  const existingCategory = guild.channels.cache.find(
    (channel): channel is CategoryChannel => {
      if (channel.type !== ChannelType.GuildCategory) {
        return false
      }
      const name = channel.name.toLowerCase()
      return (
        name === categoryName.toLowerCase() ||
        name === legacyCategoryName.toLowerCase()
      )
    },
  )

  if (existingCategory) {
    return existingCategory
  }

  return guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
  })
}

export const ensureKimakiAudioCategory = ensureOttoAudioCategory

export async function createProjectChannels({
  guild,
  projectDirectory,
  botName,
  enableVoiceChannels = false,
}: {
  guild: Guild
  projectDirectory: string
  botName?: string
  enableVoiceChannels?: boolean
}): Promise<{
  textChannelId: string
  voiceChannelId: string | null
  channelName: string
}> {
  const baseName = path.basename(projectDirectory)
  const channelName = `${baseName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 100)

  const ottoCategory = await ensureOttoCategory(guild, botName)

  const textChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: ottoCategory,
    // Channel configuration is stored in SQLite, not in the topic
  })

  await setChannelDirectory({
    channelId: textChannel.id,
    directory: projectDirectory,
    channelType: 'text',
  })

  let voiceChannelId: string | null = null

  if (enableVoiceChannels) {
    const ottoAudioCategory = await ensureOttoAudioCategory(guild, botName)

    const voiceChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: ottoAudioCategory,
    })

    await setChannelDirectory({
      channelId: voiceChannel.id,
      directory: projectDirectory,
      channelType: 'voice',
    })

    voiceChannelId = voiceChannel.id
  }

  return {
    textChannelId: textChannel.id,
    voiceChannelId,
    channelName,
  }
}

export type ChannelWithTags = {
  id: string
  name: string
  description: string | null
  kimakiDirectory?: string
}

export async function getChannelsWithDescriptions(
  guild: Guild,
): Promise<ChannelWithTags[]> {
  const channels: ChannelWithTags[] = []

  const textChannels = guild.channels.cache.filter((channel) =>
    channel.isTextBased(),
  )

  for (const channel of textChannels.values()) {
    const textChannel = channel as TextChannel
    const description = textChannel.topic || null

    // Get channel config from database instead of parsing XML from topic
    const channelConfig = await getChannelDirectory(textChannel.id)

    channels.push({
      id: textChannel.id,
      name: textChannel.name,
      description,
      kimakiDirectory: channelConfig?.directory,
    })
  }

  return channels
}

const DEFAULT_GITIGNORE = `node_modules/
dist/
.env
.env.*
!.env.example
.DS_Store
tmp/
*.log
__pycache__/
*.pyc
.venv/
*.egg-info/
`

const DEFAULT_CHANNEL_TOPIC =
  'General channel for misc tasks with Otto. Not connected to a specific OpenCode project or repository.'

/**
 * Create (or find) the default "otto" channel for general-purpose tasks.
 * Channel name is "otto-{botName}" for self-hosted bots, "otto" for gateway.
 * Directory is <dataDir>/projects/otto (or the legacy <dataDir>/projects/kimaki
 * if that already exists on disk), git-initialized with a .gitignore.
 *
 * Idempotency: checks the database for an existing channel mapped to the
 * otto (or legacy kimaki) projects directory. Also scans guild channels by
 * name+category as a fallback for channels created before DB mapping existed.
 */
export async function createDefaultOttoChannel({
  guild,
  botName,
  appId,
  isGatewayMode,
}: {
  guild: Guild
  botName?: string
  appId: string
  isGatewayMode: boolean
}): Promise<{
  textChannel: TextChannel
  textChannelId: string
  channelName: string
  projectDirectory: string
} | null> {
  // Use the legacy "kimaki" sub-directory if it already exists on disk so
  // existing users keep their project history. New installs use "otto".
  const legacyProjectDirectory = path.join(getProjectsDir(), 'kimaki')
  const projectDirectory = fs.existsSync(legacyProjectDirectory)
    ? legacyProjectDirectory
    : path.join(getProjectsDir(), 'otto')

  // Ensure the project directory exists before any DB mapping restoration
  // or git setup. Custom data dirs may not have <dataDir>/projects created
  // yet, and later writes assume the full path is present.
  if (!fs.existsSync(projectDirectory)) {
    fs.mkdirSync(projectDirectory, { recursive: true })
    logger.log(`Created default otto directory: ${projectDirectory}`)
  }

  // Hydrate guild channels from API so the cache scan is complete
  try {
    await guild.channels.fetch()
  } catch (error) {
    logger.warn(
      `Could not fetch guild channels for ${guild.name}: ${error instanceof Error ? error.stack : String(error)}`,
    )
  }

  // 1. Check database for existing channel mapped to this directory.
  // Check ALL mappings (not just the first) since the same directory could
  // have stale rows from deleted channels or other guilds.
  const existingMappings = await findChannelsByDirectory({
    directory: projectDirectory,
    channelType: 'text',
  })
  const mappedChannelInGuild = existingMappings
    .map((row) => guild.channels.cache.get(row.channel_id))
    .find((ch): ch is TextChannel => ch?.type === ChannelType.GuildText)
  if (mappedChannelInGuild) {
    logger.log(`Default otto channel already exists: ${mappedChannelInGuild.id}`)
    return null
  }

  // 2. Fallback: detect existing channel by name+category (handles both the
  // current "otto"/"otto-*" names and legacy "kimaki"/"kimaki-*" names).
  const ottoCategory = await ensureOttoCategory(guild, botName)
  const existingByName = guild.channels.cache.find((ch): ch is TextChannel => {
    if (ch.type !== ChannelType.GuildText) {
      return false
    }
    if (ch.parentId !== ottoCategory.id) {
      return false
    }
    return (
      ch.name === 'otto' ||
      ch.name.startsWith('otto-') ||
      ch.name === 'kimaki' ||
      ch.name.startsWith('kimaki-')
    )
  })
  if (existingByName) {
    logger.log(
      `Found existing default channel by name: ${existingByName.id}, restoring DB mapping`,
    )
    await setChannelDirectory({
      channelId: existingByName.id,
      directory: projectDirectory,
      channelType: 'text',
      skipIfExists: true,
    })
    return null
  }

  // Git init — gracefully skip if git is not installed
  const gitDir = path.join(projectDirectory, '.git')
  if (!fs.existsSync(gitDir)) {
    try {
      await execAsync('git init', { cwd: projectDirectory, timeout: 10_000 })
      logger.log(`Initialized git in: ${projectDirectory}`)
    } catch (error) {
      logger.warn(
        `Could not initialize git in ${projectDirectory}: ${error instanceof Error ? error.stack : String(error)}`,
      )
    }
  }

  // Write .gitignore if it doesn't exist
  const gitignorePath = path.join(projectDirectory, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE)
  }

  // Channel name: "otto-{botName}" for self-hosted, "otto" for gateway
  const channelName = (() => {
    if (isGatewayMode || !botName) {
      return 'otto'
    }
    const sanitized = botName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    if (!sanitized || sanitized === 'otto') {
      return 'otto'
    }
    return `otto-${sanitized}`.slice(0, 100)
  })()

  const textChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: ottoCategory,
    topic: DEFAULT_CHANNEL_TOPIC,
  })

  await setChannelDirectory({
    channelId: textChannel.id,
    directory: projectDirectory,
    channelType: 'text',
  })

  logger.log(`Created default otto channel: #${channelName} (${textChannel.id})`)

  return {
    textChannel,
    textChannelId: textChannel.id,
    channelName,
    projectDirectory,
  }
}

// Keep legacy export name so any unupdated callers still compile
export const createDefaultKimakiChannel = createDefaultOttoChannel
