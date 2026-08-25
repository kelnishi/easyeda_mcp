import { describe, expect, it } from "vitest";
import { diffSheet, diffSnapshots, parseProSource, readSheet, serializeProSource } from "./proSource.js";

const SOURCE = [
  '{"type":"DOCHEAD"}||{"docType":"SCH_PAGE","uuid":"page-1"}|',
  '{"type":"CANVAS","ticket":1,"id":"CANVAS"}||{"originX":0,"originY":0}|',
  '{"type":"COMPONENT","ticket":4,"id":"e2"}||{"partId":"NFET REV-PROT.1","x":920,"y":190}|',
  '{"type":"ATTR","ticket":5,"id":"e3"}||{"key":"Designator","value":"Q3","parentId":"e2","x":920,"y":174}|',
  '{"type":"ATTR","ticket":6,"id":"e4"}||{"key":"Device","value":"dev-q3","parentId":"e2","x":920,"y":-190}|',
  '{"type":"COMPONENT","ticket":7,"id":"e10"}||{"partId":"IND 4U7 3A.1","x":1120,"y":190}|',
  '{"type":"ATTR","ticket":8,"id":"e11"}||{"key":"Designator","value":"L1","parentId":"e10","x":1120,"y":174}|',
  '{"type":"WIRE","ticket":9,"id":"e408"}||{"zIndex":408}|',
  '{"type":"LINE","ticket":10,"id":"line1"}||{"startX":880,"startY":200,"endX":900,"endY":200,"lineGroup":"e408"}|',
  '{"type":"ATTR","ticket":11,"id":"e409"}||{"key":"NET","value":"PACK_NEG","parentId":"e408","x":914,"y":196}|',
  ""
].join("\n");

describe("parseProSource", () => {
  it("splits header and payload for every record", () => {
    const { records, unparsed } = parseProSource(SOURCE);
    expect(unparsed).toEqual([]);
    expect(records).toHaveLength(10);
    expect(records[2]).toMatchObject({ type: "COMPONENT", id: "e2", ticket: 4 });
    expect(records[2].payload.partId).toBe("NFET REV-PROT.1");
  });

  it("collects unrecognized lines rather than discarding them", () => {
    const { records, unparsed } = parseProSource("garbage\n" + SOURCE);
    expect(unparsed).toEqual(["garbage"]);
    expect(records).toHaveLength(10);
  });

  it("round-trips through serialize without losing records", () => {
    const { records } = parseProSource(SOURCE);
    const again = parseProSource(serializeProSource(records));
    expect(again.records).toHaveLength(records.length);
    expect(again.records[2].payload).toEqual(records[2].payload);
  });
});

describe("readSheet", () => {
  it("joins a component to the attributes that name it", () => {
    // Identity is spread across records: position on the COMPONENT, designator
    // and device on separate ATTRs pointing back through parentId.
    const model = readSheet(parseProSource(SOURCE).records);
    const q3 = model.components.find((component) => component.designator === "Q3");
    expect(q3).toMatchObject({ id: "e2", partId: "NFET REV-PROT.1", x: 920, y: 190, deviceUuid: "dev-q3" });
  });

  it("reads net labels with the wire they belong to", () => {
    const model = readSheet(parseProSource(SOURCE).records);
    expect(model.netLabels).toEqual([
      { id: "e409", net: "PACK_NEG", x: 914, y: 196, wireId: "e408", source: "attr" }
    ]);
  });

  it("counts records by type", () => {
    const model = readSheet(parseProSource(SOURCE).records);
    expect(model.counts).toMatchObject({ COMPONENT: 2, WIRE: 1, LINE: 1 });
  });
});

describe("diffSheet", () => {
  const live = readSheet(parseProSource(SOURCE).records);

  it("reports nothing when the live sheet matches intent", () => {
    const diff = diffSheet(live, {
      components: [
        { designator: "Q3", part: "NFET REV-PROT", x: 920, y: 190 },
        { designator: "L1", part: "IND 4U7 3A", x: 1120, y: 190 }
      ],
      nets: ["PACK_NEG"]
    });
    expect(diff.changes).toEqual([]);
    expect(diff.identical).toBe(true);
  });

  it("sees a component someone moved in the editor", () => {
    const diff = diffSheet(live, {
      components: [
        { designator: "Q3", part: "NFET REV-PROT", x: 920, y: 190 },
        { designator: "L1", part: "IND 4U7 3A", x: 1060, y: 190 }
      ],
      nets: ["PACK_NEG"]
    });
    expect(diff.changes).toEqual([
      { kind: "moved", designator: "L1", from: { x: 1060, y: 190 }, to: { x: 1120, y: 190 } }
    ]);
  });

  it("matches either y orientation, since the API and the source disagree on its sign", () => {
    const diff = diffSheet(live, {
      components: [{ designator: "Q3", part: "NFET REV-PROT", x: 920, y: -190 }],
      nets: ["PACK_NEG"]
    });
    expect(diff.changes.filter((change) => change.kind === "moved")).toEqual([]);
  });

  it("sees a component added in the editor", () => {
    const diff = diffSheet(live, {
      components: [{ designator: "Q3", part: "NFET REV-PROT", x: 920, y: 190 }],
      nets: ["PACK_NEG"]
    });
    expect(diff.changes).toContainEqual({
      kind: "added",
      designator: "L1",
      part: "IND 4U7 3A.1",
      at: { x: 1120, y: 190 }
    });
  });

  it("sees a component deleted from the editor", () => {
    const diff = diffSheet(live, {
      components: [
        { designator: "Q3", part: "NFET REV-PROT", x: 920, y: 190 },
        { designator: "L1", part: "IND 4U7 3A", x: 1120, y: 190 },
        { designator: "R9", part: "100R", x: 10, y: 10 }
      ],
      nets: ["PACK_NEG"]
    });
    expect(diff.changes).toContainEqual({ kind: "removed", designator: "R9", part: "100R" });
  });

  it("reports nets present on only one side", () => {
    const diff = diffSheet(live, {
      components: [
        { designator: "Q3", part: "NFET REV-PROT", x: 920, y: 190 },
        { designator: "L1", part: "IND 4U7 3A", x: 1120, y: 190 }
      ],
      nets: ["PACK_NEG", "VBAT_F"]
    });
    expect(diff.netsOnlyInIntent).toEqual(["VBAT_F"]);
    expect(diff.netsOnlyInLive).toEqual([]);
  });
});

describe("diffSnapshots", () => {
  // The edit that broke designator-keyed diffing: R1 renamed to R0 in place,
  // and a real library resistor placed under the freed designator R1. Keyed on
  // designator this reads as "R1 moved and changed part, R0 added" -- the old
  // part is reported as having moved when it never left (60,170).
  const before = readSheet(
    parseProSource(
      [
        '{"type":"COMPONENT","id":"e10"}||{"partId":"100K G-PULLUP.1","x":60,"y":170}|',
        '{"type":"ATTR","id":"a1"}||{"key":"Designator","value":"R1","parentId":"e10"}|',
        '{"type":"ATTR","id":"a2"}||{"key":"Unique ID","value":"gge116","parentId":"e10"}|',
        '{"type":"COMPONENT","id":"e2"}||{"partId":"PFET HI-SIDE.1","x":60,"y":90}|',
        '{"type":"ATTR","id":"a3"}||{"key":"Designator","value":"Q1","parentId":"e2"}|'
      ].join("\n")
    ).records
  );

  const after = readSheet(
    parseProSource(
      [
        '{"type":"COMPONENT","id":"e10"}||{"partId":"100K G-PULLUP.1","x":60,"y":170}|',
        '{"type":"ATTR","id":"a1"}||{"key":"Designator","value":"R0","parentId":"e10"}|',
        '{"type":"ATTR","id":"a2"}||{"key":"Unique ID","value":"gge116","parentId":"e10"}|',
        '{"type":"COMPONENT","id":"e2"}||{"partId":"PFET HI-SIDE.1","x":-60,"y":100}|',
        '{"type":"ATTR","id":"a3"}||{"key":"Designator","value":"Q1","parentId":"e2"}|',
        '{"type":"COMPONENT","id":"5239e4e3dfcc8823"}||{"partId":"电阻.1","x":20,"y":330}|',
        '{"type":"ATTR","id":"a4"}||{"key":"Designator","value":"R1","parentId":"5239e4e3dfcc8823"}|'
      ].join("\n")
    ).records
  );

  it("reports the rename as a rename, not a move", () => {
    const changes = diffSnapshots(before, after);
    const forE10 = changes.filter((change) => change.id === "e10");
    expect(forE10).toHaveLength(1);
    expect(forE10[0]).toMatchObject({ kind: "renamed", designator: "R0" });
  });

  it("does not claim the renamed part moved", () => {
    const changes = diffSnapshots(before, after);
    expect(changes.some((change) => change.id === "e10" && change.kind === "moved")).toBe(false);
  });

  it("reports the new component as added, under its own id", () => {
    const changes = diffSnapshots(before, after);
    const added = changes.filter((change) => change.kind === "added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: "5239e4e3dfcc8823", designator: "R1", origin: "editor" });
  });

  it("reports the genuine move", () => {
    const changes = diffSnapshots(before, after);
    expect(changes).toContainEqual(
      expect.objectContaining({ id: "e2", kind: "moved", designator: "Q1" })
    );
  });

  it("marks provenance so a hand edit is distinguishable from a generated part", () => {
    expect(after.components.find((c) => c.id === "e10")?.origin).toBe("imported");
    expect(after.components.find((c) => c.id === "5239e4e3dfcc8823")?.origin).toBe("editor");
  });

  it("reports a deletion", () => {
    const changes = diffSnapshots(after, before);
    expect(changes).toContainEqual(
      expect.objectContaining({ id: "5239e4e3dfcc8823", kind: "removed" })
    );
  });
});

describe("net flags", () => {
  // A label placed in the editor is a COMPONENT with no designator whose name
  // is the net. Reading only ATTR key=NET reported "net labels 23 -> 23" for a
  // sheet that had just gained one -- a false negative on the edit being looked
  // for.
  const withFlag = readSheet(
    parseProSource(
      [
        '{"type":"COMPONENT","id":"e10"}||{"partId":"100K G-PULLUP.1","x":60,"y":170}|',
        '{"type":"ATTR","id":"a1"}||{"key":"Designator","value":"R0","parentId":"e10"}|',
        '{"type":"WIRE","id":"w1"}||{"zIndex":1}|',
        '{"type":"LINE","id":"l1"}||{"startX":-50,"startY":320,"endX":-50,"endY":330,"lineGroup":"w1"}|',
        '{"type":"COMPONENT","id":"flag1"}||{"partId":"pid8a0e77bacb214e","x":-50,"y":320}|',
        '{"type":"ATTR","id":"a2"}||{"key":"Name","value":"NET1","parentId":"flag1"}|'
      ].join("\n")
    ).records
  );

  it("reads a net flag as a label, not as a part", () => {
    expect(withFlag.components.map((component) => component.designator)).toEqual(["R0"]);
    expect(withFlag.netLabels).toHaveLength(1);
    expect(withFlag.netLabels[0]).toMatchObject({ net: "NET1", source: "flag" });
  });

  it("finds the wire a flag sits on, which it does not reference", () => {
    expect(withFlag.netLabels[0].wireId).toBe("w1");
  });

  it("marks where each label came from", () => {
    const model = readSheet(
      parseProSource(
        [
          '{"type":"WIRE","id":"w1"}||{"zIndex":1}|',
          '{"type":"ATTR","id":"n1"}||{"key":"NET","value":"GND","parentId":"w1","x":10,"y":10}|',
          '{"type":"COMPONENT","id":"flag1"}||{"partId":"pid","x":-50,"y":320}|',
          '{"type":"ATTR","id":"a2"}||{"key":"Name","value":"NET1","parentId":"flag1"}|'
        ].join("\n")
      ).records
    );
    expect(model.netLabels.map((label) => `${label.net}:${label.source}`).sort()).toEqual([
      "GND:attr",
      "NET1:flag"
    ]);
  });

  it("matches a flag to a wire in either y orientation", () => {
    const model = readSheet(
      parseProSource(
        [
          '{"type":"WIRE","id":"w1"}||{"zIndex":1}|',
          '{"type":"LINE","id":"l1"}||{"startX":140,"startY":-345,"endX":140,"endY":-355,"lineGroup":"w1"}|',
          '{"type":"COMPONENT","id":"flag1"}||{"partId":"pid","x":140,"y":345}|',
          '{"type":"ATTR","id":"a2"}||{"key":"Name","value":"GND","parentId":"flag1"}|'
        ].join("\n")
      ).records
    );
    expect(model.netLabels[0].wireId).toBe("w1");
  });
});
