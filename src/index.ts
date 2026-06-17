#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { NPCRelay } from './relay.js'
import { createMCPServer } from './mcp.js'

const PORT = 7221
const relayOnly = process.argv.includes('--relay-only')

// Boot the relay (WebSocket bridge to Brave/Chrome extension)
const relay = new NPCRelay(PORT)

relay.on('extensionConnected', () => {
  process.stderr.write('[npc] browser extension connected\n')
})
relay.on('sessionReady', (sid: string) => {
  process.stderr.write(`[npc] tab session ready (${sid})\n`)
})
relay.on('extensionDisconnected', () => {
  process.stderr.write('[npc] browser extension disconnected\n')
})

process.on('SIGINT', () => { relay.close(); process.exit(0) })
process.on('SIGTERM', () => { relay.close(); process.exit(0) })

process.stderr.write(`[npc] relay listening on ws://localhost:${PORT}\n`)

if (relayOnly) {
  process.stderr.write('[npc] relay-only mode — load NPC extension in Brave, click icon on a tab\n')
} else {
  const mcpServer = createMCPServer(relay)
  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
  process.stderr.write('[npc] MCP server ready — waiting for Brave extension\n')
}
