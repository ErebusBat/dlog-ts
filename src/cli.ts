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
import { DailyDocumentWriter } from "./daily-document.js";
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

const ROOT_HELP = `Usage:
  dlog append [--] [WORDS...]
  dlog fixup [OPTIONS]
  dlog-append [--] [WORDS...]
  dlog-fixup [OPTIONS]
`;

const APPEND_HELP = `Usage: dlog append [--] [WORDS...]

With no words, prompt for one line on standard input.
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

export interface CliDependencies {
  readonly io: CommandIO;
  readonly configurationLoader: ConfigurationLoader;
  readonly documentWriter: DailyDocumentWriter;
  readonly clock: WatchClock;
  readonly hasher: FileHasher;
  readonly logger: OperationalLogger;
  readonly watchdogScheduler: WatchdogScheduler;
  readonly fatalExit: (status: number) => void;
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
      return runAppend(arguments_, dependencies);
    }
    if (invokedName === "dlog-fixup") {
      return runFixup(arguments_, dependencies);
    }

    const command = arguments_[0];
    if (command === "--help" || command === "-h" || command === "help") {
      dependencies.io.writeOutput(ROOT_HELP);
      return 0;
    }
    if (command === "append") {
      return runAppend(arguments_.slice(1), dependencies);
    }
    if (command === "fixup") {
      return runFixup(arguments_.slice(1), dependencies);
    }

    dependencies.io.writeError(
      command === undefined
        ? `dlog: an explicit append or fixup subcommand is required\n${ROOT_HELP}`
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
  const clock = new SystemWatchClock();
  return {
    io: new ProcessCommandIO(),
    configurationLoader: new ConfigurationLoader({
      environment: configurationEnvironment,
    }),
    documentWriter: new DailyDocumentWriter(),
    clock,
    hasher: new Sha256FileHasher(),
    logger: new StandardErrorLogger(clock),
    watchdogScheduler: new SystemWatchdogScheduler(),
    fatalExit: (status) => {
      process.exit(status);
    },
    cwd: configurationEnvironment.cwd,
    environment: configurationEnvironment.variables,
  };
}

async function runAppend(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (arguments_[0] === "--help" || arguments_[0] === "-h") {
    dependencies.io.writeOutput(APPEND_HELP);
    return 0;
  }
  const words = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  return new AppendCommand({
    configurationLoader: dependencies.configurationLoader,
    documentWriter: dependencies.documentWriter,
    io: dependencies.io,
    now: () => dependencies.clock.now(),
    cwd: dependencies.cwd,
    environment: dependencies.environment,
  }).run(words);
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
    keepWatching: () => true,
  }).run();
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
