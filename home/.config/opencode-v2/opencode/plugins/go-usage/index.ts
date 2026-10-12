// OpenCode Go usage plugin — server-side entry.
//
// No server hooks are needed: usage is fetched and rendered by the CLI
// plugin in ./tui.tsx. This entry exists so the package resolves its "."
// export when OpenCode auto-loads it from ~/.config/opencode/plugins/.

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "go-usage",
  setup() {
    // Intentionally empty; see tui.tsx.
  },
})
