<p align="center">
  <img src="extension/icons/icon128.png" alt="NPC logo" width="100" />
</p>

<h1 align="center">NPC</h1>

<p align="center">
  <em>Your browser's NPC. Handles the side quests.</em><br />
  <em>Control your real browser from any IDE - no context switching</em>
</p>

<p align="center">
  <a href="https://github.com/freyzo/npc"><img src="https://img.shields.io/badge/npc-000000?style=for-the-badge&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="https://www.npmjs.com/package/npc-agent"><img src="https://img.shields.io/badge/npm-npc--agent-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npm" /></a>
</p>

**Install the CLI globally** so NPC is available as an MCP server:

`npm i -g npc-agent`

---

## About

**Problem**

- You're deep in code and need to message someone on Slack, check Discord, or reply to an email. Every time, you context-switch out of your editor.
- Browser automation tools require API keys, OAuth tokens, or separate bot accounts per service.
- Existing solutions are slow, non-deterministic, or locked to one IDE.

**Solution**

- **NPC** is one CLI + one Chrome extension:
  - Your IDE agent says what to do ("message Tim on Slack") - NPC does it in your real, logged-in browser.
  - Works with **any MCP-compatible IDE**: VSCode, Cursor, Windsurf, or anything that speaks MCP.
  - No API keys per service. No OAuth. Uses the browser sessions you already have.

**Summary**

| You want to | Your IDE says |
| --- | --- |
| Message someone on Slack | "go to slack and message #general: deploy is done" |
| Reply on Messenger | "open messenger and reply to Tim: sounds good" |
| Check Gmail | "take a screenshot of my gmail inbox" |
| Fill out a form | "find the email field, click it, type my address, press Tab" |
| Do it all in one shot | use `npc_batch` with an array of actions |

> Requires **Node.js >= 18** and **Chrome** or **Brave** browser.

---

## Install

```bash
npm i -g npc-agent
```

---

## Setup

### 1. Load the Chrome extension

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** -> select the `extension/` folder
4. Click the NPC icon on any tab (green badge = connected)

### 2. Configure your IDE

Add to `.cursor/mcp.json` or `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "npc": {
      "command": "node",
      "args": ["/path/to/npc/dist/index.js"]
    }
  }
}
```

### 3. Use it

In your IDE chat, just ask. The agent calls NPC tools automatically.

```
"take a screenshot of the current tab"
"navigate to https://slack.com and find the message input"
"click at (450, 320) and type hello"
```

---

## How it works

<p align="center">
  <img src="docs/npc.svg" alt="NPC system design - IDE to browser pipeline" />
</p>

```
IDE (VSCode / Cursor)        NPC Server              Browser
 |                            |                       |
 |--- MCP stdio ------------->|                       |
 |    "click Send button"     |--- WebSocket :7221 -->|
 |                            |                       |--- CDP (chrome.debugger)
 |                            |                       |--- clicks in real tab
 |                            |<-- result ------------|
 |<-- tool response ----------|                       |
```

The IDE agent handles reasoning. NPC is the hands - it just executes browser actions via Chrome DevTools Protocol. No LLM inside NPC.

---

## MCP Tools

| Tool | Description |
| --- | --- |
| `npc_screenshot` | Capture browser tab as PNG (optional `savePath` to save to disk) |
| `npc_navigate` | Go to a URL |
| `npc_click` | Click at (x, y) pixel coordinates |
| `npc_type` | Type text into focused element |
| `npc_press_key` | Press Enter, Tab, Escape, arrows, etc. |
| `npc_scroll` | Scroll up or down |
| `npc_find` | Find element by CSS selector or text content, returns (x, y) center |
| `npc_batch` | Execute multiple actions in one call (cuts round-trip latency) |
| `npc_evaluate` | Run JavaScript in page context |
| `npc_extract_text` | Get all text content from the page |
| `npc_extract_html` | Get full page HTML |
| `npc_current_url` | Get current tab URL |
| `npc_page_title` | Get current tab title |

### Batch example

One MCP call instead of four:

```json
[
  {"action": "find", "selector": "Message Tim"},
  {"action": "click", "x": 450, "y": 320},
  {"action": "type", "text": "hey, deploy is done"},
  {"action": "key", "key": "Enter"}
]
```

---

## Stack

| Layer | Tech |
| --- | --- |
| IDE | Any MCP client (VSCode, Cursor, Windsurf) |
| Server | Node.js + TypeScript, MCP stdio transport |
| Transport | WebSocket relay (localhost:7221) |
| Browser | Chrome Extension (Manifest V3) + CDP via `chrome.debugger` |
| AI | None - your IDE's agent is the brain |

---

## Limitations

- **Chrome / Brave only** - uses `chrome.debugger` API (Manifest V3).
- **One active tab** at a time per extension instance.
- **Cannot attach** to `chrome://`, `brave://`, or extension pages.
- **Coordinates** from screenshots are at device pixel ratio - divide by DPR before clicking on HiDPI displays.

---

## Contact

<p align="center">
  <a href="https://x.com/freyazou"><img src="https://img.shields.io/badge/X-%40freyazou-1a1a1a?style=plastic&logo=x&logoColor=white" alt="X @freyazou" /></a>
  &nbsp;
  <a href="https://github.com/freyzo/npc"><img src="https://img.shields.io/badge/GitHub-npc-24292f?style=plastic&logo=github&logoColor=white" alt="GitHub" /></a>
  &nbsp;
  <a href="https://www.linkedin.com/in/freya-zou-068615252/"><img src="https://img.shields.io/badge/LinkedIn-Freya_Zou-0A66C2?style=plastic&logo=linkedin&logoColor=white" alt="LinkedIn" /></a>
  <br /><br />
  <a href="https://www.youtube.com/channel/UC9pdMpmZ6ZNAakfcZSxaJXQ"><img src="https://img.shields.io/badge/YouTube-channel-FF0000?style=plastic&logo=youtube&logoColor=white" alt="YouTube" /></a>
  &nbsp;
  <a href="https://freyazou.com"><img src="https://img.shields.io/badge/Site-freyazou.com-0891b2?style=plastic&logo=googlechrome&logoColor=white" alt="Website" /></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/npc-agent"><img src="https://img.shields.io/badge/npm-npc--agent-CB3837?style=plastic&logo=npm&logoColor=white" alt="npm" /></a>
</p>
