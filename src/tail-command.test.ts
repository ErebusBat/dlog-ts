import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandIO } from "./append-command.js";
import { runCli, type CliDependencies } from "./cli.js";
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
import { parseTailOptions, resolveTailDate } from "./tail-command.js";

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

interface TailFixture {
  readonly documentPath: string;
  readonly io: TestIO;
  readonly dependencies: CliDependencies;
  readonly environment: Record<string, string>;
}

async function datedTailFixture(
  documents: Record<string, string>,
): Promise<TailFixture> {
  const root = await mkdtemp(join(tmpdir(), "dlog-tail-"));
  temporaryDirectories.push(root);
  const vault = join(root, "vault");
  await mkdir(vault);
  for (const [name, source] of Object.entries(documents)) {
    await writeFile(join(vault, name), source, "utf8");
  }
  const configPath = join(root, "config.toml");
  await writeFile(
    configPath,
    `schema = "dlog-config/v1"
vault_roots = [${JSON.stringify(vault)}]
daily_path = "%Y-%m-%d.md"
entry_prefix = "- *%H:%M* - "
`,
    "utf8",
  );

  const io = new TestIO();
  const environment: Record<string, string> = {
    DLOG_CONFIG: configPath,
    PATH: process.env["PATH"] ?? "",
  };
  const configEnvironment: ConfigurationEnvironment = {
    cwd: root,
    homeDirectory: root,
    variables: environment,
  };
  return {
    documentPath: join(vault, "2025-07-25.md"),
    io,
    environment,
    dependencies: {
      io,
      configurationLoader: new ConfigurationLoader({
        environment: configEnvironment,
      }),
      documentReader: new DailyDocumentReader(),
      documentWriter: new DailyDocumentWriter(),
      clock: new FixedClock(),
      hasher: new Sha256FileHasher(),
      logger: new RecordingLogger(),
      watchdogScheduler: new SystemWatchdogScheduler(),
      fatalExit: (status) => {
        throw new Error(`Unexpected fatal exit ${status}`);
      },
      cwd: root,
      environment,
    },
  };
}

function datedDocument(label: string): string {
  return `# Log\n\n- *09:00* - ${label}\n`;
}

async function tailFixture(documentSource: string): Promise<TailFixture> {
  const root = await mkdtemp(join(tmpdir(), "dlog-tail-"));
  temporaryDirectories.push(root);
  const vault = join(root, "vault");
  await mkdir(vault);
  const documentPath = join(vault, "daily.md");
  await writeFile(documentPath, documentSource, "utf8");
  const configPath = join(root, "config.toml");
  await writeFile(
    configPath,
    `schema = "dlog-config/v1"
vault_roots = [${JSON.stringify(vault)}]
daily_path = "daily.md"
entry_prefix = "- *%H:%M* - "
`,
    "utf8",
  );

  const io = new TestIO();
  const environment: Record<string, string> = {
    DLOG_CONFIG: configPath,
    PATH: process.env["PATH"] ?? "",
  };
  const configEnvironment: ConfigurationEnvironment = {
    cwd: root,
    homeDirectory: root,
    variables: environment,
  };
  return {
    documentPath,
    io,
    environment,
    dependencies: {
      io,
      configurationLoader: new ConfigurationLoader({
        environment: configEnvironment,
      }),
      documentReader: new DailyDocumentReader(),
      documentWriter: new DailyDocumentWriter(),
      clock: new FixedClock(),
      hasher: new Sha256FileHasher(),
      logger: new RecordingLogger(),
      watchdogScheduler: new SystemWatchdogScheduler(),
      fatalExit: (status) => {
        throw new Error(`Unexpected fatal exit ${status}`);
      },
      cwd: root,
      environment,
    },
  };
}

const ESC = "\x1b[";

describe("tail CLI conformance", () => {
  test("TAIL-01 renders heading and entry with forced styling", async () => {
    const fixture = await tailFixture("# Log\n\n- *09:00* - Coffee\n");
    const status = await runCli(
      "dlog",
      ["tail", "--color=always"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toBe(
      `${ESC}1;36mLog${ESC}0m\n- ${ESC}3m09:00${ESC}0m - Coffee\n`,
    );
  });

  test("TAIL-02 renders bold and italic spans", async () => {
    const fixture = await tailFixture(
      "# Log\n\n- *10:30* - Shipped **release** build\n",
    );
    const status = await runCli(
      "dlog",
      ["tail", "--color=always"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toBe(
      `${ESC}1;36mLog${ESC}0m\n- ${ESC}3m10:30${ESC}0m - Shipped ${ESC}1mrelease${ESC}0m build\n`,
    );
  });

  test("TAIL-03 renders wiki links per Obsidian display rules", async () => {
    const fixture = await tailFixture(
      "# Log\n\n- *11:00* - Reviewed [[Page]] and [[Page|the plan]]; keep [[oops\n",
    );
    const status = await runCli(
      "dlog",
      ["tail", "--color=always"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toBe(
      `${ESC}1;36mLog${ESC}0m\n- ${ESC}3m11:00${ESC}0m - Reviewed ${ESC}4;34mPage${ESC}0m and ${ESC}4;34mthe plan${ESC}0m; keep [[oops\n`,
    );
  });

  test("TAIL-04 renders markdown links without the URL", async () => {
    const fixture = await tailFixture(
      "# Log\n\n- *12:00* - Read [status](https://example.com)\n",
    );
    const status = await runCli(
      "dlog",
      ["tail", "--color=always"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toBe(
      `${ESC}1;36mLog${ESC}0m\n- ${ESC}3m12:00${ESC}0m - Read ${ESC}4;34mstatus${ESC}0m\n`,
    );
  });

  test("TAIL-05 auto, NO_COLOR, and never produce plain output; always overrides", async () => {
    const source = "# Log\n\n- *09:00* - [[Page]]\n";
    const plain = "Log\n- 09:00 - Page\n";

    const piped = await tailFixture(source);
    expect(await runCli("dlog", ["tail"], piped.dependencies)).toBe(0);
    expect(piped.io.output).toBe(plain);

    const noColor = await tailFixture(source);
    noColor.io.outputIsTerminal = true;
    noColor.environment["NO_COLOR"] = "1";
    expect(await runCli("dlog", ["tail"], noColor.dependencies)).toBe(0);
    expect(noColor.io.output).toBe(plain);

    const never = await tailFixture(source);
    never.io.outputIsTerminal = true;
    expect(
      await runCli("dlog", ["tail", "--color=never"], never.dependencies),
    ).toBe(0);
    expect(never.io.output).toBe(plain);

    const forced = await tailFixture(source);
    forced.environment["NO_COLOR"] = "1";
    expect(
      await runCli("dlog", ["tail", "--color=always"], forced.dependencies),
    ).toBe(0);
    expect(forced.io.output).toContain(ESC);
  });

  test("TAIL-06 displays nonstandard lines in document order", async () => {
    const fixture = await tailFixture(
      "# Log\n\nNarrative note\n\n- [ ] ordinary task\n- *09:00* - Retained\n\n# Next\n\n- *08:00* - Hidden\n",
    );
    const status = await runCli("dlog", ["tail"], fixture.dependencies);

    expect(status).toBe(0);
    expect(fixture.io.output).toBe(
      "Log\nNarrative note\n- [ ] ordinary task\n- 09:00 - Retained\n",
    );
  });

  test("TAIL-07 missing # Log header fails without output or writes", async () => {
    const fixture = await tailFixture("# Notes\n\nNothing here\n");
    const before = await readFile(fixture.documentPath, "utf8");
    const status = await runCli("dlog", ["tail"], fixture.dependencies);

    expect(status).toBe(1);
    expect(fixture.io.output).toBe("");
    expect(fixture.io.error).toContain("No '# Log' section found");
    expect(await readFile(fixture.documentPath, "utf8")).toBe(before);
  });

  test("TAIL-08 empty section prints the heading only", async () => {
    const fixture = await tailFixture("# Log\n");
    const status = await runCli("dlog", ["tail"], fixture.dependencies);

    expect(status).toBe(0);
    expect(fixture.io.output).toBe("Log\n");
  });

  test("TAIL-09 never modifies the document", async () => {
    const fixture = await tailFixture(
      "# Log\n\n- *14:00* - Later\n- *09:00* - Earlier\n",
    );
    const before = await readFile(fixture.documentPath, "utf8");
    const status = await runCli(
      "dlog",
      ["tail", "--color=always"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toContain("14:00");
    expect(fixture.io.output.indexOf("14:00")).toBeLessThan(
      fixture.io.output.indexOf("09:00"),
    );
    expect(await readFile(fixture.documentPath, "utf8")).toBe(before);
  });

  test("dlog-tail argv0 alias infers tail", async () => {
    const fixture = await tailFixture("# Log\n\n- *09:00* - Coffee\n");
    const status = await runCli(
      "/tmp/dlog-tail",
      ["--color=always"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toContain(`${ESC}1;36mLog${ESC}0m`);
  });
});

describe("tail date resolution", () => {
  const cases: Array<[string, [number, number, number]]> = [
    ["-0", [2025, 6, 25]],
    ["-1", [2025, 6, 24]],
    ["-30", [2025, 5, 25]],
    ["Fri", [2025, 6, 25]],
    ["FRIDAY", [2025, 6, 25]],
    ["Monday", [2025, 6, 21]],
    ["sun", [2025, 6, 20]],
    ["9", [2025, 6, 9]],
    ["25", [2025, 6, 25]],
    ["0709", [2025, 6, 9]],
    ["1225", [2025, 11, 25]],
    ["2025-07-09", [2025, 6, 9]],
    ["07/09/2025", [2025, 6, 9]],
    ["July 9 2025", [2025, 6, 9]],
    ["Aug 9, 2026", [2026, 7, 9]],
  ];

  for (const [input, [year, month, day]] of cases) {
    test(`resolves ${input} to ${year}-${month + 1}-${day} at local midnight`, () => {
      const resolved = resolveTailDate(input, NOW);
      expect(resolved.getFullYear()).toBe(year);
      expect(resolved.getMonth()).toBe(month);
      expect(resolved.getDate()).toBe(day);
      expect(resolved.getHours()).toBe(0);
      expect(resolved.getMinutes()).toBe(0);
    });
  }

  test("rejects semantically invalid dates without falling through", () => {
    expect(() => resolveTailDate("0230", NOW)).toThrow("Invalid date: 0230");
    expect(() => resolveTailDate("2025", NOW)).toThrow("Invalid date: 2025");
    expect(() => resolveTailDate("32", NOW)).toThrow("Invalid date: 32");
    expect(() => resolveTailDate("2025-02-30", NOW)).toThrow(
      "Invalid date: 2025-02-30",
    );
  });

  test("rejects unparseable input", () => {
    expect(() => resolveTailDate("banana", NOW)).toThrow(
      "Cannot parse date: banana",
    );
  });
});

describe("tail date CLI conformance", () => {
  test("TAIL-10 selects the document from N days ago", async () => {
    const fixture = await datedTailFixture({
      "2025-07-24.md": datedDocument("Yesterday"),
      "2025-07-25.md": datedDocument("Today"),
    });
    const status = await runCli("dlog", ["tail", "-1"], fixture.dependencies);

    expect(status).toBe(0);
    expect(fixture.io.output).toContain("Yesterday");
    expect(fixture.io.output).not.toContain("Today");
  });

  test("TAIL-11 selects weekdays including today, case-insensitively", async () => {
    const fixture = await datedTailFixture({
      "2025-07-21.md": datedDocument("Monday entry"),
      "2025-07-25.md": datedDocument("Friday entry"),
    });

    expect(await runCli("dlog", ["tail", "Fri"], fixture.dependencies)).toBe(0);
    expect(fixture.io.output).toContain("Friday entry");

    fixture.io.output = "";
    expect(
      await runCli("dlog", ["tail", "monday"], fixture.dependencies),
    ).toBe(0);
    expect(fixture.io.output).toContain("Monday entry");
  });

  test("TAIL-12 selects a day of the current month", async () => {
    const fixture = await datedTailFixture({
      "2025-07-09.md": datedDocument("Ninth"),
    });
    const status = await runCli("dlog", ["tail", "9"], fixture.dependencies);

    expect(status).toBe(0);
    expect(fixture.io.output).toContain("Ninth");
  });

  test("TAIL-13 selects an MMDD date of the current year", async () => {
    const fixture = await datedTailFixture({
      "2025-07-09.md": datedDocument("Ninth"),
    });
    const status = await runCli(
      "dlog",
      ["tail", "0709"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toContain("Ninth");
  });

  test("TAIL-14 resolves fallback formats at local midnight", async () => {
    const fixture = await datedTailFixture({
      "2025-07-09.md": datedDocument("Ninth"),
    });

    for (const input of ["2025-07-09", "07/09/2025", "July 9 2025"]) {
      fixture.io.output = "";
      expect(await runCli("dlog", ["tail", input], fixture.dependencies)).toBe(
        0,
      );
      expect(fixture.io.output).toContain("Ninth");
    }
  });

  test("TAIL-15 and TAIL-16 reject invalid calendar dates", async () => {
    const fixture = await datedTailFixture({});

    expect(await runCli("dlog", ["tail", "0230"], fixture.dependencies)).toBe(
      1,
    );
    expect(fixture.io.error).toContain("Invalid date: 0230");

    fixture.io.error = "";
    expect(await runCli("dlog", ["tail", "2025"], fixture.dependencies)).toBe(
      1,
    );
    expect(fixture.io.error).toContain("Invalid date: 2025");
    expect(fixture.io.output).toBe("");
  });

  test("TAIL-17 rejects an unparseable date", async () => {
    const fixture = await datedTailFixture({});
    const status = await runCli(
      "dlog",
      ["tail", "banana"],
      fixture.dependencies,
    );

    expect(status).toBe(1);
    expect(fixture.io.error).toContain("Cannot parse date: banana");
  });

  test("TAIL-18 fails when the selected document does not exist", async () => {
    const fixture = await datedTailFixture({
      "2025-07-25.md": datedDocument("Today"),
    });
    const status = await runCli("dlog", ["tail", "-7"], fixture.dependencies);

    expect(status).toBe(1);
    expect(fixture.io.error).toContain("Daily document does not exist");
    expect(fixture.io.output).toBe("");
  });

  test("TAIL-19 accepts -0 as today", async () => {
    const fixture = await datedTailFixture({
      "2025-07-25.md": datedDocument("Today"),
    });
    const status = await runCli("dlog", ["tail", "-0"], fixture.dependencies);

    expect(status).toBe(0);
    expect(fixture.io.output).toContain("Today");
  });
});

describe("tail option parsing", () => {
  test("parses separated and inline --color values", () => {
    expect(parseTailOptions([])).toEqual({ color: "auto" });
    expect(parseTailOptions(["--color", "never"])).toEqual({ color: "never" });
    expect(parseTailOptions(["--color=always"])).toEqual({ color: "always" });
  });

  test("returns help for -h and --help", () => {
    expect(parseTailOptions(["--help"])).toBe("help");
    expect(parseTailOptions(["-h"])).toBe("help");
  });

  test("accepts a positional date alongside options", () => {
    expect(parseTailOptions(["-1"])).toEqual({ color: "auto", date: "-1" });
    expect(parseTailOptions(["--color=never", "mon"])).toEqual({
      color: "never",
      date: "mon",
    });
    expect(parseTailOptions(["--", "-1"])).toEqual({
      color: "auto",
      date: "-1",
    });
  });

  test("rejects a second positional argument", () => {
    expect(() => parseTailOptions(["9", "10"])).toThrow(
      "Unexpected extra tail argument: 10",
    );
  });

  test("rejects an invalid color value and unknown options", () => {
    expect(() => parseTailOptions(["--color", "sometimes"])).toThrow(
      "--color requires one of: auto, always, never",
    );
    expect(() => parseTailOptions(["--watch"])).toThrow(
      "Unknown tail option: --watch",
    );
  });
});
