export class DlogError extends Error {
  public override readonly name = "DlogError";

  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
