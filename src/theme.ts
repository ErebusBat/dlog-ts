import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { Ansis, type AnsiColors } from "ansis";
import { z } from "zod";
import {
  type ConfigurationEnvironment,
  type ConfigurationLoader,
  type LoadedConfiguration,
} from "./configuration.js";
import { DlogError } from "./dlog-error.js";

export const THEME_SCHEMA = "dlog-theme/v1";
export const DEFAULT_THEME_FILENAME = "theme.toml";
export const SGR_RESET = "\x1b[0m";

export const THEME_ROLES = [
  "date",
  "heading",
  "list_marker",
  "timestamp",
  "entry_separator",
  "message",
  "strong",
  "emphasis",
  "wiki_link",
  "external_link",
] as const;

export type ThemeRole = (typeof THEME_ROLES)[number];
export type ColorLevel = 0 | 1 | 2 | 3;
export type ColorMode = "auto" | "always" | "never";

const ANSI_COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright_black",
  "bright_red",
  "bright_green",
  "bright_yellow",
  "bright_blue",
  "bright_magenta",
  "bright_cyan",
  "bright_white",
] as const;

type AnsiColorName = (typeof ANSI_COLOR_NAMES)[number];
export type ThemeColor = "default" | AnsiColorName | `#${string}`;

export interface ThemeStyle {
  readonly inherit: boolean;
  readonly fg: ThemeColor;
  readonly bg: ThemeColor;
  readonly reset: boolean;
  readonly inverse: boolean;
  readonly hidden: boolean;
  readonly visible: boolean;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
}

export type Theme = Readonly<Record<ThemeRole, ThemeStyle>>;

export type ThemeSource =
  | { readonly kind: "built-in" }
  | { readonly kind: "file"; readonly path: string };

export interface LoadedTheme {
  readonly source: ThemeSource;
  readonly theme: Theme;
}

export interface ThemeProvider {
  loadForConfiguration(
    configuration: LoadedConfiguration,
  ): Promise<LoadedTheme>;
  loadStandalone(): Promise<LoadedTheme>;
}

const colorSchema = z.union([
  z.literal("default"),
  z.enum(ANSI_COLOR_NAMES),
  z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Expected #RRGGBB")
    .transform((value): `#${string}` => `#${value.slice(1).toUpperCase()}`),
]);

const roleStyleSchema = z
  .strictObject({
    inherit: z.boolean().default(true),
    fg: colorSchema.optional(),
    bg: colorSchema.optional(),
    reset: z.boolean().optional(),
    inverse: z.boolean().optional(),
    hidden: z.boolean().optional(),
    visible: z.boolean().optional(),
    bold: z.boolean().optional(),
    dim: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
  })
  .superRefine((style, context) => {
    if (style.hidden === true && style.visible === true) {
      context.addIssue({
        code: "custom",
        message: "hidden and visible cannot both be true",
      });
    }
  });
const roleSchemas = {
  date: roleStyleSchema.optional(),
  heading: roleStyleSchema.optional(),
  list_marker: roleStyleSchema.optional(),
  timestamp: roleStyleSchema.optional(),
  entry_separator: roleStyleSchema.optional(),
  message: roleStyleSchema.optional(),
  strong: roleStyleSchema.optional(),
  emphasis: roleStyleSchema.optional(),
  wiki_link: roleStyleSchema.optional(),
  external_link: roleStyleSchema.optional(),
};

const themeFileSchema = z.strictObject({
  schema: z.literal(THEME_SCHEMA),
  roles: z.strictObject(roleSchemas).default({}),
});

type ParsedRoleStyle = z.output<typeof roleStyleSchema>;
type ParsedThemeFile = z.output<typeof themeFileSchema>;

const EMPTY_STYLE: ThemeStyle = {
  inherit: false,
  fg: "default",
  bg: "default",
  reset: false,
  inverse: false,
  hidden: false,
  visible: false,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strikethrough: false,
};

export const BUILT_IN_THEME: Theme = {
  date: { ...EMPTY_STYLE, fg: "bright_black" },
  heading: { ...EMPTY_STYLE, fg: "cyan", bold: true },
  list_marker: { ...EMPTY_STYLE, fg: "magenta" },
  timestamp: { ...EMPTY_STYLE, fg: "yellow", italic: true },
  entry_separator: { ...EMPTY_STYLE, fg: "bright_black" },
  message: EMPTY_STYLE,
  strong: { ...EMPTY_STYLE, bold: true },
  emphasis: { ...EMPTY_STYLE, italic: true },
  wiki_link: { ...EMPTY_STYLE, fg: "blue", underline: true },
  external_link: { ...EMPTY_STYLE, fg: "cyan", underline: true },
};

export class ThemeLoader implements ThemeProvider {
  readonly #configurationLoader: ConfigurationLoader;
  readonly #environment: ConfigurationEnvironment;

  public constructor(options: {
    readonly configurationLoader: ConfigurationLoader;
    readonly environment: ConfigurationEnvironment;
  }) {
    this.#configurationLoader = options.configurationLoader;
    this.#environment = options.environment;
  }

  public async loadForConfiguration(
    configuration: LoadedConfiguration,
  ): Promise<LoadedTheme> {
    const environmentPath = this.#configuredEnvironmentPath();
    if (environmentPath !== undefined) {
      return this.#loadRequiredFile(environmentPath);
    }
    if (configuration.themePath !== undefined) {
      return this.#loadRequiredFile(configuration.themePath);
    }
    return this.#loadSiblingOrDefault(configuration.sourcePath);
  }

  public async loadStandalone(): Promise<LoadedTheme> {
    const environmentPath = this.#configuredEnvironmentPath();
    if (environmentPath !== undefined) {
      return this.#loadRequiredFile(environmentPath);
    }
    const configurationPath =
      await this.#configurationLoader.discoverOptional();
    if (configurationPath === undefined) {
      return { source: { kind: "built-in" }, theme: BUILT_IN_THEME };
    }
    const configuration =
      await this.#configurationLoader.load(configurationPath);
    if (configuration.themePath !== undefined) {
      return this.#loadRequiredFile(configuration.themePath);
    }
    return this.#loadSiblingOrDefault(configuration.sourcePath);
  }

  #configuredEnvironmentPath(): string | undefined {
    const configured = this.#environment.variables["DLOG_THEME"]?.trim();
    if (configured === undefined || configured.length === 0) {
      return undefined;
    }
    const expanded = expandThemePath(configured, this.#environment);
    return isAbsolute(expanded)
      ? expanded
      : resolve(this.#environment.cwd, expanded);
  }

  async #loadSiblingOrDefault(configPath: string): Promise<LoadedTheme> {
    const path = resolve(dirname(configPath), DEFAULT_THEME_FILENAME);
    if (!(await isReadableFile(path))) {
      return { source: { kind: "built-in" }, theme: BUILT_IN_THEME };
    }
    return this.#loadRequiredFile(path);
  }

  async #loadRequiredFile(path: string): Promise<LoadedTheme> {
    if (!(await isReadableFile(path))) {
      throw new DlogError(
        `Theme file does not exist or is not readable: ${path}`,
      );
    }
    const parsed = await parseThemeFile(path);
    return { source: { kind: "file", path }, theme: resolveTheme(parsed) };
  }
}

type AnsiFormatter = InstanceType<typeof Ansis>;

export class ThemeStyler {
  readonly #theme: Theme;
  readonly #ansi: AnsiFormatter;

  public constructor(theme: Theme, level: ColorLevel) {
    this.#theme = theme;
    this.#ansi = createAnsiInstance(level);
  }

  public apply(role: ThemeRole, text: string, baseRole?: ThemeRole): string {
    if (text.length === 0 || this.#ansi.level === 0) {
      return text;
    }
    const style =
      baseRole === undefined
        ? this.#theme[role]
        : composeStyles(this.#theme[baseRole], this.#theme[role]);
    return applyStyle(this.#ansi, style, text);
  }

  public finish(text: string): string {
    return this.#ansi.level === 0 ? text : `${text}${SGR_RESET}`;
  }
}

export function resolveColorLevel(
  color: ColorMode,
  outputIsTerminal: boolean,
  environment: Readonly<NodeJS.ProcessEnv>,
): ColorLevel {
  if (color === "always") {
    return 3;
  }
  if (color === "never") {
    return 0;
  }

  const forced = parseForceColor(environment["FORCE_COLOR"]);
  if (forced !== undefined) {
    return forced;
  }
  const noColor = environment["NO_COLOR"];
  if (
    !outputIsTerminal ||
    (noColor !== undefined && noColor.trim().length > 0)
  ) {
    return 0;
  }

  const detectionEnvironment = { ...environment };
  delete detectionEnvironment["FORCE_COLOR"];
  delete detectionEnvironment["NO_COLOR"];
  const detected = new Ansis({
    process: {
      argv: [],
      env: detectionEnvironment,
      platform: process.platform,
      stdout: { isTTY: true },
    },
  }).level;
  return isColorLevel(detected) ? detected : 1;
}

export function dumpTheme(theme: Theme): string {
  const lines = [`schema = "${THEME_SCHEMA}"`];
  for (const role of THEME_ROLES) {
    const style = theme[role];
    lines.push(
      "",
      `[roles.${role}]`,
      "inherit = false",
      `fg = ${tomlString(style.fg)}`,
      `bg = ${tomlString(style.bg)}`,
      `reset = ${String(style.reset)}`,
      `inverse = ${String(style.inverse)}`,
      `hidden = ${String(style.hidden)}`,
      `visible = ${String(style.visible)}`,
      `bold = ${String(style.bold)}`,
      `dim = ${String(style.dim)}`,
      `italic = ${String(style.italic)}`,
      `underline = ${String(style.underline)}`,
      `strikethrough = ${String(style.strikethrough)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function themeSourceLabel(source: ThemeSource): string {
  return source.kind === "built-in" ? "built-in default" : source.path;
}

async function parseThemeFile(path: string): Promise<ParsedThemeFile> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new DlogError(`Cannot read theme file: ${path}`, error);
  }
  if (source.length === 0) {
    throw new DlogError(`Theme file is empty: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    throw new DlogError(`Invalid TOML in theme file ${path}`, error);
  }
  const validated = themeFileSchema.safeParse(parsed);
  if (!validated.success) {
    throw new DlogError(
      `Invalid theme in ${path}: ${z.prettifyError(validated.error)}`,
    );
  }
  return validated.data;
}
function resolveTheme(parsed: ParsedThemeFile): Theme {
  return {
    date: resolveRoleStyle(BUILT_IN_THEME.date, parsed.roles.date),
    heading: resolveRoleStyle(BUILT_IN_THEME.heading, parsed.roles.heading),
    list_marker: resolveRoleStyle(
      BUILT_IN_THEME.list_marker,
      parsed.roles.list_marker,
    ),
    timestamp: resolveRoleStyle(
      BUILT_IN_THEME.timestamp,
      parsed.roles.timestamp,
    ),
    entry_separator: resolveRoleStyle(
      BUILT_IN_THEME.entry_separator,
      parsed.roles.entry_separator,
    ),
    message: resolveRoleStyle(BUILT_IN_THEME.message, parsed.roles.message),
    strong: resolveRoleStyle(BUILT_IN_THEME.strong, parsed.roles.strong),
    emphasis: resolveRoleStyle(BUILT_IN_THEME.emphasis, parsed.roles.emphasis),
    wiki_link: resolveRoleStyle(
      BUILT_IN_THEME.wiki_link,
      parsed.roles.wiki_link,
    ),
    external_link: resolveRoleStyle(
      BUILT_IN_THEME.external_link,
      parsed.roles.external_link,
    ),
  };
}

function resolveRoleStyle(
  builtIn: ThemeStyle,
  parsed: ParsedRoleStyle | undefined,
): ThemeStyle {
  if (parsed === undefined) {
    return builtIn;
  }
  const base = parsed.inherit ? builtIn : EMPTY_STYLE;
  const resolved: ThemeStyle = {
    inherit: false,
    fg: parsed.fg ?? base.fg,
    bg: parsed.bg ?? base.bg,
    reset: parsed.reset ?? base.reset,
    inverse: parsed.inverse ?? base.inverse,
    hidden: parsed.visible === true ? false : (parsed.hidden ?? base.hidden),
    visible: parsed.hidden === true ? false : (parsed.visible ?? base.visible),
    bold: parsed.bold ?? base.bold,
    dim: parsed.dim ?? base.dim,
    italic: parsed.italic ?? base.italic,
    underline: parsed.underline ?? base.underline,
    strikethrough: parsed.strikethrough ?? base.strikethrough,
  };
  if (resolved.hidden && resolved.visible) {
    throw new DlogError(
      "A resolved theme role cannot be both hidden and visible",
    );
  }
  return resolved;
}
function composeStyles(base: ThemeStyle, overlay: ThemeStyle): ThemeStyle {
  if (overlay.reset) {
    return overlay;
  }
  return {
    inherit: false,
    fg: overlay.fg === "default" ? base.fg : overlay.fg,
    bg: overlay.bg === "default" ? base.bg : overlay.bg,
    reset: false,
    inverse: base.inverse || overlay.inverse,
    hidden: overlay.visible ? false : overlay.hidden || base.hidden,
    visible: overlay.hidden ? false : overlay.visible || base.visible,
    bold: base.bold || overlay.bold,
    dim: base.dim || overlay.dim,
    italic: base.italic || overlay.italic,
    underline: base.underline || overlay.underline,
    strikethrough: base.strikethrough || overlay.strikethrough,
  };
}

function applyStyle(
  instance: AnsiFormatter,
  style: ThemeStyle,
  text: string,
): string {
  let formatter = instance;
  if (style.reset) formatter = formatter.reset;
  formatter = applyColor(formatter, style.fg, false);
  formatter = applyColor(formatter, style.bg, true);
  if (style.inverse) formatter = formatter.inverse;
  if (style.hidden && !style.visible) formatter = formatter.hidden;
  if (style.bold) formatter = formatter.bold;
  if (style.dim) formatter = formatter.dim;
  if (style.italic) formatter = formatter.italic;
  if (style.underline) formatter = formatter.underline;
  if (style.strikethrough) formatter = formatter.strikethrough;
  return formatter.visible(text);
}

function applyColor(
  formatter: AnsiFormatter,
  color: ThemeColor,
  background: boolean,
): AnsiFormatter {
  if (color === "default") {
    return formatter;
  }
  if (isHexColor(color)) {
    return background ? formatter.bgHex(color) : formatter.hex(color);
  }
  const ansisName = background
    ? ANSIS_BACKGROUND_COLORS[color]
    : ANSIS_FOREGROUND_COLORS[color];
  return formatter[ansisName];
}

function isHexColor(color: ThemeColor): color is `#${string}` {
  return color.startsWith("#");
}

const ANSIS_FOREGROUND_COLORS: Readonly<Record<AnsiColorName, AnsiColors>> = {
  black: "black",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  magenta: "magenta",
  cyan: "cyan",
  white: "white",
  bright_black: "gray",
  bright_red: "redBright",
  bright_green: "greenBright",
  bright_yellow: "yellowBright",
  bright_blue: "blueBright",
  bright_magenta: "magentaBright",
  bright_cyan: "cyanBright",
  bright_white: "whiteBright",
};

const ANSIS_BACKGROUND_COLORS: Readonly<Record<AnsiColorName, AnsiColors>> = {
  black: "bgBlack",
  red: "bgRed",
  green: "bgGreen",
  yellow: "bgYellow",
  blue: "bgBlue",
  magenta: "bgMagenta",
  cyan: "bgCyan",
  white: "bgWhite",
  bright_black: "bgGray",
  bright_red: "bgRedBright",
  bright_green: "bgGreenBright",
  bright_yellow: "bgYellowBright",
  bright_blue: "bgBlueBright",
  bright_magenta: "bgMagentaBright",
  bright_cyan: "bgCyanBright",
  bright_white: "bgWhiteBright",
};

function createAnsiInstance(level: ColorLevel): AnsiFormatter {
  return new Ansis(level);
}

function parseForceColor(value: string | undefined): ColorLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false") return 0;
  if (normalized === "2") return 2;
  if (normalized === "3") return 3;
  return 1;
}

function isColorLevel(value: number): value is ColorLevel {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function expandThemePath(
  value: string,
  environment: ConfigurationEnvironment,
): string {
  const expandedVariables = value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, bracedName: string | undefined, bareName: string | undefined) => {
      const name = bracedName ?? bareName;
      if (name === undefined) {
        throw new DlogError(
          `Cannot parse environment variable in path: ${value}`,
        );
      }
      const replacement = environment.variables[name];
      if (replacement === undefined) {
        throw new DlogError(
          `Environment variable ${name} is not set for path: ${value}`,
        );
      }
      return replacement;
    },
  );
  if (expandedVariables === "~") {
    return environment.homeDirectory;
  }
  if (expandedVariables.startsWith("~/")) {
    return resolve(environment.homeDirectory, expandedVariables.slice(2));
  }
  return expandedVariables;
}
