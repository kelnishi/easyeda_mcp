/**
 * The generators emit EasyEDA **Standard** JSON, while the editor holds Pro
 * document source. Comparing what someone changed in the editor against what
 * the generator intended means reading both into the same shape.
 *
 * Standard geometry is packed into delimited strings rather than objects: a
 * symbol is one `LIB~...` entry whose segments are joined by `#@$`, and a net
 * label is an `N~...` entry.
 */

export type StandardComponent = { designator: string; part?: string; x?: number; y?: number };
export type StandardSheet = { components: StandardComponent[]; nets: string[] };

export function readStandardSheet(json: unknown): StandardSheet {
  const shapes = extractShapes(json);
  const components: StandardComponent[] = [];
  const nets = new Set<string>();

  for (const shape of shapes) {
    if (shape.startsWith("N~")) {
      const fields = shape.split("~");
      if (fields[5]) {
        nets.add(fields[5]);
      }
      continue;
    }
    if (!shape.startsWith("LIB~")) {
      continue;
    }

    const segments = shape.split("#@$");
    const lib = segments[0].split("~");
    const x = toNumber(lib[1]);
    const y = toNumber(lib[2]);

    // Prefix and name ride as annotation text: T~P~ carries the designator,
    // T~N~ the part name. Their position in the segment list is not fixed.
    let designator: string | undefined;
    let part: string | undefined;
    for (const segment of segments) {
      if (segment.startsWith("T~P~")) {
        designator = segment.split("~")[12];
      } else if (segment.startsWith("T~N~")) {
        part = segment.split("~")[12];
      }
    }

    if (designator) {
      components.push({ designator, part, x, y });
    }
  }

  return {
    components: components.sort((left, right) => left.designator.localeCompare(right.designator)),
    nets: [...nets].sort()
  };
}

function extractShapes(json: unknown): string[] {
  if (!json || typeof json !== "object") {
    return [];
  }
  const shape = (json as { shape?: unknown }).shape;
  return Array.isArray(shape) ? shape.filter((entry): entry is string => typeof entry === "string") : [];
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
