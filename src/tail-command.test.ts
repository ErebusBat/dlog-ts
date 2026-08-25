import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  readonly #date: Date;

  public constructor(date: Date = NOW) {
    this.#date = date;
  }

  public now(): Date {
    return new Date(this.#date);
  }

  public monotonicSeconds(): number {
    return 0;
  }

  public async sleep(_seconds: number): Promise<void> {}
}

class ScriptedClock implements WatchClock {
  public wallTime: Date;
  public readonly sleeps: number[] = [];
  public readonly sleepActions: Array<() => void | Promise<void>> = [];

  public constructor(wallTime: Date) {
    this.wallTime = new Date(wallTime);
  }

  public now(): Date {
    return new Date(this.wallTime);
  }

  public monotonicSeconds(): number {
    return this.sleeps.reduce((total, seconds) => total + seconds, 0);
  }

  public async sleep(seconds: number): Promise<void> {
    this.sleeps.push(seconds);
    await this.sleepActions.shift()?.();
  }
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
  now: Date = NOW,
  clock: WatchClock = new FixedClock(now),
  keepWatching: () => boolean = () => false,
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
  const configurationLoader = new ConfigurationLoader({
    environment: configEnvironment,
  });
  const themeLoader = new ThemeLoader({
    configurationLoader,
    environment: configEnvironment,
  });
  return {
    documentPath: join(vault, "2025-07-25.md"),
    io,
    environment,
    dependencies: {
      io,
      configurationLoader,
      themeLoader,
      documentReader: new DailyDocumentReader(),
      documentWriter: new DailyDocumentWriter(),
      clock,
      hasher: new Sha256FileHasher(),
      logger: new RecordingLogger(),
      watchdogScheduler: new SystemWatchdogScheduler(),
      fatalExit: (status) => {
        throw new Error(`Unexpected fatal exit ${status}`);
      },
      keepWatching,
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
  const configurationLoader = new ConfigurationLoader({
    environment: configEnvironment,
  });
  const themeLoader = new ThemeLoader({
    configurationLoader,
    environment: configEnvironment,
  });
  return {
    documentPath,
    io,
    environment,
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
      environment,
    },
  };
}

const ESC = "\x1b[";
const DATE_HEADING = "2025-07-25-Fri\n";
const STYLED_DATE_HEADING = `${ESC}90m2025-07-25-Fri${ESC}39m\n`;
const STYLED_HEADING = `${ESC}36m${ESC}1mLog${ESC}22m${ESC}39m\n`;
const STYLED_MARKER = `${ESC}35m-${ESC}39m`;
const styledTime = (time: string): string =>
  `${ESC}33m${ESC}3m${time}${ESC}23m${ESC}39m`;
const STYLED_SEPARATOR = `${ESC}90m-${ESC}39m`;

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
      `${STYLED_DATE_HEADING}${STYLED_HEADING}${STYLED_MARKER} ${styledTime("09:00")} ${STYLED_SEPARATOR} Coffee${ESC}0m\n`,
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
      `${STYLED_DATE_HEADING}${STYLED_HEADING}${STYLED_MARKER} ${styledTime("10:30")} ${STYLED_SEPARATOR} Shipped ${ESC}1mrelease${ESC}22m build${ESC}0m\n`,
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
      `${STYLED_DATE_HEADING}${STYLED_HEADING}${STYLED_MARKER} ${styledTime("11:00")} ${STYLED_SEPARATOR} Reviewed ${ESC}34m${ESC}4mPage${ESC}24m${ESC}39m and ${ESC}34m${ESC}4mthe plan${ESC}24m${ESC}39m; keep [[oops${ESC}0m\n`,
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
      `${STYLED_DATE_HEADING}${STYLED_HEADING}${STYLED_MARKER} ${styledTime("12:00")} ${STYLED_SEPARATOR} Read ${ESC}36m${ESC}4mstatus${ESC}24m${ESC}39m${ESC}0m\n`,
    );
  });

  test("TAIL-05 auto, NO_COLOR, and never produce plain output; always overrides", async () => {
    const source = "# Log\n\n- *09:00* - [[Page]]\n";
    const plain = `${DATE_HEADING}Log\n- 09:00 - Page\n`;

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
      `${DATE_HEADING}Log\nNarrative note\n- [ ] ordinary task\n- 09:00 - Retained\n`,
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
    expect(fixture.io.output).toBe(`${DATE_HEADING}Log\n`);
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
    expect(fixture.io.output).toContain(STYLED_HEADING.trimEnd());
  });

  test("themes unordered markers and only valid canonical timestamps", async () => {
    const fixture = await tailFixture(
      "# Log\n\n+ *23:59* - Valid\n* *24:00* - Invalid\n- ordinary\n",
    );
    const status = await runCli(
      "dlog",
      ["tail", "--color=always"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(fixture.io.output).toContain(
      `${ESC}35m+${ESC}39m ${styledTime("23:59")} ${STYLED_SEPARATOR} Valid`,
    );
    expect(fixture.io.output).toContain(
      `${ESC}35m*${ESC}39m ${ESC}3m24:00${ESC}23m - Invalid`,
    );
    expect(fixture.io.output).toContain(`${ESC}35m-${ESC}39m ordinary`);
  });

  test("loads and validates a selected theme only when styling is enabled", async () => {
    const plain = await tailFixture("# Log\n\n- *09:00* - Coffee\n");
    plain.environment["DLOG_THEME"] = "missing-theme.toml";
    expect(
      await runCli("dlog", ["tail", "--color=never"], plain.dependencies),
    ).toBe(0);
    expect(plain.io.output).toBe(`${DATE_HEADING}Log\n- 09:00 - Coffee\n`);

    const styled = await tailFixture("# Log\n\n- *09:00* - Coffee\n");
    styled.environment["DLOG_THEME"] = "missing-theme.toml";
    expect(
      await runCli("dlog", ["tail", "--color=always"], styled.dependencies),
    ).toBe(1);
    expect(styled.io.error).toContain(
      "Theme file does not exist or is not readable",
    );
  });
});

describe("tail follow conformance", () => {
  test("TAIL-22 clears before drawing and redraws after a change", async () => {
    const clock = new ScriptedClock(NOW);
    let remainingPolls = 1;
    const fixture = await datedTailFixture(
      { "2025-07-25.md": datedDocument("Initial") },
      NOW,
      clock,
      () => remainingPolls-- > 0,
    );
    clock.sleepActions.push(async () => {
      await writeFile(fixture.documentPath, datedDocument("Updated"), "utf8");
    });

    const status = await runCli(
      "dlog",
      ["tail", "-f", "--color=never"],
      fixture.dependencies,
    );

    expect(status).toBe(0);
    expect(clock.sleeps).toEqual([1]);
    expect(fixture.io.output).toBe(
      "\x1b[2J\x1b[H2025-07-25-Fri\nLog\n- 09:00 - Initial\n" +
        "\x1b[2J\x1b[H2025-07-25-Fri\nLog\n- 09:00 - Updated\n",
    );
    expect(fixture.io.error).toBe("");
  });

  test("TAIL-23 keeps the previous display until the new day's file exists", async () => {
    const clock = new ScriptedClock(new Date(2025, 6, 25, 23, 59, 59));
    let remainingPolls = 2;
    const fixture = await datedTailFixture(
      { "2025-07-25.md": datedDocument("Friday") },
      clock.now(),
      clock,
      () => remainingPolls-- > 0,
    );
    let outputWhileSaturdayIsMissing = "";
    clock.sleepActions.push(
      () => {
        clock.wallTime = new Date(2025, 6, 26, 0, 0, 0);
      },
      async () => {
        outputWhileSaturdayIsMissing = fixture.io.output;
        await writeFile(
          join(dirname(fixture.documentPath), "2025-07-26.md"),
          datedDocument("Saturday"),
          "utf8",
        );
      },
    );

    const status = await runCli(
      "dlog",
      ["tail", "--follow", "--color=never"],
      fixture.dependencies,
    );

    const fridayDisplay =
      "\x1b[2J\x1b[H2025-07-25-Fri\nLog\n- 09:00 - Friday\n";
    expect(status).toBe(0);
    expect(clock.sleeps).toEqual([1, 1]);
    expect(outputWhileSaturdayIsMissing).toBe(fridayDisplay);
    expect(fixture.io.output).toBe(
      `${fridayDisplay}\x1b[2J\x1b[H2025-07-26-Sat\nLog\n- 09:00 - Saturday\n`,
    );
    expect(fixture.io.error).toBe("");
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
    expect(await runCli("dlog", ["tail", "monday"], fixture.dependencies)).toBe(
      0,
    );
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
    const status = await runCli("dlog", ["tail", "0709"], fixture.dependencies);

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
  test("TAIL-20 -w selects the previous weekday on Friday and Monday", async () => {
    const friday = await datedTailFixture({
      "2025-07-24.md": datedDocument("Thursday entry"),
    });
    expect(await runCli("dlog", ["tail", "-w"], friday.dependencies)).toBe(0);
    expect(friday.io.output).toStartWith("2025-07-24-Thu\nLog\n");
    expect(friday.io.output).toContain("Thursday entry");

    const monday = await datedTailFixture(
      { "2025-07-18.md": datedDocument("Previous Friday entry") },
      new Date(2025, 6, 21, 10, 30, 0, 0),
    );
    expect(await runCli("dlog", ["tail", "-w"], monday.dependencies)).toBe(0);
    expect(monday.io.output).toStartWith("2025-07-18-Fri\nLog\n");
    expect(monday.io.output).toContain("Previous Friday entry");
  });
});

describe("tail option parsing", () => {
  test("parses follow shorthand, long form, and color values", () => {
    expect(parseTailOptions([])).toEqual({
      color: "auto",
      follow: false,
      previousWeekday: false,
    });
    expect(parseTailOptions(["-f"])).toEqual({
      color: "auto",
      follow: true,
      previousWeekday: false,
    });
    expect(parseTailOptions(["--follow"])).toEqual({
      color: "auto",
      follow: true,
      previousWeekday: false,
    });
    expect(parseTailOptions(["--color", "never"])).toEqual({
      color: "never",
      follow: false,
      previousWeekday: false,
    });
    expect(parseTailOptions(["--color=always"])).toEqual({
      color: "always",
      follow: false,
      previousWeekday: false,
    });
  });

  test("returns help for -h and --help", () => {
    expect(parseTailOptions(["--help"])).toBe("help");
    expect(parseTailOptions(["-h"])).toBe("help");
  });

  test("accepts a positional date alongside options", () => {
    expect(parseTailOptions(["-1"])).toEqual({
      color: "auto",
      follow: false,
      previousWeekday: false,
      date: "-1",
    });
    expect(parseTailOptions(["--color=never", "mon"])).toEqual({
      color: "never",
      follow: false,
      previousWeekday: false,
      date: "mon",
    });
    expect(parseTailOptions(["--", "-1"])).toEqual({
      color: "auto",
      follow: false,
      previousWeekday: false,
      date: "-1",
    });
  });

  test("parses -w and rejects combining it with a date", () => {
    expect(parseTailOptions(["-w"])).toEqual({
      color: "auto",
      follow: false,
      previousWeekday: true,
    });
    expect(() => parseTailOptions(["-w", "-1"])).toThrow(
      "Option -w cannot be combined with a date argument",
    );
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
    expect(() => parseTailOptions(["--sometimes"])).toThrow(
      "Unknown tail option: --sometimes",
    );
    expect(() => parseTailOptions(["--watch"])).toThrow(
      "Unknown tail option: --watch",
    );
  });
});
