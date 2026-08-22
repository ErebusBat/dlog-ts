import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { relative } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";

import strftime from "strftime";

import {
  ConfigurationLoader,
  dailyDocumentPath,
  type LoadedConfiguration,
} from "./configuration.js";
import { DailyDocumentWriter } from "./daily-document.js";

const WATCHDOG_WARNING_SECONDS = 60;
const WATCHDOG_FATAL_SECONDS = 120;
const HASH_CHUNK_BYTES = 1024;

export interface FixupOptions {
  readonly watch: boolean;
  readonly pollIntervalSeconds: number;
  readonly writeDelaySeconds: number;
  readonly noChangeLogIntervalSeconds: number;
  readonly cacheConfiguration: boolean;
}

export interface WatchClock {
  now(): Date;
  monotonicSeconds(): number;
  sleep(seconds: number): Promise<void>;
}

export interface FileHasher {
  hash(path: string): Promise<string>;
}

export interface OperationalLogger {
  log(message: string): void;
}

export interface WatchdogScheduler {
  everySecond(callback: () => void): NodeJS.Timeout;
  cancel(timer: NodeJS.Timeout): void;
}

export interface FixupWatcherDependencies {
  readonly configurationLoader: ConfigurationLoader;
  readonly documentWriter: DailyDocumentWriter;
  readonly clock: WatchClock;
  readonly hasher: FileHasher;
  readonly logger: OperationalLogger;
  readonly watchdogScheduler: WatchdogScheduler;
  readonly fatalExit: (status: number) => void;
  readonly keepWatching: () => boolean;
}

export class CachedConfigurationProvider {
  readonly #loader: ConfigurationLoader;
  readonly #cacheEnabled: boolean;
  #configuration: LoadedConfiguration | undefined;
  #loadedDay: string | undefined;

  public constructor(loader: ConfigurationLoader, cacheEnabled: boolean) {
    this.#loader = loader;
    this.#cacheEnabled = cacheEnabled;
  }

  public async get(now: Date): Promise<LoadedConfiguration> {
    const localDay = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    if (
      !this.#cacheEnabled ||
      this.#configuration === undefined ||
      this.#loadedDay !== localDay
    ) {
      this.#configuration = await this.#loader.load();
      this.#loadedDay = localDay;
    }
    return this.#configuration;
  }
}

export class Watchdog {
  readonly #clock: WatchClock;
  readonly #logger: OperationalLogger;
  readonly #scheduler: WatchdogScheduler;
  readonly #fatalExit: (status: number) => void;
  #lastPet: number;
  #warned = false;
  #timer: NodeJS.Timeout | undefined;

  public constructor(
    clock: WatchClock,
    logger: OperationalLogger,
    scheduler: WatchdogScheduler,
    fatalExit: (status: number) => void,
  ) {
    this.#clock = clock;
    this.#logger = logger;
    this.#scheduler = scheduler;
    this.#fatalExit = fatalExit;
    this.#lastPet = clock.monotonicSeconds();
  }

  public start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = this.#scheduler.everySecond(() => {
      this.check();
    });
  }

  public stop(): void {
    if (this.#timer === undefined) {
      return;
    }
    this.#scheduler.cancel(this.#timer);
    this.#timer = undefined;
  }

  public pet(): void {
    this.#lastPet = this.#clock.monotonicSeconds();
    this.#warned = false;
  }

  public check(): void {
    const elapsed = this.#clock.monotonicSeconds() - this.#lastPet;
    if (elapsed >= WATCHDOG_FATAL_SECONDS) {
      this.#logger.log(
        `WATCHDOG: no main-loop pet for ${Math.floor(elapsed)} seconds; exiting`,
      );
      this.#fatalExit(7);
      return;
    }
    if (elapsed >= WATCHDOG_WARNING_SECONDS && !this.#warned) {
      this.#warned = true;
      this.#logger.log(
        `WATCHDOG: no main-loop pet for ${Math.floor(elapsed)} seconds`,
      );
    }
  }
}

export class FixupWatcher {
  readonly #options: FixupOptions;
  readonly #dependencies: FixupWatcherDependencies;
  readonly #configurations: CachedConfigurationProvider;
  readonly #watchdog: Watchdog;
  readonly #startedAt: number;
  #lastNoChangeLog = 0;

  public constructor(
    options: FixupOptions,
    dependencies: FixupWatcherDependencies,
  ) {
    this.#options = options;
    this.#dependencies = dependencies;
    this.#configurations = new CachedConfigurationProvider(
      dependencies.configurationLoader,
      options.cacheConfiguration,
    );
    this.#watchdog = new Watchdog(
      dependencies.clock,
      dependencies.logger,
      dependencies.watchdogScheduler,
      dependencies.fatalExit,
    );
    this.#startedAt = dependencies.clock.monotonicSeconds();
  }

  public async run(): Promise<number> {
    let previousHash: string | undefined;
    let fixOnStableObservation = false;
    this.#dependencies.logger.log("Starting fixup watcher");
    this.#watchdog.start();

    try {
      for (;;) {
        this.#watchdog.pet();
        let currentHash = await this.#currentHash();
        const elapsed = Math.floor(
          this.#dependencies.clock.monotonicSeconds() - this.#startedAt,
        );

        if (currentHash !== previousHash) {
          if (previousHash !== undefined) {
            this.#dependencies.logger.log("Daily document changed");
          }
          fixOnStableObservation = true;
        } else if (fixOnStableObservation) {
          fixOnStableObservation = false;
          previousHash = currentHash;

          if (
            this.#dependencies.clock.monotonicSeconds() - this.#startedAt >
              10 &&
            this.#options.writeDelaySeconds > 0
          ) {
            this.#dependencies.logger.log(
              `Changes stabilized; waiting ${this.#options.writeDelaySeconds} seconds`,
            );
            await this.#dependencies.clock.sleep(
              this.#options.writeDelaySeconds,
            );
          }

          currentHash = await this.#currentHash();
          if (currentHash !== previousHash) {
            this.#dependencies.logger.log(
              "Daily document changed during the write delay; postponing fixup",
            );
            previousHash = currentHash;
            fixOnStableObservation = true;
            continue;
          }

          const description = await this.#dailyDocumentDescription();
          this.#dependencies.logger.log(
            `t=${elapsed} ${description} Examining file`,
          );
          const changed = await this.#fixup();
          this.#dependencies.logger.log(
            changed
              ? `t=${elapsed} ${description} Log fixed up`
              : `t=${elapsed} ${description} No log changes detected`,
          );
          currentHash = await this.#currentHash();
        } else {
          this.#logNoChange(elapsed);
        }

        if (previousHash === undefined) {
          previousHash = currentHash;
          continue;
        }

        previousHash = currentHash;
        if (!this.#options.watch || !this.#dependencies.keepWatching()) {
          break;
        }
        await this.#dependencies.clock.sleep(this.#options.pollIntervalSeconds);
      }
    } finally {
      this.#watchdog.stop();
    }

    this.#dependencies.logger.log("Exiting fixup watcher");
    return 0;
  }

  async #currentHash(): Promise<string> {
    const now = this.#dependencies.clock.now();
    const configuration = await this.#configurations.get(now);
    return this.#dependencies.hasher.hash(
      dailyDocumentPath(configuration, now),
    );
  }

  async #fixup(): Promise<boolean> {
    const now = this.#dependencies.clock.now();
    const configuration = await this.#configurations.get(now);
    return this.#dependencies.documentWriter.fixup(
      dailyDocumentPath(configuration, now),
    );
  }

  async #dailyDocumentDescription(): Promise<string> {
    const now = this.#dependencies.clock.now();
    const configuration = await this.#configurations.get(now);
    return relative(
      configuration.vaultRoot,
      dailyDocumentPath(configuration, now),
    );
  }

  #logNoChange(elapsed: number): void {
    if (this.#options.noChangeLogIntervalSeconds < 0) {
      return;
    }
    const now = this.#dependencies.clock.monotonicSeconds();
    if (
      !this.#options.watch ||
      now - this.#lastNoChangeLog >= this.#options.noChangeLogIntervalSeconds
    ) {
      this.#dependencies.logger.log(`t=${elapsed} No change`);
      this.#lastNoChangeLog = now;
    }
  }
}

export class SystemWatchClock implements WatchClock {
  public now(): Date {
    return new Date();
  }

  public monotonicSeconds(): number {
    return performance.now() / 1000;
  }

  public async sleep(seconds: number): Promise<void> {
    await sleepFor(seconds * 1000);
  }
}

export class Sha256FileHasher implements FileHasher {
  public async hash(path: string): Promise<string> {
    const handle = await open(path, "r");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    try {
      for (;;) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          HASH_CHUNK_BYTES,
          null,
        );
        if (bytesRead === 0) {
          break;
        }
        digest.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return digest.digest("hex");
  }
}

export class StandardErrorLogger implements OperationalLogger {
  readonly #clock: WatchClock;

  public constructor(clock: WatchClock) {
    this.#clock = clock;
  }

  public log(message: string): void {
    process.stderr.write(
      `[${strftime("%Y-%m-%dT%H:%M:%S%z", this.#clock.now())}] ${message}\n`,
    );
  }
}

export class SystemWatchdogScheduler implements WatchdogScheduler {
  public everySecond(callback: () => void): NodeJS.Timeout {
    const timer = setInterval(callback, 1000);
    timer.unref();
    return timer;
  }

  public cancel(timer: NodeJS.Timeout): void {
    clearInterval(timer);
  }
}
