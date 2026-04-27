import { describe, test, expect } from 'vitest'
import { markdownToTelegramHtml, telegramHtmlToMarkdown } from './format-converter.js'

describe('markdownToTelegramHtml', () => {
  test('converts bold', () => {
    expect(markdownToTelegramHtml('**hello**')).toBe('<b>hello</b>')
  })

  test('converts italic', () => {
    expect(markdownToTelegramHtml('*hello*')).toBe('<i>hello</i>')
  })

  test('converts strikethrough', () => {
    expect(markdownToTelegramHtml('~~hello~~')).toBe('<s>hello</s>')
  })

  test('converts inline code', () => {
    expect(markdownToTelegramHtml('`hello`')).toBe('<code>hello</code>')
  })

  test('converts markdown links', () => {
    expect(markdownToTelegramHtml('[text](https://example.com)')).toBe(
      '<a href="https://example.com">text</a>',
    )
  })

  test('converts code blocks', () => {
    const input = '```ts\nconst x = 1\n```'
    const result = markdownToTelegramHtml(input)
    expect(result).toContain('<pre><code class="language-ts">')
    expect(result).toContain('const x = 1')
    expect(result).toContain('</code></pre>')
  })

  test('converts code blocks without language', () => {
    const input = '```\nhello\n```'
    const result = markdownToTelegramHtml(input)
    expect(result).toContain('<pre><code>')
    expect(result).toContain('hello')
  })

  test('escapes HTML entities in plain text', () => {
    expect(markdownToTelegramHtml('a < b > c & d')).toBe(
      'a &lt; b &gt; c &amp; d',
    )
  })

  test('handles mixed formatting', () => {
    const result = markdownToTelegramHtml('**bold** and *italic* and `code`')
    expect(result).toBe('<b>bold</b> and <i>italic</i> and <code>code</code>')
  })

  test('preserves plain text', () => {
    expect(markdownToTelegramHtml('hello world')).toBe('hello world')
  })
})

describe('telegramHtmlToMarkdown', () => {
  test('converts bold', () => {
    expect(telegramHtmlToMarkdown('<b>hello</b>')).toBe('**hello**')
  })

  test('converts italic', () => {
    expect(telegramHtmlToMarkdown('<i>hello</i>')).toBe('*hello*')
  })

  test('converts strikethrough', () => {
    expect(telegramHtmlToMarkdown('<s>hello</s>')).toBe('~~hello~~')
  })

  test('converts inline code', () => {
    expect(telegramHtmlToMarkdown('<code>hello</code>')).toBe('`hello`')
  })

  test('converts links', () => {
    expect(telegramHtmlToMarkdown('<a href="https://example.com">text</a>')).toBe(
      '[text](https://example.com)',
    )
  })

  test('converts underline', () => {
    expect(telegramHtmlToMarkdown('<u>hello</u>')).toBe('__hello__')
  })

  test('converts spoiler', () => {
    expect(telegramHtmlToMarkdown('<tg-spoiler>hello</tg-spoiler>')).toBe('||hello||')
  })

  test('converts blockquote', () => {
    expect(telegramHtmlToMarkdown('<blockquote>hello</blockquote>')).toBe('> hello')
  })

  test('decodes HTML entities', () => {
    expect(telegramHtmlToMarkdown('a &lt; b &amp; c')).toBe('a < b & c')
  })

  test('strips unknown HTML tags', () => {
    expect(telegramHtmlToMarkdown('<div>hello</div>')).toBe('hello')
  })
})
