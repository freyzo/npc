import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { CDP } from './cdp.js'
import type { NPCRelay } from './relay.js'
import { writeFile } from 'fs/promises'
import { resolve, dirname } from 'path'
import { mkdirSync } from 'fs'

export function createMCPServer(relay: NPCRelay): McpServer {
  const server = new McpServer({
    name: 'npc',
    version: '0.2.0'
  })

  function getCDP(): CDP {
    const sid = relay.activeSession
    if (!sid) throw new Error('No active browser session. Is the Chrome extension connected?')
    return new CDP(relay, sid)
  }

  // ── npc_screenshot ──────────────────────────────────────────────────────────

  server.tool(
    'npc_screenshot',
    'Take a screenshot of the real Chrome browser tab (via NPC Chrome extension + CDP). Returns base64 PNG.',
    {
      savePath: z.string().optional().describe('Optional absolute file path to save the PNG to disk')
    },
    async ({ savePath }) => {
      const cdp = getCDP()
      const { data, dpr } = await cdp.screenshot()

      if (savePath) {
        const abs = resolve(savePath)
        try { mkdirSync(dirname(abs), { recursive: true }) } catch {}
        await writeFile(abs, Buffer.from(data, 'base64'))
      }

      return {
        content: [
          { type: 'image', data, mimeType: 'image/png' },
          { type: 'text', text: `Device pixel ratio: ${dpr}. Divide image coords by ${dpr} before passing to click/scroll.${savePath ? ` Saved to ${savePath}` : ''}` }
        ]
      }
    }
  )

  // ── npc_navigate ────────────────────────────────────────────────────────────

  server.tool(
    'npc_navigate',
    'Navigate the real Chrome browser to a URL (via NPC Chrome extension + CDP)',
    { url: z.string().describe('The URL to navigate to') },
    async ({ url }) => {
      try {
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error(`Blocked navigation to ${parsed.protocol} URL - only http: and https: are allowed`)
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Blocked')) throw e
        throw new Error(`Invalid URL: ${url}`)
      }
      const cdp = getCDP()
      await cdp.navigate(url)
      const title = await cdp.pageTitle().catch(() => '')
      return { content: [{ type: 'text', text: `Navigated to ${url} - "${title}"` }] }
    }
  )

  // ── npc_click ───────────────────────────────────────────────────────────────

  server.tool(
    'npc_click',
    'Click at pixel coordinates in the real Chrome browser viewport',
    {
      x: z.number().describe('X coordinate (pixels from left)'),
      y: z.number().describe('Y coordinate (pixels from top)')
    },
    async ({ x, y }) => {
      const cdp = getCDP()
      await cdp.click(x, y)
      return { content: [{ type: 'text', text: `Clicked at (${x}, ${y})` }] }
    }
  )

  // ── npc_type ────────────────────────────────────────────────────────────────

  server.tool(
    'npc_type',
    'Type text into the focused element in the real Chrome browser',
    { text: z.string().describe('Text to type') },
    async ({ text }) => {
      const cdp = getCDP()
      await cdp.type(text)
      return { content: [{ type: 'text', text: `Typed "${text}"` }] }
    }
  )

  // ── npc_press_key ───────────────────────────────────────────────────────────

  server.tool(
    'npc_press_key',
    'Press a keyboard key in the real Chrome browser (Enter, Tab, Escape, ArrowDown, etc.)',
    { key: z.string().describe('Key name, e.g. "Return", "Tab", "Escape"') },
    async ({ key }) => {
      const cdp = getCDP()
      await cdp.pressKey(key)
      return { content: [{ type: 'text', text: `Pressed ${key}` }] }
    }
  )

  // ── npc_scroll ──────────────────────────────────────────────────────────────

  server.tool(
    'npc_scroll',
    'Scroll the page in the real Chrome browser',
    {
      direction: z.enum(['up', 'down']).describe('Scroll direction'),
      amount: z.number().optional().default(500).describe('Pixels to scroll (default 500)')
    },
    async ({ direction, amount }) => {
      const cdp = getCDP()
      await cdp.scroll(direction, amount)
      return { content: [{ type: 'text', text: `Scrolled ${direction} ${amount}px` }] }
    }
  )

  // ── npc_find ────────────────────────────────────────────────────────────────

  server.tool(
    'npc_find',
    'Find an element on the page by CSS selector or text content. Returns center coordinates for clicking. Searches text content, aria-label, and placeholder attributes.',
    {
      selector: z.string().describe('CSS selector (e.g. "button.submit") or text to find (e.g. "Send message")')
    },
    async ({ selector }) => {
      const cdp = getCDP()
      const result = await cdp.findElement(selector)
      if (!result.found) {
        return { content: [{ type: 'text', text: `Element not found: "${selector}"` }] }
      }
      return {
        content: [{
          type: 'text',
          text: `Found at (${result.x}, ${result.y}) - text: "${result.text}"`
        }]
      }
    }
  )

  // ── npc_batch ───────────────────────────────────────────────────────────────

  server.tool(
    'npc_batch',
    `Execute multiple browser actions in a single call. Cuts MCP round-trip overhead.
Each action is an object with an "action" field and relevant params.
Actions: click(x,y), type(text), key(key), scroll(direction,amount), navigate(url), screenshot(), wait(ms), evaluate(expression), find(selector).
Stops on first error. Example: [{"action":"find","selector":"Message Tim"},{"action":"click","x":100,"y":200},{"action":"type","text":"hello"},{"action":"key","key":"Enter"}]`,
    {
      actions: z.array(z.object({
        action: z.enum(['click', 'type', 'key', 'scroll', 'navigate', 'screenshot', 'wait', 'evaluate', 'find']),
        x: z.number().optional(),
        y: z.number().optional(),
        text: z.string().optional(),
        key: z.string().optional(),
        direction: z.enum(['up', 'down']).optional(),
        amount: z.number().optional(),
        url: z.string().optional(),
        expression: z.string().optional(),
        selector: z.string().optional(),
        ms: z.number().optional()
      })).describe('Array of actions to execute sequentially')
    },
    async ({ actions }) => {
      const cdp = getCDP()
      const results = await cdp.executeBatch(actions)

      // If any action was a screenshot, include it as image content
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
      const summary: string[] = []

      for (const r of results) {
        if (r.ok && r.action === 'screenshot' && r.result?.data) {
          content.push({ type: 'image', data: r.result.data, mimeType: 'image/png' })
          summary.push(`screenshot (dpr: ${r.result.dpr})`)
        } else if (r.ok) {
          summary.push(`${r.action}: ${typeof r.result === 'object' ? JSON.stringify(r.result) : r.result}`)
        } else {
          summary.push(`${r.action}: FAILED - ${r.error}`)
        }
      }

      content.push({ type: 'text', text: `Batch: ${results.length}/${actions.length} actions\n${summary.join('\n')}` })
      return { content }
    }
  )

  // ── npc_extract_text ────────────────────────────────────────────────────────

  server.tool(
    'npc_extract_text',
    'Get full text content from the real Chrome browser page',
    {},
    async () => {
      const cdp = getCDP()
      const text = await cdp.extractText()
      return { content: [{ type: 'text', text }] }
    }
  )

  // ── npc_extract_html ────────────────────────────────────────────────────────

  server.tool(
    'npc_extract_html',
    'Get full HTML from the real Chrome browser page',
    {},
    async () => {
      const cdp = getCDP()
      const html = await cdp.extractHTML()
      return { content: [{ type: 'text', text: html }] }
    }
  )

  // ── npc_evaluate ────────────────────────────────────────────────────────────

  server.tool(
    'npc_evaluate',
    'Run JavaScript in the real Chrome browser page context and return the result',
    { expression: z.string().describe('JavaScript expression to evaluate') },
    async ({ expression }) => {
      const cdp = getCDP()
      const result = await cdp.evaluate(expression)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  // ── npc_current_url ─────────────────────────────────────────────────────────

  server.tool(
    'npc_current_url',
    'Get the URL of the current tab in the real Chrome browser',
    {},
    async () => {
      const cdp = getCDP()
      const url = await cdp.currentUrl()
      return { content: [{ type: 'text', text: url }] }
    }
  )

  // ── npc_page_title ──────────────────────────────────────────────────────────

  server.tool(
    'npc_page_title',
    'Get the title of the current tab in the real Chrome browser',
    {},
    async () => {
      const cdp = getCDP()
      const title = await cdp.pageTitle()
      return { content: [{ type: 'text', text: title }] }
    }
  )

  return server
}
