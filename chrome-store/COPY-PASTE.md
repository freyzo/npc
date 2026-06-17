# Chrome Web Store - copy paste fields

Upload zip: `npc-extension-v0.1.0.zip`
Store icon: `extension/icons/icon128.png` (128x128)
Screenshots: `cws-assets/screenshot-1-architecture.png` and `cws-assets/screenshot-2-tools.png`

---

## Store listing

### Title
```
NPC
```

### Summary (132 char max - currently 109)
```
Control your browser from Cursor, VS Code, or any MCP IDE. Click, type, scroll, screenshot - without switching tabs.
```

### Description (200+ char min)
```
NPC connects your browser to any MCP-compatible IDE so you can control web pages without leaving your editor. Your IDE agent says what to do, NPC does it in your real, logged-in browser.

How it works: a local CLI server (npm i -g npc-agent) runs a WebSocket relay. This extension connects to that relay and uses the Chrome DevTools Protocol to execute commands on your active tab.

What you can do:
- Screenshot any tab and get the image back in your IDE
- Click, type, scroll, and press keys on any page
- Find elements by CSS selector or text content
- Extract text and HTML from pages
- Navigate to URLs, go back and forward
- Run JavaScript in the page context
- Batch multiple actions into a single command
- Auto-attaches to your active tab

Works with Cursor, VS Code, Windsurf, or anything that speaks MCP. No API keys per service. No OAuth. Uses the browser sessions you already have.

Requires the NPC CLI server running locally. Install with: npm i -g npc-agent
The extension connects to the CLI via WebSocket on localhost:7221.
```

### Category
```
Developer Tools
```

### Language
```
English (United States)
```

---

## Additional fields

### Homepage URL
```
https://github.com/freyzo/npc
```

### Support URL
```
https://github.com/freyzo/npc/issues
```

### Mature content
```
No
```

---

## Privacy

### Single purpose
```
Connect your browser to an MCP-compatible IDE for browser automation via the Chrome DevTools Protocol.
```

### Permission justifications

#### debugger
```
Sends Chrome DevTools Protocol commands (click, type, screenshot, navigate, run JavaScript) to browser tabs on behalf of the user's IDE.
```

#### tabs
```
Queries which tabs are open, detects tab switches, and auto-attaches the debugger to the active tab when the relay connects.
```

#### activeTab
```
Identifies and interacts with the currently focused tab when the user clicks the extension icon.
```

#### offscreen
```
Maintains an offscreen document that sends periodic keepalive messages, preventing Chrome from suspending the service worker during active automation sessions.
```

#### alarms
```
Schedules periodic keepalive pings to the WebSocket relay so the connection stays alive while the service worker is active.
```

#### cookies
```
Reads cookies for the target URL when performing fetch requests through the extension context, allowing authenticated API calls on behalf of the user's IDE.
```

#### host_permissions (<all_urls>)
```
Attaches the Chrome DevTools Protocol debugger to any tab the user wants to automate. Without broad host access, the extension cannot control pages on arbitrary domains.
```

### Remote code
```
No
```

### Data collection
```
All boxes: No (unchecked)
```

### Privacy certifications
```
[x] I do not sell or transfer user data to third parties
[x] I do not use or transfer user data for purposes unrelated to the item's single purpose
[x] I do not use or transfer user data to determine creditworthiness or for lending purposes
```

### Privacy policy URL
```
https://github.com/freyzo/npc#privacy
```

---

## Distribution

### Payment model
```
Free of charge
```

### Visibility
```
Public
```

### Regions
```
All regions
```

---

## Test instructions for reviewer

```
1. Install the NPC CLI: npm i -g npc-agent
2. Start the server: run "npc" in a terminal (or "node dist/index.js")
3. Load the extension in chrome://extensions (Developer mode > Load unpacked)
4. Open any web page (e.g. https://example.com)
5. The extension auto-attaches to the active tab (green badge with "1")
6. From an MCP-compatible IDE (Cursor, VS Code), configure npc as an MCP server
7. Use npc_screenshot, npc_click, npc_type tools from the IDE
8. The extension badge stays green and commands execute on the page
```
