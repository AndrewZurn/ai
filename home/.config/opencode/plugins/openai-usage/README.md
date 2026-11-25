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
- Credit status and balance shown when reported, including work accounts
- Monthly credit allowance percentage remaining and reset time when reported
- Today, week-to-date, and month-to-date reported token totals; no lifetime total
- Compact `Codex 5h 14% Wk 2%` footer status on the home screen
- 60-second usage cache and 60-second background refresh

## Authentication

No API key or token is read or stored. The plugin talks to the local
[`codex` CLI](https://github.com/openai/codex) app server, which reuses your
existing Codex sign-in (`codex login`). If Codex is not signed in, the popup
will tell you how to connect it.

This sign-in is separate from OpenCode's `/connect` credentials. The plugin
uses the Codex account and `CODEX_HOME` inherited by the OpenCode CLI.
Use `codex login status` to check that sign-in.

### Work accounts without percentage windows

Some Enterprise/work accounts return credit status but no percentage-based
usage windows. This is a valid response, not a sign-in failure. The popup
shows the available credit information and plan; the footer shows
month-to-date token totals when available, otherwise `Codex usage n/a`.
A missing balance is not treated as zero or as unlimited credits.

### Monthly percentage remaining

Codex exposes the personal monthly credit allowance separately from rolling
token windows, in `rateLimits.individualLimit.remainingPercent`. When present,
the popup shows that server-provided percentage remaining, credits used/limit,
and reset countdown. The footer shows, for example, `Codex Mo95% left`.

If the desktop app shows a monthly allowance but the CLI returns
`individualLimit: null`, the plugin cannot reproduce that percentage. Compare
the account and work workspace in the desktop app with `codex` → `/status`,
and check whether the CLI uses a different `CODEX_HOME`. No account switching
or credential changes are performed by the plugin.

Token counts are not the monthly credit allowance and cannot be used to infer
a remaining percentage. Check <https://chatgpt.com/codex/settings/usage> or
your workspace administrator's dashboard when no allowance is returned.

### Reported token totals

The plugin sums the daily records from `account/usage/read`. For consistent
calendar boundaries, it interprets service date labels as UTC dates, with
Monday-start weeks and calendar months. Totals include only returned records,
not a guaranteed complete billing ledger. The latest reported day is displayed
separately from the fetch time, because account reporting can lag.

A missing day or a period with no returned records shows `not reported`, not
zero. An explicit zero remains zero. Lifetime summary fields are not displayed.
The footer falls back to compact month-to-date tokens, for example
`Codex MTD 19.3M tokens`, when no percentage allowance is available.

## Usage

Run this command inside OpenCode:

```text
/openai-usage
```

The plugin uses the documented Codex app-server methods over stdio:

```text
codex app-server  →  account/rateLimits/read
                 →  account/usage/read
```

It also reads `account/read` metadata to identify the plan when the
rate-limit response reports a missing or unknown plan. This optional lookup
is limited to one second and cannot replace valid usage with a timeout error.
Rate limits and token activity are requested independently. If one fails,
the popup keeps the other result and shows a warning.

See <https://developers.openai.com/codex/app-server> for the protocol.

## Development

Helper and app-server protocol tests use Node's built-in test runner.
Protocol tests use a local fake CLI, with no sign-in or network requests:

```sh
node --test test/*.test.js
```

The plugin source lives at:

```text
~/.config/opencode/plugins/openai-usage/
```

This is the active plugin directory; no separate V2 tree or plugin symlink is
needed.

Run `/reload` in OpenCode after adding the plugin so it is discovered.
