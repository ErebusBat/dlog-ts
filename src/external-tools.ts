import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { z } from "zod";

import { DlogError } from "./dlog-error.js";
import type {
  CallbackExecutor,
  CallbackRequest,
  CallbackResult,
} from "./entry-processor.js";

const INITIAL_TOOL_STATUS = 1;

export interface ExternalToolResult {
  readonly requestedName: string;
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly output: string;
  readonly errorOutput: string;
  readonly status: number;
}

export interface ExternalToolRunnerOptions {
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

export class ExternalToolRunner {
  readonly #cwd: string;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #resolutionCache = new Map<string, string | null>();
  #selectedName: string | null = null;
  #selectedPath: string | null = null;
  #output: string | null = null;
  #errorOutput: string | null = null;
  #status = INITIAL_TOOL_STATUS;

  public constructor(options: ExternalToolRunnerOptions) {
    this.#cwd = options.cwd;
    this.#environment = options.environment;
  }

  public get toolOutput(): string | null {
    return this.#output;
  }

  public get toolErrorOutput(): string | null {
    return this.#errorOutput;
  }

  public get toolStatus(): number {
    return this.#status;
  }

  public get toolSuccess(): boolean {
    return this.#status === 0;
  }

  public get toolError(): boolean {
    return !this.toolSuccess;
  }

  public async hasTool(requestedName: string): Promise<boolean> {
    return (await this.#resolveExecutable(requestedName)) !== null;
  }

  public async selectTool(requestedName: string): Promise<boolean> {
    this.#selectedName = requestedName;
    this.#selectedPath = await this.#resolveExecutable(requestedName);
    this.#output = null;
    this.#errorOutput = null;
    this.#status = INITIAL_TOOL_STATUS;
    return this.#selectedPath !== null;
  }

  public async runTool(
    requestedName: string,
    arguments_: readonly string[] = [],
    standardInput?: string,
  ): Promise<ExternalToolResult> {
    await this.selectTool(requestedName);
    return this.runSelected(arguments_, standardInput);
  }

  public async runSelected(
    arguments_: readonly string[] = [],
    standardInput?: string,
  ): Promise<ExternalToolResult> {
    const requestedName = this.#selectedName;
    const executablePath = this.#selectedPath;
    this.#output = null;
    this.#errorOutput = null;
    this.#status = INITIAL_TOOL_STATUS;

    if (requestedName === null) {
      throw new DlogError("No external tool is currently selected");
    }
    if (executablePath === null) {
      throw new DlogError(
        `External tool is missing or not executable: ${requestedName}`,
      );
    }

    const execution = await executeProcess({
      executablePath,
      arguments: arguments_,
      cwd: this.#cwd,
      environment: this.#environment,
      standardInput,
    });
    this.#output = execution.output.trim();
    this.#errorOutput = execution.errorOutput.trim();
    this.#status = execution.status;

    return {
      requestedName,
      executablePath,
      arguments: [...arguments_],
      output: this.#output,
      errorOutput: this.#errorOutput,
      status: this.#status,
    };
  }

  async #resolveExecutable(requestedName: string): Promise<string | null> {
    const cached = this.#resolutionCache.get(requestedName);
    if (cached !== undefined || this.#resolutionCache.has(requestedName)) {
      return cached ?? null;
    }

    const candidates = requestedName.includes("/")
      ? [
          isAbsolute(requestedName)
            ? requestedName
            : resolve(this.#cwd, requestedName),
        ]
      : (this.#environment["PATH"] ?? "")
          .split(delimiter)
          .map((directory) =>
            join(directory.length === 0 ? this.#cwd : directory, requestedName),
          );

    for (const candidate of candidates) {
      if (await isExecutableFile(candidate)) {
        this.#resolutionCache.set(requestedName, candidate);
        return candidate;
      }
    }

    this.#resolutionCache.set(requestedName, null);
    return null;
  }
}

export interface ExternalPluginDefinition {
  readonly name: string;
  readonly protocol: "json" | "text";
  readonly command: string;
  readonly arguments: readonly string[];
}

const jsonPluginResultSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("replace"), value: z.string() }),
  z.strictObject({ action: z.literal("no-change") }),
  z.strictObject({ action: z.literal("delete") }),
]);

export class PluginExecutor implements CallbackExecutor {
  readonly #plugins: ReadonlyMap<string, ExternalPluginDefinition>;
  readonly #tools: ExternalToolRunner;

  public constructor(
    plugins: readonly ExternalPluginDefinition[],
    tools: ExternalToolRunner,
  ) {
    this.#plugins = new Map(plugins.map((plugin) => [plugin.name, plugin]));
    this.#tools = tools;
  }

  public async execute(request: CallbackRequest): Promise<CallbackResult> {
    const plugin = this.#plugins.get(request.plugin);
    if (plugin === undefined) {
      throw new DlogError(`Unknown callback plugin: ${request.plugin}`);
    }

    const standardInput =
      plugin.protocol === "json"
        ? JSON.stringify({
            protocol: "dlog-substitution/v1",
            fullEntryBeforeRule: request.fullEntryBeforeRule,
            matchedText: request.matchedText,
          })
        : request.matchedText;
    const result = await this.#tools.runTool(
      plugin.command,
      plugin.arguments,
      standardInput,
    );

    if (result.status !== 0) {
      const detail =
        result.errorOutput.length > 0 ? `: ${result.errorOutput}` : "";
      throw new DlogError(
        `Plugin ${plugin.name} exited with status ${result.status}${detail}`,
      );
    }

    if (plugin.protocol === "text") {
      return result.output.length === 0
        ? { action: "delete" }
        : { action: "replace", value: result.output };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.output);
    } catch (error) {
      throw new DlogError(`Plugin ${plugin.name} returned invalid JSON`, error);
    }
    const validated = jsonPluginResultSchema.safeParse(parsed);
    if (!validated.success) {
      throw new DlogError(
        `Plugin ${plugin.name} returned an invalid dlog-substitution/v1 response: ${z.prettifyError(validated.error)}`,
      );
    }
    return validated.data;
  }
}

interface ProcessRequest {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly standardInput: string | undefined;
}

interface ProcessOutput {
  readonly output: string;
  readonly errorOutput: string;
  readonly status: number;
}

function executeProcess(request: ProcessRequest): Promise<ProcessOutput> {
  const {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  } = Promise.withResolvers<ProcessOutput>();
  const child = spawn(request.executablePath, request.arguments, {
    cwd: request.cwd,
    env: request.environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    errorOutput += chunk;
  });
  child.once("error", rejectPromise);
  child.once("close", (status) => {
    resolvePromise({
      output,
      errorOutput,
      status: status ?? INITIAL_TOOL_STATUS,
    });
  });

  if (request.standardInput === undefined) {
    child.stdin.end();
  } else {
    child.stdin.end(request.standardInput, "utf8");
  }
  return promise;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) {
      return false;
    }
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
