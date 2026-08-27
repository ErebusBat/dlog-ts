import { Ansis } from "ansis";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

import { resolveColorLevel } from "./theme.js";
import {
  ConfigurationLoader,
  dailyDocumentPath,
  entryPrefix,
  type LoadedConfiguration,
} from "./configuration.js";
import { DailyDocumentWriter } from "./daily-document.js";
import { EntryProcessor } from "./entry-processor.js";
import { ExternalToolRunner, PluginExecutor } from "./external-tools.js";

const NO_WRITE_WARNING_TEXT =
  "Warning: --no-write is set; this entry was not written to the daily document.";

function colorizeNoWriteWarning(
  text: string,
  outputIsTerminal: boolean,
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const level = resolveColorLevel("auto", outputIsTerminal, environment);
  return level === 0 ? text : new Ansis(level).yellow(text);
}

export interface CommandIO {
  writeOutput(value: string): void;
  writeError(value: string): void;
  readLine(): Promise<string>;
  isOutputTerminal(): boolean;
  outputColumns(): number | undefined;
  subscribeToKeypresses(listener: (keypress: string) => void): () => void;
}

export interface AppendCommandDependencies {
  readonly configurationLoader: ConfigurationLoader;
  readonly documentWriter: DailyDocumentWriter;
  readonly io: CommandIO;
  readonly now: () => Date;
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly noWrite?: boolean;
}

export class AppendCommand {
  readonly #dependencies: AppendCommandDependencies;

  public constructor(dependencies: AppendCommandDependencies) {
    this.#dependencies = dependencies;
  }

  public async run(words: readonly string[]): Promise<number> {
    let input: string;
    if (words.length === 0) {
      this.#dependencies.io.writeOutput("Enter Log: ");
      input = (await this.#dependencies.io.readLine()).trim();
    } else {
      input = words.join(" ");
    }

    const configuration = await this.#dependencies.configurationLoader.load();
    if (input.trim().length === 0) {
      this.#dependencies.io.writeError("No input, exiting\n");
      return 1;
    }

    const processed = await this.#processor(configuration).process(input, {
      now: this.#dependencies.now(),
      entryPrefix: (entryText, timestamp) =>
        entryPrefix(configuration, entryText, timestamp),
    });
    if (processed.renderedEntry.trim().length === 0) {
      this.#dependencies.io.writeError("Entry was blank, exiting\n");
      return 2;
    }

    const path = dailyDocumentPath(configuration, processed.timestamp);
    if (this.#dependencies.noWrite !== true) {
      await this.#dependencies.documentWriter.append(
        path,
        processed.renderedEntry,
      );
    } else {
      this.#dependencies.io.writeError(
        `${colorizeNoWriteWarning(
          NO_WRITE_WARNING_TEXT,
          this.#dependencies.io.isOutputTerminal(),
          this.#dependencies.environment,
        )}\n`,
      );
    }
    this.#dependencies.io.writeOutput(`${processed.renderedEntry}\n`);
    return 0;
  }

  #processor(configuration: LoadedConfiguration): EntryProcessor {
    const tools = new ExternalToolRunner({
      cwd: this.#dependencies.cwd,
      environment: this.#dependencies.environment,
    });
    return new EntryProcessor(
      configuration.rules,
      new PluginExecutor(configuration.plugins, tools),
    );
  }
}

export class ProcessCommandIO implements CommandIO {
  public isOutputTerminal(): boolean {
    return process.stdout.isTTY === true;
  }
  public outputColumns(): number | undefined {
    return process.stdout.isTTY === true ? process.stdout.columns : undefined;
  }

  public subscribeToKeypresses(
    listener: (keypress: string) => void,
  ): () => void {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      return () => {};
    }

    const wasPaused = process.stdin.isPaused();
    const wasRaw = process.stdin.isRaw === true;
    const decoder = new StringDecoder("utf8");
    let disposed = false;
    let disposeSubscription: () => void = () => { };
    const onData = (chunk: Buffer | string): void => {
      for (const keypress of decoder.write(chunk)) {
        // u0003 is the control character for SIGINT (Ctrl+C). 
        // We need to handle it specially because if we don't, the process will terminate before we can clean up the terminal state.
        if (keypress === "\u0003") {
          // Restore terminal state before SIGINT can terminate the process.
          disposeSubscription();
          process.kill(process.pid, "SIGINT");
          return;
        }
        listener(keypress);
      }
    };

    process.stdin.on("data", onData);
    if (!wasRaw) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    disposeSubscription = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      process.stdin.off("data", onData);
      if (!wasRaw) {
        process.stdin.setRawMode(false);
      }
      if (wasPaused) {
        process.stdin.pause();
      }
    };
    return disposeSubscription;

  }

  public writeOutput(value: string): void {
    process.stdout.write(value);
  }

  public writeError(value: string): void {
    process.stderr.write(value);
  }

  public async readLine(): Promise<string> {
    const lines = createInterface({ input: process.stdin, terminal: false });
    for await (const line of lines) {
      lines.close();
      return line;
    }
    return "";
  }
}
