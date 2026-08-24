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
  readonly date?: string;
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
    const now = this.#dependencies.now();
    const day =
      options.date === undefined ? now : resolveTailDate(options.date, now);
    const path = dailyDocumentPath(configuration, day);
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
  let date: string | undefined;
  let optionsEnded = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }

    if (!optionsEnded && argument.startsWith("-") && !/^-\d+$/.test(argument)) {
      if (argument === "--") {
        optionsEnded = true;
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

    if (date !== undefined) {
      throw new DlogError(`Unexpected extra tail argument: ${argument}`);
    }
    date = argument;
  }

  return date === undefined ? { color } : { color, date };
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

export function resolveTailDate(input: string, now: Date): Date {
  const text = input.trim();

  const daysAgo = /^-(\d+)$/.exec(text);
  if (daysAgo !== null) {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - Number.parseInt(daysAgo[1]!, 10),
    );
  }

  const weekday = WEEKDAY_INDEX[text.toLowerCase()];
  if (weekday !== undefined) {
    const delta = (now.getDay() - weekday + 7) % 7;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - delta,
    );
  }

  if (/^\d{1,2}$/.test(text)) {
    return checkedLocalDate(
      now.getFullYear(),
      now.getMonth(),
      Number.parseInt(text, 10),
      input,
    );
  }

  const monthDay = /^(\d{2})(\d{2})$/.exec(text);
  if (monthDay !== null) {
    return checkedLocalDate(
      now.getFullYear(),
      Number.parseInt(monthDay[1]!, 10) - 1,
      Number.parseInt(monthDay[2]!, 10),
      input,
    );
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso !== null) {
    return checkedLocalDate(
      Number.parseInt(iso[1]!, 10),
      Number.parseInt(iso[2]!, 10) - 1,
      Number.parseInt(iso[3]!, 10),
      input,
    );
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slash !== null) {
    return checkedLocalDate(
      Number.parseInt(slash[3]!, 10),
      Number.parseInt(slash[1]!, 10) - 1,
      Number.parseInt(slash[2]!, 10),
      input,
    );
  }

  const named = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (named !== null) {
    const month = MONTH_INDEX[named[1]!.toLowerCase()];
    if (month !== undefined) {
      return checkedLocalDate(
        Number.parseInt(named[3]!, 10),
        month,
        Number.parseInt(named[2]!, 10),
        input,
      );
    }
  }

  throw new DlogError(`Cannot parse date: ${input}`);
}

function checkedLocalDate(
  year: number,
  monthIndex: number,
  day: number,
  input: string,
): Date {
  const date = new Date(year, monthIndex, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    throw new DlogError(`Invalid date: ${input}`);
  }
  return date;
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
