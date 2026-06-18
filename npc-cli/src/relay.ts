import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter } from 'events'
import { createServer, request as httpRequest } from 'http'

export class NPCRelay extends EventEmitter {
  private wss: WebSocketServer | null = null
  private httpServer: ReturnType<typeof createServer> | null = null
  private extensionWs: WebSocket | null = null
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private nextId = 1
  private sessionId: string | null = null
  private sessions = new Map<string, string>()
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private readyPromise: Promise<string> | null = null
  private proxyMode = false
  private proxyPollInterval: ReturnType<typeof setInterval> | null = null

  private constructor(private port = 7221) {
    super()
    this.setMaxListeners(50)
  }

  /** Create a relay - starts a server, or connects to an existing one if the port is taken. */
  static async create(port = 7221): Promise<NPCRelay> {
    const relay = new NPCRelay(port)
    const bound = await relay.tryBind()
    if (!bound) {
      // Port might be held by a dying process (Cursor restart race).
      // Wait and retry once before falling back to proxy mode.
      await new Promise(r => setTimeout(r, 1500))
      const retryBound = await relay.tryBind()
      if (!retryBound) {
        // Port is genuinely held by another relay - proxy to it
        const alive = await relay.probeRelay()
        if (alive) {
          relay.startProxyMode()
        } else {
          // Port held by something that isn't an NPC relay. Wait longer and try once more.
          await new Promise(r => setTimeout(r, 2000))
          const lastTry = await relay.tryBind()
          if (!lastTry) {
            throw new Error(`Port ${port} is in use by a non-NPC process. Kill it or set NPC_PORT.`)
          }
        }
      }
    }
    return relay
  }

  /** Check if an existing relay is alive on our port. */
  private async probeRelay(): Promise<boolean> {
    try {
      const status = await this.httpGet('/status')
      return status && typeof status.connected === 'boolean'
    } catch {
      return false
    }
  }

  /** Try to start the WebSocket server. Returns true if successful. */
  private tryBind(): Promise<boolean> {
    return new Promise((resolve) => {
      const MAX_BODY = 10 * 1024 * 1024 // 10MB
      const server = createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/cdp') {
          let body = ''
          let size = 0
          req.on('data', chunk => {
            size += chunk.length
            if (size > MAX_BODY) { res.writeHead(413); res.end('Body too large'); req.destroy(); return }
            body += chunk
          })
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
        if (req.method === 'POST' && req.url === '/fetch') {
          let body = ''
          req.on('data', chunk => { body += chunk })
          req.on('end', async () => {
            res.setHeader('Content-Type', 'application/json')
            try {
              const { url, options } = JSON.parse(body)
              if (!this.isConnected()) {
                res.writeHead(503)
                res.end(JSON.stringify({ error: 'Extension not connected' }))
                return
              }
              const id = this.nextId++
              const result = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Fetch timeout')) }, 30_000)
                this.pending.set(id, {
                  resolve: (v: any) => { clearTimeout(timer); resolve(v) },
                  reject: (e: Error) => { clearTimeout(timer); reject(e) }
                })
                this.extensionWs!.send(JSON.stringify({ id, method: 'corsFetch', params: { url, options } }))
              })
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

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false)
          return
        }
        throw err
      })

      server.once('listening', () => {
        this.httpServer = server
        this.wss = new WebSocketServer({ server })

        this.wss.on('connection', (ws, req) => {
          const url = req.url ?? ''
          if (url === '/extension' || url.startsWith('/extension')) {
            this.handleExtension(ws)
          }
        })

        resolve(true)
      })

      server.listen(this.port)
    })
  }

  /** Proxy mode: poll an existing relay via HTTP instead of running our own server. */
  private startProxyMode() {
    this.proxyMode = true
    process.stderr.write(`[npc] Port ${this.port} in use - connecting to existing relay\n`)

    // Poll /status every 2s to track session state
    const poll = async () => {
      try {
        const status = await this.httpGet('/status')
        const wasConnected = this.isConnected()
        const hadSession = this.sessionId

        if (status.connected && status.sessionId) {
          // Fake an extension connection for the relay interface
          this.extensionWs = { readyState: WebSocket.OPEN } as any
          this.sessionId = status.sessionId
          if (status.sessions) {
            this.sessions = new Map(Object.entries(status.sessions))
          }

          if (!hadSession && this.sessionId) {
            this.emit('sessionReady', this.sessionId)
          }
          if (!wasConnected) {
            this.emit('extensionConnected')
          }
        } else {
          if (wasConnected) {
            this.extensionWs = null
            this.sessionId = null
            this.sessions.clear()
            this.emit('extensionDisconnected')
          }
        }
      } catch {
        // Relay not reachable
        if (this.extensionWs) {
          this.extensionWs = null
          this.sessionId = null
          this.sessions.clear()
          this.emit('extensionDisconnected')
        }
      }
    }

    poll()
    const pollMs = parseInt(process.env.NPC_POLL_MS || '1000', 10)
    this.proxyPollInterval = setInterval(poll, pollMs)
  }

  private httpGet(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: 'localhost', port: this.port, path, method: 'GET' }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON')) }
        })
      })
      req.on('error', reject)
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')) })
      req.end()
    })
  }

  private httpPost(path: string, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body)
      const req = httpRequest({
        hostname: 'localhost', port: this.port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.error) reject(new Error(parsed.error))
            else resolve(parsed.result)
          } catch { reject(new Error('Invalid JSON')) }
        })
      })
      req.on('error', reject)
      req.setTimeout(35000, () => { req.destroy(); reject(new Error('Timeout')) })
      req.write(payload)
      req.end()
    })
  }

  // ─── Extension connection (server mode only) ──────────────────────────────

  private handleExtension(ws: WebSocket) {
    const prev = this.extensionWs
    if (prev && prev !== ws) {
      prev.close()
    }

    // Flush stale pending promises from previous connection
    for (const [id, p] of this.pending) {
      p.reject(new Error('Extension reconnected'))
    }
    this.pending.clear()

    this.extensionWs = ws
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    this.emit('extensionConnected')

    this.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }))
      }
    }, 20_000)

    ws.on('message', (raw) => {
      let msg: any
      try { msg = JSON.parse(raw.toString()) } catch { return }

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

      if (msg.method === 'forwardCDPEvent') {
        const { method, params } = msg.params ?? {}

        if (method === 'Target.attachedToTarget' && params?.sessionId) {
          this.sessions.set(params.sessionId, params.targetInfo?.targetId ?? '')
          this.sessionId = params.sessionId
          this.emit('sessionReady', params.sessionId)
        }
        if (method === 'Target.detachedFromTarget' && params?.sessionId) {
          this.sessions.delete(params.sessionId)
          if (this.sessionId === params.sessionId) {
            const remaining = [...this.sessions.keys()]
            this.sessionId = remaining.length > 0 ? remaining[remaining.length - 1] : null
          }
        }

        this.emit('cdpEvent', { method, params })
      }
    })

    ws.on('close', () => {
      if (this.extensionWs !== ws) return
      this.extensionWs = null
      this.sessionId = null
      this.sessions.clear()
      this.readyPromise = null
      if (this.pingInterval) clearInterval(this.pingInterval)
      this.pingInterval = null

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

  async waitForReady(timeoutMs = 30_000): Promise<string> {
    if (this.sessionId) return this.sessionId
    if (this.readyPromise) return this.readyPromise

    this.readyPromise = new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        if (retryInterval) clearInterval(retryInterval)
        this.removeListener('sessionReady', onSession)
        this.removeListener('extensionConnected', onExtension)
        this.readyPromise = null
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

      const requestAttach = () => {
        if (this.sessionId) {
          cleanup()
          resolve(this.sessionId)
          return
        }
        if (!this.proxyMode && this.extensionWs?.readyState === WebSocket.OPEN) {
          try {
            const id = this.nextId++
            this.extensionWs!.send(JSON.stringify({ id, method: 'attachActiveTab' }))
          } catch {}
        }
      }

      const onExtension = () => requestAttach()

      this.once('sessionReady', onSession)
      this.once('extensionConnected', onExtension)

      // If extension is already connected but no session, actively request attach
      // Retry every 2s in case the first attach fails (e.g. no active tab yet)
      if (this.isConnected() && !this.sessionId) {
        requestAttach()
      }
      const retryInterval = setInterval(() => {
        if (this.sessionId) {
          cleanup()
          resolve(this.sessionId)
          return
        }
        requestAttach()
      }, 2000)
    })

    return this.readyPromise
  }

  async cdp(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    if (this.proxyMode) {
      return this.httpPost('/cdp', { method, params, sessionId: sessionId ?? this.sessionId })
    }

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

  async fetch(url: string, options: Record<string, any> = {}): Promise<any> {
    if (this.proxyMode) {
      return this.httpPost('/fetch', { url, options })
    }

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

  get isProxy(): boolean { return this.proxyMode }

  isConnected(): boolean {
    if (this.proxyMode) {
      return this.extensionWs !== null
    }
    return this.extensionWs?.readyState === WebSocket.OPEN
  }

  close() {
    if (this.pingInterval) clearInterval(this.pingInterval)
    if (this.proxyPollInterval) clearInterval(this.proxyPollInterval)
    if (this.extensionWs) {
      try { this.extensionWs.close() } catch {}
      this.extensionWs = null
    }
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.httpServer) {
      this.httpServer.close()
      // Force-close all open sockets so the port is released immediately
      this.httpServer.closeAllConnections?.()
      this.httpServer = null
    }
  }
}
