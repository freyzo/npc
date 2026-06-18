const RELAY_URL = 'ws://localhost:7221/extension';
let ws = null;
let connectedTabs = new Map();
let nextSessionId = 1;
let lastAttachedTabId = null;

let offscreenCreating = null;
async function setupOffscreen() {
  if (offscreenCreating) return offscreenCreating;

  offscreenCreating = (async () => {
    try {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (!hasDoc) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['BLOBS'],
          justification: 'Keep service worker alive for NPC browser automation'
        });
      }
    } catch (e) {
      console.log('[npc] Offscreen setup:', e.message);
    } finally {
      offscreenCreating = null;
    }
  })();

  return offscreenCreating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'keepalive') {
    sendResponse({ ok: true });
  }
  return true;
});

chrome.runtime.onInstalled.addListener(setupOffscreen);
chrome.runtime.onStartup.addListener(setupOffscreen);

function isAttachable(url) {
  return url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('brave://') && !url.startsWith('edge://') && !url.startsWith('about:');
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(RELAY_URL);
  } catch (e) {
    updateIcon();
    return;
  }

  ws.onopen = async () => {
    console.log('[npc] WebSocket connected to relay');
    updateIcon();

    // Re-announce any already-attached tabs to the relay
    for (const [tabId, info] of connectedTabs) {
      ws.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: { sessionId: info.sessionId, targetInfo: { targetId: info.targetId, attached: true, type: 'page' }, waitingForDebugger: false }
        }
      }));
    }

    // If no tabs attached, auto-attach the active tab
    if (connectedTabs.size === 0) {
      await new Promise(r => setTimeout(r, 300));
      await autoAttachActiveTab();
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    ws = null;
    updateIcon();
    setTimeout(connect, 3000);
  };

  ws.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.method === 'ping') {
      ws.send(JSON.stringify({ method: 'pong' }));
      return;
    }

    if (msg.method === 'attachActiveTab') {
      await autoAttachActiveTab();
      ws.send(JSON.stringify({ id: msg.id, result: { attached: connectedTabs.size, sessionId: connectedTabs.size > 0 ? [...connectedTabs.values()][0].sessionId : null } }));
      return;
    }

    if (msg.method === 'corsFetch') {
      const response = { id: msg.id };
      try {
        const { url, options = {} } = msg.params || {};

        const cookies = await chrome.cookies.getAll({ url: url });
        const cookieString = cookies
          .filter(c => !c.expirationDate || c.expirationDate > Date.now() / 1000)
          .map(c => `${c.name}=${c.value}`)
          .join('; ');

        const fetchOpts = {
          method: options.method || 'GET',
          headers: {
            'Accept': 'application/json',
            ...(options.headers || {}),
            'Cookie': cookieString
          }
        };
        if (options.body) fetchOpts.body = options.body;

        const resp = await fetch(url, fetchOpts);
        const text = await resp.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        response.result = { status: resp.status, ok: resp.ok, data };
      } catch (err) {
        response.error = err.message || 'Fetch failed';
      }
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
      }
      return;
    }

    if (msg.method === 'forwardCDPCommand') {
      const response = { id: msg.id };
      try {
        response.result = await handleCDP(msg.params);
      } catch (err) {
        response.error = err.message || 'Unknown error';
      }
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
      }
    }
  };
}

async function handleCDP({ method, params, sessionId }) {
  const browserLevelCommands = [
    'Target.createTarget',
    'Target.closeTarget',
    'Target.activateTarget',
    'Target.getTargets',
    'Target.attachToTarget'
  ];

  if (browserLevelCommands.includes(method)) {
    if (method === 'Target.attachToTarget') {
      const targetId = params?.targetId;
      for (const [tid, info] of connectedTabs) {
        if (info.targetId === targetId) {
          return { sessionId: info.sessionId };
        }
      }
      throw new Error('Target not found: ' + targetId);
    }

    if (method === 'Target.createTarget') {
      let tab;
      if (params?.newWindow) {
        const win = await chrome.windows.create({ url: params?.url || 'about:blank', focused: false });
        tab = win.tabs[0];
      } else {
        tab = await chrome.tabs.create({ url: params?.url || 'about:blank', active: false });
      }
      await new Promise(r => setTimeout(r, 500));

      try {
        await chrome.debugger.detach({ tabId: tab.id });
      } catch (e) {
      }

      const { targetInfo } = await attachTab(tab.id);
      return { targetId: targetInfo.targetId };
    }

    if (method === 'Target.closeTarget') {
      const targetId = params?.targetId;
      let foundTabId = null;
      let foundWindowId = null;
      for (const [tid, info] of connectedTabs) {
        if (info.targetId === targetId) { foundTabId = tid; break; }
      }
      if (foundTabId) {
        try {
          const tab = await chrome.tabs.get(foundTabId);
          foundWindowId = tab.windowId;

          const win = await chrome.windows.get(foundWindowId, { populate: true });
          const isLastTab = win.tabs.length <= 1;

          await chrome.debugger.detach({ tabId: foundTabId }).catch(() => {});
          connectedTabs.delete(foundTabId);

          if (isLastTab) {
            await chrome.windows.remove(foundWindowId);
          } else {
            await chrome.tabs.remove(foundTabId);
          }

          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              method: 'forwardCDPEvent',
              params: {
                method: 'Target.targetDestroyed',
                params: { targetId }
              }
            }));
          }
          return { success: true };
        } catch (e) {
          throw new Error('Could not close tab: ' + e.message);
        }
      }
      throw new Error('Target not found: ' + targetId);
    }

    if (method === 'Target.activateTarget') {
      const targetId = params?.targetId;
      let foundTabId = null;
      for (const [tid, info] of connectedTabs) {
        if (info.targetId === targetId) { foundTabId = tid; break; }
      }
      if (foundTabId) {
        await chrome.tabs.update(foundTabId, { active: true });
        const tab = await chrome.tabs.get(foundTabId);
        if (tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return { success: true };
      }
      throw new Error('Target not found: ' + targetId);
    }

    if (method === 'Target.getTargets') {
      return {
        targetInfos: Array.from(connectedTabs.values()).map(info => ({
          targetId: info.targetId,
          type: 'page',
          attached: true
        }))
      };
    }
  }

  let tabId = null;
  for (const [tid, info] of connectedTabs) {
    if (info.sessionId === sessionId) { tabId = tid; break; }
  }

  if (!tabId) throw new Error('Session not found');
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

async function attachTab(tabId) {
  if (connectedTabs.has(tabId)) {
    return { targetInfo: { targetId: connectedTabs.get(tabId).targetId }, sessionId: connectedTabs.get(tabId).sessionId };
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!e.message.includes('Already attached')) {
      throw new Error('Could not attach to tab: ' + e.message);
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  } catch {}

  let targetInfo;
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
    targetInfo = result.targetInfo;
  } catch {
    targetInfo = { targetId: `tab-${tabId}`, url: '', type: 'page' };
  }

  const sessionId = `session-${nextSessionId++}`;
  connectedTabs.set(tabId, { sessionId, targetId: targetInfo.targetId });
  lastAttachedTabId = tabId;

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: { sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false }
      }
    }));
  }

  updateIcon();
  return { targetInfo, sessionId };
}

function detachTab(tabId) {
  const info = connectedTabs.get(tabId);
  if (!info) return;

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.detachedFromTarget',
        params: { sessionId: info.sessionId, targetId: info.targetId }
      }
    }));
  }

  connectedTabs.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
  updateIcon();
}

function detachAllTabs() {
  for (const tabId of [...connectedTabs.keys()]) {
    const info = connectedTabs.get(tabId);
    connectedTabs.delete(tabId);
    chrome.debugger.detach({ tabId }).catch(() => {});
    if (info && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: info.sessionId, targetId: info.targetId }
        }
      }));
    }
  }
  updateIcon();
}

function updateIcon() {
  const n = connectedTabs.size;
  const ok = ws?.readyState === WebSocket.OPEN;
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : (ok ? '' : '!') });
  chrome.action.setBadgeBackgroundColor({ color: n > 0 ? '#22c55e' : (ok ? '#64748b' : '#ef4444') });
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  const info = connectedTabs.get(src.tabId);
  if (info && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: 'forwardCDPEvent', params: { sessionId: info.sessionId, method, params } }));
  }
});

// When debugger detaches (user dismisses bar, tab navigates to chrome:// etc),
// try to reattach the active tab so the session isn't permanently lost
chrome.debugger.onDetach.addListener(async (src, reason) => {
  if (connectedTabs.has(src.tabId)) {
    detachTab(src.tabId);
  }

  // Auto-recover: if we lost our only session, try to reattach
  if (connectedTabs.size === 0 && ws?.readyState === WebSocket.OPEN) {
    await new Promise(r => setTimeout(r, 500));
    await autoAttachActiveTab();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (connectedTabs.has(tabId)) {
    detachTab(tabId);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !isAttachable(tab.url)) return;

  if (connectedTabs.has(tab.id)) {
    detachTab(tab.id);
  } else {
    detachAllTabs();
    connect();
    try {
      await attachTab(tab.id);
    } catch (e) {
      console.log('[npc] Failed to attach:', e.message);
    }
  }
});

connect();

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    } else {
      ws.send(JSON.stringify({ method: 'ping' }));

      // Verify connected tabs are still alive
      for (const tabId of [...connectedTabs.keys()]) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (!isAttachable(tab.url)) {
            detachTab(tabId);
          }
        } catch {
          // Tab no longer exists
          detachTab(tabId);
        }
      }

      // If we lost all sessions, try to reattach
      if (connectedTabs.size === 0) {
        await autoAttachActiveTab();
      }
    }
  }
});

let autoAttaching = false;
async function autoAttachActiveTab() {
  if (autoAttaching) return;
  autoAttaching = true;
  try {
    // First try the last tab we were attached to (if still alive)
    if (lastAttachedTabId && !connectedTabs.has(lastAttachedTabId)) {
      try {
        const tab = await chrome.tabs.get(lastAttachedTabId);
        if (tab && isAttachable(tab.url)) {
          await attachTab(tab.id);
          return;
        }
      } catch {}
    }

    // Fall back to the currently active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

    for (const tab of tabs) {
      if (tab && tab.id && isAttachable(tab.url)) {
        if (!connectedTabs.has(tab.id)) {
          try {
            await attachTab(tab.id);
            return;
          } catch (e) {
            console.log('[npc] Failed to attach tab:', tab.id, e.message);
          }
        }
      }
    }

    // Last resort: try any window's active tab
    const allTabs = await chrome.tabs.query({ active: true });
    for (const tab of allTabs) {
      if (tab && tab.id && isAttachable(tab.url) && !connectedTabs.has(tab.id)) {
        try {
          await attachTab(tab.id);
          return;
        } catch {}
      }
    }
  } catch (e) {
    console.log('[npc] Auto-attach failed:', e.message);
  } finally {
    autoAttaching = false;
  }
}

// When user switches tabs, attach the new active tab (swap, not accumulate)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (ws?.readyState !== WebSocket.OPEN) return;

  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab || !isAttachable(tab.url)) return;

    // If this tab is already connected, nothing to do
    if (connectedTabs.has(tab.id)) return;

    // Small delay to let in-flight CDP commands finish before switching
    await new Promise(r => setTimeout(r, 50));
    detachAllTabs();
    await attachTab(tab.id);
  } catch {}
});
