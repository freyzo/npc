import type { NPCRelay } from './relay.js'

export interface BatchAction {
  action: 'click' | 'type' | 'key' | 'scroll' | 'navigate' | 'screenshot' | 'wait' | 'evaluate' | 'find'
  x?: number
  y?: number
  text?: string
  key?: string
  direction?: 'up' | 'down'
  amount?: number
  url?: string
  expression?: string
  selector?: string
  ms?: number
}

export interface BatchResult {
  action: string
  ok: boolean
  result?: any
  error?: string
}

export class CDP {
  constructor(private relay: NPCRelay, private sessionId: string) {}

  // ─── Page ───────────────────────────────────────────────────────────────────

  async screenshot(): Promise<{ data: string; dpr: number }> {
    const [{ data }, dpr] = await Promise.all([
      this.relay.cdp(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false },
        this.sessionId
      ),
      this.getDevicePixelRatio()
    ])
    return { data: data as string, dpr }
  }

  async getDevicePixelRatio(): Promise<number> {
    try {
      return await this.evaluate<number>('window.devicePixelRatio') || 1
    } catch {
      return 1
    }
  }

  async navigate(url: string): Promise<void> {
    await this.relay.cdp('Page.navigate', { url }, this.sessionId)
    await this.waitForLoad()
  }

  async waitForLoad(timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.relay.removeListener('cdpEvent', onEvent)
        resolve()
      }, timeoutMs)

      const onEvent = (evt: { method: string; params: any }) => {
        if (evt.method === 'Page.loadEventFired') {
          clearTimeout(timer)
          this.relay.removeListener('cdpEvent', onEvent)
          resolve()
        }
      }

      this.relay.on('cdpEvent', onEvent)
    })
  }

  // ─── Input (no artificial sleeps) ──────────────────────────────────────────

  async click(x: number, y: number): Promise<void> {
    const base = { x, y, button: 'left' as const, clickCount: 1, modifiers: 0 }
    await this.relay.cdp('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, this.sessionId)
    await this.relay.cdp('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, this.sessionId)
  }

  async type(text: string): Promise<void> {
    await this.relay.cdp('Input.insertText', { text }, this.sessionId)
  }

  async pressKey(key: string): Promise<void> {
    const mapped = resolveKey(key)
    await this.relay.cdp('Input.dispatchKeyEvent', { ...mapped, type: 'keyDown' }, this.sessionId)
    await this.relay.cdp('Input.dispatchKeyEvent', { ...mapped, type: 'keyUp' }, this.sessionId)
  }

  async pressEnter(): Promise<void> {
    await this.pressKey('Enter')
  }

  async scroll(direction: 'up' | 'down', amount = 500): Promise<void> {
    await this.relay.cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 640,
      y: 400,
      deltaX: 0,
      deltaY: direction === 'down' ? amount : -amount
    }, this.sessionId)
  }

  // ─── Semantic element finding ──────────────────────────────────────────────

  async findElement(selector: string): Promise<{ found: boolean; x: number; y: number; text: string }> {
    const result = await this.evaluate<{ found: boolean; x: number; y: number; text: string }>(`
      (() => {
        // Try CSS selector first
        let el = document.querySelector(${JSON.stringify(selector)});

        // If no CSS match, search by text content
        if (!el) {
          const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          const target = ${JSON.stringify(selector.toLowerCase())};
          while (walk.nextNode()) {
            const node = walk.currentNode;
            const txt = (node.textContent || '').trim().toLowerCase();
            const aria = (node.getAttribute('aria-label') || '').toLowerCase();
            const placeholder = (node.getAttribute('placeholder') || '').toLowerCase();
            if (txt === target || txt.includes(target) || aria.includes(target) || placeholder.includes(target)) {
              el = node;
              break;
            }
          }
        }

        if (!el) return { found: false, x: 0, y: 0, text: '' };
        const rect = el.getBoundingClientRect();
        return {
          found: true,
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
          text: (el.textContent || '').trim().slice(0, 200)
        };
      })()
    `)
    return result
  }

  // ─── Batch execution ───────────────────────────────────────────────────────

  async executeBatch(actions: BatchAction[]): Promise<BatchResult[]> {
    const results: BatchResult[] = []

    for (const act of actions) {
      try {
        let result: any = null

        switch (act.action) {
          case 'click':
            await this.click(act.x ?? 0, act.y ?? 0)
            result = `Clicked (${act.x}, ${act.y})`
            break

          case 'type':
            await this.type(act.text ?? '')
            result = `Typed "${act.text}"`
            break

          case 'key':
            if ((act.key ?? '').toLowerCase() === 'enter' || (act.key ?? '').toLowerCase() === 'return') {
              await this.pressEnter()
            } else {
              await this.pressKey(act.key ?? '')
            }
            result = `Pressed ${act.key}`
            break

          case 'scroll':
            await this.scroll(act.direction ?? 'down', act.amount ?? 500)
            result = `Scrolled ${act.direction} ${act.amount ?? 500}px`
            break

          case 'navigate':
            await this.navigate(act.url ?? '')
            result = `Navigated to ${act.url}`
            break

          case 'screenshot': {
            const shot = await this.screenshot()
            result = { data: shot.data, dpr: shot.dpr }
            break
          }

          case 'wait':
            await new Promise(r => setTimeout(r, act.ms ?? 100))
            result = `Waited ${act.ms ?? 100}ms`
            break

          case 'evaluate':
            result = await this.evaluate(act.expression ?? '')
            break

          case 'find': {
            const found = await this.findElement(act.selector ?? act.text ?? '')
            result = found
            break
          }

          default:
            throw new Error(`Unknown action: ${act.action}`)
        }

        results.push({ action: act.action, ok: true, result })
      } catch (e: any) {
        results.push({ action: act.action, ok: false, error: e.message })
        break // stop batch on first error
      }
    }

    return results
  }

  // ─── Runtime ────────────────────────────────────────────────────────────────

  async evaluate<T = any>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.relay.cdp(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId
    )

    if (exceptionDetails) {
      throw new Error(`JS eval error: ${exceptionDetails.text}`)
    }

    return result?.value as T
  }

  async extractText(): Promise<string> {
    return this.evaluate<string>('document.body.innerText')
  }

  async extractHTML(): Promise<string> {
    return this.evaluate<string>('document.documentElement.outerHTML')
  }

  async currentUrl(): Promise<string> {
    return this.evaluate<string>('window.location.href')
  }

  async pageTitle(): Promise<string> {
    return this.evaluate<string>('document.title')
  }

  async viewportSize(): Promise<{ width: number; height: number }> {
    return this.evaluate<{ width: number; height: number }>(
      '({ width: window.innerWidth, height: window.innerHeight })'
    )
  }
}

const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  enter:      { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13 },
  return:     { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13 },
  tab:        { key: 'Tab',        code: 'Tab',         windowsVirtualKeyCode: 9 },
  escape:     { key: 'Escape',     code: 'Escape',      windowsVirtualKeyCode: 27 },
  backspace:  { key: 'Backspace',  code: 'Backspace',   windowsVirtualKeyCode: 8 },
  delete:     { key: 'Delete',     code: 'Delete',      windowsVirtualKeyCode: 46 },
  space:      { key: ' ',          code: 'Space',       windowsVirtualKeyCode: 32 },
  arrowup:    { key: 'ArrowUp',    code: 'ArrowUp',     windowsVirtualKeyCode: 38 },
  arrowdown:  { key: 'ArrowDown',  code: 'ArrowDown',   windowsVirtualKeyCode: 40 },
  arrowleft:  { key: 'ArrowLeft',  code: 'ArrowLeft',   windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight',  windowsVirtualKeyCode: 39 },
  home:       { key: 'Home',       code: 'Home',        windowsVirtualKeyCode: 36 },
  end:        { key: 'End',        code: 'End',         windowsVirtualKeyCode: 35 },
  pageup:     { key: 'PageUp',     code: 'PageUp',      windowsVirtualKeyCode: 33 },
  pagedown:   { key: 'PageDown',   code: 'PageDown',    windowsVirtualKeyCode: 34 },
}

function resolveKey(key: string): { key: string; code: string; windowsVirtualKeyCode: number } {
  const lower = key.toLowerCase()

  // Check named keys
  const mapped = KEY_MAP[lower]
  if (mapped) return mapped

  // Single letter a-z
  if (lower.length === 1 && lower >= 'a' && lower <= 'z') {
    return { key: lower, code: `Key${lower.toUpperCase()}`, windowsVirtualKeyCode: lower.toUpperCase().charCodeAt(0) }
  }

  // Single digit 0-9
  if (lower.length === 1 && lower >= '0' && lower <= '9') {
    return { key: lower, code: `Digit${lower}`, windowsVirtualKeyCode: lower.charCodeAt(0) }
  }

  // F1-F12
  const fMatch = lower.match(/^f(\d{1,2})$/)
  if (fMatch) {
    const n = parseInt(fMatch[1])
    if (n >= 1 && n <= 12) {
      return { key: `F${n}`, code: `F${n}`, windowsVirtualKeyCode: 111 + n }
    }
  }

  // Fallback - pass through, let Chrome infer
  return { key, code: key, windowsVirtualKeyCode: 0 }
}
