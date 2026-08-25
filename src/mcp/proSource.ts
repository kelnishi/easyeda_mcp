/**
 * EasyEDA Pro document source, as a model rather than a string.
 *
 * In-place editing needs both directions: seeing what someone changed in the
 * editor, and writing a change back without disturbing everything else. Both
 * require addressing records individually, which a whole-document string does
 * not allow.
 *
 * Line shape: `{header json}||{payload json}|`
 */

export type ProRecord = {
  type: string;
  id?: string;
  ticket?: number;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
};

const LINE = /^(\{"type":"[A-Z_]+"[^|]*\})\|\|(\{.*\})\|\s*$/;

export function parseProSource(text: string): { records: ProRecord[]; unparsed: string[] } {
  const records: ProRecord[] = [];
  const unparsed: string[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const match = LINE.exec(line);
    if (!match) {
      unparsed.push(line);
      continue;
    }
    const header = JSON.parse(match[1]) as Record<string, unknown>;
    records.push({
      type: String(header.type),
      id: typeof header.id === "string" ? header.id : undefined,
      ticket: typeof header.ticket === "number" ? header.ticket : undefined,
      header,
      payload: JSON.parse(match[2]) as Record<string, unknown>
    });
  }

  return { records, unparsed };
}

export function serializeProSource(records: ProRecord[]): string {
  return (
    records
      .map((record) => `${JSON.stringify(record.header)}||${JSON.stringify(record.payload)}|`)
      .join("\n") + "\n"
  );
}

export type SheetComponent = {
  id: string;
  partId?: string;
  designator?: string;
  name?: string;
  x?: number;
  y?: number;
  deviceUuid?: string;
  symbolUuid?: string;
};

export type SheetNetLabel = { id: string; net: string; x?: number; y?: number; wireId?: string };

export type SheetModel = {
  components: SheetComponent[];
  netLabels: SheetNetLabel[];
  wireIds: string[];
  counts: Record<string, number>;
};

/**
 * A component's identity is spread across records: the COMPONENT carries its
 * position and part, while designator, device and symbol arrive as separate
 * ATTRs pointing back at it through parentId.
 */
export function readSheet(records: ProRecord[]): SheetModel {
  const components = new Map<string, SheetComponent>();
  const netLabels: SheetNetLabel[] = [];
  const wireIds: string[] = [];
  const counts: Record<string, number> = {};

  for (const record of records) {
    counts[record.type] = (counts[record.type] ?? 0) + 1;

    if (record.type === "COMPONENT" && record.id) {
      components.set(record.id, {
        id: record.id,
        partId: asString(record.payload.partId),
        x: asNumber(record.payload.x),
        y: asNumber(record.payload.y)
      });
    } else if (record.type === "WIRE" && record.id) {
      wireIds.push(record.id);
    }
  }

  for (const record of records) {
    if (record.type !== "ATTR") {
      continue;
    }
    const key = asString(record.payload.key);
    const parentId = asString(record.payload.parentId);
    const value = asString(record.payload.value);

    if (key === "NET" && value && record.id) {
      netLabels.push({
        id: record.id,
        net: value,
        x: asNumber(record.payload.x),
        y: asNumber(record.payload.y),
        wireId: parentId
      });
      continue;
    }

    const component = parentId ? components.get(parentId) : undefined;
    if (!component) {
      continue;
    }
    if (key === "Designator") component.designator = value;
    else if (key === "Name") component.name = value;
    else if (key === "Device") component.deviceUuid = value;
    else if (key === "Symbol") component.symbolUuid = value;
  }

  return {
    components: [...components.values()].sort(byDesignator),
    netLabels,
    wireIds,
    counts
  };
}

export type ComponentChange =
  | { kind: "added"; designator: string; part?: string; at?: { x?: number; y?: number } }
  | { kind: "removed"; designator: string; part?: string }
  | { kind: "moved"; designator: string; from: { x?: number; y?: number }; to: { x?: number; y?: number } }
  | { kind: "part-changed"; designator: string; from?: string; to?: string };

export type SheetDiff = {
  changes: ComponentChange[];
  netsOnlyInLive: string[];
  netsOnlyInIntent: string[];
  identical: boolean;
};

/**
 * Compares the live sheet against what the generator intended. Designator is
 * the identity: positions move and part names get edited, but a designator that
 * disappears is a different component, not the same one relocated.
 *
 * The y sign differs between the runtime API and document source, so intent
 * positions are matched against both orientations rather than one.
 */
export function diffSheet(
  live: SheetModel,
  intent: { components: Array<{ designator: string; part?: string; x?: number; y?: number }>; nets: string[] }
): SheetDiff {
  const changes: ComponentChange[] = [];
  const liveByDesignator = new Map(
    live.components.filter((component) => component.designator).map((component) => [component.designator as string, component])
  );
  const intentByDesignator = new Map(intent.components.map((component) => [component.designator, component]));

  for (const [designator, expected] of intentByDesignator) {
    const actual = liveByDesignator.get(designator);
    if (!actual) {
      changes.push({ kind: "removed", designator, part: expected.part });
      continue;
    }
    if (!samePosition(expected, actual)) {
      changes.push({
        kind: "moved",
        designator,
        from: { x: expected.x, y: expected.y },
        to: { x: actual.x, y: actual.y }
      });
    }
    if (expected.part && actual.partId && !actual.partId.startsWith(expected.part)) {
      changes.push({ kind: "part-changed", designator, from: expected.part, to: actual.partId });
    }
  }

  for (const [designator, actual] of liveByDesignator) {
    if (!intentByDesignator.has(designator)) {
      changes.push({ kind: "added", designator, part: actual.partId, at: { x: actual.x, y: actual.y } });
    }
  }

  const liveNets = new Set(live.netLabels.map((label) => label.net));
  const intentNets = new Set(intent.nets);

  return {
    changes,
    netsOnlyInLive: [...liveNets].filter((net) => !intentNets.has(net)).sort(),
    netsOnlyInIntent: [...intentNets].filter((net) => !liveNets.has(net)).sort(),
    identical: changes.length === 0 && liveNets.size === intentNets.size
  };
}

function samePosition(
  expected: { x?: number; y?: number },
  actual: { x?: number; y?: number }
): boolean {
  if (expected.x === undefined || actual.x === undefined) {
    return true;
  }
  if (expected.x !== actual.x) {
    return false;
  }
  if (expected.y === undefined || actual.y === undefined) {
    return true;
  }
  return expected.y === actual.y || expected.y === -actual.y;
}

function byDesignator(left: SheetComponent, right: SheetComponent): number {
  return (left.designator ?? left.id).localeCompare(right.designator ?? right.id);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
