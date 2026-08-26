# dlog

`dlog` appends a timestamped entry to the first `# Log` section in today's
existing daily document. It also provides a one-shot normalizer and a watch
mode. The observable compatibility contract is in
[`docs/specification.md`](docs/specification.md); executable cases are listed
in [`docs/conformance.md`](docs/conformance.md).

## Development

The project uses Bun 1.4, TypeScript, and `just`.

```bash
bun install
just check
just run --help
just compile
```

`just compile` creates:

```text
dist/<os>-<arch>/dlog
dist/<os>-<arch>/dlog-append -> dlog
dist/<os>-<arch>/dlog-fixup -> dlog
dist/<os>-<arch>/dlog-tail -> dlog
```

`just compile-all` builds the supported macOS ARM64 and Linux x64 targets.
Builds never install into `~/bin`.

## Docker deployment

The production image contains a compiled musl executable on Alpine and runs
`dlog fixup --watch` by default. The bundled Compose deployment bind-mounts the
existing configuration directory read-only and the existing vault read-write:

```text
~/.config/dlog                  -> /config
~/Documents/Obsidian/vimwiki    -> /vault
```

The container uses `/config/config.toml` and defaults to the host's
`America/Denver` time zone. Override `TZ` when deploying in another time zone.

```bash
docker compose up --detach --build
docker compose logs --follow dlog
docker compose down
```

Compose arguments override the default watch command while retaining the
compiled `dlog` entrypoint. For example:

```bash
docker compose run --rm dlog tail --color=never
```

## Commands

`dlog` is a strict dispatcher:

```bash
dlog append Had coffee with Sarah
dlog append                 # prompts for one line
dlog fixup                  # normalize once
dlog fixup --watch          # continue watching
dlog tail                   # print today's date and formatted # Log section
dlog tail -f                # clear and redraw while following today's log
dlog tail --color=never     # plain log formatting for piping
dlog tail -w                # previous weekday (Monday selects Friday)
dlog tail -1                # yesterday's section
dlog tail Mon               # most recent Monday (today if Monday)
dlog tail 9                 # the 9th of this month
dlog tail 0709              # July 9 of this year
dlog tail 2026-08-09        # also: 08/09/2026 or "August 9 2026"
dlog theme                  # deterministic preview of the active theme
dlog theme --swatches       # one styled sample for every semantic role
dlog theme --dump --silent  # complete reusable theme.toml on stdout
dlog theme --check          # validate through exit status
dlog rules                  # list supported rule types
dlog rules info prefix      # detailed help and examples
dlog rules plugin           # inspect configured plugins
dlog rules print            # rule files and counts
dlog rules print --rules    # include rules in application order
```

The argv0 aliases are equivalent:

```bash
dlog-append Had coffee with Sarah
dlog-fixup --watch
dlog-tail
```

`theme` and `rules` intentionally have no argv0 aliases.

Append arguments are joined with one space. Prefix an argument list with `--`
to log a word that would otherwise be CLI syntax.

Fixup options:

```text
-w, --watch
-s, --sleep SECONDS
-d, --delay SECONDS
    --log-no-change SECONDS
    --cache-config
    --no-cache-config
```

Tail options:

```text
-w
-f, --follow
    --truncate
    --no-truncate
    --width COLUMNS
    --color auto|always|never
```

With `--width`, each rendered line is truncated to that many display columns and
ends with `…` when needed.

With `--truncate`, truncation also uses the terminal width, then `COLUMNS`, then
explicit `--width`.

The `--truncate` option requires a measurable width (a terminal width, `COLUMNS`,
or `--width`), otherwise tail exits with an error.

Truncation is width-safe for ANSI styling, tabs, and wide glyphs.

The command can also be configured in `[tail]`:

```toml
[tail]
truncate = false
width = 80
```

`width` applies only when truncation is enabled.
CLI `--width` forces truncation and `--no-truncate` disables truncation regardless
of config.

With `--follow`, a default-today tail follows the local date across midnight. If
the new document does not exist yet, the prior display remains until the new
document appears.

## Application configuration

The first readable primary configuration is loaded from:

1. `$DLOG_CONFIG`, when nonblank;
2. `~/.config/dlog/config.toml`;
3. `./dlog.toml`.

The primary file owns application settings. It cannot contain processing
rules.

```toml
schema = "dlog-config/v1"

# First existing directory wins.
vault_roots = [
  "$HOME/Obsidian/Main",
  "~/Documents/Main",
]

# Uses the documented strftime package dialect and local time.
daily_path = "logs/%Y/%m-%b/%Y-%m-%d-%a.md"
entry_prefix = "- *%H:%M* - "
theme = "theme.toml" # optional; relative to this config

# Optional tail display defaults.
[tail]
truncate = false
width = 80 # optional

[[includes]]
path = "rules"
# enabled = true

Path fields expand `~`, `$NAME`, and `${NAME}`. An unset variable is an error.
The selected daily document must already exist and be a regular file.

An include can name one TOML file or a directory. A directory contributes its
immediate, non-hidden `*.toml` files in lexical filename order. Rule files may
include more paths, but every relative path remains relative to the primary
configuration directory. Include cycles and repeated files are errors.

## Renderer themes

Theme selection is `$DLOG_THEME`, then the primary config's `theme`, then
`theme.toml` beside the primary config, then the built-in default. A relative
`DLOG_THEME` resolves from the invocation directory; a config path resolves
from the config directory.

Theme files are strict, independently versioned TOML. They may override only
the roles that need changing:

```toml
schema = "dlog-theme/v1"

[roles.timestamp]
fg = "#E5C07B"
bold = true

[roles.external_link]
inherit = false
fg = "bright_cyan"
underline = true
```

Available roles are `date`, `heading`, `list_marker`, `timestamp`,
`entry_separator`, `message`, `strong`, `emphasis`, `wiki_link`, and
`external_link`. Each role accepts `inherit`, `fg`, `bg`, `reset`, `inverse`,
`hidden`, `visible`, `bold`, `dim`, `italic`, `underline`, and
`strikethrough`. Colors are `default`, lowercase ANSI names, canonical
`bright_*` names, or six-digit `#RRGGBB`.

`inherit` defaults to true. Set it false to replace the built-in role rather
than merge with it. Use `dlog theme --dump --silent > theme.toml` to obtain a
complete editable snapshot. Preview is on by default; `--swatches`, `--check`,
and `--dump` are off. Every boolean option has a `--no-*` form. When any
positive action flag is supplied, unspecified actions are disabled.

## Rule files

Rule files have a distinct schema:

```toml
schema = "dlog-rules/v1"
# enabled = true

[[rules]]
kind = "prefix"
match = "W"
replace = "Work"
# enabled = true

[[rules]]
kind = "global"
match = ":100:"
replace = "💯"

[[rules]]
kind = "global"
pattern = 'TEST-(\d+)'
replace = "TEST-$1"

[[rules]]
kind = "link"
match = "PAGE"
page = "Page"
# display = "Shown text"
# alias = "Shown text" # ergonomic synonym for display

[[plugins]]
name = "phone-formatter"
protocol = "text"
command = "/usr/local/bin/format-phone"
arguments = []
# enabled = true

[[rules]]
kind = "callback"
matcher = "phone"
plugin = "phone-formatter"
```

All rules share one ordered `[[rules]]` list. Prefix rules run first in their
registration order; global, link, and callback rules then run in their
registration order. Literal and regular-expression keys are distinct.
Duplicate prefix keys and duplicate global/link/callback keys are errors.

Rules, plugins, includes, and whole rule files accept `enabled`, defaulting to
`true`. Disabled records remain schema-validated but are not registered,
duplicate-checked, resolved, or executed.

Matchers use exactly one of:

- `match = "literal"`;
- `pattern = "JavaScript regular expression"` with optional `flags`;
- `matcher = "phone"` for the bundled North American phone pattern.

A callback can set `scope = "prefix"` with a literal `match`; the default scope
is `global`.

## Executable plugins and tools

Plugins are synchronous executables resolved through `PATH`, or from the
process working directory when the configured name contains `/`. Only
executable regular files qualify. Arguments are explicit TOML string arrays;
no shell parses or expands them.

The default JSON protocol writes this request to standard input:

```json
{
  "protocol": "dlog-substitution/v1",
  "fullEntryBeforeRule": "complete entry before this rule",
  "matchedText": "this match"
}
```

It accepts one response:

```json
{"action":"replace","value":"replacement"}
{"action":"no-change"}
{"action":"delete"}
```

The `text` protocol writes the exact matched text to standard input. Exit
status `0` replaces the match with trimmed standard output; empty output
deletes the match. A nonzero exit is an error.

## Compatibility profile

The implementation deliberately preserves the document writer's destructive
filtering, lexical whole-line sort, digest behavior, task/timestamp split
quirks, direct overwrite, and missing terminal newline.

It deliberately differs from the Ruby-compatible profile in three places:

- configuration is versioned TOML rather than executable Ruby;
- daily paths and entry prefixes are strftime templates rather than arbitrary
  configuration functions;
- external commands receive explicit argv arrays and never run through a
  shell.

The bundled Spotify helper, direct clipboard API, legacy Ruby watcher image,
and legacy configuration adapter are outside this implementation's scope.
