import { createInterface } from "node:readline";

import {
  ConfigurationLoader,
  dailyDocumentPath,
  entryPrefix,
  type LoadedConfiguration,
} from "./configuration.js";
import { DailyDocumentWriter } from "./daily-document.js";
import { EntryProcessor } from "./entry-processor.js";
import { ExternalToolRunner, PluginExecutor } from "./external-tools.js";

export interface CommandIO {
  writeOutput(value: string): void;
  writeError(value: string): void;
  readLine(): Promise<string>;
}

export interface AppendCommandDependencies {
  readonly configurationLoader: ConfigurationLoader;
  readonly documentWriter: DailyDocumentWriter;
  readonly io: CommandIO;
  readonly now: () => Date;
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
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
    await this.#dependencies.documentWriter.append(
      path,
      processed.renderedEntry,
    );
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
