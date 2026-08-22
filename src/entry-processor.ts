import { DlogError } from "./dlog-error.js";

export const PHONE_NUMBER_PATTERN = String.raw`(?<!\d)(?:1[-.\s]?)?(?:\d{3}-\d{3}-\d{4}|\(\d{3}\)\s*\d{3}-\d{4}|\d{3}\.\d{3}\.\d{4}|\d{3}\s+\d{3}\s+\d{4}|\d{10})(?!\d)`;

export type CallbackResult =
  | { readonly action: "replace"; readonly value: string }
  | { readonly action: "no-change" }
  | { readonly action: "delete" };

export interface CallbackRequest {
  readonly plugin: string;
  readonly fullEntryBeforeRule: string;
  readonly matchedText: string;
}

export interface CallbackExecutor {
  execute(request: CallbackRequest): Promise<CallbackResult>;
}

export type RuleReplacement =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "callback"; readonly plugin: string };

export interface PrefixRule {
  readonly phase: "prefix";
  readonly key: string;
  readonly replacement: RuleReplacement;
}

export type GlobalMatcher =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "pattern"; readonly expression: RegExp };

export interface GlobalRule {
  readonly phase: "global";
  readonly matcher: GlobalMatcher;
  readonly replacement: RuleReplacement;
}

export type ProcessingRule = PrefixRule | GlobalRule;

export interface ProcessEntryOptions {
  readonly now: Date;
  readonly explicitTimestamp?: Date;
  readonly entryPrefix?: (entryText: string, timestamp: Date) => string;
}

export interface ProcessedEntry {
  readonly timestamp: Date;
  readonly entryText: string;
  readonly renderedEntry: string;
}

interface PreprocessedEntry {
  readonly timestamp: Date;
  readonly text: string;
}

export class EntryProcessor {
  readonly #prefixRules: readonly PrefixRule[];
  readonly #globalRules: readonly GlobalRule[];
  readonly #callbacks: CallbackExecutor;

  public constructor(
    rules: readonly ProcessingRule[],
    callbacks: CallbackExecutor,
  ) {
    this.#prefixRules = rules.filter(
      (rule): rule is PrefixRule => rule.phase === "prefix",
    );
    this.#globalRules = rules.filter(
      (rule): rule is GlobalRule => rule.phase === "global",
    );
    this.#callbacks = callbacks;
  }

  public async process(
    input: string,
    options: ProcessEntryOptions,
  ): Promise<ProcessedEntry> {
    const preprocessed = preprocessTimestamp(input, options);
    let entryText = preprocessed.text;

    for (const rule of this.#prefixRules) {
      entryText = await applyPrefixRule(entryText, rule, this.#callbacks);
    }
    for (const rule of this.#globalRules) {
      entryText = await applyGlobalRule(entryText, rule, this.#callbacks);
    }

    entryText = entryText.trim();
    const renderedEntry = `${
      options.entryPrefix?.(entryText, preprocessed.timestamp) ?? ""
    }${entryText}`;

    return {
      timestamp: preprocessed.timestamp,
      entryText,
      renderedEntry,
    };
  }
}

function preprocessTimestamp(
  input: string,
  options: ProcessEntryOptions,
): PreprocessedEntry {
  const relativeMatch = /^-([0-9hm]+)\|\s*(.*)$/s.exec(input);
  if (relativeMatch !== null) {
    rejectCompetingTimestamp(options.explicitTimestamp);
    const duration = relativeMatch[1];
    const text = relativeMatch[2];
    if (duration === undefined || text === undefined) {
      throw new DlogError("Relative timestamp parsing failed");
    }

    return {
      timestamp: subtractDuration(options.now, duration),
      text,
    };
  }

  const absoluteMatch = /^(\d{2}):?(\d{2})\|\s*(.*)$/s.exec(input);
  if (absoluteMatch !== null) {
    rejectCompetingTimestamp(options.explicitTimestamp);
    const hours = absoluteMatch[1];
    const minutes = absoluteMatch[2];
    const text = absoluteMatch[3];
    if (hours === undefined || minutes === undefined || text === undefined) {
      throw new DlogError("Absolute timestamp parsing failed");
    }

    const timestamp = new Date(options.now);
    timestamp.setHours(
      Number.parseInt(hours, 10),
      Number.parseInt(minutes, 10),
      0,
      0,
    );
    return { timestamp, text };
  }

  const timestamp = new Date(options.explicitTimestamp ?? options.now);
  return {
    timestamp,
    text: input === "." ? "⬆︎" : input,
  };
}

function rejectCompetingTimestamp(explicitTimestamp: Date | undefined): void {
  if (explicitTimestamp !== undefined) {
    throw new DlogError(
      "An explicit timestamp cannot be combined with an entry timestamp prefix",
    );
  }
}

function subtractDuration(now: Date, duration: string): Date {
  let milliseconds = 0;

  if (/^\d+$/.test(duration)) {
    milliseconds = Number.parseInt(duration, 10) * 60_000;
  } else {
    const minutesMatch = /^(\d+)m$/.exec(duration);
    const hoursMatch = /^(\d+)h$/.exec(duration);
    const combinedMatch = /^(\d+)h(\d+)m$/.exec(duration);

    if (minutesMatch?.[1] !== undefined) {
      milliseconds = Number.parseInt(minutesMatch[1], 10) * 60_000;
    } else if (hoursMatch?.[1] !== undefined) {
      milliseconds = Number.parseInt(hoursMatch[1], 10) * 3_600_000;
    } else if (
      combinedMatch?.[1] !== undefined &&
      combinedMatch[2] !== undefined
    ) {
      milliseconds =
        Number.parseInt(combinedMatch[1], 10) * 3_600_000 +
        Number.parseInt(combinedMatch[2], 10) * 60_000;
    }
  }

  return new Date(now.getTime() - milliseconds);
}

async function applyPrefixRule(
  entry: string,
  rule: PrefixRule,
  callbacks: CallbackExecutor,
): Promise<string> {
  const expression = new RegExp(`^${escapeRegExp(rule.key)}(\\s|$)`);
  const match = expression.exec(entry);
  if (match === null) {
    return entry;
  }

  const matchedText = match[0];
  const replacement = await resolveReplacement(
    rule.replacement,
    callbacks,
    entry,
    matchedText,
  );
  return `${replacement}${entry.slice(matchedText.length)}`;
}

async function applyGlobalRule(
  entry: string,
  rule: GlobalRule,
  callbacks: CallbackExecutor,
): Promise<string> {
  if (rule.replacement.kind === "static") {
    if (rule.matcher.kind === "literal") {
      return entry.replaceAll(rule.matcher.value, rule.replacement.value);
    }
    return entry.replace(
      cloneGlobalPattern(rule.matcher.expression),
      rule.replacement.value,
    );
  }

  const matches = collectMatches(entry, rule.matcher);
  if (matches.length === 0) {
    return entry;
  }

  let output = "";
  let cursor = 0;
  for (const match of matches) {
    output += entry.slice(cursor, match.index);
    output += await resolveReplacement(
      rule.replacement,
      callbacks,
      entry,
      match.text,
    );
    cursor = match.index + match.text.length;
  }
  return output + entry.slice(cursor);
}

interface LocatedMatch {
  readonly index: number;
  readonly text: string;
}

function collectMatches(
  entry: string,
  matcher: GlobalMatcher,
): readonly LocatedMatch[] {
  if (matcher.kind === "literal") {
    const matches: LocatedMatch[] = [];
    let index = entry.indexOf(matcher.value);
    while (index !== -1) {
      matches.push({ index, text: matcher.value });
      index = entry.indexOf(matcher.value, index + matcher.value.length);
    }
    return matches;
  }

  return Array.from(
    entry.matchAll(cloneGlobalPattern(matcher.expression)),
    (match) => ({
      index: match.index,
      text: match[0],
    }),
  );
}

async function resolveReplacement(
  replacement: RuleReplacement,
  callbacks: CallbackExecutor,
  fullEntryBeforeRule: string,
  matchedText: string,
): Promise<string> {
  if (replacement.kind === "static") {
    return replacement.value;
  }

  const result = await callbacks.execute({
    plugin: replacement.plugin,
    fullEntryBeforeRule,
    matchedText,
  });
  switch (result.action) {
    case "replace":
      return result.value;
    case "no-change":
      return matchedText;
    case "delete":
      return "";
  }
}

function cloneGlobalPattern(expression: RegExp): RegExp {
  const flags = expression.flags.includes("g")
    ? expression.flags
    : `${expression.flags}g`;
  return new RegExp(expression.source, flags);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
