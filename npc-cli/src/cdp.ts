import type { NPCRelay } from './relay.js'

export interface BatchAction {
  action: 'click' | 'type' | 'key' | 'scroll' | 'navigate' | 'screenshot' | 'wait' | 'evaluate' | 'find' | 'wait_for'
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
  private cachedDpr: number | null = null

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
    if (this.cachedDpr !== null) return this.cachedDpr
    try {
      const dpr = await this.evaluate<number>('window.devicePixelRatio') || 1
      this.cachedDpr = dpr
      return dpr
    } catch {
      return 1
    }
  }

  async navigate(url: string): Promise<void> {
    await this.relay.cdp('Page.navigate', { url }, this.sessionId)
    await this.waitForLoad()
  }

  async waitForLoad(timeoutMs = 5_000): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false
      const done = () => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        clearTimeout(readyCheckTimer)
        this.relay.removeListener('cdpEvent', onEvent)
        resolve()
      }

      const timer = setTimeout(done, timeoutMs)

      const onEvent = (evt: { method: string; params: any }) => {
        if (evt.method === 'Page.loadEventFired' || evt.method === 'Page.frameStoppedLoading') {
          done()
        }
      }

      this.relay.on('cdpEvent', onEvent)

      // Fast-path: check readyState after 500ms for SPAs that never fire load events
      const readyCheckTimer = setTimeout(async () => {
        try {
          const state = await this.evaluate<string>('document.readyState')
          if (state === 'complete') done()
        } catch {}
      }, 500)
    })
  }

  // ─── Input (no artificial sleeps) ──────────────────────────────────────────

  async click(x: number, y: number): Promise<void> {
    const base = { x, y, button: 'left' as const, clickCount: 1, modifiers: 0 }
    // Fire-and-forget first two - CDP guarantees in-order per session
    this.relay.cdp('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, this.sessionId)
    this.relay.cdp('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, this.sessionId)
    await this.relay.cdp('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, this.sessionId)
  }

  async type(text: string): Promise<void> {
    // insertText handles contenteditable natively
    await this.relay.cdp('Input.insertText', { text }, this.sessionId)
    // Skip React hack for contenteditable (Slack, Messenger) - insertText already worked
    const isContentEditable = await this.evaluate<boolean>('document.activeElement?.isContentEditable ?? false')
    if (isContentEditable) return
    // Force React/Vue controlled inputs to pick up the value via native setter
    const escaped = JSON.stringify(text)
    await this.evaluate(`
      (() => {
        const el = document.activeElement;
        if (!el) return;
        const newText = ${escaped};
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          if (!el.value.includes(newText)) {
            nativeSetter.call(el, el.value + newText);
          } else {
            nativeSetter.call(el, el.value);
          }
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `)
  }

  async pressKey(key: string): Promise<void> {
    const mapped = resolveKey(key)
    await this.relay.cdp('Input.dispatchKeyEvent', { ...mapped, type: 'keyDown' }, this.sessionId)
    await this.relay.cdp('Input.dispatchKeyEvent', { ...mapped, type: 'keyUp' }, this.sessionId)
  }

  async pressEnter(): Promise<void> {
    await this.pressKey('Enter')
  }

  async scroll(direction: 'up' | 'down', amount = 500, x?: number, y?: number): Promise<void> {
    if (x === undefined || y === undefined) {
      const vp = await this.viewportSize()
      x = x ?? Math.round(vp.width / 2)
      y = y ?? Math.round(vp.height / 2)
    }
    await this.relay.cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x, y,
      deltaX: 0,
      deltaY: direction === 'down' ? amount : -amount
    }, this.sessionId)
  }

  // ─── Semantic element finding ──────────────────────────────────────────────

  async findElement(selector: string): Promise<{ found: boolean; x: number; y: number; text: string }> {
    const result = await this.evaluate<{ found: boolean; x: number; y: number; text: string }>(`
      (() => {
        // Try CSS selector first (may throw on invalid CSS like plain text)
        let el = null;
        try { el = document.querySelector(${JSON.stringify(selector)}); } catch {}
        if (el) {
          const rect = el.getBoundingClientRect();
          return { found: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), text: (el.textContent || '').trim().slice(0, 200) };
        }

        // Text search: XPath first (fast), TreeWalker fallback for scoring
        const CLICKABLE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','DETAILS']);
        const CLICKABLE_ROLES = new Set(['button','link','menuitem','tab','option','checkbox','radio','switch','treeitem']);
        const target = ${JSON.stringify(selector.toLowerCase())};

        // Fast path: XPath text contains - avoids full TreeWalker for simple text matches
        try {
          const xpath = document.evaluate(
            '//*[contains(translate(text(),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),' + JSON.stringify(target) + ')]',
            document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
          );
          if (xpath.snapshotLength === 1) {
            const node = xpath.snapshotItem(0);
            const rect = node.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { found: true, x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2), text: (node.textContent||'').trim().slice(0,200) };
            }
          }
        } catch {}

        // Full TreeWalker with scoring for ambiguous matches
        const candidates = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);

        while (walk.nextNode()) {
          const node = walk.currentNode;
          const txt = (node.textContent || '').trim().toLowerCase();
          const aria = (node.getAttribute('aria-label') || '').toLowerCase();
          const placeholder = (node.getAttribute('placeholder') || '').toLowerCase();
          const title = (node.getAttribute('title') || '').toLowerCase();
          if (!(txt === target || txt.includes(target) || aria.includes(target) || placeholder.includes(target) || title.includes(target))) continue;

          const rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          let score = 0;
          if (txt === target || aria === target) score += 100;
          if (CLICKABLE.has(node.tagName)) score += 50;
          if (CLICKABLE_ROLES.has((node.getAttribute('role') || '').toLowerCase())) score += 50;
          if (node.getAttribute('onclick') || node.getAttribute('tabindex')) score += 20;
          if (node.closest('a,button,[role="button"],[role="link"]')) score += 30;
          score += Math.max(0, 50 - Math.floor((rect.width * rect.height) / 1000));
          if (rect.width > 500 && rect.height > 300) score -= 40;

          candidates.push({ node, score, rect, txt: (node.textContent || '').trim().slice(0, 200) });
        }

        if (candidates.length === 0) return { found: false, x: 0, y: 0, text: '' };
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        return {
          found: true,
          x: Math.round(best.rect.x + best.rect.width / 2),
          y: Math.round(best.rect.y + best.rect.height / 2),
          text: best.txt
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

          case 'wait_for': {
            const found = await this.waitForElement(act.selector ?? act.text ?? '', act.ms ?? 10000)
            result = found
            if (!found.found) throw new Error(`Timed out waiting for "${act.selector ?? act.text}"`)
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

  async waitForElement(selector: string, timeoutMs = 10_000): Promise<{ found: boolean; x: number; y: number; text: string }> {
    // Single CDP call with MutationObserver instead of polling loop
    const escapedSelector = JSON.stringify(selector)
    const escapedLower = JSON.stringify(selector.toLowerCase())
    const result = await this.evaluate<{ found: boolean; x: number; y: number; text: string }>(`
      new Promise((resolve) => {
        const timeout = ${timeoutMs};
        const tryFind = () => {
          let el = null;
          try { el = document.querySelector(${escapedSelector}); } catch {}
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { found: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: (el.textContent||'').trim().slice(0,200) };
          }
          // Text fallback
          const target = ${escapedLower};
          const els = document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"]');
          for (const node of els) {
            const txt = (node.textContent||'').trim().toLowerCase();
            const aria = (node.getAttribute('aria-label')||'').toLowerCase();
            if (txt.includes(target) || aria.includes(target)) {
              const r = node.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return { found: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: (node.textContent||'').trim().slice(0,200) };
            }
          }
          return null;
        };
        const existing = tryFind();
        if (existing) { resolve(existing); return; }
        const obs = new MutationObserver(() => {
          const found = tryFind();
          if (found) { obs.disconnect(); resolve(found); }
        });
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        setTimeout(() => { obs.disconnect(); resolve({ found: false, x: 0, y: 0, text: '' }); }, timeout);
      })
    `)
    return result
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
