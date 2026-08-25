import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandIO } from "./append-command.js";
import {
  ConfigurationLoader,
  type ConfigurationEnvironment,
} from "./configuration.js";
import { parseRulesOptions, RulesCommand } from "./rules-command.js";

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
  public outputIsTerminal = false;

  public isOutputTerminal(): boolean {
    return this.outputIsTerminal;
  }

  public writeOutput(value: string): void {
    this.output += value;
  }

  public writeError(_value: string): void {}

  public async readLine(): Promise<string> {
    return "";
  }
}

interface RulesFixture {
  readonly root: string;
  readonly io: TestIO;
  readonly command: RulesCommand;
}

async function rulesFixture(): Promise<RulesFixture> {
  const root = await mkdtemp(join(tmpdir(), "dlog-rules-command-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "vault"));
  await mkdir(join(root, "rules"));
  const configPath = join(root, "config.toml");
  await writeFile(
    configPath,
    `schema = "dlog-config/v1"
vault_roots = ["${join(root, "vault")}"]
daily_path = "daily.md"
entry_prefix = "- *%H:%M* - "

[[includes]]
path = "rules"
`,
    "utf8",
  );
  await writeFile(
    join(root, "rules", "000-first.toml"),
    `schema = "dlog-rules/v1"

[[plugins]]
name = "MyPlugin"
protocol = "json"
command = "~/bin/My Plugin"
arguments = ["--mode", "one two"]

[[rules]]
kind = "prefix"
match = "+1"
replace = "👍"

[[rules]]
kind = "global"
match = " AI "
replace = " 🤖 "

[[rules]]
kind = "global"
match = ":check:"
replace = "✅"

[[rules]]
kind = "prefix"
match = "TODO"
replace = "✅"

[[rules]]
kind = "link"
match = "disabled"
page = "Disabled"
enabled = false
`,
    "utf8",
  );
  await writeFile(
    join(root, "rules", "010-more.toml"),
    `schema = "dlog-rules/v1"

[[rules]]
kind = "link"
match = "Lucy"
page = "People/Lucy"
display = "Lucy"

[[rules]]
kind = "callback"
pattern = "ISSUE-[0-9]+"
flags = "i"
plugin = "MyPlugin"
`,
    "utf8",
  );
  await writeFile(
    join(root, "rules", "020-disabled.toml"),
    `schema = "dlog-rules/v1"
enabled = false

[[rules]]
kind = "global"
match = "disabled"
replace = "ignored"
`,
    "utf8",
  );

  const io = new TestIO();
  const environment: ConfigurationEnvironment = {
    cwd: root,
    homeDirectory: root,
    variables: { DLOG_CONFIG: configPath, HOME: root },
  };
  return {
    root,
    io,
    command: new RulesCommand({
      io,
      configurationLoader: new ConfigurationLoader({ environment }),
      environment: environment.variables,
    }),
  };
}

async function run(
  fixture: RulesFixture,
  arguments_: readonly string[],
): Promise<number> {
  const options = parseRulesOptions(arguments_);
  if (options === "help") {
    throw new Error("Test did not expect help");
  }
  return fixture.command.run(options);
}

describe("rules command", () => {
  test("RULES-01 lists every supported rule type without loading configuration", async () => {
    const fixture = await rulesFixture();

    expect(await run(fixture, [])).toBe(0);
    expect(fixture.io.output).toBe(`Kind      Description
---------------------
prefix    replace a literal match at the start of input
global    replace a literal match or pattern anywhere in input
callback  call an external plugin to handle replacement
link      replace a literal match with an Obsidian link
`);
  });

  test.each([
    ["prefix", 'kind = "prefix"', "+1 Report for Lucy"],
    ["global", 'kind = "global"', "Reviewed the AI report"],
    ["callback", 'kind = "callback"', "ISSUE-[0-9]+"],
    ["link", 'kind = "link"', "People/Lucy"],
  ] as const)(
    "RULES-02 shows detailed configuration and usage for %s rules",
    async (kind, configurationEvidence, exampleEvidence) => {
      const fixture = await rulesFixture();

      expect(await run(fixture, ["info", kind])).toBe(0);
      expect(fixture.io.output).toContain(configurationEvidence);
      expect(fixture.io.output).toContain("Configuration:\n");
      expect(fixture.io.output).toContain("[[rules]]");
      expect(fixture.io.output).toContain("Example:\nInput:  dlog append");
      expect(fixture.io.output).toContain(exampleEvidence);
      expect(fixture.io.output).toContain("Output: - *HH:MM* -");
    },
  );

  test("RULES-03 shows installed plugins with their source and parsed command", async () => {
    const fixture = await rulesFixture();

    expect(await run(fixture, ["plugin"])).toBe(0);
    expect(fixture.io.output).toBe(`~/rules/000-first.toml
json - MyPlugin
  command: ${JSON.stringify(join(fixture.root, "bin", "My Plugin"))} --mode "one two"
`);
  });

  test("RULES-04 prints each file, active kind counts, and an unconditional total", async () => {
    const fixture = await rulesFixture();

    expect(await run(fixture, ["print"])).toBe(0);
    expect(fixture.io.output).toBe(`┌─ ~/rules/000-first.toml
│
│  PLUGIN (1)
│
│  PREFIX rules (2)
│
│  GLOBAL rules (2)
│
└─ TOTAL rules (4)

┌─ ~/rules/010-more.toml
│
│  LINK rules (1)
│
│  CALLBACK rules (1)
│
└─ TOTAL rules (2)

┌─ ~/rules/020-disabled.toml
│
└─ TOTAL rules (0)
`);
  });

  test("RULES-05 frames files, separates sections, and preserves alternating rule order", async () => {
    const fixture = await rulesFixture();

    expect(await run(fixture, ["print", "--rules", "--color=never"])).toBe(0);
    expect(fixture.io.output).toBe(`┌─ ~/rules/000-first.toml
│
│  PLUGIN (1)
│  json - MyPlugin
│
│  PREFIX rules (1)
│  \`+1\` => \`👍\`
│
│  GLOBAL rules (2)
│  \` AI \`    => \` 🤖 \`
│  \`:check:\` => \`✅\`
│
│  PREFIX rules (1)
│  \`TODO\` => \`✅\`
│
└─ TOTAL rules (4)

┌─ ~/rules/010-more.toml
│
│  LINK rules (1)
│  \`Lucy\` => \`[[People/Lucy|Lucy]]\`
│
│  CALLBACK rules (1)
│  \`/ISSUE-[0-9]+/i\` => \`plugin:MyPlugin\`
│
└─ TOTAL rules (2)

┌─ ~/rules/020-disabled.toml
│
└─ TOTAL rules (0)
`);
  });

  test("RULES-06 detailed print uses white-on-black values with red backticks", async () => {
    const fixture = await rulesFixture();

    expect(await run(fixture, ["print", "--rules", "--color=always"])).toBe(0);
    const styledInput =
      "\u001b[31m`\u001b[39m\u001b[40m\u001b[37m+1\u001b[39m\u001b[49m\u001b[31m`\u001b[39m";
    const styledOutput =
      "\u001b[31m`\u001b[39m\u001b[40m\u001b[37m👍\u001b[39m\u001b[49m\u001b[31m`\u001b[39m";
    expect(fixture.io.output).toContain(`${styledInput} => ${styledOutput}`);
    expect(Bun.stripANSI(fixture.io.output)).toContain(
      "\n│  \` AI \`    => \` 🤖 \`\n",
    );
  });

  test("RULES-07 rejects unknown rule types and print options", () => {
    expect(() => parseRulesOptions(["info", "missing"])).toThrow(
      "Unknown rule type: missing",
    );
    expect(() => parseRulesOptions(["print", "--unknown"])).toThrow(
      "Unknown rules print option: --unknown",
    );
  });
});
