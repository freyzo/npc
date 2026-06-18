

# NPC

*Your browser's NPC. Handles the side quests.*  
*Control your real browser from any IDE - no context switching.*

## Packages

| Package | What | Install |
| --- | --- | --- |
| [`npc-cli`](./npc-cli) | MCP server + WebSocket relay | `npm i -g npc-agent` |
| [Chrome extension](./npc-cli/extension) | Browser bridge via chrome.debugger | Load unpacked in Chrome/Brave |

## Quick start

```bash
npm i -g npc-agent
```

1. Load `npc-cli/extension/` in Chrome/Brave (Developer mode > Load unpacked)
2. Add NPC to your IDE's MCP config
3. Start automating

See [`npc-cli/README.md`](./npc-cli/README.md) for full setup and tool docs.

## Repo structure

```
npc/
  npc-cli/         npm package (MCP server + extension)
    src/            TypeScript source
    dist/           compiled JS
    extension/      Chrome extension (ships with npm)
  docs/             GitHub Pages site
  chrome-store/     CWS submission files
  plans/            internal workflows
```

## Contact

[X @freyazou](https://x.com/freyazou) - [GitHub](https://github.com/freyzo/npc) - [LinkedIn](https://www.linkedin.com/in/freya-zou-068615252/) - [freyazou.com](https://freyazou.com)
