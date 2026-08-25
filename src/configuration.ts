import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import strftime from "strftime";
import { z } from "zod";

import { DlogError } from "./dlog-error.js";
import {
  PHONE_NUMBER_PATTERN,
  type GlobalMatcher,
  type ProcessingRule,
  type RuleReplacement,
} from "./entry-processor.js";
import type { ExternalPluginDefinition } from "./external-tools.js";

const PRIMARY_SCHEMA = "dlog-config/v1";
const RULES_SCHEMA = "dlog-rules/v1";
const DEFAULT_CONFIG_DISPLAY_PATH = "~/.config/dlog/config.toml";

const includeSchema = z.strictObject({
  path: z.string().min(1),
  enabled: z.boolean().default(true),
});

const pluginSchema = z.strictObject({
  name: z.string().min(1),
  protocol: z.enum(["json", "text"]),
  command: z.string().min(1),
  arguments: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const matchFields = {
  match: z.string().min(1).optional(),
  pattern: z.string().min(1).optional(),
  matcher: z.literal("phone").optional(),
  flags: z
    .string()
    .regex(/^[dimsuv]*$/)
    .default(""),
};

const prefixRuleSchema = z.strictObject({
  kind: z.literal("prefix"),
  match: z.string().min(1),
  replace: z.string(),
  enabled: z.boolean().default(true),
});

const globalRuleSchema = z
  .strictObject({
    kind: z.literal("global"),
    ...matchFields,
    replace: z.string(),
    enabled: z.boolean().default(true),
  })
  .superRefine(validateMatcherFields);

const linkRuleSchema = z
  .strictObject({
    kind: z.literal("link"),
    match: z.string().min(1),
    page: z
      .string()
      .refine((page) => page.trim().length > 0, "Page cannot be blank"),
    display: z.string().optional(),
    alias: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((rule, context) => {
    if (rule.display !== undefined && rule.alias !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A link rule cannot set both display and alias",
      });
    }
  });

const callbackRuleSchema = z
  .strictObject({
    kind: z.literal("callback"),
    scope: z.enum(["prefix", "global"]).default("global"),
    ...matchFields,
    plugin: z.string().min(1),
    enabled: z.boolean().default(true),
  })
  .superRefine((rule, context) => {
    validateMatcherFields(rule, context);
    if (rule.scope === "prefix" && rule.match === undefined) {
      context.addIssue({
        code: "custom",
        message: "A prefix callback requires a literal match",
      });
    }
  });

const ruleSchema = z.union([
  prefixRuleSchema,
  globalRuleSchema,
  linkRuleSchema,
  callbackRuleSchema,
]);

const primaryConfigSchema = z.strictObject({
  schema: z.literal(PRIMARY_SCHEMA),
  vault_roots: z.array(z.string().min(1)).min(1),
  daily_path: z.string().min(1),
  entry_prefix: z.string(),
  debug_output: z.string().min(1).optional(),
  theme: z.string().min(1).optional(),
  includes: z.array(includeSchema).default([]),
});

const ruleFileSchema = z.strictObject({
  schema: z.literal(RULES_SCHEMA),
  enabled: z.boolean().default(true),
  includes: z.array(includeSchema).default([]),
  plugins: z.array(pluginSchema).default([]),
  rules: z.array(ruleSchema).default([]),
});

type ParsedRule = z.infer<typeof ruleSchema>;
type ParsedPlugin = z.infer<typeof pluginSchema>;

export interface ConfigurationEnvironment {
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly variables: Readonly<NodeJS.ProcessEnv>;
}

export interface LoadedConfiguration {
  readonly sourcePath: string;
  readonly vaultRoot: string;
  readonly dailyPathTemplate: string;
  readonly entryPrefixTemplate: string;
  readonly debugOutputPath?: string;
  readonly themePath?: string;
  readonly rules: readonly ProcessingRule[];
  readonly plugins: readonly ExternalPluginDefinition[];
}

export interface ConfigurationLoaderOptions {
  readonly environment: ConfigurationEnvironment;
}

export class ConfigurationLoader {
  readonly #environment: ConfigurationEnvironment;

  public constructor(options: ConfigurationLoaderOptions) {
    this.#environment = options.environment;
  }

  public async discoverOptional(): Promise<string | undefined> {
    const configuredPath = this.#environment.variables["DLOG_CONFIG"]?.trim();
    const candidates = [
      ...(configuredPath === undefined || configuredPath.length === 0
        ? []
        : [configuredPath]),
      DEFAULT_CONFIG_DISPLAY_PATH,
      "./dlog.toml",
    ];

    for (const candidate of candidates) {
      const expanded = expandConfiguredPath(candidate, this.#environment);
      const absolute = isAbsolute(expanded)
        ? expanded
        : resolve(this.#environment.cwd, expanded);
      try {
        await access(absolute, fsConstants.R_OK);
        const metadata = await stat(absolute);
        if (metadata.isFile()) {
          return absolute;
        }
      } catch {
        // Try the next discovery candidate.
      }
    }
    return undefined;
  }

  public async discover(): Promise<string> {
    const discovered = await this.discoverOptional();
    if (discovered !== undefined) {
      return discovered;
    }
    throw new DlogError(
      `No readable dlog configuration found; expected ${DEFAULT_CONFIG_DISPLAY_PATH}`,
    );
  }

  public async load(path?: string): Promise<LoadedConfiguration> {
    const sourcePath = path ?? (await this.discover());
    const absoluteSource = isAbsolute(sourcePath)
      ? sourcePath
      : resolve(this.#environment.cwd, sourcePath);
    const primary = await parseTomlFile(absoluteSource, primaryConfigSchema);
    const primaryDirectory = dirname(absoluteSource);

    let vaultRoot: string | undefined;
    const attemptedRoots: string[] = [];
    for (const configuredRoot of primary.vault_roots) {
      const expanded = expandConfiguredPath(configuredRoot, this.#environment);
      const candidate = isAbsolute(expanded)
        ? expanded
        : resolve(primaryDirectory, expanded);
      attemptedRoots.push(candidate);
      try {
        if ((await stat(candidate)).isDirectory()) {
          vaultRoot = candidate;
          break;
        }
      } catch {
        // Keep trying configured roots.
      }
    }
    if (vaultRoot === undefined) {
      throw new DlogError(
        `No configured vault root is an existing directory: ${attemptedRoots.join(", ")}`,
      );
    }

    const collector = new RuleFileCollector(
      primaryDirectory,
      this.#environment,
    );
    for (const include of primary.includes) {
      if (include.enabled) {
        await collector.loadPath(include.path);
      }
    }
    const { rules, plugins } = collector.build();

    const dailyPathTemplate = expandConfiguredPath(
      primary.daily_path,
      this.#environment,
    );
    const debugOutputPath =
      primary.debug_output === undefined
        ? undefined
        : resolvePathField(
            expandConfiguredPath(primary.debug_output, this.#environment),
            primaryDirectory,
          );
    const themePath =
      primary.theme === undefined
        ? undefined
        : resolvePathField(
            expandConfiguredPath(primary.theme, this.#environment),
            primaryDirectory,
          );

    return {
      sourcePath: absoluteSource,
      vaultRoot,
      dailyPathTemplate,
      entryPrefixTemplate: primary.entry_prefix,
      ...(debugOutputPath === undefined ? {} : { debugOutputPath }),
      ...(themePath === undefined ? {} : { themePath }),
      rules,
      plugins,
    };
  }
}

export function defaultConfigurationEnvironment(): ConfigurationEnvironment {
  return {
    cwd: process.cwd(),
    homeDirectory: homedir(),
    variables: process.env,
  };
}

export function dailyDocumentPath(
  configuration: LoadedConfiguration,
  day: Date,
): string {
  const formatted = strftime(configuration.dailyPathTemplate, day);
  return isAbsolute(formatted)
    ? formatted
    : resolve(configuration.vaultRoot, formatted);
}

export function entryPrefix(
  configuration: LoadedConfiguration,
  _entryText: string,
  timestamp: Date,
): string {
  return strftime(configuration.entryPrefixTemplate, timestamp);
}

class RuleFileCollector {
  readonly #primaryDirectory: string;
  readonly #environment: ConfigurationEnvironment;
  readonly #activeFiles = new Set<string>();
  readonly #loadedFiles = new Set<string>();
  readonly #rules: ParsedRule[] = [];
  readonly #plugins: ParsedPlugin[] = [];

  public constructor(
    primaryDirectory: string,
    environment: ConfigurationEnvironment,
  ) {
    this.#primaryDirectory = primaryDirectory;
    this.#environment = environment;
  }

  public async loadPath(configuredPath: string): Promise<void> {
    const expanded = expandConfiguredPath(configuredPath, this.#environment);
    const absolute = resolvePathField(expanded, this.#primaryDirectory);
    let metadata;
    try {
      metadata = await stat(absolute);
    } catch (error) {
      throw new DlogError(
        `Included rule path does not exist: ${absolute}`,
        error,
      );
    }

    if (metadata.isDirectory()) {
      const entries = (await readdir(absolute, { withFileTypes: true }))
        .filter(
          (entry) =>
            !entry.name.startsWith(".") &&
            entry.name.endsWith(".toml") &&
            (entry.isFile() || entry.isSymbolicLink()),
        )
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        await this.#loadFile(join(absolute, entry.name));
      }
      return;
    }

    if (!metadata.isFile()) {
      throw new DlogError(
        `Included rule path is not a file or directory: ${absolute}`,
      );
    }
    await this.#loadFile(absolute);
  }

  public build(): {
    readonly rules: readonly ProcessingRule[];
    readonly plugins: readonly ExternalPluginDefinition[];
  } {
    const plugins: ExternalPluginDefinition[] = [];
    const pluginNames = new Set<string>();
    for (const plugin of this.#plugins) {
      if (!plugin.enabled) {
        continue;
      }
      if (pluginNames.has(plugin.name)) {
        throw new DlogError(`Duplicate plugin name: ${plugin.name}`);
      }
      pluginNames.add(plugin.name);
      plugins.push({
        name: plugin.name,
        protocol: plugin.protocol,
        command: expandConfiguredPath(plugin.command, this.#environment),
        arguments: plugin.arguments,
      });
    }

    const rules: ProcessingRule[] = [];
    const prefixKeys = new Set<string>();
    const globalKeys = new Set<string>();
    for (const rule of this.#rules) {
      if (!rule.enabled) {
        continue;
      }
      const converted = convertRule(rule);
      const keySet =
        converted.rule.phase === "prefix" ? prefixKeys : globalKeys;
      if (keySet.has(converted.uniquenessKey)) {
        throw new DlogError(
          `Duplicate ${converted.rule.phase} substitution key: ${converted.displayKey}`,
        );
      }
      if (
        converted.rule.replacement.kind === "callback" &&
        !pluginNames.has(converted.rule.replacement.plugin)
      ) {
        throw new DlogError(
          `Rule references unknown plugin: ${converted.rule.replacement.plugin}`,
        );
      }
      keySet.add(converted.uniquenessKey);
      rules.push(converted.rule);
    }

    return { rules, plugins };
  }

  async #loadFile(path: string): Promise<void> {
    const canonicalPath = await realpath(path);
    if (this.#activeFiles.has(canonicalPath)) {
      throw new DlogError(`Rule include cycle detected at ${canonicalPath}`);
    }
    if (this.#loadedFiles.has(canonicalPath)) {
      throw new DlogError(
        `Rule file included more than once: ${canonicalPath}`,
      );
    }

    this.#activeFiles.add(canonicalPath);
    const parsed = await parseTomlFile(canonicalPath, ruleFileSchema);
    if (parsed.enabled) {
      for (const include of parsed.includes) {
        if (include.enabled) {
          await this.loadPath(include.path);
        }
      }
      this.#plugins.push(...parsed.plugins);
      this.#rules.push(...parsed.rules);
    }
    this.#activeFiles.delete(canonicalPath);
    this.#loadedFiles.add(canonicalPath);
  }
}

interface ConvertedRule {
  readonly rule: ProcessingRule;
  readonly uniquenessKey: string;
  readonly displayKey: string;
}

function convertRule(rule: ParsedRule): ConvertedRule {
  switch (rule.kind) {
    case "prefix": {
      const value = rule.replace.endsWith(" ")
        ? rule.replace
        : `${rule.replace} `;
      return {
        rule: {
          phase: "prefix",
          key: rule.match,
          replacement: { kind: "static", value },
        },
        uniquenessKey: `literal:${rule.match}`,
        displayKey: rule.match,
      };
    }
    case "link": {
      const display = rule.display ?? rule.alias;
      const wrappedPage = /^\[\[(.+)\]\]$/.exec(rule.page);
      const page = wrappedPage?.[1] ?? rule.page;
      const value =
        display === undefined && wrappedPage !== null
          ? rule.page
          : `[[${page}${display === undefined ? "" : `|${display}`}]]`;
      return {
        rule: {
          phase: "global",
          matcher: { kind: "literal", value: rule.match },
          replacement: { kind: "static", value },
        },
        uniquenessKey: `literal:${rule.match}`,
        displayKey: rule.match,
      };
    }
    case "global": {
      const matcher = convertMatcher(rule);
      return {
        rule: {
          phase: "global",
          matcher,
          replacement: { kind: "static", value: rule.replace },
        },
        uniquenessKey: matcherUniquenessKey(matcher),
        displayKey: displayMatcher(matcher),
      };
    }
    case "callback": {
      const replacement: RuleReplacement = {
        kind: "callback",
        plugin: rule.plugin,
      };
      if (rule.scope === "prefix") {
        if (rule.match === undefined) {
          throw new DlogError("A prefix callback requires a literal match");
        }
        return {
          rule: { phase: "prefix", key: rule.match, replacement },
          uniquenessKey: `literal:${rule.match}`,
          displayKey: rule.match,
        };
      }
      const matcher = convertMatcher(rule);
      return {
        rule: { phase: "global", matcher, replacement },
        uniquenessKey: matcherUniquenessKey(matcher),
        displayKey: displayMatcher(matcher),
      };
    }
  }
}

function convertMatcher(rule: {
  readonly match?: string | undefined;
  readonly pattern?: string | undefined;
  readonly matcher?: "phone" | undefined;
  readonly flags: string;
}): GlobalMatcher {
  if (rule.match !== undefined) {
    return { kind: "literal", value: rule.match };
  }

  const source = rule.matcher === "phone" ? PHONE_NUMBER_PATTERN : rule.pattern;
  if (source === undefined) {
    throw new DlogError("A global rule requires a matcher");
  }
  try {
    return {
      kind: "pattern",
      expression: new RegExp(source, `${rule.flags}g`),
    };
  } catch (error) {
    throw new DlogError(
      `Invalid regular expression /${source}/${rule.flags}`,
      error,
    );
  }
}

function matcherUniquenessKey(matcher: GlobalMatcher): string {
  return matcher.kind === "literal"
    ? `literal:${matcher.value}`
    : `pattern:${matcher.expression.source}/${matcher.expression.flags}`;
}

function displayMatcher(matcher: GlobalMatcher): string {
  return matcher.kind === "literal"
    ? matcher.value
    : `/${matcher.expression.source}/${matcher.expression.flags}`;
}

function validateMatcherFields(
  value: {
    readonly match?: string | undefined;
    readonly pattern?: string | undefined;
    readonly matcher?: "phone" | undefined;
    readonly flags: string;
  },
  context: z.RefinementCtx,
): void {
  const selected = [value.match, value.pattern, value.matcher].filter(
    (candidate) => candidate !== undefined,
  );
  if (selected.length !== 1) {
    context.addIssue({
      code: "custom",
      message: "Exactly one of match, pattern, or matcher must be set",
    });
  }
  if (value.pattern === undefined && value.flags.length > 0) {
    context.addIssue({
      code: "custom",
      message: "flags can only be used with pattern",
    });
  }
}

async function parseTomlFile<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
): Promise<z.output<Schema>> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new DlogError(`Cannot read configuration file: ${path}`, error);
  }
  if (source.length === 0) {
    throw new DlogError(`Configuration file is empty: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    throw new DlogError(`Invalid TOML in ${path}`, error);
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new DlogError(
      `Invalid configuration in ${path}: ${z.prettifyError(validated.error)}`,
    );
  }
  return validated.data;
}

function expandConfiguredPath(
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
    return join(environment.homeDirectory, expandedVariables.slice(2));
  }
  return expandedVariables;
}

function resolvePathField(value: string, baseDirectory: string): string {
  return isAbsolute(value) ? value : resolve(baseDirectory, value);
}
