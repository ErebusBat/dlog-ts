import type { CommandIO } from "./append-command.js";
import {
  dailyDocumentPath,
  type ConfigurationLoader,
} from "./configuration.js";
import type { DailyDocumentReader } from "./daily-document.js";
import { DlogError } from "./dlog-error.js";

export type TailColorMode = "auto" | "always" | "never";

export interface TailOptions {
  readonly color: TailColorMode;
}

export interface TailCommandDependencies {
  readonly configurationLoader: ConfigurationLoader;
  readonly documentReader: DailyDocumentReader;
  readonly io: CommandIO;
  readonly now: () => Date;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

const SGR_RESET = "\x1b[0m";
const LINK_PATTERN =
  /\[\[(?<page>[^\]|]+)\|(?<display>[^\]]+)\]\]|\[\[(?<bare>[^\]|]+)\]\]|\[(?<label>[^\]]+)\]\((?<url>[^)]*)\)/g;

export class TailCommand {
  readonly #dependencies: TailCommandDependencies;

  public constructor(dependencies: TailCommandDependencies) {
    this.#dependencies = dependencies;
  }

  public async run(options: TailOptions): Promise<number> {
    const configuration =
      await this.#dependencies.configurationLoader.load();
    const path = dailyDocumentPath(configuration, this.#dependencies.now());
    const lines = await this.#dependencies.documentReader.readLogSection(path);
    const styled = shouldStyle(
      options.color,
      this.#dependencies.io.isOutputTerminal(),
      this.#dependencies.environment,
    );
    this.#dependencies.io.writeOutput(renderLogSection(lines, styled));
    return 0;
  }
}

export function parseTailOptions(
  arguments_: readonly string[],
): TailOptions | "help" {
  let color: TailColorMode = "auto";

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      return "help";
    }

    const inlineValue = /^--color=(.*)$/.exec(argument);
    let optionValue = inlineValue?.[1];
    if (argument === "--color" || inlineValue !== null) {
      if (optionValue === undefined) {
        index += 1;
        optionValue = arguments_[index];
      }
      if (
        optionValue !== "auto" &&
        optionValue !== "always" &&
        optionValue !== "never"
      ) {
        throw new DlogError(
          "Option --color requires one of: auto, always, never",
        );
      }
      color = optionValue;
      continue;
    }

    throw new DlogError(`Unknown tail option: ${argument}`);
  }

  return { color };
}

export function shouldStyle(
  color: TailColorMode,
  outputIsTerminal: boolean,
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean {
  if (color === "always") {
    return true;
  }
  if (color === "never") {
    return false;
  }
  const noColor = environment["NO_COLOR"];
  return (
    outputIsTerminal && (noColor === undefined || noColor.trim().length === 0)
  );
}

export function renderLogSection(
  lines: readonly string[],
  styled: boolean,
): string {
  const heading = styled ? `\x1b[1;36mLog${SGR_RESET}` : "Log";
  return [heading, ...lines.map((line) => renderTailLine(line, styled))]
    .map((line) => `${line}\n`)
    .join("");
}

export function renderTailLine(line: string, styled: boolean): string {
  let output = "";
  let cursor = 0;
  for (const match of line.matchAll(LINK_PATTERN)) {
    const index = match.index;
    output += renderEmphasis(line.slice(cursor, index), styled);
    const display =
      match.groups?.["display"] ??
      match.groups?.["page"] ??
      match.groups?.["bare"] ??
      match.groups?.["label"] ??
      match[0];
    output += styled ? `\x1b[4;34m${display}${SGR_RESET}` : display;
    cursor = index + match[0].length;
  }
  output += renderEmphasis(line.slice(cursor), styled);
  return output;
}

function renderEmphasis(text: string, styled: boolean): string {
  const bold = text.replace(
    /\*\*([^*]+)\*\*/g,
    (_match, content: string) =>
      styled ? `\x1b[1m${content}${SGR_RESET}` : content,
  );
  return bold
    .replace(/\*([^*]+)\*/g, (_match, content: string) =>
      styled ? `\x1b[3m${content}${SGR_RESET}` : content,
    )
    .replace(/_([^_]+)_/g, (_match, content: string) =>
      styled ? `\x1b[3m${content}${SGR_RESET}` : content,
    );
}
