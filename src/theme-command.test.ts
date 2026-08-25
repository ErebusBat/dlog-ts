import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandIO } from "./append-command.js";
import {
  ConfigurationLoader,
  type ConfigurationEnvironment,
} from "./configuration.js";
import { DlogError } from "./dlog-error.js";
import {
  parseThemeOptions,
  ThemeCommand,
  type ThemeCommandOptions,
} from "./theme-command.js";
import {
  dumpTheme,
  resolveColorLevel,
  ThemeLoader,
  ThemeStyler,
} from "./theme.js";

const temporaryDirectories: string[] = [];

class TestIO implements CommandIO {
  public output = "";
  public error = "";
  public outputIsTerminal = false;
  public columns: number | undefined;

  public writeOutput(text: string): void {
    this.output += text;
  }

  public writeError(text: string): void {
    this.error += text;
  }

  public async readLine(): Promise<string> {
    return "";
  }

  public isOutputTerminal(): boolean {
    return this.outputIsTerminal;
  }

  public outputColumns(): number | undefined {
    return this.columns;
  }
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function themeFixture(options?: {
  readonly themeSource?: string;
  readonly environmentTheme?: string;
}): Promise<{
  readonly root: string;
  readonly io: TestIO;
  readonly loader: ThemeLoader;
}> {
  const root = await mkdtemp(join(tmpdir(), "dlog-theme-"));
  temporaryDirectories.push(root);
  const variables: Record<string, string> = {};
  if (options?.themeSource !== undefined) {
    await writeFile(join(root, "theme.toml"), options.themeSource, "utf8");
  }
  if (options?.environmentTheme !== undefined) {
    variables["DLOG_THEME"] = options.environmentTheme;
  }
  const environment: ConfigurationEnvironment = {
    cwd: root,
    homeDirectory: root,
    variables,
  };
  const configurationLoader = new ConfigurationLoader({ environment });
  return {
    root,
    io: new TestIO(),
    loader: new ThemeLoader({ configurationLoader, environment }),
  };
}

const DEFAULT_OPTIONS: ThemeCommandOptions = {
  preview: false,
  swatches: false,
  check: false,
  dump: false,
  silent: false,
  color: "never",
};

describe("theme option parsing", () => {
  test("defaults to preview and supports positive action selection", () => {
    expect(parseThemeOptions([])).toEqual({
      ...DEFAULT_OPTIONS,
      preview: true,
      color: "auto",
    });
    expect(parseThemeOptions(["--check"])).toEqual({
      ...DEFAULT_OPTIONS,
      check: true,
      color: "auto",
    });
    expect(parseThemeOptions(["--preview", "--swatches", "--dump"])).toEqual({
      ...DEFAULT_OPTIONS,
      preview: true,
      swatches: true,
      dump: true,
      color: "auto",
    });
  });

  test("negative flags override in argument order and may select no actions", () => {
    expect(
      parseThemeOptions(["--check", "--no-check", "--preview", "--no-preview"]),
    ).toEqual({ ...DEFAULT_OPTIONS, color: "auto" });
    expect(parseThemeOptions(["--no-preview"])).toEqual({
      ...DEFAULT_OPTIONS,
      color: "auto",
    });
  });
});

describe("theme loading and rendering", () => {
  test("loads DLOG_THEME relative to cwd and merges partial role overrides", async () => {
    const fixture = await themeFixture({
      environmentTheme: "custom.toml",
    });
    await writeFile(
      join(fixture.root, "custom.toml"),
      `schema = "dlog-theme/v1"

[roles.timestamp]
fg = "#a1b2c3"
bold = true
`,
      "utf8",
    );

    const loaded = await fixture.loader.loadStandalone();
    expect(loaded.source).toEqual({
      kind: "file",
      path: join(fixture.root, "custom.toml"),
    });
    expect(loaded.theme.timestamp).toMatchObject({
      inherit: false,
      fg: "#A1B2C3",
      bold: true,
      italic: true,
    });
    expect(new ThemeStyler(loaded.theme, 3).apply("timestamp", "09:42")).toBe(
      "\x1b[38;2;161;178;195m\x1b[1m\x1b[3m09:42\x1b[23m\x1b[22m\x1b[39m",
    );
  });

  test("visible inline roles cancel inherited hidden message styling", async () => {
    const fixture = await themeFixture({ environmentTheme: "visible.toml" });
    await writeFile(
      join(fixture.root, "visible.toml"),
      `schema = "dlog-theme/v1"
[roles.message]
hidden = true

[roles.strong]
visible = true
`,
      "utf8",
    );

    const loaded = await fixture.loader.loadStandalone();
    const rendered = new ThemeStyler(loaded.theme, 3).apply(
      "strong",
      "shown",
      "message",
    );
    expect(rendered).not.toContain("\x1b[8m");
    expect(rendered).toContain("\x1b[1mshown");
  });
  test("rejects unknown theme fields and conflicting visibility", async () => {
    const fixture = await themeFixture({ environmentTheme: "bad.toml" });
    await writeFile(
      join(fixture.root, "bad.toml"),
      `schema = "dlog-theme/v1"

[roles.message]
unknown = true
hidden = true
visible = true
`,
      "utf8",
    );
    await expect(fixture.loader.loadStandalone()).rejects.toBeInstanceOf(
      DlogError,
    );
    await expect(fixture.loader.loadStandalone()).rejects.toThrow(
      /Invalid theme.*unrecognized key|Invalid theme.*unknown/is,
    );
  });

  test("config theme overrides the conventional sibling and resolves from config", async () => {
    const fixture = await themeFixture();
    const vault = join(fixture.root, "vault");
    await mkdir(vault);
    await writeFile(
      join(fixture.root, "dlog.toml"),
      `schema = "dlog-config/v1"
vault_roots = ["vault"]
daily_path = "daily.md"
entry_prefix = "- *%H:%M* - "
theme = "selected.toml"
`,
      "utf8",
    );
    await writeFile(
      join(fixture.root, "selected.toml"),
      `schema = "dlog-theme/v1"
[roles.date]
fg = "red"
`,
      "utf8",
    );
    await writeFile(
      join(fixture.root, "theme.toml"),
      `schema = "dlog-theme/v1"
[roles.date]
fg = "blue"
`,
      "utf8",
    );

    const loaded = await fixture.loader.loadStandalone();
    expect(loaded.source).toEqual({
      kind: "file",
      path: join(fixture.root, "selected.toml"),
    });
    expect(loaded.theme.date.fg).toBe("red");
  });

  test("uses a conventional sibling theme when config has no override", async () => {
    const fixture = await themeFixture({
      themeSource: `schema = "dlog-theme/v1"
[roles.date]
fg = "blue"
`,
    });
    const vault = join(fixture.root, "vault");
    await mkdir(vault);
    await writeFile(
      join(fixture.root, "dlog.toml"),
      `schema = "dlog-config/v1"
vault_roots = ["vault"]
daily_path = "daily.md"
entry_prefix = "- *%H:%M* - "
`,
      "utf8",
    );

    const loaded = await fixture.loader.loadStandalone();
    expect(loaded.source).toEqual({
      kind: "file",
      path: join(fixture.root, "theme.toml"),
    });
    expect(loaded.theme.date.fg).toBe("blue");
  });

  test("missing explicit theme path is an error", async () => {
    const fixture = await themeFixture({ environmentTheme: "missing.toml" });
    await expect(fixture.loader.loadStandalone()).rejects.toThrow(
      `Theme file does not exist or is not readable: ${join(fixture.root, "missing.toml")}`,
    );
  });

  test("uses built-in theme when no config or theme exists", async () => {
    const fixture = await themeFixture();
    const loaded = await fixture.loader.loadStandalone();
    expect(loaded.source).toEqual({ kind: "built-in" });
    expect(loaded.theme.list_marker.fg).toBe("magenta");
  });

  test("dump is a complete non-inheriting canonical TOML snapshot", async () => {
    const fixture = await themeFixture();
    const loaded = await fixture.loader.loadStandalone();
    const dumped = dumpTheme(loaded.theme);

    expect(dumped).toStartWith('schema = "dlog-theme/v1"\n');
    expect(dumped.match(/inherit = false/g)).toHaveLength(10);
    expect(dumped).toContain("[roles.external_link]");
    expect(dumped).toContain('fg = "cyan"');
    expect(dumped).toContain("strikethrough = false");
  });
});

describe("theme command", () => {
  test("default preview is deterministic and reports the source", async () => {
    const fixture = await themeFixture();
    const command = new ThemeCommand({
      io: fixture.io,
      themeLoader: fixture.loader,
      environment: {},
    });

    expect(
      await command.run({
        ...DEFAULT_OPTIONS,
        preview: true,
      }),
    ).toBe(0);
    expect(fixture.io.error).toBe("Theme: built-in default\n");
    expect(fixture.io.output).toContain("2025-07-25-Fri\nLog\n");
    expect(fixture.io.output).toContain(
      "- 09:42 - Plain strong emphasis wiki link external link\n",
    );
  });

  test("dump and swatches combine in order while silent suppresses source", async () => {
    const fixture = await themeFixture();
    const command = new ThemeCommand({
      io: fixture.io,
      themeLoader: fixture.loader,
      environment: {},
    });

    expect(
      await command.run({
        ...DEFAULT_OPTIONS,
        swatches: true,
        dump: true,
        silent: true,
      }),
    ).toBe(0);
    expect(fixture.io.error).toBe("");
    expect(fixture.io.output.indexOf("date")).toBeLessThan(
      fixture.io.output.indexOf('schema = "dlog-theme/v1"'),
    );
  });

  test("zero actions succeeds without loading or output", async () => {
    const fixture = await themeFixture({ environmentTheme: "missing.toml" });
    const command = new ThemeCommand({
      io: fixture.io,
      themeLoader: fixture.loader,
      environment: {},
    });

    expect(await command.run(DEFAULT_OPTIONS)).toBe(0);
    expect(fixture.io.output).toBe("");
    expect(fixture.io.error).toBe("");
  });
});

describe("color policy", () => {
  test("CLI modes outrank environment controls", () => {
    expect(resolveColorLevel("always", false, { NO_COLOR: "1" })).toBe(3);
    expect(resolveColorLevel("never", true, { FORCE_COLOR: "3" })).toBe(0);
  });

  test("auto honors FORCE_COLOR before NO_COLOR and terminal detection", () => {
    expect(
      resolveColorLevel("auto", false, {
        FORCE_COLOR: "2",
        NO_COLOR: "1",
      }),
    ).toBe(2);
    expect(resolveColorLevel("auto", true, { FORCE_COLOR: "0" })).toBe(0);
    expect(resolveColorLevel("auto", true, { NO_COLOR: "1" })).toBe(0);
    expect(resolveColorLevel("auto", false, {})).toBe(0);
  });
});
