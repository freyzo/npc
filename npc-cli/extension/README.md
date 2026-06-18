# NPC Chrome Extension

## Install

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable Developer mode (top right toggle)
3. Click Load unpacked
4. Select this folder (`extension/`)
5. Click the NPC icon on any tab - green badge = connected

## How it works

The extension connects to the NPC relay server via WebSocket (localhost:7221).
It uses chrome.debugger (CDP) to control browser tabs on behalf of your IDE.

## Troubleshooting

- Red `!` badge: relay server not running. Start NPC from your IDE or run `npc`
- Gray icon: click the NPC icon on the tab you want to control
- Green `1` badge: connected and ready
