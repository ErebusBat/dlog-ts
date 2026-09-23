import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const justfile = fileURLToPath(new URL("../justfile", import.meta.url));

test("INSTALL-01 replaces the inode and preserves the installed binary on copy failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlog-install-"));
  try {
    const source = join(root, "source ' binary");
    const destination = join(root, "installed ' binary");
    await writeFile(source, "#!/bin/sh\nprintf 'installed'\n", { mode: 0o755 });
    await writeFile(destination, "old binary");
    const oldInode = (await stat(destination)).ino;
    const install = (path: string) =>
      spawnSync(
        "just",
        [
          "--justfile",
          justfile,
          "--set",
          "OS_COMPILE_PATH",
          path,
          "install-binary",
          destination,
        ],
        { encoding: "utf8" },
      );

    const result = install(source);
    expect(result.status).toBe(0);
    expect((await stat(destination)).ino).not.toBe(oldInode);
    expect(await readFile(destination)).toEqual(await readFile(source));
    const execution = spawnSync(destination, [], { encoding: "utf8" });
    expect(execution.status).toBe(0);
    expect(execution.stdout).toBe("installed");

    const installedInode = (await stat(destination)).ino;
    expect(install(join(root, "missing")).status).not.toBe(0);
    expect((await stat(destination)).ino).toBe(installedInode);
    expect(await readFile(destination)).toEqual(await readFile(source));
    expect((await readdir(root)).sort()).toEqual([
      "installed ' binary",
      "source ' binary",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
