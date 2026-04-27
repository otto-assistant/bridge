// Bidirectional format converter between Discord markdown and Telegram HTML.
//
// Discord markdown uses:
//   **bold**, *italic*, ~~strike~~, [text](url), `code`, ```code blocks```
//
// Telegram HTML uses:
//   <b>bold</b>, <i>italic</i>, <s>strike</s>, <a href="url">text</a>,
//   <code>code</code>, <pre><code>code blocks</code></pre>
//
// Both use same code block syntax with ``` but Telegram requires HTML tags.

/**
 * Convert Discord markdown to Telegram HTML (outbound, REST).
 * Used when translating discord.js message posts into Telegram sendMessage.
 */
export function markdownToTelegramHtml(text: string): string {
  let result = text

  // Escape HTML entities first (but not inside code blocks)
  const codeBlocks: string[] = []
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match)
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`
  })

  const inlineCode: string[] = []
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match)
    return `\x00INLINE${inlineCode.length - 1}\x00`
  })

  // Escape HTML entities in the remaining text
  result = result
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Convert markdown links [text](url) to Telegram <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Convert bold: **text** -> <b>text</b>
  result = result.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')

  // Convert italic: *text* -> <i>text</i> (but not inside <b> tags)
  result = result.replace(/(?<![<>*/])\*([^*\n]+)\*(?![*/])/g, '<i>$1</i>')

  // Convert strikethrough: ~~text~~ -> <s>text</s>
  result = result.replace(/~~([^~]+)~~/g, '<s>$1</s>')

  // Convert inline code: `code` -> <code>code</code>
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_, idx) => {
    const raw = inlineCode[Number(idx)]!
    const code = raw.slice(1, -1)
    return `<code>${escapeHtml(code)}</code>`
  })

  // Convert code blocks: ```lang\ncode\n``` -> <pre><code class="lang">code</code></pre>
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => {
    const raw = codeBlocks[Number(idx)]!
    // Extract language and content from ```lang\n...\n```
    const match = raw.match(/^```(\w*)\n?([\s\S]*?)\n?```$/)
    if (match) {
      const lang = match[1] ?? ''
      const code = match[2] ?? ''
      const escaped = escapeHtml(code)
      if (lang) {
        return `<pre><code class="language-${lang}">${escaped}</code></pre>`
      }
      return `<pre><code>${escaped}</code></pre>`
    }
    return `<pre><code>${escapeHtml(raw)}</code></pre>`
  })

  return result
}

/**
 * Convert Telegram HTML to Discord markdown (inbound, events).
 * Used when translating Telegram messages into Discord MESSAGE_CREATE.
 */
export function telegramHtmlToMarkdown(html: string): string {
  let result = html

  // Telegram may use HTML entities
  result = decodeHtmlEntities(result)

  // Convert <a href="url">text</a> -> [text](url)
  result = result.replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')

  // Convert <b>text</b> or <strong>text</strong> -> **text**
  result = result.replace(/<(?:b|strong)>(.*?)<\/?(?:b|strong)>/gi, '**$1**')

  // Convert <i>text</i> or <em>text</em> -> *text*
  result = result.replace(/<(?:i|em)>(.*?)<\/?(?:i|em)>/gi, '*$1*')

  // Convert <s>text</s> or <del>text</del> or <strike>text</strike> -> ~~text~~
  result = result.replace(/<(?:s|del|strike)>(.*?)<\/?(?:s|del|strike)>/gi, '~~$1~~')

  // Convert <code>text</code> -> `text`
  result = result.replace(/<code(?:\s[^>]*)?>(.*?)<\/code>/gi, '`$1`')

  // Convert <pre><code ...>text</code></pre> -> ```lang\ntext\n```
  result = result.replace(
    /<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/gi,
    (_, lang, code) => {
      const language = lang ?? ''
      return `\`\`\`${language}\n${code}\n\`\`\``
    },
  )

  // Convert <pre>text</pre> -> ```text```
  result = result.replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')

  // Convert <u>text</u> -> __text__ (Discord underline)
  result = result.replace(/<u>(.*?)<\/u>/gi, '__$1__')

  // Convert <blockquote>text</blockquote> -> > text
  result = result.replace(/<blockquote(?:expandable)?>([\s\S]*?)<\/blockquote>/gi, (_, text) => {
    const lines = text.split('\n').map((line: string) => `> ${line}`)
    return lines.join('\n')
  })

  // Convert <tg-spoiler>text</tg-spoiler> -> ||text|| (Discord spoiler)
  result = result.replace(/<tg-spoiler>(.*?)<\/tg-spoiler>/gi, '||$1||')

  // Strip any remaining HTML tags
  result = result.replace(/<\/?[a-zA-Z][^>]*>/g, '')

  // Final cleanup of HTML entities that weren't decoded
  result = decodeHtmlEntities(result)

  return result
}

/**
 * Escape special HTML characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Decode common HTML entities.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      return String.fromCharCode(Number(code))
    })
}
