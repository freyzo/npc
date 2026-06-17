const RELAY_URL = 'ws://localhost:7221/extension';
let ws = null;
let connectedTabs = new Map();
let nextSessionId = 1;

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
    await new Promise(r => setTimeout(r, 500));
    await autoAttachActiveTab();
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    ws = null;
    connectedTabs.clear();
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
      ws.send(JSON.stringify({ id: msg.id, result: { attached: connectedTabs.size } }));
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
            ...(options.headers || { 'Accept': 'application/json' }),
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
  console.log('[npc] Attempting to attach tab:', tabId);
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    console.log('[npc] Debugger attached to tab:', tabId);
  } catch (e) {
    console.log('[npc] Attach failed:', e.message);
    throw new Error('Could not attach to tab: ' + e.message);
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

chrome.debugger.onDetach.addListener((src) => {
  if (connectedTabs.has(src.tabId)) {
    detachTab(src.tabId);
    ensureConnected();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (connectedTabs.has(tabId)) {
    detachTab(tabId);
    ensureConnected();
  }
});

async function ensureConnected() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (connectedTabs.size > 0) return;

  console.log('[npc] No tabs connected, auto-attaching...');
  await autoAttachActiveTab();
}

chrome.action.onClicked.addListener(async (tab) => {
  console.log('[npc] Extension icon clicked, tab:', tab?.id, tab?.url);
  if (!tab.id || !isAttachable(tab.url)) {
    console.log('[npc] Skipping non-attachable page');
    return;
  }

  if (connectedTabs.has(tab.id)) {
    console.log('[npc] Tab already connected, detaching');
    detachTab(tab.id);
  } else {
    console.log('[npc] Connecting to relay and attaching tab');
    connect();
    try {
      await attachTab(tab.id);
      console.log('[npc] Successfully attached tab');
    } catch (e) {
      console.log('[npc] Failed to attach:', e.message);
    }
  }
});

connect();

setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
  } else if (connectedTabs.size === 0) {
    autoAttachActiveTab();
  }
}, 3000);

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ method: 'ping' }));
    }
  }
});

let autoAttaching = false;
async function autoAttachActiveTab() {
  if (autoAttaching) return;
  autoAttaching = true;
  console.log('[npc] autoAttachActiveTab called');
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

    for (const tab of tabs) {
      if (tab && tab.id && isAttachable(tab.url)) {
        if (!connectedTabs.has(tab.id)) {
          try {
            await attachTab(tab.id);
            console.log('[npc] Auto-attached to tab:', tab.url);
            return;
          } catch (e) {
            console.log('[npc] Failed to attach tab:', tab.id, e.message);
          }
        }
      }
    }
    console.log('[npc] No valid tabs found to attach');
  } catch (e) {
    console.log('[npc] Auto-attach failed:', e.message);
  } finally {
    autoAttaching = false;
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && isAttachable(tab.url)) {
      if (!connectedTabs.has(tab.id)) {
        await attachTab(tab.id);
        console.log('[npc] Auto-attached on tab switch:', tab.url);
      }
    }
  } catch {}
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (connectedTabs.size > 0) return;

  await new Promise(r => setTimeout(r, 1000));

  try {
    const updatedTab = await chrome.tabs.get(tab.id);
    if (updatedTab && isAttachable(updatedTab.url)) {
      await attachTab(tab.id);
      console.log('[npc] Auto-attached to new tab:', updatedTab.url);
    }
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (connectedTabs.size > 0) return;

  if (tab && isAttachable(tab.url)) {
    try {
      await attachTab(tabId);
      console.log('[npc] Auto-attached on tab load:', tab.url);
    } catch {}
  }
});
