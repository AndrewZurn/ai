// OpenAI Codex usage plugin — server-side entry.
//
// No server hooks are needed: rate limits are read from the local `codex`
// CLI and rendered by the CLI plugin in ./tui.tsx. This entry exists so the
// package resolves its "." export when OpenCode auto-loads it from
// ~/.config/opencode/plugins/.

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "openai-usage",
  setup() {
    // Intentionally empty; see tui.tsx.
  },
})
