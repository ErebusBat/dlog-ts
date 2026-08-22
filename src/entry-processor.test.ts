import { describe, expect, test } from "bun:test";

import {
  EntryProcessor,
  PHONE_NUMBER_PATTERN,
  type CallbackExecutor,
  type CallbackRequest,
  type CallbackResult,
  type ProcessingRule,
} from "./entry-processor.js";

const NOW = new Date(2025, 6, 25, 10, 30, 0, 0);

class ConformanceCallbacks implements CallbackExecutor {
  public readonly requests: CallbackRequest[] = [];

  public async execute(request: CallbackRequest): Promise<CallbackResult> {
    this.requests.push(request);
    if (request.plugin === "issues") {
      const issueNumber = Number.parseInt(request.matchedText.slice(5), 10);
      return issueNumber < 1000
        ? { action: "no-change" }
        : { action: "replace", value: `[[TEST Issue ${issueNumber}]]` };
    }
    if (request.plugin === "brackets") {
      return { action: "replace", value: `[${request.matchedText}]` };
    }
    throw new Error(`Unexpected test plugin ${request.plugin}`);
  }
}

const CONFORMANCE_RULES: readonly ProcessingRule[] = [
  {
    phase: "prefix",
    key: "W",
    replacement: { kind: "static", value: "Work " },
  },
  {
    phase: "prefix",
    key: "MEET",
    replacement: { kind: "static", value: "👥 " },
  },
  {
    phase: "global",
    matcher: { kind: "literal", value: ":100:" },
    replacement: { kind: "static", value: "💯" },
  },
  {
    phase: "global",
    matcher: { kind: "literal", value: "PAGE" },
    replacement: { kind: "static", value: "[[Page]]" },
  },
  {
    phase: "global",
    matcher: { kind: "pattern", expression: /TEST-\d+/g },
    replacement: { kind: "callback", plugin: "issues" },
  },
];

function timestampPrefix(_entryText: string, timestamp: Date): string {
  const hours = String(timestamp.getHours()).padStart(2, "0");
  const minutes = String(timestamp.getMinutes()).padStart(2, "0");
  return `- *${hours}:${minutes}* - `;
}

describe("entry conformance", () => {
  const cases = [
    [
      "W on PAGE, :100:",
      "Work on [[Page]], 💯",
      "- *10:30* - Work on [[Page]], 💯",
    ],
    ["MEET Sarah", "👥 Sarah", "- *10:30* - 👥 Sarah"],
    ["W- Task", "W- Task", "- *10:30* - W- Task"],
    ["W", "Work", "- *10:30* - Work"],
    [
      "TEST-999 and TEST-1234",
      "TEST-999 and [[TEST Issue 1234]]",
      "- *10:30* - TEST-999 and [[TEST Issue 1234]]",
    ],
  ] as const;

  for (const [input, entryText, renderedEntry] of cases) {
    test(input, async () => {
      const callbacks = new ConformanceCallbacks();
      const result = await new EntryProcessor(
        CONFORMANCE_RULES,
        callbacks,
      ).process(input, {
        now: NOW,
        entryPrefix: timestampPrefix,
      });
      expect(result.entryText).toBe(entryText);
      expect(result.renderedEntry).toBe(renderedEntry);
    });
  }

  test("empty static replacement deletes only the match and preserves interior spacing", async () => {
    const rules: readonly ProcessingRule[] = [
      {
        phase: "global",
        matcher: { kind: "literal", value: "[REMOVE]" },
        replacement: { kind: "static", value: "" },
      },
    ];
    const result = await new EntryProcessor(
      rules,
      new ConformanceCallbacks(),
    ).process("This [REMOVE] stays", {
      now: NOW,
      entryPrefix: timestampPrefix,
    });
    expect(result.entryText).toBe("This  stays");
    expect(result.renderedEntry).toBe("- *10:30* - This  stays");
  });

  test("dynamic callbacks receive the unchanged full entry for every match", async () => {
    const callbacks = new ConformanceCallbacks();
    await new EntryProcessor(CONFORMANCE_RULES, callbacks).process(
      "TEST-999 and TEST-1234",
      { now: NOW },
    );
    expect(callbacks.requests).toEqual([
      {
        plugin: "issues",
        fullEntryBeforeRule: "TEST-999 and TEST-1234",
        matchedText: "TEST-999",
      },
      {
        plugin: "issues",
        fullEntryBeforeRule: "TEST-999 and TEST-1234",
        matchedText: "TEST-1234",
      },
    ]);
  });
});

describe("timestamp conformance", () => {
  const cases = [
    ["12:34|Had lunch", 12, 34, "Had lunch"],
    ["0922|W on PAGE", 9, 22, "W on PAGE"],
    ["-12|W on PAGE", 10, 18, "W on PAGE"],
    ["-1h3m|W on PAGE", 9, 27, "W on PAGE"],
    ["-45m|W on PAGE", 9, 45, "W on PAGE"],
    ["-3h|W on PAGE", 7, 30, "W on PAGE"],
    [".", 10, 30, "⬆︎"],
    ["-5|.", 10, 25, "."],
  ] as const;

  for (const [input, hours, minutes, text] of cases) {
    test(input, async () => {
      const result = await new EntryProcessor(
        [],
        new ConformanceCallbacks(),
      ).process(input, {
        now: NOW,
      });
      expect(result.timestamp.getHours()).toBe(hours);
      expect(result.timestamp.getMinutes()).toBe(minutes);
      expect(result.entryText).toBe(text);
    });
  }

  test("syntactically accepted unknown duration subtracts zero", async () => {
    const result = await new EntryProcessor(
      [],
      new ConformanceCallbacks(),
    ).process("-1m2h|Text", { now: NOW });
    expect(result.timestamp.getTime()).toBe(NOW.getTime());
  });

  test("explicit and embedded timestamps conflict", async () => {
    const processor = new EntryProcessor([], new ConformanceCallbacks());
    await expect(
      processor.process("12:34|Text", { now: NOW, explicitTimestamp: NOW }),
    ).rejects.toThrow("cannot be combined");
    await expect(
      processor.process("-5|Text", { now: NOW, explicitTimestamp: NOW }),
    ).rejects.toThrow("cannot be combined");
  });
});

describe("phone matcher conformance", () => {
  const cases = [
    ["Call 123-456-7890", "Call [123-456-7890]"],
    ["Call (123) 456-7890", "Call [(123) 456-7890]"],
    ["Call 123.456.7890", "Call [123.456.7890]"],
    ["Call 1234567890", "Call [1234567890]"],
    ["Call 123 456 7890", "Call [123 456 7890]"],
    ["Call 1-234-567-8901", "Call [1-234-567-8901]"],
    ["Call 1 234-567-8901", "Call [1 234-567-8901]"],
    ["Call 1 (234) 567-8901", "Call [1 (234) 567-8901]"],
    ["Call 1.234.567.8901", "Call [1.234.567.8901]"],
    ["Call 12345678901", "Call [12345678901]"],
    ["Call 456-7890", "Call 456-7890"],
    [
      "Call 123-456-7890 or 987-654-3210",
      "Call [123-456-7890] or [987-654-3210]",
    ],
  ] as const;

  for (const [input, expected] of cases) {
    test(input, async () => {
      const result = await new EntryProcessor(
        [
          {
            phase: "global",
            matcher: {
              kind: "pattern",
              expression: new RegExp(PHONE_NUMBER_PATTERN, "g"),
            },
            replacement: { kind: "callback", plugin: "brackets" },
          },
        ],
        new ConformanceCallbacks(),
      ).process(input, { now: NOW });
      expect(result.entryText).toBe(expected);
    });
  }
});
