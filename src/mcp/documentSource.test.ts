import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileStamp, headLines, readSourceFile, summarizeSource, writeSourceFile } from "./documentSource.js";

const SAMPLE = [
  '{"type":"DOCHEAD"}||{"docType":"SYMBOL"}|',
  '{"type":"RECT","ticket":3,"id":"e0"}||{"dotX1":0}|',
  '{"type":"PIN","ticket":4,"id":"e1"}||{"pinNumber":"1"}|',
  '{"type":"PIN","ticket":5,"id":"e2"}||{"pinNumber":"2"}|',
  ""
].join("\n");

describe("summarizeSource", () => {
  it("counts records by type", () => {
    const summary = summarizeSource(SAMPLE);
    expect(summary.recordTypes).toEqual({ DOCHEAD: 1, RECT: 1, PIN: 2 });
    expect(summary.lineCount).toBe(4);
    expect(summary.byteLength).toBe(SAMPLE.length);
  });

  it("reports an absent type rather than defaulting it to zero", () => {
    // The bug this whole capability exists to catch: symbols that imported as
    // bare rectangles have no PIN key at all, which must stay distinguishable
    // from a document that genuinely has zero pins recorded.
    const summary = summarizeSource('{"type":"RECT","ticket":1,"id":"e0"}||{}|');
    expect(summary.recordTypes.PIN).toBeUndefined();
    expect(summary.recordTypes).toEqual({ RECT: 1 });
  });

  it("tolerates a document with no parsable records", () => {
    const summary = summarizeSource("not a record\nnor this");
    expect(summary.recordTypes).toEqual({});
    expect(summary.lineCount).toBe(2);
  });
});

describe("headLines", () => {
  it("returns at most the requested number of lines", () => {
    expect(headLines(SAMPLE, 2)).toHaveLength(2);
    expect(headLines(SAMPLE, 99)).toHaveLength(5);
  });
});

describe("fileStamp", () => {
  it("produces a sortable name-safe stamp", () => {
    expect(fileStamp(new Date("2026-08-24T20:46:43.952Z"))).toBe("20260824T204643");
  });
});

describe("source files", () => {
  it("round-trips through disk, creating missing directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "easyeda-source-test-"));
    const path = join(dir, "nested", "doc.epru");
    const written = await writeSourceFile(path, SAMPLE);
    expect(await readFile(written, "utf8")).toBe(SAMPLE);
    expect(await readSourceFile(written)).toBe(SAMPLE);
  });

  it("refuses an empty source file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "easyeda-source-test-"));
    const path = join(dir, "empty.epru");
    await writeSourceFile(path, "   ");
    await expect(readSourceFile(path)).rejects.toThrow(/empty/i);
  });
});
