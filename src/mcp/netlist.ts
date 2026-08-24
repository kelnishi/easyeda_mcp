/**
 * A netlist is the only connectivity answer that does not come from inference:
 * EasyEDA's own netlister produced it. Parsing it into net -> pins is what makes
 * it checkable against a design's intent rather than merely readable.
 */

export type NetlistPin = { designator: string; pin: string };
export type NetlistNet = { name: string; pins: NetlistPin[] };
export type ParsedNetlist = {
  nets: NetlistNet[];
  components: string[];
  /** False when the text did not look like a netlist we can read. */
  parsed: boolean;
};

/**
 * Protel2 shape: component blocks in brackets, net blocks in parentheses whose
 * first line is the net name and whose remaining lines are REFDES-PIN.
 *
 *   [ R1 / 0603 / 5.1K ]        ( CC1 / R1-1 / J1-A5 )
 */
export function parseProtel2Netlist(text: string): ParsedNetlist {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const nets: NetlistNet[] = [];
  const components: string[] = [];

  let mode: "none" | "component" | "net" = "none";
  let block: string[] = [];

  const flush = () => {
    if (mode === "component" && block.length) {
      components.push(block[0]);
    } else if (mode === "net" && block.length) {
      const [name, ...rest] = block;
      nets.push({ name, pins: rest.map(parsePinRef).filter(isPin) });
    }
    block = [];
  };

  for (const line of lines) {
    if (line === "[") {
      flush();
      mode = "component";
      continue;
    }
    if (line === "(") {
      flush();
      mode = "net";
      continue;
    }
    if (line === "]" || line === ")") {
      flush();
      mode = "none";
      continue;
    }
    if (mode !== "none" && line) {
      block.push(line);
    }
  }
  flush();

  return { nets, components, parsed: nets.length > 0 || components.length > 0 };
}

/**
 * `R1-1` and `U3-P-` both occur: the designator is everything before the FIRST
 * hyphen, since pin names themselves contain hyphens but designators do not.
 */
function parsePinRef(raw: string): NetlistPin | undefined {
  const index = raw.indexOf("-");
  if (index <= 0 || index === raw.length - 1) {
    return undefined;
  }
  return { designator: raw.slice(0, index), pin: raw.slice(index + 1) };
}

function isPin(value: NetlistPin | undefined): value is NetlistPin {
  return value !== undefined;
}

export type NetlistDiff = {
  matched: string[];
  missingNets: string[];
  unexpectedNets: string[];
  pinMismatches: Array<{ net: string; missingPins: string[]; unexpectedPins: string[] }>;
  ok: boolean;
};

/**
 * Compares an actual netlist against an intended net -> pins map. Pin order is
 * irrelevant, so both sides are compared as sets; a net present on both sides
 * with differing membership is reported as a mismatch rather than as a missing
 * net, because that is the failure a wiring mistake actually produces.
 */
export function diffNetlist(actual: ParsedNetlist, expected: Record<string, string[]>): NetlistDiff {
  const actualByName = new Map(actual.nets.map((net) => [net.name, net]));
  const expectedNames = Object.keys(expected);

  const matched: string[] = [];
  const missingNets: string[] = [];
  const pinMismatches: NetlistDiff["pinMismatches"] = [];

  for (const name of expectedNames) {
    const net = actualByName.get(name);
    if (!net) {
      missingNets.push(name);
      continue;
    }
    const actualPins = new Set(net.pins.map(formatPin));
    const expectedPins = new Set(expected[name]);
    const missingPins = [...expectedPins].filter((pin) => !actualPins.has(pin));
    const unexpectedPins = [...actualPins].filter((pin) => !expectedPins.has(pin));
    if (missingPins.length || unexpectedPins.length) {
      pinMismatches.push({ net: name, missingPins, unexpectedPins });
    } else {
      matched.push(name);
    }
  }

  const unexpectedNets = actual.nets
    .map((net) => net.name)
    .filter((name) => !(name in expected));

  return {
    matched,
    missingNets,
    unexpectedNets,
    pinMismatches,
    ok: missingNets.length === 0 && pinMismatches.length === 0
  };
}

export function formatPin(pin: NetlistPin): string {
  return `${pin.designator}-${pin.pin}`;
}

export function summarizeNetlist(parsed: ParsedNetlist): {
  netCount: number;
  componentCount: number;
  pinCount: number;
  singleEndedNets: string[];
} {
  return {
    netCount: parsed.nets.length,
    componentCount: parsed.components.length,
    pinCount: parsed.nets.reduce((sum, net) => sum + net.pins.length, 0),
    // A net reaching one pin connects nothing; it is the cheapest real defect a
    // netlist exposes, and it survives every geometry check that came before.
    singleEndedNets: parsed.nets.filter((net) => net.pins.length < 2).map((net) => net.name)
  };
}
