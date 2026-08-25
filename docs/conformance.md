# dlog conformance suite

Use this document to verify a portable implementation against the behavioral contract in [Specification](specification.md). The examples deliberately describe inputs and outputs rather than a particular programming language or configuration syntax.

## Test harness requirements

A conformance harness needs the ability to:

- control the local clock and time zone;
- supply temporary, existing daily-document roots and paths;
- configure deterministic prefix, global, link, and dynamic substitution rules;
- capture standard output, standard error, process status, and final document bytes;
- simulate external executable exit status and output;
- control watcher poll time and file hashes without waiting for real time;
- control whether standard output is a terminal, set or clear `NO_COLOR`, and force tail color policy;
- optionally mock the Spotify HTTP and OAuth boundaries.

For deterministic examples below, use local time `2025-07-25 10:30:00`. The default entry formatter is `- *HH:MM* - ` unless another formatter is stated.

## Configuration scenarios

These cases verify configuration semantics. The configuration format and how a deployment discovers its configuration are implementation choices.

| ID     | Setup                                                                         | Expected result                                                                                   |
| ------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| CFG-01 | A supplied configuration source is readable and nonempty.                     | Load one configuration model before processing input.                                             |
| CFG-02 | No usable configuration source is available.                                  | Fail clearly before reading or modifying a daily document.                                        |
| CFG-03 | A relative included fragment is named `people`.                               | Resolve it against the primary configuration's parent, not the process working directory.         |
| CFG-04 | A nested fragment includes `tools`.                                           | Resolve `tools` against the same primary configuration parent, not the nested fragment's parent.  |
| CFG-05 | A glob includes files whose names sort as `10-base`, `20-people`, `90-tools`. | Load in that lexical order.                                                                       |
| CFG-06 | The same prefix key is registered twice.                                      | Reject the duplicate.                                                                             |
| CFG-07 | The same global or wiki-link key is registered twice.                         | Reject the duplicate.                                                                             |
| CFG-08 | A link has an empty page value.                                               | Reject it.                                                                                        |
| CFG-09 | A rule, plugin, include, or whole rule file sets `enabled = false`.           | Validate its schema, then omit it from registration, duplicate checks, resolution, and execution. |
| CFG-10 | A primary include names a directory.                                          | Load only its immediate non-hidden `*.toml` files in lexical order.                               |
| CFG-11 | A path field contains `~`, `$NAME`, or `${NAME}`.                             | Expand it; reject a reference to an unset variable.                                               |
| CFG-12 | A primary or rule file omits its required schema marker.                      | Reject it as the wrong or unsupported schema.                                                     |

## Input acquisition and append scenarios

| ID     | Invocation                                                  | Expected result                                                                                                   |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| CLI-01 | Positional words: `Had`, `coffee`, `with`, `Sarah`.         | Process exactly `Had coffee with Sarah`.                                                                          |
| CLI-02 | No words; standard input is `Had coffee\n`.                 | Write `Enter Log: `, process `Had coffee`.                                                                        |
| CLI-03 | Input is blank or whitespace only.                          | Standard error is `No input, exiting`; status is `1`; document is unchanged.                                      |
| CLI-05 | A normal rendered entry is persisted successfully.          | Print that exact rendered entry to standard output after the write.                                               |
| CLI-06 | `--no-write` is provided with text content.                 | Status is `0`, output is the rendered entry, stderr contains `--no-write` warning, and the document is unchanged. |
| CLI-07 | Invoke `dlog` without an explicit subcommand.               | Print dispatcher help to standard error and exit nonzero.                                                         |
| CLI-08 | Invoke through `dlog-append`, `dlog-fixup`, or `dlog-tail`. | Infer the matching subcommand from argv0.                                                                         |

## Rules inspection scenarios

| ID       | Invocation / setup                                                                | Expected result                                                                                                         |
| -------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| RULES-01 | `dlog rules`                                                                      | List `prefix`, `global`, `callback`, and `link` with short descriptions without loading configuration.                  |
| RULES-02 | `dlog rules info KIND` for each supported kind.                                   | Show detailed semantics, valid TOML configuration, and sample append input/output for that kind.                        |
| RULES-03 | `dlog rules plugin` with one enabled plugin.                                      | Show its tilde-abbreviated source file, protocol, name, expanded command, and arguments in registration order.          |
| RULES-04 | `dlog rules print` with active and disabled files, rules, and plugins.            | Show files in effective order, nonzero counts by kind, and `TOTAL rules (N)` for every file; omit disabled definitions. |
| RULES-05 | `dlog rules print --rules` with prefix, global, then prefix definitions.          | Print three sections in that order rather than regrouping the prefix rules; show each input and output.                 |
| RULES-06 | `dlog rules print --rules --color=always` with values containing edge whitespace. | Apply different ANSI background colors to inputs and outputs while preserving the exact value bytes.                    |
| RULES-07 | An unknown rule kind, nested command, or print option.                            | Reject it with a specific usage error and nonzero status.                                                               |
| RULES-08 | Invoke through `dlog-rules`.                                                      | Do not infer the `rules` command from argv0.                                                                            |

## Entry-processing scenarios

Configure these ordered rules unless a case says otherwise:

- prefix `W` → `Work`;
- prefix `MEET` → `👥`;
- global `:100:` → `💯`;
- wiki-link `PAGE` → page `Page`;
- dynamic global rule `TEST-(digits)` → unchanged below 1000, otherwise `[[TEST Issue <digits>]]`.

| ID     | Input                                                             | Expected entry text                  | Expected rendered entry                        |
| ------ | ----------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| ENT-01 | `W on PAGE, :100:`                                                | `Work on [[Page]], 💯`               | `- *10:30* - Work on [[Page]], 💯`             |
| ENT-02 | `MEET Sarah`                                                      | `👥 Sarah`                           | `- *10:30* - 👥 Sarah`                         |
| ENT-03 | `W- Task`                                                         | `W- Task`                            | `- *10:30* - W- Task`                          |
| ENT-04 | `W`                                                               | `Work`                               | `- *10:30* - Work`                             |
| ENT-05 | `TEST-999 and TEST-1234`                                          | `TEST-999 and [[TEST Issue 1234]]`   | `- *10:30* - TEST-999 and [[TEST Issue 1234]]` |
| ENT-06 | A replacement rule removes `[REMOVE]` from `This [REMOVE] stays`. | `This  stays` before final trimming. | `- *10:30* - This  stays`                      |

The callback in ENT-05 must receive the complete entry as it stood before the `TEST-…` rule, once for each match. Returning the no-change value must preserve only that match, not abort the rule.

### Timestamp scenarios

| ID      | Input  | Expected timestamp | Expected remaining text |
| ------- | ------ | ------------------ | ----------------------- |
| TIME-01 | `12:34 | Had lunch`         | `12:34`                 | `Had lunch` |
| TIME-02 | `0922  | W on PAGE`         | `09:22`                 | `W on PAGE` |
| TIME-03 | `-12   | W on PAGE`         | `10:18`                 | `W on PAGE` |
| TIME-04 | `-1h3m | W on PAGE`         | `09:27`                 | `W on PAGE` |
| TIME-05 | `-45m  | W on PAGE`         | `09:45`                 | `W on PAGE` |
| TIME-06 | `-3h   | W on PAGE`         | `07:30`                 | `W on PAGE` |
| TIME-07 | `.`    | `10:30`            | `⬆︎`                     |
| TIME-08 | `-5    | .`                 | `10:25`                 | `.`         |

For TIME-01 through TIME-06, apply the configured substitutions after extraction. A library-level caller that supplies a timestamp and sends `12:34|text` or `-5|text` must fail rather than selecting one timestamp silently.

### Phone helper scenarios

A dynamic replacement that surrounds each helper match with square brackets must produce these values:

| Input                               | Output                                  |
| ----------------------------------- | --------------------------------------- |
| `Call 123-456-7890`                 | `Call [123-456-7890]`                   |
| `Call (123) 456-7890`               | `Call [(123) 456-7890]`                 |
| `Call 123.456.7890`                 | `Call [123.456.7890]`                   |
| `Call 1234567890`                   | `Call [1234567890]`                     |
| `Call 123 456 7890`                 | `Call [123 456 7890]`                   |
| `Call 1-234-567-8901`               | `Call [1-234-567-8901]`                 |
| `Call 1 234-567-8901`               | `Call [1 234-567-8901]`                 |
| `Call 1 (234) 567-8901`             | `Call [1 (234) 567-8901]`               |
| `Call 1.234.567.8901`               | `Call [1.234.567.8901]`                 |
| `Call 12345678901`                  | `Call [12345678901]`                    |
| `Call 456-7890`                     | `Call 456-7890`                         |
| `Call 123-456-7890 or 987-654-3210` | `Call [123-456-7890] or [987-654-3210]` |

## Daily-document scenarios

### DLOG-01: Insert into an empty section

Input document:

```markdown
# Some Header

Content here

# Log

# Another Header

More content
```

Append `- *10:00* - Test entry`. The log region must contain exactly:

```markdown
# Log

- _10:00_ - Test entry

# Another Header
```

The surrounding headers and content remain present.

### DLOG-02: Standard entries normalize into lexical time order

Input log section:

```markdown
# Log

- _10:00_ - Coffee
- _14:00_ - Meeting
- _09:00_ - Breakfast
```

Append `- *11:00* - Lunch`. The retained entries, in order, must be:

```text
- *09:00* - Breakfast
- *10:00* - Coffee
- *11:00* - Lunch
- *14:00* - Meeting
```

### DLOG-03: Case-insensitive sort key, exact duplicate removal

Start with:

```text
- *10:00* - zebra task
- *11:00* - Apple picking
- *12:00* - BANANA break
```

Append `- *13:00* - berry smoothie`. The four lines remain in time order because the timestamp prefix dominates the lowercase whole-line key.

Then append a byte-for-byte duplicate. It must appear only once. Append an otherwise identical entry that differs only in text casing; both entries must remain.

### DLOG-04: Remove nonstandard section content

Start with a `# Log` section containing these trimmed nonblank lines:

```text
Narrative note
- [ ] ordinary task
- *09:00* - Retained
```

Run fixup without a new entry. The narrative note and ordinary task must be absent afterward. The timestamped entry remains.

### DLOG-05: First section and section boundary

Create a document with two exact `# Log` headers and a later `## Details` header after the first. Append one standard entry. Only content between the first `# Log` and `## Details` may change. The second `# Log` section must remain byte-for-byte unchanged except if it is also the document's final line, where final-line stripping still applies.

### DLOG-06: Required header

A document with no exact trimmed `# Log` line must fail. It must not be rewritten.

### DLOG-07: Existing file requirement

If the configured daily-document locator yields a nonexistent file, append and fixup must fail. Neither operation may create the path.

### DLOG-08: Terminal newline compatibility

Start with this document whose log section reaches end of file:

```markdown
# Some Header

Content

# Log

- _10:00_ - First entry
```

Append `- *09:00* - Earlier entry`. The final bytes must be equivalent to:

```text
# Some Header\nContent\n\n# Log\n\n- *09:00* - Earlier entry\n- *10:00* - First entry
```

The last line has **no** trailing newline. This is intentional compatibility behavior.

### DLOG-09: Task-with-embedded-entry split

Start with a `# Log` line in this form:

```text
- [ ] - *09:15* - Follow up with Sam (@2025-07-25)
```

Run fixup. The timestamped entry must be extracted as a normal entry. The unchecked task residual becomes blank; an implementation may represent that retained blank internally but the serialized section contains a blank line in its place.

### DLOG-10: No-op digest

Use a canonically formatted log section: a blank line immediately after `# Log`, followed only by sorted standard entries, plus the expected section spacing. Run fixup without a new entry. It must report no change and leave bytes untouched. Changing spacing, adding any nonstandard line, changing order, or adding a duplicate must trigger a rewrite.

### DLOG-11: Mid-entry timestamp split

Start with a `# Log` line that contains a second timestamped entry after arbitrary text, without a task marker or list marker before it:

```text
- *09:00* - Wrote notes ⬆︎ *09:45* - Follow up
```

Run fixup. The embedded `*09:45* - Follow up` is extracted and normalized into a full list item by prepending `- `. The residual is retained as-is; residuals are not re-trimmed, so the first line keeps its single trailing space. The resulting section is:

```text
- *09:00* - Wrote notes ⬆︎
- *09:45* - Follow up
```

## Tail display scenarios

These cases run `dlog tail --color=always` unless stated otherwise, against
local day `2025-07-25`. `ESC` denotes `\x1b`. Every styled result terminates
with `ESC[0m\n`; plain results terminate with `\n`. Tail never modifies the
document.

| ID      | Setup                                                                                                     | Expected result                                                                                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TAIL-01 | Section contains `- *09:00* - Coffee`.                                                                    | Date is bright black; `Log` is cyan and bold; marker is magenta; timestamp is yellow and italic; separator is bright black; message uses terminal defaults. All ansis close sequences and the final reset are exact.                                          |
| TAIL-02 | Section contains `- *10:30* - Shipped **release** build`.                                                 | The canonical entry roles render as TAIL-01 and `release` is bold, composed over message styling.                                                                                                                                                             |
| TAIL-03 | Section contains `- *11:00* - Reviewed [[Page]] and [[Page\|the plan]]; keep [[oops`.                     | Wiki displays are underlined blue. The unterminated `[[oops` is literal message text.                                                                                                                                                                         |
| TAIL-04 | Section contains `- *12:00* - Read [status](https://example.com)`.                                        | `status` is underlined cyan and the URL is not displayed.                                                                                                                                                                                                     |
| TAIL-05 | Run with piped output, nonblank `NO_COLOR`, `FORCE_COLOR=0`, and `--color=never`; separately force color. | Disabled runs print `2025-07-25-Fri\nLog\n- 09:00 - Page\n` with no markup or escapes. Positive `FORCE_COLOR` wins in auto. `--color=always` wins over environment values and emits truecolor-capable styling; `--color=never` always wins and remains plain. |
| TAIL-06 | Section contains narrative text, an ordinary `+ item`, a `* item`, a task, and blank lines.               | All lines remain in document order, blank lines are dropped, and each leading unordered marker is styled without requiring a timed entry.                                                                                                                     |
| TAIL-07 | Document has no exact trimmed `# Log` line.                                                               | Fail nonzero, write no stdout, and leave document bytes untouched.                                                                                                                                                                                            |
| TAIL-08 | The `# Log` section is empty.                                                                             | Output contains the themed date and heading followed by final reset and newline.                                                                                                                                                                              |
| TAIL-09 | Any document.                                                                                             | After success, document bytes are identical.                                                                                                                                                                                                                  |
| TAIL-21 | Lines contain `+ *23:59* - Valid` and `* *24:00* - Invalid`.                                              | The first line decomposes into marker, timestamp, separator, and message roles. On the second, only the first `*` is a marker; `24:00` is ordinary emphasis because it is not a valid canonical timestamp.                                                    |
| TAIL-22 | Run `tail -f`; replace the selected document after the initial rendering.                                 | Write `ESC[2JESC[H` before the initial rendering. Poll at one-second intervals, then write the clear sequence and complete updated rendering after the hash changes.                                                                                          |
| TAIL-23 | Run default-today `tail --follow` across local midnight; the new day's document is initially absent.      | Emit nothing while the new path is absent and leave the previous display intact. Once the new document exists, clear once and redraw it with the new date heading.                                                                                            |

### Tail date scenarios

These cases use local time `2025-07-25 10:30:00` (a Friday), a strftime `daily_path` of `%Y-%m-%d.md`, and run `dlog tail` without forced color.

| ID      | Invocation                                                   | Expected result                                                                                                |
| ------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| TAIL-10 | `tail -1`; documents exist for 2025-07-24 and 2025-07-25.    | Display the 2025-07-24 section.                                                                                |
| TAIL-11 | `tail Fri` and `tail Monday`.                                | `Fri` displays today (2025-07-25); `Monday` displays 2025-07-21. Matching is case-insensitive.                 |
| TAIL-12 | `tail 9`.                                                    | Display the 2025-07-09 section.                                                                                |
| TAIL-13 | `tail 0709`.                                                 | Display the 2025-07-09 section.                                                                                |
| TAIL-14 | `tail 2025-07-09`, `tail 07/09/2025`, `tail "July 9 2025"`.  | All display the 2025-07-09 section, resolved at local midnight regardless of time zone.                        |
| TAIL-15 | `tail 0230`.                                                 | Hard error, status nonzero: February 30 does not exist.                                                        |
| TAIL-16 | `tail 2025`.                                                 | Hard error, status nonzero: the `MMDD` form matched and month 20 is invalid; no year fallback.                 |
| TAIL-17 | `tail banana`.                                               | Hard error naming the unparseable input, status nonzero.                                                       |
| TAIL-18 | `tail -7`; no 2025-07-18 document exists.                    | `Daily document does not exist`, status nonzero, nothing on standard output.                                   |
| TAIL-19 | `tail -0`.                                                   | Display today's (2025-07-25) section.                                                                          |
| TAIL-20 | `tail -w`; run on Friday 2025-07-25, then Monday 2025-07-21. | Select Thursday 2025-07-24 and Friday 2025-07-18, respectively; each output starts with that date and weekday. |

## Theme scenarios

| ID       | Setup / invocation                                                                                                     | Expected result                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| THEME-01 | No `DLOG_THEME`, config theme, or sibling `theme.toml`; run `dlog theme --dump --silent`.                              | Status `0`; stdout is complete valid `dlog-theme/v1` TOML for the built-in theme, with ten role tables, every property explicit, and every `inherit = false`; stderr empty. |
| THEME-02 | `DLOG_THEME=custom.toml` from cwd; file overrides timestamp `fg = \"#a1b2c3\"` and `bold = true`.                      | Environment file wins. Timestamp keeps built-in italic, adds bold, normalizes foreground to `#A1B2C3`, and the source diagnostic names the absolute file.                   |
| THEME-03 | No environment override; primary config has `theme = \"themes/night.toml\"`; sibling `theme.toml` also exists.         | Config path resolves from the primary parent and wins over the sibling.                                                                                                     |
| THEME-04 | No explicit path; readable sibling `theme.toml` exists.                                                                | Sibling wins. If absent, built-in wins. A missing explicit path is an error.                                                                                                |
| THEME-05 | Existing theme has malformed TOML, wrong schema, unknown role/property, invalid color, or both `hidden` and `visible`. | Active theme loading fails nonzero with path and validation detail.                                                                                                         |
| THEME-06 | Run `dlog theme` with no action flags.                                                                                 | Deterministic plain/styled preview is the only stdout section; source is reported on stderr unless silent.                                                                  |
| THEME-07 | Run with `--preview --swatches --dump --check`.                                                                        | All actions are enabled; stdout order is preview, blank line, swatches, blank line, dump. Check adds no success text.                                                       |
| THEME-08 | Run `--check --no-check --preview --no-preview`.                                                                       | Last occurrences win; no actions remain, so status is `0`, no theme is loaded, and both output streams are empty.                                                           |
| THEME-09 | Run `--check` alone against a valid or invalid selected theme.                                                         | Valid theme returns `0` with no stdout; invalid returns nonzero with its normal error. Source diagnostic remains unless silent.                                             |
| THEME-10 | Run preview or swatches with `--color=never`, and dump under any color mode.                                           | Visual display contains no escapes when disabled. Dump always contains semantic theme values, never degraded colors or ANSI sequences.                                      |

## External-tool scenarios

| ID      | Setup                                                                                                    | Expected result                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| TOOL-01 | A bare executable name resolves through `PATH`, exits `0`, and writes ` result \n`.                      | `toolOutput` is `result`; `toolSuccess` is true; `toolError` is false.                                                                           |
| TOOL-02 | A path-like name resolves to a nonexecutable file.                                                       | `hasTool` is false and its negative resolution is cached.                                                                                        |
| TOOL-03 | The configured tool exits `4`.                                                                           | `toolError` is true; captured output is still available.                                                                                         |
| TOOL-04 | A callback sets a tool path, then checks output before running.                                          | Output is empty/null and exit status is nonzero.                                                                                                 |
| TOOL-05 | A tool path contains `/` but is relative.                                                                | Resolve from the process working directory, not the configuration directory.                                                                     |
| TOOL-06 | A callback invokes the currently selected tool again with an explicit argument array, without naming it. | The same resolved executable runs with exactly those argument values; captured output is cleared first and refreshed along with the exit status. |
| TOOL-07 | A text-protocol plugin receives a match and exits `0` with ` result \n`.                                 | Send the exact match on standard input and replace it with `result`.                                                                             |
| TOOL-08 | A text-protocol plugin exits `0` with blank output.                                                      | Delete that match.                                                                                                                               |
| TOOL-09 | A JSON-protocol plugin returns a valid replace, no-change, or delete response.                           | Apply the selected callback state to that match.                                                                                                 |
| TOOL-10 | A plugin exits nonzero.                                                                                  | Propagate a callback error containing its status.                                                                                                |

## Fixup watcher scenarios

Use a fake monotonic clock and controllable document hash.

| ID     | State transition                                          | Expected behavior                                                                                                    |
| ------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| FIX-01 | Start once mode with a stable daily document.             | Observe it, then run exactly one fixup without the normal delay because startup is under 10 seconds; exit afterward. |
| FIX-02 | Loop mode observes hash A, then A again.                  | Run the initial fixup after the second observation.                                                                  |
| FIX-03 | Loop mode observes A, then B, then B.                     | Treat B as a stabilized external change; wait `writeDelay` when past startup grace, then rehash before fixing.       |
| FIX-04 | During the delay in FIX-03, the hash changes from B to C. | Do not fix B; record C as pending and wait for C to stabilize.                                                       |
| FIX-05 | Fixup itself changes the file.                            | Refresh the stored hash so the next poll does not treat that write as external.                                      |
| FIX-06 | Cached configuration crosses a local midnight.            | Reload configuration and select the new day's document.                                                              |
| FIX-07 | Configuration caching is disabled.                        | Reload on every configuration access, even multiple times per poll cycle.                                            |
| FIX-08 | No main-loop pet arrives for 60 seconds.                  | Emit one watchdog warning.                                                                                           |
| FIX-09 | No main-loop pet arrives for 120 seconds.                 | Exit with status `7`.                                                                                                |
| FIX-10 | Start loop mode with `--watch` and no `--delay`.          | Use a zero-second write delay; selecting loop mode does not restore the constructor's one-second value.              |

## Spotify helper scenarios

These are optional and are not run for this TypeScript implementation because
the bundled helper is outside its selected scope.

| ID      | Mocked condition                                                                                               | Expected standard output                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| SPOT-01 | A valid unexpired token and a track titled `Song`, artist `A` and `B`, URL `https://open.spotify.com/track/x`. | `[🎵 Song - A, B](https://open.spotify.com/track/x)`                                                          |
| SPOT-02 | The currently-playing endpoint returns 204.                                                                    | `❌ SONG ERROR: No track currently playing`                                                                   |
| SPOT-03 | The endpoint returns 401 and refresh fails.                                                                    | `❌ SONG ERROR: Access token expired, please re-authorize`                                                    |
| SPOT-04 | The endpoint returns 500.                                                                                      | `❌ SONG ERROR: API request failed (500)`                                                                     |
| SPOT-05 | Token expiry is less than five minutes away and a refresh token exists.                                        | Refresh before querying current playback.                                                                     |
| SPOT-06 | No usable token exists.                                                                                        | Start authorization-code flow with `user-read-currently-playing` and a local callback at the configured port. |

## Evidence note

The TypeScript suite executes 122 deterministic tests across seven files and
covers every non-Spotify scenario plus the implementation-profile cases above.
The Ruby behavioral suite used to derive this contract contained 69 examples
with one known mismatch: an assertion expected a terminal newline after an
end-of-file log section while the running writer stripped it. DLOG-08 follows
the running writer and remains normative.
