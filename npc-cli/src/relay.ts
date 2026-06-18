import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter } from 'events'
import { createServer } from 'http'

export class NPCRelay extends EventEmitter {
  private wss: WebSocketServer
  private extensionWs: WebSocket | null = null
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private nextId = 1
  private sessionId: string | null = null
  private sessions = new Map<string, string>() // sessionId -> targetId
  private pingInterval: ReturnType<typeof setInterval> | null = null

  constructor(private port = 7221) {
    super()

    // Use an HTTP server so we can inspect req.url per connection
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/cdp') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json')
          try {
            const { method, params, sessionId } = JSON.parse(body)
            if (!this.isConnected()) {
              res.writeHead(503)
              res.end(JSON.stringify({ error: 'Extension not connected' }))
              return
            }
            if (!this.sessionId && !sessionId) {
              await this.waitForReady(10000)
            }
            const result = await this.cdp(method, params ?? {}, sessionId)
            res.end(JSON.stringify({ result }))
          } catch (e: any) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: e.message }))
          }
        })
        return
      }
      if (req.method === 'POST' && req.url === '/attach') {
        res.setHeader('Content-Type', 'application/json')
        try {
          if (!this.isConnected()) {
            res.writeHead(503)
            res.end(JSON.stringify({ error: 'Extension not connected' }))
            return
          }
          const id = this.nextId++
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('attach timeout')), 10000)
            const onSession = () => { clearTimeout(timer); this.removeListener('sessionReady', onSession); resolve() }
            this.once('sessionReady', onSession)
            this.extensionWs!.send(JSON.stringify({ id, method: 'attachActiveTab' }))
          })
          res.end(JSON.stringify({ sessionId: this.sessionId }))
        } catch (e: any) {
          res.writeHead(500)
          res.end(JSON.stringify({ error: e.message }))
        }
        return
      }
      if (req.method === 'GET' && req.url === '/status') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          connected: this.isConnected(),
          sessionId: this.sessionId,
          sessions: Object.fromEntries(this.sessions)
        }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    this.wss = new WebSocketServer({ server })

    this.wss.on('connection', (ws, req) => {
      const url = req.url ?? ''
      if (url === '/extension' || url.startsWith('/extension')) {
        this.handleExtension(ws)
      }
      // Unknown paths — ignore (future: /cli for remote control)
    })

    server.listen(port)
  }

  // ─── Extension connection ───────────────────────────────────────────────────

  private handleExtension(ws: WebSocket) {
    const prev = this.extensionWs
    if (prev && prev !== ws) {
      prev.close()
    }

    this.extensionWs = ws
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    this.emit('extensionConnected')

    // Send keepalive pings every 20s (extension expects them)
    this.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }))
      }
    }, 20_000)

    ws.on('message', (raw) => {
      let msg: any
      try { msg = JSON.parse(raw.toString()) } catch { return }

      // Responses to our commands (have an id)
      if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id)
        if (pending) {
          this.pending.delete(msg.id)
          if (msg.error) {
            pending.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)))
          } else {
            pending.resolve(msg.result)
          }
        }
        return
      }

      // CDP events forwarded from the extension
      if (msg.method === 'forwardCDPEvent') {
        const { method, params } = msg.params ?? {}

        // Track sessions - store all, set most recent as active
        if (method === 'Target.attachedToTarget' && params?.sessionId) {
          this.sessions.set(params.sessionId, params.targetInfo?.targetId ?? '')
          this.sessionId = params.sessionId
          this.emit('sessionReady', params.sessionId)
        }
        if (method === 'Target.detachedFromTarget' && params?.sessionId) {
          this.sessions.delete(params.sessionId)
          if (this.sessionId === params.sessionId) {
            // Fall back to another session if available
            const remaining = [...this.sessions.keys()]
            this.sessionId = remaining.length > 0 ? remaining[remaining.length - 1] : null
          }
        }

        this.emit('cdpEvent', { method, params })
      }

      // Pong — nothing to do
    })

    ws.on('close', () => {
      if (this.extensionWs !== ws) return
      this.extensionWs = null
      this.sessionId = null
      this.sessions.clear()
      if (this.pingInterval) clearInterval(this.pingInterval)
      this.pingInterval = null

      // Reject all in-flight CDP commands immediately
      for (const [id, pending] of this.pending) {
        pending.reject(new Error('Extension disconnected'))
      }
      this.pending.clear()

      this.emit('extensionDisconnected')
    })

    ws.on('error', (err) => {
      process.stderr.write(`[npc] WebSocket error: ${err.message}\n`)
    })
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Wait until the Chrome extension connects and a tab session is ready */
  async waitForReady(timeoutMs = 30_000): Promise<string> {
    if (this.sessionId) return this.sessionId

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        this.removeListener('sessionReady', onSession)
        this.removeListener('extensionConnected', onExtension)
      }

      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(
          'Timed out waiting for browser extension.\n' +
          '1. Start relay: npm run relay\n' +
          '2. Load extension in Brave: brave://extensions -> Load unpacked -> ./extension/\n' +
          '3. Click the NPC icon on any tab (badge turns green)'
        ))
      }, timeoutMs)

      const onSession = (sid: string) => {
        cleanup()
        resolve(sid)
      }

      const onExtension = async () => {
        if (this.sessionId) {
          cleanup()
          resolve(this.sessionId)
          return
        }
        // Ask extension to attach active tab (triggers Target.attachedToTarget event)
        try {
          const id = this.nextId++
          this.extensionWs!.send(JSON.stringify({ id, method: 'attachActiveTab' }))
        } catch {}
      }

      this.once('sessionReady', onSession)
      this.once('extensionConnected', onExtension)
    })
  }

  /** Send a CDP command and await the response */
  async cdp(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    const sid = sessionId ?? this.sessionId
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      throw new Error('Chrome extension not connected')
    }

    const id = this.nextId++

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command "${method}" timed out after 30s`))
      }, 30_000)

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject:  (e) => { clearTimeout(timer); reject(e) }
      })

      this.extensionWs!.send(JSON.stringify({
        id,
        method: 'forwardCDPCommand',
        params: { method, params, sessionId: sid }
      }))
    })
  }

  /** CORS-bypassing authenticated fetch via the extension */
  async fetch(url: string, options: Record<string, any> = {}): Promise<any> {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      throw new Error('Chrome extension not connected')
    }

    const id = this.nextId++

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`corsFetch timed out for ${url}`))
      }, 30_000)

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject:  (e) => { clearTimeout(timer); reject(e) }
      })

      this.extensionWs!.send(JSON.stringify({ id, method: 'corsFetch', params: { url, options } }))
    })
  }

  get activeSession(): string | null { return this.sessionId }

  get allSessions(): Map<string, string> { return new Map(this.sessions) }

  isConnected(): boolean {
    return this.extensionWs?.readyState === WebSocket.OPEN
  }

  close() {
    if (this.pingInterval) clearInterval(this.pingInterval)
    this.wss.close()
  }
}
