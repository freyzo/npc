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
    version: '1.0.0'
  })

  async function getCDP(): Promise<CDP> {
    let sid = relay.activeSession
    if (!sid) {
      sid = await relay.waitForReady(15_000)
    }
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
      const cdp = await getCDP()
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
      const cdp = await getCDP()
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
      const cdp = await getCDP()
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
      const cdp = await getCDP()
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
      const cdp = await getCDP()
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
      const cdp = await getCDP()
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
      const cdp = await getCDP()
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

  // ── npc_wait_for ────────────────────────────────────────────────────────────

  server.tool(
    'npc_wait_for',
    'Wait for an element to appear on the page (by CSS selector or text). Polls every 500ms until found or timeout. Use after navigation or SPA route changes instead of screenshot-retry loops.',
    {
      selector: z.string().describe('CSS selector or text content to wait for'),
      timeout: z.number().optional().default(10000).describe('Max wait time in ms (default 10000)')
    },
    async ({ selector, timeout }) => {
      const cdp = await getCDP()
      const result = await cdp.waitForElement(selector, timeout)
      if (!result.found) {
        return { content: [{ type: 'text', text: `Timed out after ${timeout}ms waiting for "${selector}"` }] }
      }
      return {
        content: [{
          type: 'text',
          text: `Found "${selector}" at (${result.x}, ${result.y}) - text: "${result.text}"`
        }]
      }
    }
  )

  // ── npc_status ─────────────────────────────────────────────────────────────

  server.tool(
    'npc_status',
    'Check NPC relay and extension health. Returns connection state, active session, and current URL. Call this before issuing commands to avoid wasted retries.',
    {},
    async () => {
      const connected = relay.isConnected()
      const session = relay.activeSession
      let url = ''
      let title = ''
      if (connected && session) {
        const cdp = new CDP(relay, session)
        try {
          [url, title] = await Promise.all([
            cdp.currentUrl().catch(() => ''),
            cdp.pageTitle().catch(() => '')
          ])
        } catch {}
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ relayUp: true, extensionConnected: connected, sessionId: session, url, title }, null, 2)
        }]
      }
    }
  )

  // ── npc_batch ───────────────────────────────────────────────────────────────

  server.tool(
    'npc_batch',
    `Execute multiple browser actions in a single call. Cuts MCP round-trip overhead.
Each action is an object with an "action" field and relevant params.
Actions: click(x,y), type(text), key(key), scroll(direction,amount), navigate(url), screenshot(), wait(ms), evaluate(expression), find(selector), wait_for(selector,timeout).
Stops on first error. Example: [{"action":"find","selector":"Message Tim"},{"action":"click","x":100,"y":200},{"action":"type","text":"hello"},{"action":"key","key":"Enter"}]`,
    {
      actions: z.array(z.object({
        action: z.enum(['click', 'type', 'key', 'scroll', 'navigate', 'screenshot', 'wait', 'evaluate', 'find', 'wait_for']),
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
      const cdp = await getCDP()
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

  // ── npc_fetch ────────────────────────────────────────────────────────────────

  server.tool(
    'npc_fetch',
    `Fetch a URL using the browser extension - bypasses CORS and includes the user's cookies/session for that domain.
Use this to hit APIs the user is already logged into (Microsoft Graph, GitHub, Slack, etc.) without separate auth.
The extension forwards cookies from the browser's cookie jar for the target URL's domain.
For APIs needing a Bearer token (like Graph API), extract the token from the page first via npc_evaluate, then pass it in headers.`,
    {
      url: z.string().describe('URL to fetch'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().default('GET').describe('HTTP method'),
      headers: z.record(z.string()).optional().describe('Custom headers (e.g. {"Authorization": "Bearer xxx"})'),
      body: z.string().optional().describe('Request body for POST/PUT/PATCH')
    },
    async ({ url, method, headers, body }) => {
      const options: Record<string, any> = { method }
      if (headers) options.headers = headers
      if (body) options.body = body
      const result = await relay.fetch(url, options)
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      }
    }
  )

  // ── npc_teams_unread ────────────────────────────────────────────────────────

  server.tool(
    'npc_teams_unread',
    `Check Microsoft Teams for unread messages. Works by inspecting the Teams web app DOM.
If the browser is already on teams.microsoft.com, reads the current page. Otherwise navigates there first.
Returns: unread count from page title, list of chats with unread badges, and recent message previews.
Requires the user to be logged into Teams in the browser.`,
    {
      navigate: z.boolean().optional().default(true).describe('Navigate to Teams if not already there (default true)')
    },
    async ({ navigate }) => {
      const cdp = await getCDP()
      const currentUrl = await cdp.currentUrl().catch(() => '')

      // Navigate to Teams if needed
      const isOnTeams = currentUrl.includes('teams.microsoft.com') || currentUrl.includes('teams.live.com')
      if (!isOnTeams && navigate) {
        await cdp.navigate('https://teams.microsoft.com/v2/')
        // Wait for Teams to load - it's a heavy SPA
        await cdp.waitForElement('[data-tid="chat-list"]', 15000).catch(() => null)
        // Extra settle time for React hydration
        await new Promise(r => setTimeout(r, 2000))
      } else if (!isOnTeams && !navigate) {
        return {
          content: [{ type: 'text', text: 'Not on Teams and navigate=false. Set navigate=true or navigate to teams.microsoft.com first.' }]
        }
      }

      // Extract unread state from the DOM
      const result = await cdp.evaluate<{
        titleCount: number | null
        unreadChats: Array<{ name: string; preview: string; time: string }>
        totalUnread: number
        loggedIn: boolean
      }>(`
        (() => {
          // Check if we're on a login page
          const isLogin = window.location.hostname.includes('login.microsoftonline.com') ||
                          window.location.hostname.includes('login.live.com') ||
                          document.querySelector('[data-testid="login"]') !== null;
          if (isLogin) return { titleCount: null, unreadChats: [], totalUnread: 0, loggedIn: false };

          // 1. Title-based count - most resilient
          //    Teams shows "(3) Microsoft Teams" or "(3) Chat | Microsoft Teams"
          const titleMatch = document.title.match(/^\\((\\d+)\\)/);
          const titleCount = titleMatch ? parseInt(titleMatch[1]) : null;

          // 2. Chat list unread badges - scrape the sidebar
          const unreadChats = [];
          // Teams v2 uses various selectors for unread indicators
          const chatItems = document.querySelectorAll(
            '[data-tid="chat-list-item"], ' +
            '[role="treeitem"], ' +
            '[data-testid="chat-list-item"], ' +
            '.chat-list-item'
          );

          for (const item of chatItems) {
            // Look for unread indicators: bold text, badge dots, aria-label with "unread"
            const hasUnread =
              item.querySelector('[class*="unread"], [class*="badge"], [data-tid*="unread"]') !== null ||
              (item.getAttribute('aria-label') || '').toLowerCase().includes('unread') ||
              item.querySelector('b, strong, [style*="font-weight: bold"], [style*="font-weight:700"]') !== null;

            if (hasUnread) {
              const nameEl = item.querySelector('[data-tid="chat-display-name"], [class*="displayName"], [class*="title"]');
              const previewEl = item.querySelector('[data-tid="chat-last-message"], [class*="preview"], [class*="lastMessage"], [class*="subtitle"]');
              const timeEl = item.querySelector('[data-tid="chat-timestamp"], [class*="timestamp"], time');
              unreadChats.push({
                name: (nameEl?.textContent || item.textContent || '').trim().slice(0, 100),
                preview: (previewEl?.textContent || '').trim().slice(0, 200),
                time: (timeEl?.textContent || timeEl?.getAttribute('datetime') || '').trim()
              });
            }
          }

          // 3. Fallback: check for notification badge on Chat icon in the left nav
          let totalUnread = titleCount || 0;
          if (!totalUnread) {
            const chatNav = document.querySelector('[data-tid="app-bar-chat"] [class*="badge"], [aria-label*="Chat"] [class*="badge"]');
            if (chatNav) {
              const badgeText = chatNav.textContent?.trim();
              totalUnread = parseInt(badgeText || '0') || (badgeText ? 1 : 0);
            }
          }

          return { titleCount, unreadChats, totalUnread: Math.max(totalUnread, unreadChats.length), loggedIn: true };
        })()
      `)

      if (!result.loggedIn) {
        return {
          content: [{ type: 'text', text: 'Teams login page detected - you need to log in first. Use npc_screenshot to see the login page, then npc_click/npc_type to authenticate.' }]
        }
      }

      const lines: string[] = []
      if (result.totalUnread > 0) {
        lines.push(`${result.totalUnread} unread message${result.totalUnread > 1 ? 's' : ''}`)
      } else {
        lines.push('No unread messages')
      }

      if (result.unreadChats.length > 0) {
        lines.push('')
        for (const chat of result.unreadChats) {
          const timePart = chat.time ? ` (${chat.time})` : ''
          const previewPart = chat.preview ? ` - "${chat.preview}"` : ''
          lines.push(`  ${chat.name}${timePart}${previewPart}`)
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }
  )

  // ── npc_extract_text ────────────────────────────────────────────────────────

  server.tool(
    'npc_extract_text',
    'Get full text content from the real Chrome browser page',
    {},
    async () => {
      const cdp = await getCDP()
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
      const cdp = await getCDP()
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
      const cdp = await getCDP()
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
      const cdp = await getCDP()
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
      const cdp = await getCDP()
      const title = await cdp.pageTitle()
      return { content: [{ type: 'text', text: title }] }
    }
  )

  return server
}
