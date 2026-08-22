import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigurationLoader,
  type ConfigurationEnvironment,
  type LoadedConfiguration,
} from "./configuration.js";
import { DailyDocumentWriter } from "./daily-document.js";
import {
  CachedConfigurationProvider,
  FixupWatcher,
  SystemWatchdogScheduler,
  Watchdog,
  type FileHasher,
  type FixupOptions,
  type OperationalLogger,
  type WatchClock,
} from "./fixup-watcher.js";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

class FakeClock implements WatchClock {
  public wallTime = new Date(2025, 6, 25, 10, 30);
  public monotonic = 0;
  public readonly sleeps: number[] = [];
  public onSleep: ((seconds: number) => void) | undefined;

  public now(): Date {
    return new Date(this.wallTime);
  }

  public monotonicSeconds(): number {
    return this.monotonic;
  }

  public async sleep(seconds: number): Promise<void> {
    this.sleeps.push(seconds);
    this.monotonic += seconds;
    this.wallTime = new Date(this.wallTime.getTime() + seconds * 1000);
    this.onSleep?.(seconds);
  }
}

class SequenceHasher implements FileHasher {
  readonly #values: readonly string[];
  #index = 0;
  public readonly paths: string[] = [];

  public constructor(values: readonly string[]) {
    this.#values = values;
  }

  public async hash(path: string): Promise<string> {
    this.paths.push(path);
    const value = this.#values[this.#index] ?? this.#values.at(-1);
    this.#index += 1;
    if (value === undefined) {
      throw new Error("Hasher sequence is empty");
    }
    return value;
  }
}

class StubWriter extends DailyDocumentWriter {
  public fixupCalls = 0;
  public changed = false;

  public override async fixup(_path: string): Promise<boolean> {
    this.fixupCalls += 1;
    return this.changed;
  }
}

class RecordingLogger implements OperationalLogger {
  public readonly messages: string[] = [];

  public log(message: string): void {
    this.messages.push(message);
  }
}

class CountingLoader extends ConfigurationLoader {
  public loadCount = 0;

  public override async load(path?: string): Promise<LoadedConfiguration> {
    this.loadCount += 1;
    return super.load(path);
  }
}

interface WatchFixture {
  readonly loader: CountingLoader;
  readonly writer: StubWriter;
  readonly clock: FakeClock;
  readonly logger: RecordingLogger;
}

async function watchFixture(): Promise<WatchFixture> {
  const root = await mkdtemp(join(tmpdir(), "dlog-watch-"));
  temporaryDirectories.push(root);
  const vault = join(root, "vault");
  await mkdir(vault);
  const configPath = join(root, "config.toml");
  await writeFile(
    configPath,
    `schema = "dlog-config/v1"
vault_roots = [${JSON.stringify(vault)}]
daily_path = "daily-%Y-%m-%d.md"
entry_prefix = "- *%H:%M* - "
`,
    "utf8",
  );
  const environment: ConfigurationEnvironment = {
    cwd: root,
    homeDirectory: root,
    variables: { DLOG_CONFIG: configPath },
  };
  return {
    loader: new CountingLoader({ environment }),
    writer: new StubWriter(),
    clock: new FakeClock(),
    logger: new RecordingLogger(),
  };
}

function options(overrides: Partial<FixupOptions> = {}): FixupOptions {
  return {
    watch: false,
    pollIntervalSeconds: 5,
    writeDelaySeconds: 0,
    noChangeLogIntervalSeconds: 60,
    cacheConfiguration: true,
    ...overrides,
  };
}

async function runWatcher(
  fixture: WatchFixture,
  hashes: readonly string[],
  watcherOptions: FixupOptions,
  decisions: boolean[] = [],
): Promise<void> {
  const hasher = new SequenceHasher(hashes);
  await new FixupWatcher(watcherOptions, {
    configurationLoader: fixture.loader,
    documentWriter: fixture.writer,
    clock: fixture.clock,
    hasher,
    logger: fixture.logger,
    watchdogScheduler: new SystemWatchdogScheduler(),
    fatalExit: (status) => {
      throw new Error(`Unexpected watchdog exit ${status}`);
    },
    keepWatching: () => decisions.shift() ?? false,
  }).run();
}

describe("fixup watcher conformance", () => {
  test("FIX-01 once mode observes stability and fixes immediately during startup", async () => {
    const fixture = await watchFixture();
    await runWatcher(fixture, ["A", "A", "A", "A"], options());

    expect(fixture.writer.fixupCalls).toBe(1);
    expect(fixture.clock.sleeps).toEqual([]);
  });

  test("FIX-02 loop mode fixes after the second stable observation", async () => {
    const fixture = await watchFixture();
    await runWatcher(fixture, ["A", "A", "A", "A"], options({ watch: true }), [
      false,
    ]);
    expect(fixture.writer.fixupCalls).toBe(1);
  });

  test("FIX-03 waits after a later stabilized external change", async () => {
    const fixture = await watchFixture();
    await runWatcher(
      fixture,
      ["A", "A", "A", "A", "B", "B", "B", "B"],
      options({ watch: true, pollIntervalSeconds: 6, writeDelaySeconds: 3 }),
      [true, true, false],
    );

    expect(fixture.writer.fixupCalls).toBe(2);
    expect(fixture.clock.sleeps).toEqual([6, 6, 3]);
  });

  test("FIX-04 postpones B when the hash changes to C during delay", async () => {
    const fixture = await watchFixture();
    await runWatcher(
      fixture,
      ["A", "A", "A", "A", "B", "B", "C", "C", "C", "C"],
      options({ watch: true, pollIntervalSeconds: 6, writeDelaySeconds: 3 }),
      [true, true, false],
    );

    expect(fixture.writer.fixupCalls).toBe(2);
    expect(fixture.logger.messages).toContain(
      "Daily document changed during the write delay; postponing fixup",
    );
  });

  test("FIX-05 refreshes the stored hash after its own write", async () => {
    const fixture = await watchFixture();
    fixture.writer.changed = true;
    await runWatcher(
      fixture,
      ["A", "A", "A", "B", "B"],
      options({ watch: true }),
      [true, false],
    );

    expect(fixture.writer.fixupCalls).toBe(1);
  });

  test("FIX-06 cached configuration reloads across local midnight", async () => {
    const fixture = await watchFixture();
    const provider = new CachedConfigurationProvider(fixture.loader, true);
    await provider.get(fixture.clock.now());
    await provider.get(fixture.clock.now());
    expect(fixture.loader.loadCount).toBe(1);

    fixture.clock.wallTime = new Date(2025, 6, 26, 0, 0);
    await provider.get(fixture.clock.now());
    expect(fixture.loader.loadCount).toBe(2);
  });

  test("FIX-07 disabled caching reloads on every access", async () => {
    const fixture = await watchFixture();
    const provider = new CachedConfigurationProvider(fixture.loader, false);
    await provider.get(fixture.clock.now());
    await provider.get(fixture.clock.now());
    expect(fixture.loader.loadCount).toBe(2);
  });

  test("FIX-08 watchdog emits one warning after 60 seconds", async () => {
    const fixture = await watchFixture();
    const exits: number[] = [];
    const watchdog = new Watchdog(
      fixture.clock,
      fixture.logger,
      new SystemWatchdogScheduler(),
      (status) => exits.push(status),
    );
    fixture.clock.monotonic = 60;
    watchdog.check();
    watchdog.check();

    expect(
      fixture.logger.messages.filter((message) =>
        message.includes("no main-loop pet"),
      ),
    ).toHaveLength(1);
    expect(exits).toEqual([]);
  });

  test("FIX-09 watchdog exits with status 7 after 120 seconds", async () => {
    const fixture = await watchFixture();
    const exits: number[] = [];
    const watchdog = new Watchdog(
      fixture.clock,
      fixture.logger,
      new SystemWatchdogScheduler(),
      (status) => exits.push(status),
    );
    fixture.clock.monotonic = 120;
    watchdog.check();
    expect(exits).toEqual([7]);
  });
});
