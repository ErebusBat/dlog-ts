import type { CommandIO } from "./command-io.js";
import { DlogError } from "./dlog-error.js";
import { renderDailyLog } from "./tail-command.js";
import {
  dumpTheme,
  resolveColorLevel,
  THEME_ROLES,
  ThemeStyler,
  themeSourceLabel,
  type ThemeProvider,
  type ThemeRole,
} from "./theme.js";
import type { TailColorMode } from "./tail-command.js";

export interface ThemeCommandOptions {
  readonly preview: boolean;
  readonly swatches: boolean;
  readonly check: boolean;
  readonly dump: boolean;
  readonly silent: boolean;
  readonly color: TailColorMode;
}

export interface ThemeCommandDependencies {
  readonly io: CommandIO;
  readonly themeLoader: Pick<ThemeProvider, "loadStandalone">;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

const PREVIEW_DATE = "2025-07-25-Fri";
const PREVIEW_LINES = [
  "- *09:42* - Plain **strong** *emphasis* `inline code` [[Daily Notes|wiki link]] [external link](https://example.com)",
] as const;

const SWATCH_SAMPLES: Readonly<Record<ThemeRole, string>> = {
  date: PREVIEW_DATE,
  heading: "Log",
  list_marker: "-",
  timestamp: "09:42",
  entry_separator: "-",
  message: "Plain message text",
  strong: "Strong text",
  emphasis: "Emphasized text",
  inline_code: "Inline code",
  wiki_link: "Wiki link",
  external_link: "External link",
};

export class ThemeCommand {
  readonly #dependencies: ThemeCommandDependencies;

  public constructor(dependencies: ThemeCommandDependencies) {
    this.#dependencies = dependencies;
  }

  public async run(options: ThemeCommandOptions): Promise<number> {
    if (
      !options.preview &&
      !options.swatches &&
      !options.check &&
      !options.dump
    ) {
      return 0;
    }

    const loaded = await this.#dependencies.themeLoader.loadStandalone();
    if (!options.silent) {
      this.#dependencies.io.writeError(
        `Theme: ${themeSourceLabel(loaded.source)}\n`,
      );
    }

    const level = resolveColorLevel(
      options.color,
      this.#dependencies.io.isOutputTerminal(),
      this.#dependencies.environment,
    );
    const styler = new ThemeStyler(loaded.theme, level);
    const sections: string[] = [];
    if (options.preview) {
      sections.push(renderDailyLog(PREVIEW_DATE, PREVIEW_LINES, styler));
    }
    if (options.swatches) {
      sections.push(renderSwatches(styler));
    }
    if (options.dump) {
      sections.push(dumpTheme(loaded.theme));
    }
    if (sections.length > 0) {
      this.#dependencies.io.writeOutput(joinSections(sections));
    }
    return 0;
  }
}

export function parseThemeOptions(
  arguments_: readonly string[],
): ThemeCommandOptions | "help" {
  const hasPositiveAction = arguments_.some((argument) =>
    /^--(?:preview|swatches|check|dump)$/.test(argument),
  );
  let preview = !hasPositiveAction;
  let swatches = false;
  let check = false;
  let dump = false;
  let silent = false;
  let color: TailColorMode = "auto";

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      return "help";
    }

    const booleanOption = /^--(no-)?(preview|swatches|check|dump|silent)$/.exec(
      argument,
    );
    if (booleanOption !== null) {
      const enabled = booleanOption[1] === undefined;
      switch (booleanOption[2]) {
        case "preview":
          preview = enabled;
          break;
        case "swatches":
          swatches = enabled;
          break;
        case "check":
          check = enabled;
          break;
        case "dump":
          dump = enabled;
          break;
        case "silent":
          silent = enabled;
          break;
      }
      continue;
    }

    const inlineColor = /^--color=(.*)$/.exec(argument);
    let colorValue = inlineColor?.[1];
    if (argument === "--color" || inlineColor !== null) {
      if (colorValue === undefined) {
        index += 1;
        colorValue = arguments_[index];
      }
      if (
        colorValue !== "auto" &&
        colorValue !== "always" &&
        colorValue !== "never"
      ) {
        throw new DlogError(
          "Option --color requires one of: auto, always, never",
        );
      }
      color = colorValue;
      continue;
    }

    throw new DlogError(`Unknown theme option: ${argument}`);
  }

  return { preview, swatches, check, dump, silent, color };
}

function renderSwatches(styler: ThemeStyler): string {
  const width = Math.max(...THEME_ROLES.map((role) => role.length));
  const lines = THEME_ROLES.map((role) => {
    const label = role.padEnd(width);
    return `${label}  ${styler.apply(role, SWATCH_SAMPLES[role])}`;
  });
  return `${styler.finish(lines.join("\n"))}\n`;
}

function joinSections(sections: readonly string[]): string {
  return `${sections.map((section) => section.replace(/\n$/, "")).join("\n\n")}\n`;
}
