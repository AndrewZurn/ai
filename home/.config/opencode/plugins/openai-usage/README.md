# OpenCode OpenAI Usage

An OpenCode CLI plugin that displays OpenAI Codex (ChatGPT) plan usage in a
popup and in the TUI footer.

## Features

- `/openai-usage` command, also available from the command palette
- Popup showing the Codex rate-limit windows your plan reports (on a standard
  Plus/Pro plan: the 5-hour rolling window and the weekly window)
- Usage bars with a left-to-right wave animation
- Green bars at 50% or below, yellow above 50%, and red above 90%
- Reset countdowns aligned on the right
- Plan type and available free resets shown when reported
- Compact `Codex 5h 14% Wk 2%` footer status on the home screen
- 60-second usage cache and 60-second background refresh

## Authentication

No API key or token is read or stored. The plugin talks to the local
[`codex` CLI](https://github.com/openai/codex) app server, which reuses your
existing Codex sign-in (`codex login`). If Codex is not signed in, the popup
will tell you how to connect it.

## Usage

Run this command inside OpenCode:

```text
/openai-usage
```

The plugin uses the documented Codex app-server method:

```text
codex app-server  →  account/rateLimits/read
```

See <https://developers.openai.com/codex/app-server> for the protocol.

## Development

Pure helper tests use Node's built-in test runner:

```sh
node --test test/usage-core.test.js
```

The plugin source lives at:

```text
~/.config/opencode/plugins/openai-usage/
```

This is the active plugin directory; no separate V2 tree or plugin symlink is
needed.

Run `/reload` in OpenCode after adding the plugin so it is discovered.
