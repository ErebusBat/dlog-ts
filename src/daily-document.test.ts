import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DailyDocumentWriter,
  normalizeDailyDocument,
} from "./daily-document.js";

function entriesFrom(content: string): string[] {
  return content.split("\n").filter((line) => /^- \*\d\d:\d\d\* -/.test(line));
}

describe("daily-document conformance", () => {
  test("DLOG-01 inserts into an empty section", () => {
    const source = `# Some Header
Content here

# Log

# Another Header
More content
`;
    const result = normalizeDailyDocument(source, "- *10:00* - Test entry");
    expect(result.content).toBe(`# Some Header
Content here

# Log

- *10:00* - Test entry

# Another Header
More content`);
  });

  test("DLOG-02 sorts standard entries by lowercase whole line", () => {
    const source = `# Log
- *10:00* - Coffee
- *14:00* - Meeting
- *09:00* - Breakfast`;
    const result = normalizeDailyDocument(source, "- *11:00* - Lunch");
    expect(entriesFrom(result.content)).toEqual([
      "- *09:00* - Breakfast",
      "- *10:00* - Coffee",
      "- *11:00* - Lunch",
      "- *14:00* - Meeting",
    ]);
  });

  test("DLOG-03 removes exact duplicates but preserves case differences", () => {
    const source = `# Log
- *10:00* - zebra task
- *11:00* - Apple picking
- *12:00* - BANANA break`;
    const first = normalizeDailyDocument(source, "- *13:00* - berry smoothie");
    expect(entriesFrom(first.content)).toEqual([
      "- *10:00* - zebra task",
      "- *11:00* - Apple picking",
      "- *12:00* - BANANA break",
      "- *13:00* - berry smoothie",
    ]);

    const duplicate = normalizeDailyDocument(
      first.content,
      "- *13:00* - berry smoothie",
    );
    expect(duplicate.changed).toBe(false);
    expect(entriesFrom(duplicate.content)).toHaveLength(4);

    const differentCase = normalizeDailyDocument(
      duplicate.content,
      "- *13:00* - Berry smoothie",
    );
    expect(entriesFrom(differentCase.content).slice(-2)).toEqual([
      "- *13:00* - berry smoothie",
      "- *13:00* - Berry smoothie",
    ]);
  });

  test("DLOG-04 removes nonstandard section content", () => {
    const source = `# Log
Narrative note
- [ ] ordinary task
- *09:00* - Retained`;
    const result = normalizeDailyDocument(source);
    expect(result.content).not.toContain("Narrative note");
    expect(result.content).not.toContain("ordinary task");
    expect(result.content).toContain("- *09:00* - Retained");
  });

  test("DLOG-05 changes only the first exact Log section", () => {
    const secondSection = `# Log
Narrative in second section
- *12:00* - Untouched`;
    const source = `# Intro
Text
# Log
- *10:00* - First
## Details
Detail text
${secondSection}`;
    const result = normalizeDailyDocument(source, "- *09:00* - Earlier");
    expect(result.content).toContain(`# Log

- *09:00* - Earlier
- *10:00* - First

## Details`);
    expect(result.content.endsWith(secondSection)).toBe(true);
  });

  test("DLOG-06 rejects a document without the required header", () => {
    expect(() =>
      normalizeDailyDocument("# Notes\nText", "- *10:00* - Entry"),
    ).toThrow("No '# Log' section");
  });

  test("DLOG-07 refuses to create a missing daily document", async () => {
    const root = await mkdtemp(join(tmpdir(), "dlog-missing-"));
    const writer = new DailyDocumentWriter();
    await expect(
      writer.append(join(root, "missing.md"), "- *10:00* - Entry"),
    ).rejects.toThrow("does not exist");
    await expect(writer.fixup(join(root, "missing.md"))).rejects.toThrow(
      "does not exist",
    );
  });

  test("DLOG-08 strips the terminal newline at end of file", () => {
    const source = `# Some Header
Content

# Log
- *10:00* - First entry
`;
    const result = normalizeDailyDocument(source, "- *09:00* - Earlier entry");
    expect(result.content).toBe(
      "# Some Header\nContent\n\n# Log\n\n- *09:00* - Earlier entry\n- *10:00* - First entry",
    );
    expect(result.content.endsWith("\n")).toBe(false);
  });

  test("DLOG-09 splits a task with an embedded entry and preserves blank residual", () => {
    const source = `# Log
- [ ] - *09:15* - Follow up with Sam (@2025-07-25)`;
    const result = normalizeDailyDocument(source);
    expect(result.entries).toEqual(["", "- *09:15* - Follow up with Sam"]);
    expect(result.content).toBe("# Log\n\n\n- *09:15* - Follow up with Sam");
  });

  test("DLOG-10 leaves a canonical EOF section byte-for-byte untouched", () => {
    const source = "# Log\n\n- *09:00* - First\n- *10:00* - Second";
    const result = normalizeDailyDocument(source);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(source);

    expect(normalizeDailyDocument(source.replace("\n\n", "\n")).changed).toBe(
      true,
    );
    expect(normalizeDailyDocument(`${source}\n- *09:00* - First`).changed).toBe(
      true,
    );
  });

  test("DLOG-11 splits a mid-entry timestamp and preserves residual whitespace", () => {
    const source = `# Log
- *09:00* - Wrote notes ⬆︎ *09:45* - Follow up`;
    const result = normalizeDailyDocument(source);
    expect(result.entries).toEqual([
      "- *09:00* - Wrote notes ⬆︎ ",
      "- *09:45* - Follow up",
    ]);
    expect(result.content).toBe(
      "# Log\n\n- *09:00* - Wrote notes ⬆︎ \n- *09:45* - Follow up",
    );
  });
});
