import type { CommandIO } from "./append-command.js";
import {
  dailyDocumentPath,
  type ConfigurationLoader,
  type LoadedConfiguration,
} from "./configuration.js";
import type { DailyDocumentReader } from "./daily-document.js";
import { DlogError } from "./dlog-error.js";
import type { FileHasher, WatchClock } from "./fixup-watcher.js";
import {
  resolveColorLevel,
  SGR_RESET,
  ThemeStyler,
  type ThemeProvider,
  type ColorMode,
} from "./theme.js";

export type TailColorMode = ColorMode;

const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const WATCH_POLL_INTERVAL_SECONDS = 1;

interface TailRenderState {
  readonly configuration: LoadedConfiguration;
  readonly truncate: boolean;
  readonly fixedWidth?: number;
  readonly styler?: ThemeStyler;
}

export interface TailOptions {
  readonly color: TailColorMode;
  readonly follow: boolean;
  readonly previousWeekday: boolean;
  readonly date?: string;
  readonly truncate?: boolean;
  readonly width?: number;
}

export interface TailCommandDependencies {
  readonly configurationLoader: ConfigurationLoader;
  readonly documentReader: DailyDocumentReader;
  readonly io: CommandIO;
  readonly clock: Pick<WatchClock, "now" | "sleep">;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly themeLoader: Pick<ThemeProvider, "loadForConfiguration">;
  readonly hasher: FileHasher;
  readonly keepWatching: () => boolean;
}

const LINK_PATTERN =
  /\[\[(?<page>[^\]|]+)\|(?<display>[^\]]+)\]\]|\[\[(?<bare>[^\]|]+)\]\]|\[(?<label>[^\]]+)\]\((?<url>[^)]*)\)/g;

export class TailCommand {
  readonly #dependencies: TailCommandDependencies;

  public constructor(dependencies: TailCommandDependencies) {
    this.#dependencies = dependencies;
  }

  public async run(options: TailOptions): Promise<number> {
    const measureWidth = (fixedWidth: number | undefined): number | undefined =>
      fixedWidth ??
      this.#dependencies.io.outputColumns() ??
      environmentColumns(this.#dependencies.environment);
    const loadRenderState = async (): Promise<TailRenderState> => {
      const configuration = await this.#dependencies.configurationLoader.load();
      const truncate = options.truncate ?? configuration.tail.truncate;
      const fixedWidth = options.width ?? configuration.tail.width;
      if (options.truncate === true && measureWidth(fixedWidth) === undefined) {
        throw new DlogError(
          "Option --truncate requires a measurable width; pass --width COLUMNS",
        );
      }
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
      return {
        configuration,
        truncate,
        ...(fixedWidth === undefined ? {} : { fixedWidth }),
        ...(styler === undefined ? {} : { styler }),
      };
    };
    let renderState = await loadRenderState();
    const truncateWidth = (state: TailRenderState): number | undefined =>
      state.truncate ? measureWidth(state.fixedWidth) : undefined;
    const initialDay = selectTailDate(options, this.#dependencies.clock.now());
    const initialPath = dailyDocumentPath(
      renderState.configuration,
      initialDay,
    );
    const initialLines =
      await this.#dependencies.documentReader.readLogSection(initialPath);
    this.#dependencies.io.writeOutput(
      `${options.follow ? CLEAR_SCREEN : ""}${renderDailyLog(
        formatTailDate(initialDay),
        initialLines,
        renderState.styler,
        truncateWidth(renderState),
      )}`,
    );
    if (!options.follow) {
      return 0;
    }

    let displayedDay = initialDay;
    let displayedPath = initialPath;
    let displayedHash = await this.#hashIfPresent(displayedPath);
    const followsCurrentDay =
      options.date === undefined && !options.previousWeekday;
    let reloadRequested = false;
    const disposeKeypresses = this.#dependencies.io.subscribeToKeypresses(
      (keypress) => {
        if (keypress === "r") {
          reloadRequested = true;
        }
      },
    );

    try {
      while (this.#dependencies.keepWatching()) {
        await this.#dependencies.clock.sleep(WATCH_POLL_INTERVAL_SECONDS);
        const shouldReload = reloadRequested;
        reloadRequested = false;
        if (shouldReload) {
          renderState = await loadRenderState();
        }
        const candidateDay = followsCurrentDay
          ? this.#dependencies.clock.now()
          : displayedDay;
        const candidatePath = dailyDocumentPath(
          renderState.configuration,
          candidateDay,
        );
        const candidateHash = await this.#hashIfPresent(candidatePath);
        if (
          candidateHash === undefined ||
          (!shouldReload &&
            candidatePath === displayedPath &&
            candidateHash === displayedHash &&
            formatTailDate(candidateDay) === formatTailDate(displayedDay))
        ) {
          continue;
        }

        let candidateLines: readonly string[];
        try {
          candidateLines =
            await this.#dependencies.documentReader.readLogSection(
              candidatePath,
            );
        } catch (error) {
          if (isMissingFileError(error)) {
            continue;
          }
          throw error;
        }

        this.#dependencies.io.writeOutput(
          `${CLEAR_SCREEN}${renderDailyLog(
            formatTailDate(candidateDay),
            candidateLines,
            renderState.styler,
            truncateWidth(renderState),
          )}`,
        );
        displayedDay = candidateDay;
        displayedPath = candidatePath;
        displayedHash = candidateHash;
      }
    } finally {
      disposeKeypresses();
    }

    return 0;
  }

  async #hashIfPresent(path: string): Promise<string | undefined> {
    try {
      return await this.#dependencies.hasher.hash(path);
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }
}

export function parseTailOptions(
  arguments_: readonly string[],
): TailOptions | "help" {
  let follow = false;
  let color: TailColorMode = "auto";
  let previousWeekday = false;
  let truncate: boolean | undefined;
  let width: number | undefined;
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
      if (argument === "-f" || argument === "--follow") {
        follow = true;
        continue;
      }
      if (argument === "-t" || argument === "--truncate") {
        truncate = true;
        continue;
      }
      if (argument === "--no-truncate") {
        truncate = false;
        continue;
      }

      const inlineWidth = /^--width=(.*)$/.exec(argument);
      if (argument === "--width" || inlineWidth !== null) {
        let widthValue = inlineWidth?.[1];
        if (widthValue === undefined) {
          index += 1;
          widthValue = arguments_[index];
        }
        width = parseWidthOption(widthValue);
        truncate = true;
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

  return {
    color,
    follow,
    previousWeekday,
    ...(date === undefined ? {} : { date }),
    ...(truncate === undefined ? {} : { truncate }),
    ...(width === undefined ? {} : { width }),
  };
}

function parseWidthOption(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new DlogError("Option --width requires a positive integer");
  }
  const width = Number.parseInt(value, 10);
  if (width === 0) {
    throw new DlogError("Option --width requires a positive integer");
  }
  return width;
}

function environmentColumns(
  environment: Readonly<NodeJS.ProcessEnv>,
): number | undefined {
  const value = environment["COLUMNS"];
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }
  const columns = Number.parseInt(value, 10);
  return columns > 0 ? columns : undefined;
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

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if ("code" in error && error.code === "ENOENT") {
    return true;
  }
  return isMissingFileError(error.cause);
}

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
  truncateWidth?: number,
): string {
  const rendered = [
    styler?.apply("date", date) ?? date,
    styler?.apply("heading", "Log") ?? "Log",
    ...lines.map((line) => renderTailLine(line, styler)),
  ]
    .map((line) =>
      truncateWidth === undefined
        ? line
        : truncateDisplayLine(line, truncateWidth),
    )
    .join("\n");
  return `${styler?.finish(rendered) ?? rendered}\n`;
}

export function renderLogSection(
  lines: readonly string[],
  styler?: ThemeStyler,
  truncateWidth?: number,
): string {
  const rendered = [
    styler?.apply("heading", "Log") ?? "Log",
    ...lines.map((line) => renderTailLine(line, styler)),
  ]
    .map((line) =>
      truncateWidth === undefined
        ? line
        : truncateDisplayLine(line, truncateWidth),
    )
    .join("\n");
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
const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ELLIPSIS = "…";
const TAB_STOP = 8;
const COMBINING_MARK_PATTERN = /[\p{Mn}\p{Me}\p{Cf}]/u;
const graphemeSegmenter = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

interface DisplayToken {
  readonly text: string;
  readonly isEscape: boolean;
}

function* displayTokens(text: string): Generator<DisplayToken> {
  let cursor = 0;
  for (const match of text.matchAll(ANSI_CSI_PATTERN)) {
    if (match.index > cursor) {
      yield { text: text.slice(cursor, match.index), isEscape: false };
    }
    yield { text: match[0], isEscape: true };
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    yield { text: text.slice(cursor), isEscape: false };
  }
}

// East Asian Wide/Fullwidth and emoji presentation ranges.
const WIDE_CODEPOINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x2ffb],
  [0x3000, 0x303e],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x318e],
  [0x3190, 0x31e3],
  [0x31f0, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0x4dbf],
  [0x4e00, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x187f7],
  [0x18800, 0x18cd5],
  [0x18d00, 0x18d08],
  [0x1aff0, 0x1afff],
  [0x1b000, 0x1b122],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb],
  [0x1f1e6, 0x1f1ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa74],
  [0x1fa78, 0x1fa7c],
  [0x1fa80, 0x1fa86],
  [0x1fa90, 0x1faac],
  [0x1fab0, 0x1faba],
  [0x1fabd, 0x1fabf],
  [0x1face, 0x1fadb],
  [0x1fae0, 0x1fae8],
  [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isWideCodepoint(codePoint: number): boolean {
  let low = 0;
  let high = WIDE_CODEPOINT_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = WIDE_CODEPOINT_RANGES[middle]!;
    if (codePoint < range[0]) {
      high = middle - 1;
    } else if (codePoint > range[1]) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function graphemeWidth(cluster: string, column: number): number {
  if (cluster === "\t") {
    return TAB_STOP - (column % TAB_STOP);
  }
  let width = 0;
  for (const character of cluster) {
    const codePoint = character.codePointAt(0)!;
    let unit = 1;
    if (
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint < 0xa0) ||
      COMBINING_MARK_PATTERN.test(character)
    ) {
      unit = 0;
    } else if (isWideCodepoint(codePoint)) {
      unit = 2;
    }
    width = Math.max(width, unit);
  }
  return width;
}

export function displayWidth(text: string): number {
  let column = 0;
  for (const token of displayTokens(text)) {
    if (token.isEscape) {
      continue;
    }
    for (const { segment } of graphemeSegmenter.segment(token.text)) {
      column += graphemeWidth(segment, column);
    }
  }
  return column;
}

export function truncateDisplayLine(line: string, width: number): string {
  if (displayWidth(line) <= width) {
    return line;
  }
  const budget = Math.max(width - 1, 0);
  let result = "";
  let column = 0;
  let hasEscape = false;
  let truncated = false;
  for (const token of displayTokens(line)) {
    if (token.isEscape) {
      result += token.text;
      hasEscape = true;
      continue;
    }
    for (const { segment } of graphemeSegmenter.segment(token.text)) {
      const segmentWidth = graphemeWidth(segment, column);
      if (column + segmentWidth > budget) {
        truncated = true;
        break;
      }
      result += segment;
      column += segmentWidth;
    }
    if (truncated) {
      break;
    }
  }
  return `${result}${hasEscape ? SGR_RESET : ""}${ELLIPSIS}`;
}
