# Installation

## Via agentplugins CLI

```bash
pnpm dlx agentplugins install agentplugins-autoresearch
```

Then reload agentplugins.

## Manual install

```bash
cp -r extensions/agentplugins-autoresearch ~/.agentplugins/extensions/
cp -r skills/autoresearch-create ~/.agentplugins/skills/
cp -r skills/autoresearch-finalize ~/.agentplugins/skills/
cp -r skills/autoresearch-hooks ~/.agentplugins/skills/   # optional
```

Then reload agentplugins.

## Prerequisites

1. **Install agentplugins** — build from source or use `pnpm dlx agentplugins`
2. **An API key** for your preferred LLM provider (configured in agentplugins)

## Keyboard shortcuts

| Shortcut | Description |
|----------|-------------|
| `Ctrl+Shift+F` | Open fullscreen scrollable dashboard overlay. Navigate with `↑`/`↓`/`j`/`k`, `PageUp`/`PageDown`/`u`/`d`, `g`/`G` for top/bottom, `Escape` or `q` to close. |

To avoid conflicts with other agentplugins extensions, override or disable shortcuts in `<agent-dir>/extensions/agentplugins-autoresearch.json`. `<agent-dir>` is the active agentplugins profile config directory (usually `~/.agentplugins`, or `AGENTPLUGINS_AGENT_DIR` when set):

```json
{
  "shortcuts": {
    "fullscreenDashboard": "ctrl+shift+y"
  }
}
```

Use `null` to skip registering a shortcut. Omitted shortcuts keep their defaults.
