import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExternalToolRunner, PluginExecutor } from "./external-tools.js";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dlog-tools-"));
  temporaryDirectories.push(path);
  return path;
}

async function executableFixture(
  directory: string,
  name: string,
  body: string,
): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("external-tool conformance", () => {
  test("TOOL-01 resolves a bare executable through PATH and trims output", async () => {
    const root = await temporaryDirectory();
    await executableFixture(root, "result-tool", "printf ' result \\n'");
    const tools = new ExternalToolRunner({
      cwd: root,
      environment: { PATH: root },
    });

    const result = await tools.runTool("result-tool");
    expect(result.output).toBe("result");
    expect(tools.toolSuccess).toBe(true);
    expect(tools.toolError).toBe(false);
  });

  test("TOOL-02 caches a negative nonexecutable resolution", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "disabled-tool");
    await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
    const tools = new ExternalToolRunner({
      cwd: root,
      environment: { PATH: root },
    });

    expect(await tools.hasTool("disabled-tool")).toBe(false);
    await chmod(path, 0o755);
    expect(await tools.hasTool("disabled-tool")).toBe(false);
  });

  test("TOOL-03 retains output and nonzero status", async () => {
    const root = await temporaryDirectory();
    await executableFixture(root, "failure-tool", "printf 'captured'; exit 4");
    const tools = new ExternalToolRunner({
      cwd: root,
      environment: { PATH: root },
    });

    const result = await tools.runTool("failure-tool");
    expect(result.output).toBe("captured");
    expect(result.status).toBe(4);
    expect(tools.toolError).toBe(true);
  });

  test("TOOL-04 selecting a tool clears output and sets failure sentinel", async () => {
    const root = await temporaryDirectory();
    await executableFixture(root, "selected-tool", "printf 'unused'");
    const tools = new ExternalToolRunner({
      cwd: root,
      environment: { PATH: root },
    });

    expect(await tools.selectTool("selected-tool")).toBe(true);
    expect(tools.toolOutput).toBeNull();
    expect(tools.toolStatus).not.toBe(0);
  });

  test("TOOL-05 resolves relative path-like names from process cwd", async () => {
    const root = await temporaryDirectory();
    await executableFixture(root, "relative-tool", "printf 'relative'");
    const tools = new ExternalToolRunner({
      cwd: root,
      environment: { PATH: "" },
    });

    expect((await tools.runTool("./relative-tool")).output).toBe("relative");
  });

  test("TOOL-06 reruns the selected executable with fresh explicit argv", async () => {
    const root = await temporaryDirectory();
    await executableFixture(
      root,
      "argument-tool",
      'printf \'%s|%s\' "$1" "$2"',
    );
    const tools = new ExternalToolRunner({
      cwd: root,
      environment: { PATH: root },
    });

    expect(
      (await tools.runTool("argument-tool", ["first", "value"])).output,
    ).toBe("first|value");
    const rerun = await tools.runSelected(["hello world", "$HOME"]);
    expect(rerun.output).toBe("hello world|$HOME");
    expect(tools.toolStatus).toBe(0);
  });
});

describe("external callback protocols", () => {
  test("raw text sends the exact match on stdin and uses trimmed stdout", async () => {
    const root = await temporaryDirectory();
    await executableFixture(
      root,
      "raw-plugin",
      "input=$(cat); printf '  [%s]  ' \"$input\"",
    );
    const tools = new ExternalToolRunner({
      cwd: root,
      environment: { PATH: `${root}:/bin:/usr/bin` },
    });
    const plugins = new PluginExecutor(
      [
        {
          name: "raw",
          protocol: "text",
          command: "raw-plugin",
          arguments: [],
        },
      ],
      tools,
    );

    await expect(
      plugins.execute({
        plugin: "raw",
        fullEntryBeforeRule: "Call 123",
        matchedText: "123",
      }),
    ).resolves.toEqual({ action: "replace", value: "[123]" });
  });

  test("raw text maps empty successful output to delete", async () => {
    const root = await temporaryDirectory();
    await executableFixture(root, "empty-plugin", "cat >/dev/null");
    const plugins = new PluginExecutor(
      [
        {
          name: "empty",
          protocol: "text",
          command: "empty-plugin",
          arguments: [],
        },
      ],
      new ExternalToolRunner({
        cwd: root,
        environment: { PATH: `${root}:/bin:/usr/bin` },
      }),
    );

    await expect(
      plugins.execute({
        plugin: "empty",
        fullEntryBeforeRule: "remove",
        matchedText: "remove",
      }),
    ).resolves.toEqual({ action: "delete" });
  });

  test("JSON protocol validates the discriminated callback response", async () => {
    const root = await temporaryDirectory();
    await executableFixture(
      root,
      "json-plugin",
      'cat >/dev/null; printf \'{"action":"replace","value":"done"}\'',
    );
    const plugins = new PluginExecutor(
      [
        {
          name: "json",
          protocol: "json",
          command: "json-plugin",
          arguments: [],
        },
      ],
      new ExternalToolRunner({
        cwd: root,
        environment: { PATH: `${root}:/bin:/usr/bin` },
      }),
    );

    await expect(
      plugins.execute({
        plugin: "json",
        fullEntryBeforeRule: "before",
        matchedText: "match",
      }),
    ).resolves.toEqual({ action: "replace", value: "done" });
  });

  test("nonzero plugin status is an error", async () => {
    const root = await temporaryDirectory();
    await executableFixture(root, "bad-plugin", "printf 'bad' >&2; exit 9");
    const plugins = new PluginExecutor(
      [
        {
          name: "bad",
          protocol: "text",
          command: "bad-plugin",
          arguments: [],
        },
      ],
      new ExternalToolRunner({
        cwd: root,
        environment: { PATH: `${root}:/bin:/usr/bin` },
      }),
    );

    await expect(
      plugins.execute({
        plugin: "bad",
        fullEntryBeforeRule: "before",
        matchedText: "match",
      }),
    ).rejects.toThrow("status 9: bad");
  });
});
