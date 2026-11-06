# OpenCode Go Usage

An OpenCode CLI plugin that displays OpenCode Go usage limits in a popup and
in the TUI footer.

## Features

- `/go-usage` command, also available from the command palette
- Popup showing rolling 5-hour, weekly, and monthly usage
- Usage bars with a left-to-right wave animation
- Green bars at 50% or below, yellow above 50%, and red above 90%
- Reset countdowns aligned on the right
- Compact `Go R/W/M` footer status while an `opencode-go` model is active
- 60-second usage cache and 30-second background refresh

## Authentication

The plugin resolves the OpenCode Go API key in this order:

1. `OPENCODE_GO_API_KEY`
2. `~/.local/share/opencode/auth.json` and `~/.config/opencode/auth.json`
   (legacy `/connect` format, `{ "opencode-go": { type: "api", key } }`)
3. The OpenCode server's credential store — where V2's `/connect` →
   OpenCode Go saves the key (looked up via `context.client.credential.list()`)

The auth files are only written by the V1 client; V2 stores credentials
server-side, so on V2 the key comes from the credential store.

## Usage

Run this command inside OpenCode:

```text
/go-usage
```

The plugin uses the official Go usage endpoint:

```text
GET https://opencode.ai/zen/go/v1/usage
```

The endpoint can be overridden for development with:

```sh
OPENCODE_GO_USAGE_URL=https://example.test/usage
```

## Development

Pure helper tests use Node's built-in test runner:

```sh
node --test test/usage-core.test.js
```

The plugin source lives at:

```text
~/.config/opencode-v2/opencode/plugins/go-usage/
```

and is symlinked into the active plugin directory for discovery:

```text
~/.config/opencode/plugins/go-usage
```
