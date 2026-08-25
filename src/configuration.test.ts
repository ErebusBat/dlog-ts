import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigurationLoader,
  dailyDocumentPath,
  entryPrefix,
  type ConfigurationEnvironment,
} from "./configuration.js";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dlog-config-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "vault"));
  return root;
}

function environment(
  root: string,
  variables: Readonly<NodeJS.ProcessEnv> = {},
): ConfigurationEnvironment {
  return { cwd: root, homeDirectory: root, variables };
}

function primaryToml(
  root: string,
  includePaths: readonly string[] = [],
): string {
  const includes = includePaths
    .map((path) => `\n[[includes]]\npath = ${JSON.stringify(path)}\n`)
    .join("");
  return `schema = "dlog-config/v1"
vault_roots = [${JSON.stringify(join(root, "vault"))}]
daily_path = "logs/%Y/%m-%b/%Y-%m-%d-%a.md"
entry_prefix = "- *%H:%M* - "
${includes}`;
}

async function writePrimary(
  root: string,
  includePaths: readonly string[] = [],
): Promise<string> {
  const path = join(root, "config.toml");
  await writeFile(path, primaryToml(root, includePaths), "utf8");
  return path;
}

function ruleFile(...rules: readonly string[]): string {
  return `schema = "dlog-rules/v1"\n${rules.join("\n")}`;
}

describe("configuration conformance", () => {
  test("CFG-01 loads one readable nonempty configuration model", async () => {
    const root = await testRoot();
    const path = await writePrimary(root);
    const loaded = await new ConfigurationLoader({
      environment: environment(root),
    }).load(path);

    expect(loaded.sourcePath).toBe(path);
    expect(loaded.vaultRoot).toBe(join(root, "vault"));
    expect(loaded.rules).toEqual([]);
  });

  test("CFG-02 fails clearly when no usable source exists", async () => {
    const root = await testRoot();
    const loader = new ConfigurationLoader({ environment: environment(root) });
    await expect(loader.discover()).rejects.toThrow(
      "expected ~/.config/dlog/config.toml",
    );
  });

  test("CFG-03 resolves relative includes from the primary parent", async () => {
    const root = await testRoot();
    const configDirectory = join(root, "config");
    const workingDirectory = join(root, "working");
    await mkdir(join(configDirectory, "rules"), { recursive: true });
    await mkdir(workingDirectory);
    const primaryPath = join(configDirectory, "config.toml");
    await writeFile(
      primaryPath,
      primaryToml(root, ["rules/people.toml"]),
      "utf8",
    );
    await writeFile(
      join(configDirectory, "rules", "people.toml"),
      ruleFile(`[[rules]]\nkind = "prefix"\nmatch = "P"\nreplace = "People"`),
      "utf8",
    );

    const loaded = await new ConfigurationLoader({
      environment: { ...environment(root), cwd: workingDirectory },
    }).load(primaryPath);
    expect(loaded.rules).toHaveLength(1);
  });

  test("CFG-04 nested includes still resolve from the primary parent", async () => {
    const root = await testRoot();
    const rulesDirectory = join(root, "rules");
    await mkdir(rulesDirectory);
    const primaryPath = await writePrimary(root, ["rules/people.toml"]);
    await writeFile(
      join(rulesDirectory, "people.toml"),
      ruleFile(`[[includes]]\npath = "tools.toml"`),
      "utf8",
    );
    await writeFile(
      join(root, "tools.toml"),
      ruleFile(`[[rules]]\nkind = "prefix"\nmatch = "T"\nreplace = "Tools"`),
      "utf8",
    );

    const loaded = await new ConfigurationLoader({
      environment: environment(root),
    }).load(primaryPath);
    expect(loaded.rules).toHaveLength(1);
  });

  test("CFG-05 loads directory rule files in lexical filename order", async () => {
    const root = await testRoot();
    const rulesDirectory = join(root, "rules");
    await mkdir(rulesDirectory);
    const primaryPath = await writePrimary(root, ["rules"]);
    for (const [file, key] of [
      ["90-tools.toml", "T"],
      ["20-people.toml", "P"],
      ["10-base.toml", "B"],
    ] as const) {
      await writeFile(
        join(rulesDirectory, file),
        ruleFile(
          `[[rules]]\nkind = "prefix"\nmatch = "${key}"\nreplace = "${key}"`,
        ),
        "utf8",
      );
    }

    const loaded = await new ConfigurationLoader({
      environment: environment(root),
    }).load(primaryPath);
    expect(
      loaded.rules.map((rule) =>
        rule.phase === "prefix" ? rule.key : "unexpected",
      ),
    ).toEqual(["B", "P", "T"]);
  });

  test("CFG-06 rejects duplicate prefix keys", async () => {
    const root = await testRoot();
    const primaryPath = await writePrimary(root, ["rules.toml"]);
    await writeFile(
      join(root, "rules.toml"),
      ruleFile(
        `[[rules]]\nkind = "prefix"\nmatch = "W"\nreplace = "Work"`,
        `[[rules]]\nkind = "prefix"\nmatch = "W"\nreplace = "Double"`,
      ),
      "utf8",
    );

    await expect(
      new ConfigurationLoader({ environment: environment(root) }).load(
        primaryPath,
      ),
    ).rejects.toThrow("Duplicate prefix substitution key: W");
  });

  test("CFG-07 links share the global duplicate namespace", async () => {
    const root = await testRoot();
    const primaryPath = await writePrimary(root, ["rules.toml"]);
    await writeFile(
      join(root, "rules.toml"),
      ruleFile(
        `[[rules]]\nkind = "global"\nmatch = "PAGE"\nreplace = "value"`,
        `[[rules]]\nkind = "link"\nmatch = "PAGE"\npage = "Page"`,
      ),
      "utf8",
    );

    await expect(
      new ConfigurationLoader({ environment: environment(root) }).load(
        primaryPath,
      ),
    ).rejects.toThrow("Duplicate global substitution key: PAGE");
  });

  test("CFG-08 rejects an empty wiki-link page", async () => {
    const root = await testRoot();
    const primaryPath = await writePrimary(root, ["rules.toml"]);
    await writeFile(
      join(root, "rules.toml"),
      ruleFile(`[[rules]]\nkind = "link"\nmatch = "PAGE"\npage = "   "`),
      "utf8",
    );

    await expect(
      new ConfigurationLoader({ environment: environment(root) }).load(
        primaryPath,
      ),
    ).rejects.toThrow("Page cannot be blank");
  });

  test("disabled fragments and rules validate but do not register", async () => {
    const root = await testRoot();
    const primaryPath = await writePrimary(root, [
      "disabled.toml",
      "rules.toml",
    ]);
    await writeFile(
      join(root, "disabled.toml"),
      `schema = "dlog-rules/v1"
enabled = false

[[rules]]
kind = "prefix"
match = "W"
replace = "Disabled"
`,
      "utf8",
    );
    await writeFile(
      join(root, "rules.toml"),
      ruleFile(
        `[[rules]]\nkind = "prefix"\nmatch = "W"\nreplace = "Work"`,
        `[[rules]]\nkind = "callback"\nmatch = "X"\nplugin = "missing"\nenabled = false`,
      ),
      "utf8",
    );

    const loaded = await new ConfigurationLoader({
      environment: environment(root),
    }).load(primaryPath);
    expect(loaded.rules).toHaveLength(1);
  });

  test("expands environment variables in path fields and applies strftime", async () => {
    const root = await testRoot();
    const primaryPath = join(root, "config.toml");
    await writeFile(
      primaryPath,
      `schema = "dlog-config/v1"
vault_roots = ["$TEST_VAULT"]
daily_path = "logs/%Y/%m-%b/%Y-%m-%d-%a.md"
entry_prefix = "- *%H:%M* - "
`,
      "utf8",
    );
    const loaded = await new ConfigurationLoader({
      environment: environment(root, { TEST_VAULT: join(root, "vault") }),
    }).load(primaryPath);
    const now = new Date(2025, 6, 25, 10, 30);

    expect(dailyDocumentPath(loaded, now)).toBe(
      join(root, "vault", "logs/2025/07-Jul/2025-07-25-Fri.md"),
    );
    expect(entryPrefix(loaded, "Entry", now)).toBe("- *10:30* - ");
  });

  test("rejects an unset environment variable in a path", async () => {
    const root = await testRoot();
    const primaryPath = join(root, "config.toml");
    await writeFile(
      primaryPath,
      `schema = "dlog-config/v1"
vault_roots = ["$MISSING_VAULT"]
daily_path = "daily.md"
entry_prefix = ""
`,
      "utf8",
    );
    await expect(
      new ConfigurationLoader({ environment: environment(root) }).load(
        primaryPath,
      ),
    ).rejects.toThrow("Environment variable MISSING_VAULT is not set");
  });

  test("requires explicit config and rule schema markers", async () => {
    const root = await testRoot();
    const primaryPath = join(root, "config.toml");
    await writeFile(
      primaryPath,
      `vault_roots = [${JSON.stringify(join(root, "vault"))}]\ndaily_path = "x"\nentry_prefix = ""\n`,
      "utf8",
    );
    await expect(
      new ConfigurationLoader({ environment: environment(root) }).load(
        primaryPath,
      ),
    ).rejects.toThrow("schema");
  });

  test("CFG-13 loads [tail] defaults", async () => {
    const root = await testRoot();
    const primaryPath = join(root, "config.toml");
    await writeFile(
      primaryPath,
      `${primaryToml(root)}[tail]\ntruncate = true\nwidth = 20\n`,
      "utf8",
    );
    const loaded = await new ConfigurationLoader({
      environment: environment(root),
    }).load(primaryPath);

    expect(loaded.tail).toEqual({ truncate: true, width: 20 });
  });

  test("CFG-14 defaults omitted tail settings to non-truncating output", async () => {
    const root = await testRoot();
    const primaryPath = await writePrimary(root);
    const loaded = await new ConfigurationLoader({
      environment: environment(root),
    }).load(primaryPath);

    expect(loaded.tail).toEqual({ truncate: false });
  });

  test("CFG-15 rejects a non-positive [tail] width", async () => {
    const root = await testRoot();
    const primaryPath = join(root, "config.toml");
    await writeFile(
      primaryPath,
      `${primaryToml(root)}[tail]\nwidth = 0\n`,
      "utf8",
    );
    await expect(
      new ConfigurationLoader({ environment: environment(root) }).load(primaryPath),
    ).rejects.toThrow();
  });
});
