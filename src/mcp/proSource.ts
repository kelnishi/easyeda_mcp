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
  /** Stable across a rename, a move and a part swap. The real identity. */
  id: string;
  partId?: string;
  designator?: string;
  name?: string;
  x?: number;
  y?: number;
  deviceUuid?: string;
  symbolUuid?: string;
  uniqueId?: string;
  /**
   * Imported components keep a short sequential record id and a gge* Unique ID
   * carried over from the Standard JSON. One placed in the editor gets a
   * uuid-style id and no Unique ID, so provenance is readable -- which is what
   * distinguishes a generated part from someone's hand edit.
   */
  origin: "imported" | "editor";
};

export type SheetNetLabel = {
  id: string;
  net: string;
  x?: number;
  y?: number;
  wireId?: string;
  /**
   * A generated sheet's net labels arrive as ATTR key=NET parented to a wire.
   * One placed in the editor is a net-flag COMPONENT whose name is an ATTR
   * key=Name and which has no parentId at all -- the same concept in two
   * encodings. Reading only the first silently misses every label added by hand.
   */
  source: "attr" | "flag";
};

export type SheetWire = { id: string; segments: Array<{ x1: number; y1: number; x2: number; y2: number }> };

export type SheetModel = {
  /** Real parts only; net flags are components too but are reported as labels. */
  components: SheetComponent[];
  netLabels: SheetNetLabel[];
  wires: SheetWire[];
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
  const segmentsByGroup = new Map<string, SheetWire["segments"]>();
  const counts: Record<string, number> = {};

  for (const record of records) {
    counts[record.type] = (counts[record.type] ?? 0) + 1;

    if (record.type === "COMPONENT" && record.id) {
      components.set(record.id, {
        id: record.id,
        partId: asString(record.payload.partId),
        x: asNumber(record.payload.x),
        y: asNumber(record.payload.y),
        origin: /^e\d+$/.test(record.id) ? "imported" : "editor"
      });
    } else if (record.type === "WIRE" && record.id) {
      wireIds.push(record.id);
    } else if (record.type === "LINE") {
      const group = asString(record.payload.lineGroup);
      const x1 = asNumber(record.payload.startX);
      const y1 = asNumber(record.payload.startY);
      const x2 = asNumber(record.payload.endX);
      const y2 = asNumber(record.payload.endY);
      if (group && x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
        segmentsByGroup.set(group, [...(segmentsByGroup.get(group) ?? []), { x1, y1, x2, y2 }]);
      }
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
        wireId: parentId,
        source: "attr"
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
    else if (key === "Unique ID") component.uniqueId = value;
  }

  const wires: SheetWire[] = wireIds.map((id) => ({ id, segments: segmentsByGroup.get(id) ?? [] }));

  // A component with no designator is a net flag: the net name rides on its
  // Name attribute. Left among the parts it reads as an unnamed component
  // appearing from nowhere; read as a label it is the edit someone just made.
  const parts: SheetComponent[] = [];
  for (const component of components.values()) {
    if (component.designator) {
      parts.push(component);
      continue;
    }
    if (component.name) {
      netLabels.push({
        id: component.id,
        net: component.name,
        x: component.x,
        y: component.y,
        wireId: findWireAt(wires, component.x, component.y),
        source: "flag"
      });
    }
  }

  return {
    components: parts.sort(byDesignator),
    netLabels,
    wires,
    wireIds,
    counts
  };
}

/**
 * A net flag carries no parentId, so its wire has to be found by position. The
 * y sign differs between representations, so both orientations are tried.
 */
function findWireAt(wires: SheetWire[], x?: number, y?: number): string | undefined {
  if (x === undefined || y === undefined) {
    return undefined;
  }
  for (const wire of wires) {
    for (const segment of wire.segments) {
      for (const candidate of [y, -y]) {
        if (
          (segment.x1 === x && segment.y1 === candidate) ||
          (segment.x2 === x && segment.y2 === candidate)
        ) {
          return wire.id;
        }
      }
    }
  }
  return undefined;
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

export type SnapshotChange = {
  id: string;
  designator?: string;
  kind: "added" | "removed" | "renamed" | "moved" | "re-parted";
  detail: string;
  origin?: "imported" | "editor";
};

/**
 * Compares two states of the same document, keyed on record id.
 *
 * This is the comparison that can be exact. Designators are labels that move
 * between components -- renaming R1 to R0 and placing a new R1 leaves the
 * designator set unchanged while nothing about the components matches -- so a
 * designator-keyed diff of that edit reports the old part as moved and re-parted
 * when it did not move at all. Record ids survive renames, moves and part swaps.
 */
export function diffSnapshots(before: SheetModel, after: SheetModel): SnapshotChange[] {
  const changes: SnapshotChange[] = [];
  const beforeById = new Map(before.components.map((component) => [component.id, component]));
  const afterById = new Map(after.components.map((component) => [component.id, component]));

  for (const [id, old] of beforeById) {
    const now = afterById.get(id);
    if (!now) {
      changes.push({
        id,
        designator: old.designator,
        kind: "removed",
        detail: `${old.designator ?? id} (${old.partId ?? "unknown part"}) is gone`,
        origin: old.origin
      });
      continue;
    }
    if (old.designator !== now.designator) {
      changes.push({
        id,
        designator: now.designator,
        kind: "renamed",
        detail: `${old.designator ?? id} renamed to ${now.designator ?? id}`,
        origin: now.origin
      });
    }
    if (old.x !== now.x || old.y !== now.y) {
      changes.push({
        id,
        designator: now.designator,
        kind: "moved",
        detail: `${now.designator ?? id} moved from (${old.x},${old.y}) to (${now.x},${now.y})`,
        origin: now.origin
      });
    }
    if (old.partId !== now.partId) {
      changes.push({
        id,
        designator: now.designator,
        kind: "re-parted",
        detail: `${now.designator ?? id} changed part from ${old.partId} to ${now.partId}`,
        origin: now.origin
      });
    }
  }

  for (const [id, now] of afterById) {
    if (!beforeById.has(id)) {
      changes.push({
        id,
        designator: now.designator,
        kind: "added",
        detail: `${now.designator ?? id} (${now.partId ?? "unknown part"}) added at (${now.x},${now.y})`,
        origin: now.origin
      });
    }
  }

  return changes;
}
