import type { CommandIO } from "./append-command.js";
import {
  dailyDocumentPath,
  type ConfigurationLoader,
} from "./configuration.js";
import type { DailyDocumentReader } from "./daily-document.js";
import { DlogError } from "./dlog-error.js";
import {
  resolveColorLevel,
  ThemeStyler,
  type ThemeProvider,
  type ColorMode,
} from "./theme.js";

export type TailColorMode = ColorMode;

export interface TailOptions {
  readonly color: TailColorMode;
  readonly previousWeekday: boolean;
  readonly date?: string;
}

export interface TailCommandDependencies {
  readonly configurationLoader: ConfigurationLoader;
  readonly documentReader: DailyDocumentReader;
  readonly io: CommandIO;
  readonly now: () => Date;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly themeLoader: Pick<ThemeProvider, "loadForConfiguration">;
}

const LINK_PATTERN =
  /\[\[(?<page>[^\]|]+)\|(?<display>[^\]]+)\]\]|\[\[(?<bare>[^\]|]+)\]\]|\[(?<label>[^\]]+)\]\((?<url>[^)]*)\)/g;

export class TailCommand {
  readonly #dependencies: TailCommandDependencies;

  public constructor(dependencies: TailCommandDependencies) {
    this.#dependencies = dependencies;
  }

  public async run(options: TailOptions): Promise<number> {
    const configuration = await this.#dependencies.configurationLoader.load();
    const now = this.#dependencies.now();
    const day = selectTailDate(options, now);
    const path = dailyDocumentPath(configuration, day);
    const lines = await this.#dependencies.documentReader.readLogSection(path);
    const colorLevel = resolveColorLevel(
      options.color,
      this.#dependencies.io.isOutputTerminal(),
      this.#dependencies.environment,
    );
    const styler =
      colorLevel === 0
        ? undefined
        : new ThemeStyler(
            (
              await this.#dependencies.themeLoader.loadForConfiguration(
                configuration,
              )
            ).theme,
            colorLevel,
          );
    this.#dependencies.io.writeOutput(
      renderDailyLog(formatTailDate(day), lines, styler),
    );
    return 0;
  }
}

export function parseTailOptions(
  arguments_: readonly string[],
): TailOptions | "help" {
  let color: TailColorMode = "auto";
  let previousWeekday = false;
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
      if (argument === "-w") {
        previousWeekday = true;
        continue;
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

  if (previousWeekday && date !== undefined) {
    throw new DlogError("Option -w cannot be combined with a date argument");
  }

  const options = { color, previousWeekday };
  return date === undefined ? options : { ...options, date };
}

const WEEKDAY_ABBREVIATIONS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

function selectTailDate(options: TailOptions, now: Date): Date {
  if (options.previousWeekday) {
    const daysBack = now.getDay() === 1 ? 3 : now.getDay() === 0 ? 2 : 1;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - daysBack,
    );
  }
  return options.date === undefined ? now : resolveTailDate(options.date, now);
}

export function formatTailDate(day: Date): string {
  const year = day.getFullYear();
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}-${WEEKDAY_ABBREVIATIONS[day.getDay()]}`;
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
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - delta);
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
  return resolveColorLevel(color, outputIsTerminal, environment) > 0;
}

export function renderDailyLog(
  date: string,
  lines: readonly string[],
  styler?: ThemeStyler,
): string {
  const rendered = [
    styler?.apply("date", date) ?? date,
    styler?.apply("heading", "Log") ?? "Log",
    ...lines.map((line) => renderTailLine(line, styler)),
  ].join("\n");
  return `${styler?.finish(rendered) ?? rendered}\n`;
}

export function renderLogSection(
  lines: readonly string[],
  styler?: ThemeStyler,
): string {
  const rendered = [
    styler?.apply("heading", "Log") ?? "Log",
    ...lines.map((line) => renderTailLine(line, styler)),
  ].join("\n");
  return `${styler?.finish(rendered) ?? rendered}\n`;
}

export function renderTailLine(line: string, styler?: ThemeStyler): string {
  const listMarker = /^([-+*])(?=\s)/.exec(line);
  if (listMarker === null) {
    return renderInlineMarkup(line, styler);
  }

  const marker = listMarker[1]!;
  const remainder = line.slice(marker.length);
  const timedEntry =
    /^(\s+)\*((?:[01]\d|2[0-3]):[0-5]\d)\*(\s+)-(\s+)(.*)$/.exec(remainder);
  const renderedMarker = styler?.apply("list_marker", marker) ?? marker;
  if (timedEntry === null) {
    return `${renderedMarker}${renderInlineMarkup(remainder, styler)}`;
  }

  const [, beforeTime, timestamp, beforeSeparator, afterSeparator, message] =
    timedEntry;
  return [
    renderedMarker,
    beforeTime,
    styler?.apply("timestamp", timestamp!) ?? timestamp,
    beforeSeparator,
    styler?.apply("entry_separator", "-") ?? "-",
    afterSeparator,
    renderInlineMarkup(message!, styler),
  ].join("");
}

function renderInlineMarkup(text: string, styler?: ThemeStyler): string {
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const index = match.index;
    output += renderEmphasis(text.slice(cursor, index), styler);
    const display =
      match.groups?.["display"] ??
      match.groups?.["page"] ??
      match.groups?.["bare"] ??
      match.groups?.["label"] ??
      match[0];
    const role =
      match.groups?.["url"] === undefined ? "wiki_link" : "external_link";
    output += styler?.apply(role, display, "message") ?? display;
    cursor = index + match[0].length;
  }
  output += renderEmphasis(text.slice(cursor), styler);
  return output;
}

function renderEmphasis(text: string, styler?: ThemeStyler): string {
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    output += renderMessageText(text.slice(cursor, match.index), styler);
    const strong = match[1];
    const content = strong ?? match[2] ?? match[3] ?? match[0];
    output +=
      styler?.apply(
        strong === undefined ? "emphasis" : "strong",
        content,
        "message",
      ) ?? content;
    cursor = match.index + match[0].length;
  }
  output += renderMessageText(text.slice(cursor), styler);
  return output;
}

function renderMessageText(text: string, styler?: ThemeStyler): string {
  return styler?.apply("message", text) ?? text;
}
