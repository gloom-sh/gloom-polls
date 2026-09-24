# Polls for Gloom

VoteHub political polls: approval, favorability, generic ballot, Senate, governor, and House. Trend charts, pollster breakdowns, search, and a link to each source.

## Install

Requires Gloom 0.15.0 or newer. Gloom restores this plugin once for existing installations when it moves out of the core app: saved panes keep working because the pane and template ids are unchanged, a previously disabled plugin stays disabled, and a deliberate removal is respected.

```sh
gloomberb install gloom-sh/gloom-polls
```

Open `POLL` in the command bar. Also in the hosted web app at term.gloom.sh, where the host proxies the data source.

## Usage

The poll types are tabs in the pane title bar (a tab row in the terminal); `h`/`l` or the arrow keys switch them. `/` searches subjects and pollsters; arrow keys move between the search field and the list. The result column shows the top two answers, candidates by surname, tinted by what leads (disapproval red, approval green).

Enter opens a poll: when and by whom it was fielded, sample, margin of error, this poll against the recent weighted average, a trend chart of the leading answer, and each pollster's average of it. `h`/`l` switch between those views. `o` opens the source, `r` refreshes.

## Data

[VoteHub](https://votehub.com), licensed CC BY 4.0. Fetched directly from `api.votehub.com`; nothing goes through Gloom Cloud.

## Development

```sh
bun install
# Link a Gloom checkout, as the plugin installer does:
ln -s /path/to/gloomberb node_modules/gloomberb
ln -s /path/to/gloomberb/node_modules/react node_modules/react
bun run typecheck
bun test
```

`gloomberb` and `react` are peer dependencies, never real ones. Gloom symlinks its own copies into every plugin directory on install and on load, so there is exactly one instance of each in the process. CI links the host the same way.

## License

MIT
