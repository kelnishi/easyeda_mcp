import { describe, expect, it } from "vitest";
import { diffSheet, parseProSource, readSheet, serializeProSource } from "./proSource.js";

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
      { id: "e409", net: "PACK_NEG", x: 914, y: 196, wireId: "e408" }
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
