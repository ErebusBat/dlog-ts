import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandIO } from "./append-command.js";
import { runCli, parseFixupOptions, type CliDependencies } from "./cli.js";
import {
  ConfigurationLoader,
  type ConfigurationEnvironment,
} from "./configuration.js";
import { DailyDocumentReader, DailyDocumentWriter } from "./daily-document.js";
import {
  Sha256FileHasher,
  SystemWatchdogScheduler,
  type OperationalLogger,
  type WatchClock,
} from "./fixup-watcher.js";
import { ThemeLoader } from "./theme.js";

const NOW = new Date(2025, 6, 25, 10, 30, 0, 0);
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

class TestIO implements CommandIO {
  public output = "";
  public error = "";
  public input = "";
  public outputIsTerminal = false;

  public isOutputTerminal(): boolean {
    return this.outputIsTerminal;
  }

  public writeOutput(value: string): void {
    this.output += value;
  }

  public writeError(value: string): void {
    this.error += value;
  }

  public async readLine(): Promise<string> {
    return this.input;
  }
}

class FixedClock implements WatchClock {
  public now(): Date {
    return new Date(NOW);
  }

  public monotonicSeconds(): number {
    return 0;
  }

  public async sleep(_seconds: number): Promise<void> {}
}

class RecordingLogger implements OperationalLogger {
  public readonly messages: string[] = [];

  public log(message: string): void {
    this.messages.push(message);
  }
}

interface CliFixture {
  readonly root: string;
  readonly documentPath: string;
  readonly io: TestIO;
  readonly dependencies: CliDependencies;
}

async function cliFixture(ruleSource = ""): Promise<CliFixture> {
  const root = await mkdtemp(join(tmpdir(), "dlog-cli-"));
  temporaryDirectories.push(root);
  const vault = join(root, "vault");
  await mkdir(vault);
  const documentPath = join(vault, "daily.md");
  await writeFile(documentPath, "# Log", "utf8");
  const configPath = join(root, "config.toml");
  const include =
    ruleSource.length === 0 ? "" : `\n[[includes]]\npath = "rules.toml"\n`;
  await writeFile(
    configPath,
    `schema = "dlog-config/v1"
vault_roots = [${JSON.stringify(vault)}]
daily_path = "daily.md"
entry_prefix = "- *%H:%M* - "
${include}`,
    "utf8",
  );
  if (ruleSource.length > 0) {
    await writeFile(
      join(root, "rules.toml"),
      `schema = "dlog-rules/v1"\n${ruleSource}`,
      "utf8",
    );
  }

  const io = new TestIO();
  const configEnvironment: ConfigurationEnvironment = {
    cwd: root,
    homeDirectory: root,
    variables: { DLOG_CONFIG: configPath, PATH: process.env["PATH"] },
  };
  const configurationLoader = new ConfigurationLoader({
    environment: configEnvironment,
  });
  const themeLoader = new ThemeLoader({
    configurationLoader,
    environment: configEnvironment,
  });
  return {
    root,
    documentPath,
    io,
    dependencies: {
      io,
      configurationLoader,
      themeLoader,
      documentReader: new DailyDocumentReader(),
      documentWriter: new DailyDocumentWriter(),
      clock: new FixedClock(),
      hasher: new Sha256FileHasher(),
      logger: new RecordingLogger(),
      watchdogScheduler: new SystemWatchdogScheduler(),
      fatalExit: (status) => {
        throw new Error(`Unexpected fatal exit ${status}`);
      },
      keepWatching: () => false,
      cwd: root,
      environment: configEnvironment.variables,
    },
  };
}

describe("append CLI conformance", () => {
  test("CLI-01 joins positional words with one space", async () => {
    const fixture = await cliFixture();
    const status = await runCli(
      "dlog",
      ["append", "Had", "coffee", "with", "Sarah"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(await readFile(fixture.documentPath, "utf8")).toContain(
      "- *10:30* - Had coffee with Sarah",
    );
  });

  test("CLI-02 prompts and reads one stdin line", async () => {
    const fixture = await cliFixture();
    fixture.io.input = "Had coffee\n";
    const status = await runCli("dlog", ["append"], fixture.dependencies);

    expect(status).toBe(0);
    expect(fixture.io.output).toBe("Enter Log: - *10:30* - Had coffee\n");
  });

  test("CLI-03 blank input returns status 1 without changing the document", async () => {
    const fixture = await cliFixture();
    const before = await readFile(fixture.documentPath, "utf8");
    const status = await runCli(
      "dlog",
      ["append", "   "],
      fixture.dependencies,
    );

    expect(status).toBe(1);
    expect(fixture.io.error).toBe("No input, exiting\n");
    expect(await readFile(fixture.documentPath, "utf8")).toBe(before);
  });

  test("CLI-04 blank rendered entry returns status 2 without changing bytes", async () => {
    const fixture = await cliFixture(
      `[[rules]]\nkind = "global"\nmatch = "REMOVE"\nreplace = ""`,
    );
    await writeFile(
      join(fixture.root, "config.toml"),
      `schema = "dlog-config/v1"
vault_roots = [${JSON.stringify(join(fixture.root, "vault"))}]
daily_path = "daily.md"
entry_prefix = ""
[[includes]]
path = "rules.toml"
`,
      "utf8",
    );
    const before = await readFile(fixture.documentPath, "utf8");
    const status = await runCli(
      "dlog",
      ["append", "REMOVE"],
      fixture.dependencies,
    );

    expect(status).toBe(2);
    expect(fixture.io.error).toBe("Entry was blank, exiting\n");
    expect(await readFile(fixture.documentPath, "utf8")).toBe(before);
  });

  test("CLI-05 prints the exact rendered entry after persistence", async () => {
    const fixture = await cliFixture();
    const status = await runCli(
      "dlog",
      ["append", "Persisted"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toBe("- *10:30* - Persisted\n");
    expect(await readFile(fixture.documentPath, "utf8")).toContain(
      "- *10:30* - Persisted",
    );
  });

  test("CLI-06 does not write when --no-write is set", async () => {
    const fixture = await cliFixture();
    const before = await readFile(fixture.documentPath, "utf8");
    const status = await runCli(
      "dlog",
      ["append", "--no-write", "Persisted", "without", "write"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toBe(
      "- *10:30* - Persisted without write\n",
    );
    expect(fixture.io.error).toBe(
      "Warning: --no-write is set; this entry was not written to the daily document.\n",
    );
    expect(await readFile(fixture.documentPath, "utf8")).toBe(before);
  });

  test("CLI-07 colorizes the no-write warning when forced", async () => {
    const fixture = await cliFixture();
    fixture.io.outputIsTerminal = true;
    const dependencies = {
      ...fixture.dependencies,
      environment: {
        ...fixture.dependencies.environment,
        FORCE_COLOR: "1",
      },
    };
    const status = await runCli(
      "dlog",
      ["append", "--no-write", "Colorful"],
      dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toBe("- *10:30* - Colorful\n");
    expect(fixture.io.error).toContain("\x1b[");
    expect(fixture.io.error).toContain(
      "Warning: --no-write is set; this entry was not written to the daily document.",
    );
  });

  test("CLI-08 keeps entry text that starts with option-looking words when -- is used", async () => {
    const fixture = await cliFixture();
    const status = await runCli(
      "dlog",
      ["append", "--", "--help", "entry"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toBe("- *10:30* - --help entry\n");
  });

  test("strict dispatcher rejects a missing subcommand", async () => {
    const fixture = await cliFixture();
    expect(await runCli("dlog", [], fixture.dependencies)).toBe(1);
    expect(fixture.io.error).toContain(
      "explicit append, fixup, tail, or theme subcommand",
    );
  });

  test("dlog-append argv0 alias infers append", async () => {
    const fixture = await cliFixture();
    expect(
      await runCli("/tmp/dlog-append", ["Aliased"], fixture.dependencies),
    ).toBe(0);
    expect(await readFile(fixture.documentPath, "utf8")).toContain(
      "- *10:30* - Aliased",
    );
  });

  test("dlog-fixup argv0 alias runs one stabilized fixup", async () => {
    const fixture = await cliFixture();
    await writeFile(
      fixture.documentPath,
      "# Log\nNarrative\n- *09:00* - Retained",
      "utf8",
    );
    expect(await runCli("/tmp/dlog-fixup", [], fixture.dependencies)).toBe(0);
    expect(await readFile(fixture.documentPath, "utf8")).not.toContain(
      "Narrative",
    );
  });

  test("theme subcommand dumps the active theme without an executable alias", async () => {
    const fixture = await cliFixture();
    expect(
      await runCli(
        "dlog",
        ["theme", "--dump", "--silent"],
        fixture.dependencies,
      ),
    ).toBe(0);
    expect(fixture.io.output).toStartWith('schema = "dlog-theme/v1"\n');

    const aliasFixture = await cliFixture();
    expect(await runCli("dlog-theme", [], aliasFixture.dependencies)).toBe(1);
  });
});

describe("fixup option parsing", () => {
  test("FIX-10 watch mode retains a zero-second default delay", () => {
    const options = parseFixupOptions(["--watch"]);
    expect(options).not.toBe("help");
    if (options !== "help") {
      expect(options.watch).toBe(true);
      expect(options.writeDelaySeconds).toBe(0);
    }
  });

  test("clamps polling and delay bounds and honors cache precedence", () => {
    expect(
      parseFixupOptions([
        "--sleep",
        "0",
        "--delay=5000",
        "--no-cache-config",
        "--cache-config",
      ]),
    ).toEqual({
      watch: false,
      pollIntervalSeconds: 1,
      writeDelaySeconds: 3600,
      noChangeLogIntervalSeconds: 60,
      cacheConfiguration: true,
    });
  });
});
