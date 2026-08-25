import { homedir } from "node:os";
import { sep } from "node:path";

import { Ansis } from "ansis";

import type { CommandIO } from "./append-command.js";
import type {
  ConfiguredRule,
  ConfigurationLoader,
  LoadedRuleFile,
} from "./configuration.js";
import { DlogError } from "./dlog-error.js";
import { resolveColorLevel, type ColorMode } from "./theme.js";

export const RULES_HELP = `Usage:
  dlog rules
  dlog rules plugin
  dlog rules info RULE_TYPE
  dlog rules print [--rules] [--color WHEN]

Commands:
  plugin          Show installed plugins from the loaded configuration
  info RULE_TYPE  Show detailed help and examples for one rule type
  print           Show loaded rule files and rule counts

Print options:
      --rules       Show every configured rule in application order
      --color WHEN  Emit ANSI styling: auto, always, never (default auto)
  -h, --help        Show this help
`;

const RULE_KINDS = ["prefix", "global", "callback", "link"] as const;
type RuleKind = (typeof RULE_KINDS)[number];

interface RuleHelp {
  readonly description: string;
  readonly details: string;
  readonly configuration: string;
  readonly input: string;
  readonly output: string;
}

const RULE_HELP_BY_KIND: Readonly<Record<RuleKind, RuleHelp>> = {
  prefix: {
    description: "replace a literal match at the start of input",
    details:
      "Replaces a literal match at the beginning of a string with the given replacement. The match must be followed by whitespace or the end of the input.",
    configuration: `[[rules]]
kind = "prefix"
match = "+1"
replace = "👍"`,
    input: "dlog append '+1 Report for Lucy'",
    output: "- *HH:MM* - 👍 Report for Lucy",
  },
  global: {
    description: "replace a literal match or pattern anywhere in input",
    details:
      "Replaces every occurrence of a literal match or regular-expression pattern. Global rules run in configuration order after all prefix rules.",
    configuration: `[[rules]]
kind = "global"
match = "AI"
replace = "🤖"`,
    input: "dlog append 'Reviewed the AI report'",
    output: "- *HH:MM* - Reviewed the 🤖 report",
  },
  callback: {
    description: "call an external plugin to handle replacement",
    details:
      'Calls a named external plugin for each match. Use scope = "prefix" for a literal beginning-of-input match; otherwise the callback is global.',
    configuration: `[[plugins]]
name = "issues"
protocol = "json"
command = "dlog-issue-plugin"

[[rules]]
kind = "callback"
pattern = "ISSUE-[0-9]+"
plugin = "issues"`,
    input: "dlog append 'Follow up on ISSUE-123'",
    output: "- *HH:MM* - Follow up on <plugin result>",
  },
  link: {
    description: "replace a literal match with an Obsidian link",
    details:
      "Replaces every literal match with an Obsidian wiki link. Set display (or alias) when the displayed text should differ from the page name.",
    configuration: `[[rules]]
kind = "link"
match = "Lucy"
page = "People/Lucy"
display = "Lucy"`,
    input: "dlog append 'Report for Lucy'",
    output: "- *HH:MM* - Report for [[People/Lucy|Lucy]]",
  },
};

export type RulesCommandOptions =
  | { readonly action: "list" }
  | { readonly action: "plugin" }
  | { readonly action: "info"; readonly ruleKind: RuleKind }
  | {
      readonly action: "print";
      readonly includeRules: boolean;
      readonly color: ColorMode;
    };

export interface RulesCommandDependencies {
  readonly io: CommandIO;
  readonly configurationLoader: Pick<ConfigurationLoader, "load">;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

export class RulesCommand {
  readonly #dependencies: RulesCommandDependencies;

  public constructor(dependencies: RulesCommandDependencies) {
    this.#dependencies = dependencies;
  }

  public async run(options: RulesCommandOptions): Promise<number> {
    switch (options.action) {
      case "list":
        this.#dependencies.io.writeOutput(renderRuleKindList());
        return 0;
      case "info":
        this.#dependencies.io.writeOutput(renderRuleInfo(options.ruleKind));
        return 0;
      case "plugin": {
        const configuration =
          await this.#dependencies.configurationLoader.load();
        this.#dependencies.io.writeOutput(
          renderPlugins(
            configuration.ruleFiles,
            this.#dependencies.environment,
          ),
        );
        return 0;
      }
      case "print": {
        const configuration =
          await this.#dependencies.configurationLoader.load();
        const colorLevel = resolveColorLevel(
          options.color,
          this.#dependencies.io.isOutputTerminal(),
          this.#dependencies.environment,
        );
        this.#dependencies.io.writeOutput(
          renderRuleFiles(
            configuration.ruleFiles,
            options.includeRules,
            new RuleValueStyler(colorLevel),
            this.#dependencies.environment,
          ),
        );
        return 0;
      }
    }
  }
}

export function parseRulesOptions(
  arguments_: readonly string[],
): RulesCommandOptions | "help" {
  if (arguments_.length === 0) {
    return { action: "list" };
  }
  if (
    arguments_.some((argument) => argument === "-h" || argument === "--help")
  ) {
    return "help";
  }

  const subcommand = arguments_[0];
  if (subcommand === "plugin") {
    requireNoTrailingArguments("plugin", arguments_.slice(1));
    return { action: "plugin" };
  }
  if (subcommand === "info") {
    const ruleKind = arguments_[1];
    if (ruleKind === undefined) {
      throw new DlogError("rules info requires a rule type");
    }
    if (!isRuleKind(ruleKind)) {
      throw new DlogError(
        `Unknown rule type: ${ruleKind}; expected one of: ${RULE_KINDS.join(", ")}`,
      );
    }
    requireNoTrailingArguments("info", arguments_.slice(2));
    return { action: "info", ruleKind };
  }
  if (subcommand === "print") {
    return parsePrintOptions(arguments_.slice(1));
  }

  throw new DlogError(`Unknown rules subcommand: ${subcommand}`);
}

function parsePrintOptions(arguments_: readonly string[]): RulesCommandOptions {
  let includeRules = false;
  let color: ColorMode = "auto";

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--rules") {
      includeRules = true;
      continue;
    }

    const inlineColor = argument.match(/^--color=(.*)$/);
    if (argument === "--color" || inlineColor !== null) {
      let value = inlineColor?.[1];
      if (value === undefined) {
        index += 1;
        value = arguments_[index];
      }
      if (value !== "auto" && value !== "always" && value !== "never") {
        throw new DlogError(
          "Option --color requires one of: auto, always, never",
        );
      }
      color = value;
      continue;
    }

    throw new DlogError(`Unknown rules print option: ${argument}`);
  }

  return { action: "print", includeRules, color };
}

function requireNoTrailingArguments(
  subcommand: string,
  arguments_: readonly string[],
): void {
  const argument = arguments_[0];
  if (argument !== undefined) {
    throw new DlogError(
      `Unexpected argument for rules ${subcommand}: ${argument}`,
    );
  }
}

function isRuleKind(value: string): value is RuleKind {
  return RULE_KINDS.some((kind) => kind === value);
}

function renderRuleKindList(): string {
  const kindWidth = Math.max(
    "Kind".length,
    ...RULE_KINDS.map((kind) => kind.length),
  );
  const heading = `${"Kind".padEnd(kindWidth)}  Description`;
  const separator = "-".repeat(heading.length);
  const rows = RULE_KINDS.map(
    (kind) =>
      `${kind.padEnd(kindWidth)}  ${RULE_HELP_BY_KIND[kind].description}`,
  );
  return `${[heading, separator, ...rows].join("\n")}\n`;
}

function renderRuleInfo(kind: RuleKind): string {
  const help = RULE_HELP_BY_KIND[kind];
  return `${kind}\n${help.details}\n\nConfiguration:\n${help.configuration}\n\nExample:\nInput:  ${help.input}\nOutput: ${help.output}\n`;
}

function renderPlugins(
  files: readonly LoadedRuleFile[],
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const sections = files
    .filter((file) => file.plugins.length > 0)
    .map((file) => {
      const lines = [displayPath(file.sourcePath, environment)];
      for (const plugin of file.plugins) {
        lines.push(`${plugin.protocol} - ${plugin.name}`);
        lines.push(
          `  command: ${renderCommand(plugin.command, plugin.arguments)}`,
        );
      }
      return lines.join("\n");
    });
  return sections.length === 0
    ? "No plugins configured.\n"
    : `${sections.join("\n\n")}\n`;
}

function renderRuleFiles(
  files: readonly LoadedRuleFile[],
  includeRules: boolean,
  styler: RuleValueStyler,
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  if (files.length === 0) {
    return "No rule files configured.\n";
  }
  return `${files
    .map((file) => renderRuleFile(file, includeRules, styler, environment))
    .join("\n\n")}\n`;
}

function renderRuleFile(
  file: LoadedRuleFile,
  includeRules: boolean,
  styler: RuleValueStyler,
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const lines = [displayPath(file.sourcePath, environment)];
  if (file.plugins.length > 0) {
    lines.push(`PLUGIN (${file.plugins.length})`);
    if (includeRules) {
      for (const plugin of file.plugins) {
        lines.push(`${plugin.protocol} - ${plugin.name}`);
      }
    }
  }

  if (includeRules) {
    appendDetailedRules(lines, file.rules, styler);
  } else {
    appendRuleCounts(lines, file.rules);
  }
  lines.push(`TOTAL rules (${file.rules.length})`);
  return lines.join("\n");
}

function appendRuleCounts(
  lines: string[],
  rules: readonly ConfiguredRule[],
): void {
  const countByKind: Record<RuleKind, number> = {
    prefix: 0,
    global: 0,
    callback: 0,
    link: 0,
  };
  const encounteredKinds: RuleKind[] = [];
  for (const rule of rules) {
    if (countByKind[rule.kind] === 0) {
      encounteredKinds.push(rule.kind);
    }
    countByKind[rule.kind] += 1;
  }
  for (const kind of encounteredKinds) {
    lines.push(ruleSectionHeading(kind, countByKind[kind]));
  }
}

function appendDetailedRules(
  lines: string[],
  rules: readonly ConfiguredRule[],
  styler: RuleValueStyler,
): void {
  let index = 0;
  while (index < rules.length) {
    const first = rules[index];
    if (first === undefined) {
      throw new DlogError("Rule detail rendering lost its current rule");
    }
    let end = index + 1;
    while (rules[end]?.kind === first.kind) {
      end += 1;
    }
    let inputWidth = 0;
    for (let ruleIndex = index; ruleIndex < end; ruleIndex += 1) {
      const rule = rules[ruleIndex];
      if (rule === undefined) {
        throw new DlogError("Rule width calculation lost a grouped rule");
      }
      inputWidth = Math.max(inputWidth, ruleInput(rule).length);
    }
    lines.push(ruleSectionHeading(first.kind, end - index));
    for (let ruleIndex = index; ruleIndex < end; ruleIndex += 1) {
      const rule = rules[ruleIndex];
      if (rule === undefined) {
        throw new DlogError("Rule detail rendering lost a grouped rule");
      }
      const input = ruleInput(rule);
      const padding = " ".repeat(inputWidth - input.length);
      lines.push(
        `${styler.input(input)}${padding} => ${styler.output(ruleOutput(rule))}`,
      );
    }
    index = end;
  }
}

function ruleSectionHeading(kind: RuleKind, count: number): string {
  return `${kind.toUpperCase()} rules (${count})`;
}

function ruleInput(rule: ConfiguredRule): string {
  switch (rule.kind) {
    case "prefix":
    case "link":
      return rule.match;
    case "global":
    case "callback":
      return configuredMatcher(rule);
  }
}

function ruleOutput(rule: ConfiguredRule): string {
  switch (rule.kind) {
    case "prefix":
    case "global":
      return rule.replace;
    case "callback":
      return `plugin:${rule.plugin}`;
    case "link": {
      const wrappedPage = /^\[\[(.+)\]\]$/.exec(rule.page);
      const page = wrappedPage?.[1] ?? rule.page;
      const display = rule.display ?? rule.alias;
      return display === undefined && wrappedPage !== null
        ? rule.page
        : `[[${page}${display === undefined ? "" : `|${display}`}]]`;
    }
  }
}

function configuredMatcher(
  rule: Extract<ConfiguredRule, { kind: "global" | "callback" }>,
): string {
  if (rule.match !== undefined) {
    return rule.match;
  }
  if (rule.matcher === "phone") {
    return "matcher:phone";
  }
  if (rule.pattern !== undefined) {
    return `/${rule.pattern}/${rule.flags}`;
  }
  throw new DlogError(`Configured ${rule.kind} rule has no matcher`);
}

function displayPath(
  path: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const homeDirectory = environment["HOME"] ?? homedir();
  if (path === homeDirectory) {
    return "~";
  }
  return path.startsWith(`${homeDirectory}${sep}`)
    ? `~${path.slice(homeDirectory.length)}`
    : path;
}

function renderCommand(command: string, arguments_: readonly string[]): string {
  return [command, ...arguments_].map(renderCommandPart).join(" ");
}

function renderCommandPart(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

class RuleValueStyler {
  readonly #formatter: Ansis | undefined;

  public constructor(level: 0 | 1 | 2 | 3) {
    this.#formatter = level === 0 ? undefined : new Ansis(level);
  }

  public input(value: string): string {
    return this.#formatter?.bgBlue.black(value) ?? value;
  }

  public output(value: string): string {
    return this.#formatter?.bgMagenta.black(value) ?? value;
  }
}
