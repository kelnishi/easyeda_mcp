import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * A document source is one record per line, each line beginning with a JSON
 * header object whose `type` names the primitive:
 *
 *   {"type":"PIN","ticket":3,"id":"e0"}||{...payload...}|
 *
 * A type histogram is the cheapest useful read of a whole document: a symbol
 * that imported as a bare rectangle shows up as RECT and ATTR records with no
 * PIN records at all, which no amount of component-level inspection reveals.
 */
// Whitespace-tolerant for the same reason, and it matters more here: the
// empty-source guard counts these records to decide whether a write would blank
// the document. A miscount refuses a valid write, or lets a destructive one past.
const RECORD_TYPE = /^\{\s*"type"\s*:\s*"([A-Z_]+)"/;

export type SourceSummary = {
  byteLength: number;
  lineCount: number;
  recordTypes: Record<string, number>;
};

export function summarizeSource(source: string): SourceSummary {
  const lines = source.split("\n");
  const recordTypes: Record<string, number> = {};
  let counted = 0;

  for (const line of lines) {
    const match = RECORD_TYPE.exec(line);
    if (!match) {
      continue;
    }
    recordTypes[match[1]] = (recordTypes[match[1]] ?? 0) + 1;
    counted += 1;
  }

  return {
    byteLength: source.length,
    lineCount: counted || lines.filter((line) => line.trim()).length,
    recordTypes
  };
}

/** First `count` lines, for a shape check that does not haul the whole document into context. */
export function headLines(source: string, count: number): string[] {
  return source.split("\n").slice(0, count);
}

export function defaultSourcePath(kind: "snapshot" | "backup", stamp: string): string {
  return join(tmpdir(), "easyeda-mcp", `document-${kind}-${stamp}.epru`);
}

export async function writeSourceFile(path: string, source: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, source, "utf8");
  return absolute;
}

export async function readSourceFile(path: string): Promise<string> {
  const absolute = resolve(path);
  const source = await readFile(absolute, "utf8");
  if (!source.trim()) {
    throw new Error(`Source file is empty: ${absolute}`);
  }
  return source;
}

/**
 * Timestamps are only used to keep successive snapshot filenames distinct, so
 * a sortable compact form beats an ISO string with characters that need quoting.
 */
export function fileStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}
