import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";

import { DlogError } from "./dlog-error.js";

const STANDARD_ENTRY = /^(- \[ \] )?- \*\d\d:\d\d\* -\s/;
const COMPLETE_TASK_ENTRY =
  /^(?<task>- \[ \] )(?<entry>- \*\d\d:\d\d\* -\s.+)\s\(@(?<dueDate>20\d\d-\d\d-\d\d)\)$/;
const EMBEDDED_LIST_ENTRY = /(?<entry>- \*\d\d:\d\d\* -\s.+)/;
const EMBEDDED_TIMESTAMP = /(?<entry>\*\d\d:\d\d\* -\s.+)/;
const UNCHECKED_TASK_PREFIX = /^- \[ \]( -)?\s*/;

export interface NormalizationResult {
  readonly changed: boolean;
  readonly content: string;
  readonly entries: readonly string[];
}

export class DailyDocumentReader {
  public async readLogSection(path: string): Promise<readonly string[]> {
    const source = await readDailyDocumentFile(path);
    return selectLogSection(readlines(source)).lines;
  }
}

export class DailyDocumentWriter {
  public async fixup(path: string): Promise<boolean> {
    return this.#normalize(path);
  }

  public async append(path: string, renderedEntry: string): Promise<boolean> {
    return this.#normalize(path, renderedEntry);
  }

  async #normalize(path: string, renderedEntry?: string): Promise<boolean> {
    const source = await readDailyDocumentFile(path);
    const normalized = normalizeDailyDocument(source, renderedEntry);
    if (!normalized.changed) {
      return false;
    }
    await writeFile(path, normalized.content, "utf8");
    return true;
  }
}

export function normalizeDailyDocument(
  source: string,
  renderedEntry?: string,
): NormalizationResult {
  const lines = readlines(source);
  const section = selectLogSection(lines);
  const { startIndex, endIndex } = section;
  const originalEntries = [...section.lines];
  const originalDigest = arrayDigest(
    originalEntries,
    `count=${endIndex - startIndex - 1}`,
  );

  const candidates = [...originalEntries];
  if (renderedEntry !== undefined && renderedEntry.trim().length > 0) {
    candidates.push(renderedEntry);
  }
  const normalizedEntries = sortAndDeduplicate(splitEntries(candidates));
  const normalizedDigest = arrayDigest(
    normalizedEntries,
    `count=${normalizedEntries.length}`,
  );
  if (normalizedDigest === originalDigest) {
    return { changed: false, content: source, entries: normalizedEntries };
  }

  const outputParts = lines.slice(0, startIndex);
  if (normalizedEntries.length > 0) {
    if (startIndex > 0 && lines[startIndex - 1]?.trim() === "# Log") {
      outputParts.push("\n");
    }
    for (const entry of normalizedEntries) {
      outputParts.push(`${entry}\n`);
    }
  }
  if (endIndex < lines.length) {
    if (normalizedEntries.length > 0) {
      outputParts.push("\n");
    }
    outputParts.push(...lines.slice(endIndex));
  }

  const finalPartIndex = outputParts.length - 1;
  const finalPart = outputParts[finalPartIndex];
  if (finalPart === undefined) {
    throw new DlogError("Cannot serialize an empty daily document");
  }
  outputParts[finalPartIndex] = finalPart.trim();

  return {
    changed: true,
    content: outputParts.join(""),
    entries: normalizedEntries,
  };
}

interface LogSectionSelection {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly lines: readonly string[];
}

function selectLogSection(lines: readonly string[]): LogSectionSelection {
  const logHeaderIndex = lines.findIndex((line) => line.trim() === "# Log");
  if (logHeaderIndex === -1) {
    throw new DlogError("No '# Log' section found in daily document");
  }

  const startIndex = logHeaderIndex + 1;
  let endIndex = startIndex;
  while (endIndex < lines.length) {
    const trimmed = lines[endIndex]?.trim() ?? "";
    if (trimmed.length > 0 && trimmed.startsWith("#")) {
      break;
    }
    endIndex += 1;
  }

  const sectionLines: string[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed.length > 0) {
      sectionLines.push(trimmed);
    }
  }
  return { startIndex, endIndex, lines: sectionLines };
}

async function readDailyDocumentFile(path: string): Promise<string> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new DlogError(`Daily document does not exist: ${path}`, error);
  }
  if (!metadata.isFile()) {
    throw new DlogError(`Daily document is not a regular file: ${path}`);
  }
  return readFile(path, "utf8");
}

function splitEntries(entries: readonly string[]): string[] {
  const output = entries.filter((entry) => STANDARD_ENTRY.test(entry));

  for (let index = 0; index < output.length; index += 1) {
    const entry = output[index];
    if (entry === undefined) {
      continue;
    }

    const completeTask = COMPLETE_TASK_ENTRY.exec(entry);
    const embeddedList =
      completeTask ?? findFromOffset(entry, EMBEDDED_LIST_ENTRY, 1);
    const match = embeddedList ?? findFromOffset(entry, EMBEDDED_TIMESTAMP, 5);
    const extracted = match?.groups?.["entry"];
    if (extracted === undefined) {
      continue;
    }

    let residual = entry.replace(extracted, "");
    if (UNCHECKED_TASK_PREFIX.test(residual)) {
      residual = "";
    }
    if (residual !== entry) {
      output[index] = residual;
    }

    const normalizedExtracted = extracted.trim();
    if (normalizedExtracted.length > 0) {
      output.push(
        normalizedExtracted.startsWith("-")
          ? normalizedExtracted
          : `- ${normalizedExtracted}`,
      );
    }
  }

  return output;
}

function findFromOffset(
  entry: string,
  expression: RegExp,
  offset: number,
): RegExpExecArray | null {
  const match = expression.exec(entry.slice(offset));
  if (match === null) {
    return null;
  }
  return match;
}

function sortAndDeduplicate(entries: readonly string[]): string[] {
  const sorted = [...entries].sort((left, right) => {
    const leftKey = left.toLowerCase();
    const rightKey = right.toLowerCase();
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  });

  return sorted.filter(
    (entry, index) => index === 0 || entry !== sorted[index - 1],
  );
}

function arrayDigest(entries: readonly string[], count: string): string {
  const digestEntries = [...entries];
  while (
    digestEntries.length > 0 &&
    (digestEntries[digestEntries.length - 1]?.trim().length ?? 0) === 0
  ) {
    digestEntries.pop();
  }
  digestEntries.push(count);

  const hash = createHash("sha256");
  for (const entry of digestEntries) {
    hash.update(entry, "utf8");
  }
  return hash.digest("hex");
}

function readlines(source: string): string[] {
  if (source.length === 0) {
    return [];
  }
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
