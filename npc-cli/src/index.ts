#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { NPCRelay } from './relay.js'
import { createMCPServer } from './mcp.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stderr.write(`NPC - Your browser's NPC. Handles the side quests.

Usage:
  npc                   Start MCP server (IDE connects via stdio)
  npc --relay-only      Extension bridge without MCP
  npc --help            Show this help
  npc --version         Show version

Configure your IDE:
  Add to .cursor/mcp.json or .vscode/mcp.json:
  {
    "mcpServers": {
      "npc": { "command": "npc", "args": [] }
    }
  }

Environment:
  NPC_PORT    Override relay port (default: 7221)

Docs: https://github.com/freyzo/npc
`)
  process.exit(0)
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'))
    process.stdout.write(pkg.version + '\n')
  } catch {
    process.stdout.write('unknown\n')
  }
  process.exit(0)
}

const PORT = parseInt(process.env.NPC_PORT || '7221', 10)
const relayOnly = process.argv.includes('--relay-only')

const relay = await NPCRelay.create(PORT)

if (relay.isProxy) {
  process.stderr.write(`[npc] connected to existing relay on port ${PORT}\n`)
} else {
  process.stderr.write(`[npc] relay listening on ws://localhost:${PORT}\n`)
}

relay.on('extensionConnected', () => {
  process.stderr.write('[npc] browser extension connected\n')
})
relay.on('sessionReady', (sid: string) => {
  process.stderr.write(`[npc] tab session ready (${sid})\n`)
})
relay.on('extensionDisconnected', () => {
  process.stderr.write('[npc] browser extension disconnected\n')
})

function shutdown() {
  relay.close()
  // Force exit after 500ms if cleanup hangs - don't hold the port
  setTimeout(() => process.exit(0), 500).unref()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => relay.close())

if (relayOnly) {
  if (relay.isProxy) {
    process.stderr.write('[npc] relay already running on this port - nothing to do\n')
    process.exit(0)
  }
  process.stderr.write('[npc] relay-only mode - load NPC extension in Brave, click icon on a tab\n')
} else {
  const mcpServer = createMCPServer(relay)
  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
  process.stderr.write('[npc] MCP server ready - waiting for Brave extension\n')
}
