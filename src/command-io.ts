import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

export interface CommandIO {
  writeOutput(value: string): void;
  writeError(value: string): void;
  readLine(): Promise<string>;
  isOutputTerminal(): boolean;
  outputColumns(): number | undefined;
  subscribeToKeypresses(listener: (keypress: string) => void): () => void;
}

export class ProcessCommandIO implements CommandIO {
  public isOutputTerminal(): boolean {
    return process.stdout.isTTY === true;
  }

  public outputColumns(): number | undefined {
    return process.stdout.isTTY === true ? process.stdout.columns : undefined;
  }

  public subscribeToKeypresses(
    listener: (keypress: string) => void,
  ): () => void {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      return () => {};
    }

    const wasPaused = process.stdin.isPaused();
    const wasRaw = process.stdin.isRaw === true;
    const decoder = new StringDecoder("utf8");
    let disposed = false;
    let disposeSubscription: () => void = () => {};
    const onData = (chunk: Buffer | string): void => {
      for (const keypress of decoder.write(chunk)) {
        // Raw mode delivers Ctrl-C as \u0003; restore state before SIGINT.
        if (keypress === "\u0003") {
          disposeSubscription();
          process.kill(process.pid, "SIGINT");
          return;
        }
        listener(keypress);
      }
    };

    process.stdin.on("data", onData);
    if (!wasRaw) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    disposeSubscription = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      process.stdin.off("data", onData);
      if (!wasRaw) {
        process.stdin.setRawMode(false);
      }
      if (wasPaused) {
        process.stdin.pause();
      }
    };
    return disposeSubscription;
  }

  public writeOutput(value: string): void {
    process.stdout.write(value);
  }

  public writeError(value: string): void {
    process.stderr.write(value);
  }

  public async readLine(): Promise<string> {
    const lines = createInterface({ input: process.stdin, terminal: false });
    for await (const line of lines) {
      lines.close();
      return line;
    }
    return "";
  }
}
