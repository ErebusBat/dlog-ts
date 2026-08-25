import { basename } from "node:path";

import {
  AppendCommand,
  ProcessCommandIO,
  type CommandIO,
} from "./append-command.js";
import {
  ConfigurationLoader,
  defaultConfigurationEnvironment,
} from "./configuration.js";
import { DailyDocumentReader, DailyDocumentWriter } from "./daily-document.js";
import { DlogError } from "./dlog-error.js";
import {
  FixupWatcher,
  Sha256FileHasher,
  StandardErrorLogger,
  SystemWatchClock,
  SystemWatchdogScheduler,
  type FileHasher,
  type FixupOptions,
  type OperationalLogger,
  type WatchClock,
  type WatchdogScheduler,
} from "./fixup-watcher.js";
import {
  TailCommand,
  parseTailOptions,
  type TailCommandDependencies,
} from "./tail-command.js";
import {
  ThemeCommand,
  parseThemeOptions,
  type ThemeCommandDependencies,
} from "./theme-command.js";
import { ThemeLoader, type ThemeProvider } from "./theme.js";

const ROOT_HELP = `Usage:
  dlog append [--no-write] [--] [WORDS...]
  dlog fixup [OPTIONS]
  dlog tail [OPTIONS] [DATE]
  dlog theme [OPTIONS]
  dlog-append [--no-write] [--] [WORDS...]
  dlog-fixup [OPTIONS]
  dlog-tail [OPTIONS] [DATE]
`;

const APPEND_HELP = `Usage: dlog append [OPTIONS] [WORDS...]

Options:
      --no-write         Do not write to the daily document. A warning is printed to stderr.

With no words, write Enter Log: , read one standard-input line, and trim it.
`;
const FIXUP_HELP = `Usage: dlog fixup [OPTIONS]

Options:
  -w, --watch                  Continue watching after initial fixup
  -s, --sleep SECONDS          Poll interval (default 5; clamp 1..3600)
  -d, --delay SECONDS          Stabilized-write delay (default 0; clamp 0..3600)
      --log-no-change SECONDS  No-change log interval (default 60; negative disables)
      --cache-config           Cache configuration within the local day (default)
      --no-cache-config        Reload configuration on every access
  -h, --help                   Show this help
`;

const TAIL_HELP = `Usage: dlog tail [OPTIONS] [DATE]

Print the # Log section with headings, emphasis, and links rendered.

DATE selects the day (default today): -N for N days ago, a weekday (Mon,
Tuesday), D or DD of this month, MMDD of this year, YYYY-MM-DD, MM/DD/YYYY,
or a month-name form like "August 9 2026".

Options:
  -w                           Select the previous weekday
  -f, --follow                 Clear before drawing and redraw when the document changes
      --color WHEN             Emit ANSI styling: auto, always, never (default auto)
  -h, --help                   Show this help
`;

const THEME_HELP = `Usage: dlog theme [OPTIONS]

Validate and inspect the active renderer theme.

Options:
      --preview, --no-preview    Render a representative log (default on)
      --swatches, --no-swatches  Render one sample for every theme role
      --check, --no-check        Validate using exit status only
      --dump, --no-dump          Emit complete resolved dlog-theme/v1 TOML
      --silent, --no-silent      Suppress the selected-theme source diagnostic
      --color WHEN               Emit ANSI styling: auto, always, never (default auto)
  -h, --help                     Show this help
`;


export interface CliDependencies {
  readonly io: CommandIO;
  readonly configurationLoader: ConfigurationLoader;
  readonly documentReader: DailyDocumentReader;
  readonly themeLoader: ThemeProvider;
  readonly documentWriter: DailyDocumentWriter;
  readonly clock: WatchClock;
  readonly hasher: FileHasher;
  readonly logger: OperationalLogger;
  readonly watchdogScheduler: WatchdogScheduler;
  readonly fatalExit: (status: number) => void;
  readonly keepWatching: () => boolean;
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

export async function runCli(
  invokedPath: string,
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  try {
    const invokedName = basename(invokedPath);
    if (invokedName === "dlog-append") {
      return await runAppend(arguments_, dependencies);
    }
    if (invokedName === "dlog-fixup") {
      return await runFixup(arguments_, dependencies);
    }
    if (invokedName === "dlog-tail") {
      return await runTail(arguments_, dependencies);
    }

    const command = arguments_[0];
    if (command === "--help" || command === "-h" || command === "help") {
      dependencies.io.writeOutput(ROOT_HELP);
      return 0;
    }
    if (command === "append") {
      return await runAppend(arguments_.slice(1), dependencies);
    }
    if (command === "fixup") {
      return await runFixup(arguments_.slice(1), dependencies);
    }
    if (command === "tail") {
      return await runTail(arguments_.slice(1), dependencies);
    }
    if (command === "theme") {
      return await runTheme(arguments_.slice(1), dependencies);
    }

    dependencies.io.writeError(
      command === undefined
        ? `dlog: an explicit append, fixup, tail, or theme subcommand is required\n${ROOT_HELP}`
        : `dlog: unknown subcommand: ${command}\n${ROOT_HELP}`,
    );
    return 1;
  } catch (error) {
    if (error instanceof DlogError) {
      dependencies.io.writeError(`dlog: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

export function createDefaultCliDependencies(): CliDependencies {
  const configurationEnvironment = defaultConfigurationEnvironment();
  const configurationLoader = new ConfigurationLoader({
    environment: configurationEnvironment,
  });
  const clock = new SystemWatchClock();
  return {
    io: new ProcessCommandIO(),
    configurationLoader,
    themeLoader: new ThemeLoader({
      configurationLoader,
      environment: configurationEnvironment,
    }),
    documentReader: new DailyDocumentReader(),
    documentWriter: new DailyDocumentWriter(),
    clock,
    hasher: new Sha256FileHasher(),
    logger: new StandardErrorLogger(clock),
    watchdogScheduler: new SystemWatchdogScheduler(),
    fatalExit: (status) => {
      process.exit(status);
    },
    keepWatching: () => true,
    cwd: configurationEnvironment.cwd,
    environment: configurationEnvironment.variables,
  };
}

async function runAppend(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseAppendOptions(arguments_);
  if (parsed === "help") {
    dependencies.io.writeOutput(APPEND_HELP);
    return 0;
  }
  return new AppendCommand({
    configurationLoader: dependencies.configurationLoader,
    documentWriter: dependencies.documentWriter,
    io: dependencies.io,
    now: () => dependencies.clock.now(),
    cwd: dependencies.cwd,
    environment: dependencies.environment,
    noWrite: parsed.noWrite,
  }).run(parsed.words);
}

interface AppendOptions {
  readonly noWrite: boolean;
  readonly words: readonly string[];
}

function parseAppendOptions(
  arguments_: readonly string[],
): AppendOptions | "help" {
  let noWrite = false;
  let index = 0;
  const words: string[] = [];
  for (; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--") {
      words.push(...arguments_.slice(index + 1));
      return { noWrite, words };
    }
    if (argument === "--help" || argument === "-h") {
      return "help";
    }
    if (argument === "--no-write") {
      noWrite = true;
      continue;
    }

    break;
  }
  words.push(...arguments_.slice(index));
  return { noWrite, words };
}
async function runFixup(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseFixupOptions(arguments_);
  if (parsed === "help") {
    dependencies.io.writeOutput(FIXUP_HELP);
    return 0;
  }
  return new FixupWatcher(parsed, {
    configurationLoader: dependencies.configurationLoader,
    documentWriter: dependencies.documentWriter,
    clock: dependencies.clock,
    hasher: dependencies.hasher,
    logger: dependencies.logger,
    watchdogScheduler: dependencies.watchdogScheduler,
    fatalExit: dependencies.fatalExit,
    keepWatching: dependencies.keepWatching,
  }).run();
}

async function runTail(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseTailOptions(arguments_);
  if (parsed === "help") {
    dependencies.io.writeOutput(TAIL_HELP);
    return 0;
  }
  const commandDependencies: TailCommandDependencies = {
    configurationLoader: dependencies.configurationLoader,
    documentReader: dependencies.documentReader,
    io: dependencies.io,
    clock: dependencies.clock,
    environment: dependencies.environment,
    themeLoader: dependencies.themeLoader,
    hasher: dependencies.hasher,
    keepWatching: dependencies.keepWatching,
  };
  return new TailCommand(commandDependencies).run(parsed);
}

async function runTheme(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseThemeOptions(arguments_);
  if (parsed === "help") {
    dependencies.io.writeOutput(THEME_HELP);
    return 0;
  }
  const commandDependencies: ThemeCommandDependencies = {
    io: dependencies.io,
    themeLoader: dependencies.themeLoader,
    environment: dependencies.environment,
  };
  return new ThemeCommand(commandDependencies).run(parsed);
}

export function parseFixupOptions(
  arguments_: readonly string[],
): FixupOptions | "help" {
  let watch = false;
  let pollIntervalSeconds = 5;
  let writeDelaySeconds = 0;
  let noChangeLogIntervalSeconds = 60;
  let cacheConfiguration = true;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      return "help";
    }
    if (argument === "-w" || argument === "--watch") {
      watch = true;
      continue;
    }
    if (argument === "--cache-config") {
      cacheConfiguration = true;
      continue;
    }
    if (argument === "--no-cache-config") {
      cacheConfiguration = false;
      continue;
    }

    const inlineValue = /^--(sleep|delay|log-no-change)=(.*)$/.exec(argument);
    const optionName =
      inlineValue?.[1] === undefined ? argument : `--${inlineValue[1]}`;
    let optionValue = inlineValue?.[2];
    if (
      optionName === "-s" ||
      optionName === "--sleep" ||
      optionName === "-d" ||
      optionName === "--delay" ||
      optionName === "--log-no-change"
    ) {
      if (optionValue === undefined) {
        index += 1;
        optionValue = arguments_[index];
      }
      if (optionValue === undefined || !/^-?\d+$/.test(optionValue)) {
        throw new DlogError(
          `Option ${optionName} requires an integer number of seconds`,
        );
      }
      const seconds = Number.parseInt(optionValue, 10);
      if (optionName === "-s" || optionName === "--sleep") {
        pollIntervalSeconds = Math.min(3600, Math.max(1, seconds));
      } else if (optionName === "-d" || optionName === "--delay") {
        writeDelaySeconds = Math.min(3600, Math.max(0, seconds));
      } else {
        noChangeLogIntervalSeconds = seconds;
      }
      continue;
    }

    throw new DlogError(`Unknown fixup option: ${argument}`);
  }

  return {
    watch,
    pollIntervalSeconds,
    writeDelaySeconds,
    noChangeLogIntervalSeconds,
    cacheConfiguration,
  };
}
