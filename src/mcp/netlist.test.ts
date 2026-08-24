import { describe, expect, it } from "vitest";
import { diffNetlist, parseProtel2Netlist, summarizeNetlist } from "./netlist.js";

const PROTEL2 = `[
R1
0603
5.1K
]
[
U3
SOT23
BM3451
]
(
CC1
R1-1
J1-A5
)
(
PACK_NEG
U3-P-
Q3-S
)
(
DANGLING
R1-2
)
`;

describe("parseProtel2Netlist", () => {
  it("reads components and nets", () => {
    const parsed = parseProtel2Netlist(PROTEL2);
    expect(parsed.parsed).toBe(true);
    expect(parsed.components).toEqual(["R1", "U3"]);
    expect(parsed.nets.map((net) => net.name)).toEqual(["CC1", "PACK_NEG", "DANGLING"]);
  });

  it("splits a pin reference at the first hyphen, not the last", () => {
    // U3's pin is literally named "P-", so splitting on the last hyphen would
    // yield designator "U3-P" and an empty pin.
    const parsed = parseProtel2Netlist(PROTEL2);
    const packNeg = parsed.nets.find((net) => net.name === "PACK_NEG");
    expect(packNeg?.pins).toEqual([
      { designator: "U3", pin: "P-" },
      { designator: "Q3", pin: "S" }
    ]);
  });

  it("reports unparsable text rather than an empty netlist", () => {
    const parsed = parseProtel2Netlist("this is not a netlist");
    expect(parsed.parsed).toBe(false);
    expect(parsed.nets).toEqual([]);
  });
});

describe("summarizeNetlist", () => {
  it("counts pins and flags nets that reach only one", () => {
    const summary = summarizeNetlist(parseProtel2Netlist(PROTEL2));
    expect(summary).toMatchObject({ netCount: 3, componentCount: 2, pinCount: 5 });
    expect(summary.singleEndedNets).toEqual(["DANGLING"]);
  });
});

describe("diffNetlist", () => {
  const parsed = parseProtel2Netlist(PROTEL2);

  it("passes when every expected net has exactly its expected pins", () => {
    const diff = diffNetlist(parsed, {
      CC1: ["J1-A5", "R1-1"],
      PACK_NEG: ["U3-P-", "Q3-S"],
      DANGLING: ["R1-2"]
    });
    expect(diff.ok).toBe(true);
    expect(diff.matched).toHaveLength(3);
  });

  it("reports a wrongly-wired net as a pin mismatch, not a missing net", () => {
    // The distinction matters: a missing net means the label never landed, a pin
    // mismatch means it landed on the wrong thing. Different fixes.
    const diff = diffNetlist(parsed, { PACK_NEG: ["U3-P-", "Q3-D"] });
    expect(diff.missingNets).toEqual([]);
    expect(diff.pinMismatches).toEqual([
      { net: "PACK_NEG", missingPins: ["Q3-D"], unexpectedPins: ["Q3-S"] }
    ]);
    expect(diff.ok).toBe(false);
  });

  it("reports an expected net that the netlist does not have at all", () => {
    const diff = diffNetlist(parsed, { VBAT_F: ["F1-2"] });
    expect(diff.missingNets).toEqual(["VBAT_F"]);
    expect(diff.ok).toBe(false);
  });

  it("lists nets present in the design but absent from intent without failing", () => {
    const diff = diffNetlist(parsed, { CC1: ["R1-1", "J1-A5"] });
    expect(diff.unexpectedNets).toEqual(["PACK_NEG", "DANGLING"]);
    expect(diff.ok).toBe(true);
  });

  it("ignores pin order", () => {
    expect(diffNetlist(parsed, { CC1: ["J1-A5", "R1-1"] }).ok).toBe(true);
    expect(diffNetlist(parsed, { CC1: ["R1-1", "J1-A5"] }).ok).toBe(true);
  });
});
