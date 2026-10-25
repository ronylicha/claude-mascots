import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AssembledBlock,
  assistantContentForCount,
  blocksFromMessageContent,
  buildCountRequest,
  buildOutputCountRequest,
  repairedInput,
  repairedOutput,
  repairMessageJson,
  repairSseStream,
} from "../src/usageShim/repair.ts";
import { parseSseBlock, serializeSseBlock, SseSplitter } from "../src/usageShim/sse.ts";

const sse = (event: string, data: object) => serializeSseBlock(event, data);

/** Flux tel que ghostcli.cloud l'émet (2026-10-25) : entrée à 0 dans message_start, sortie sous-comptée. */
function brokenStream(): string[] {
  return [
    sse("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-opus-5-5", usage: { input_tokens: 0, output_tokens: 0 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ": ping\n\n",
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bonjour " } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "le monde" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } }),
    sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } }),
    sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } }),
    sse("content_block_stop", { type: "content_block_stop", index: 1 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 6 } }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

async function* chunks(parts: string[], chunkSize = 7): AsyncGenerator<string> {
  const text = parts.join("");
  for (let index = 0; index < text.length; index += chunkSize) yield text.slice(index, index + chunkSize);
}

async function collect(stream: AsyncIterable<string>): Promise<{ text: string; events: Record<string, unknown>[] }> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  const events: Record<string, unknown>[] = [];
  for (const block of new SseSplitter().push(text)) {
    try {
      events.push(JSON.parse(block.data ?? "") as Record<string, unknown>);
    } catch {
      // Bloc sans JSON (commentaire, charge brute) : le test de passage ne les compte pas comme événements.
    }
  }
  return { text, events };
}

describe("SseSplitter", () => {
  it("splits blocks across arbitrary chunk boundaries and keeps the raw text", () => {
    const splitter = new SseSplitter();
    const text = `${sse("a", { n: 1 })}: comment\n\n${sse("b", { n: 2 })}event: c\ndata: {"n"`;
    const blocks = [...splitter.push(text.slice(0, 10)), ...splitter.push(text.slice(10))];
    assert.deepEqual(
      blocks.map((block) => [block.event, block.data]),
      [
        ["a", '{"n":1}'],
        [null, null],
        ["b", '{"n":2}'],
      ],
    );
    assert.equal(blocks.map((block) => block.raw).join(""), text.slice(0, text.indexOf("event: c")));
    assert.equal(splitter.flush(), 'event: c\ndata: {"n"');
  });

  it("joins multi-line data fields and accepts CRLF separators", () => {
    const block = parseSseBlock("event: x\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\n");
    assert.equal(block.event, "x");
    assert.equal(block.data, '{"a":\n1}');
  });
});

describe("repair rules", () => {
  it("keeps a positive reported input and replaces a zero one by the count", () => {
    assert.equal(repairedInput(212_416, 300), 212_416);
    assert.equal(repairedInput(0, 300), 300);
    assert.equal(repairedInput(undefined, 300), 300);
    assert.equal(repairedInput(0, null), 0);
    assert.equal(repairedInput(undefined, null), undefined);
  });

  it("takes the larger of reported and counted output", () => {
    assert.equal(repairedOutput(66, 653), 653);
    assert.equal(repairedOutput(700, 653), 700);
    assert.equal(repairedOutput(66, null), 66);
    assert.equal(repairedOutput(undefined, 12), 12);
  });

  it("builds a count_tokens body from the fields that endpoint accepts", () => {
    const request = { model: "m", max_tokens: 10, stream: true, system: "s", messages: [], tools: [{ name: "t" }], tool_choice: { type: "auto" }, thinking: { type: "enabled" }, metadata: { user_id: "u" }, temperature: 1 };
    assert.deepEqual(buildCountRequest(request), { model: "m", system: "s", messages: [], tools: [{ name: "t" }], tool_choice: { type: "auto" }, thinking: { type: "enabled" } });
  });

  it("turns assembled blocks into a countable assistant message (thinking as text, tool input parsed)", () => {
    const blocks: AssembledBlock[] = [
      { type: "thinking", text: "réflexion" },
      { type: "text", text: "Bonjour" },
      { type: "tool_use", id: "toolu_1", name: "Read", text: '{"path":"a.txt"}' },
      { type: "tool_use", id: "toolu_2", name: "Bash", text: "" },
      { type: "tool_use", id: "toolu_3", name: "Edit", text: '{"tronqué' },
      { type: "text", text: "" },
    ];
    assert.deepEqual(assistantContentForCount(blocks), [
      { type: "text", text: "réflexion" },
      { type: "text", text: "Bonjour" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } },
      { type: "tool_use", id: "toolu_2", name: "Bash", input: {} },
      { type: "text", text: '{"tronqué' },
    ]);
    assert.deepEqual(buildOutputCountRequest("m", blocks.slice(1, 2)), {
      model: "m",
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "text", text: "Bonjour" }] },
      ],
    });
  });

  it("reads the blocks of a non-streamed message the same way", () => {
    const blocks = blocksFromMessageContent([{ type: "text", text: "a" }, { type: "tool_use", id: "t", name: "Read", input: { path: "p" } }, null, { type: "thinking", thinking: "hm" }]);
    assert.deepEqual(blocks, [
      { type: "text", name: undefined, id: undefined, text: "a" },
      { type: "tool_use", name: "Read", id: "t", text: '{"path":"p"}' },
      { type: "thinking", name: undefined, id: undefined, text: "hm" },
    ]);
    const repaired = repairMessageJson({ type: "message", usage: { input_tokens: 0, output_tokens: 3 } }, { input: 50, output: 40 });
    assert.deepEqual(repaired.usage, { input_tokens: 50, output_tokens: 40 });
  });
});

describe("repairSseStream", () => {
  it("repairs message_start and message_delta, forwards everything else byte for byte", async () => {
    const parts = brokenStream();
    const countedBlocks: AssembledBlock[][] = [];
    const { text, events } = await collect(
      repairSseStream(chunks(parts), {
        inputCount: Promise.resolve(301_000),
        countOutput: async (blocks) => {
          countedBlocks.push([...blocks]);
          return 48;
        },
        holdMs: 1000,
      }),
    );

    const start = events.find((event) => event.type === "message_start") as { message: { usage: Record<string, number> } };
    assert.equal(start.message.usage.input_tokens, 301_000);
    const delta = events.find((event) => event.type === "message_delta") as { usage: Record<string, number> };
    assert.deepEqual(delta.usage, { output_tokens: 48, input_tokens: 301_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    // Les blocs comptés sont ceux du flux, dans l'ordre, texte et JSON d'outil réassemblés.
    assert.deepEqual(countedBlocks, [[{ type: "text", name: undefined, id: undefined, text: "Bonjour le monde" }, { type: "tool_use", name: "Read", id: "toolu_1", text: '{"path":"a.txt"}' }]]);
    // Tout ce qui n'est pas réparé est identique à l'original, commentaire « ping » compris.
    const untouched = parts.filter((part) => !part.startsWith("event: message_start") && !part.startsWith("event: message_delta"));
    for (const part of untouched) assert.ok(text.includes(part), `bloc perdu : ${part}`);
    assert.ok(text.indexOf("message_start") < text.indexOf("content_block_start"));
    assert.ok(text.indexOf("message_delta") < text.indexOf("message_stop"));
  });

  it("leaves a positive reported input alone and never lowers the reported output", async () => {
    const parts = brokenStream();
    parts[0] = sse("message_start", { type: "message_start", message: { usage: { input_tokens: 212_416, output_tokens: 0 } } });
    const { events } = await collect(repairSseStream(chunks(parts), { inputCount: Promise.resolve(5), countOutput: async () => 2, holdMs: 1000 }));
    const start = events.find((event) => event.type === "message_start") as { message: { usage: Record<string, number> } };
    assert.equal(start.message.usage.input_tokens, 212_416);
    const delta = events.find((event) => event.type === "message_delta") as { usage: Record<string, number> };
    assert.equal(delta.usage.output_tokens, 6);
    assert.equal(delta.usage.input_tokens, 212_416);
  });

  it("gives up on a count that is too slow or fails, without stalling the stream", async () => {
    const never = new Promise<number | null>(() => {});
    const { events } = await collect(repairSseStream(chunks(brokenStream()), { inputCount: never, countOutput: () => Promise.reject(new Error("boom")), holdMs: 20 }));
    const start = events.find((event) => event.type === "message_start") as { message: { usage: Record<string, number> } };
    assert.equal(start.message.usage.input_tokens, 0);
    const delta = events.find((event) => event.type === "message_delta") as { usage: Record<string, number> };
    assert.equal(delta.usage.output_tokens, 6);
    assert.equal(events.at(-1)?.type, "message_stop");
  });

  it("uses an input count that arrives after message_start for message_delta", async () => {
    let resolveInput: (value: number) => void = () => {};
    const late = new Promise<number | null>((resolve) => {
      resolveInput = resolve;
    });
    const stream = repairSseStream(chunks(brokenStream()), { inputCount: late, countOutput: async () => 48, holdMs: 15 });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.ok(String(first.value).includes('"input_tokens":0'));
    resolveInput(777);
    let rest = "";
    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) rest += chunk;
    assert.ok(rest.includes('"input_tokens":777'));
  });

  it("passes non-JSON and non-event payloads through unchanged and flushes a trailing partial block", async () => {
    const parts = ["event: weird\ndata: not json\n\n", "data: [1,2]\n\n", "event: message_stop\ndata: {\"type\":\"message_stop\"}"];
    const { text } = await collect(repairSseStream(chunks(parts), { inputCount: Promise.resolve(1), countOutput: async () => 1, holdMs: 10 }));
    assert.equal(text, parts.join(""));
  });
});
