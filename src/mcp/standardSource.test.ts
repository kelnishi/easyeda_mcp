import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { readStandardSheet } from "./standardSource.js";

const GENERATED = "/Users/kelvinnishikawa/electronics/kamen_driver/generated";

describe("readStandardSheet", () => {
  it("reads designators, parts and positions from a real generated sheet", async () => {
    const json = JSON.parse(await readFile(`${GENERATED}/ble-sheet.json`, "utf8"));
    const sheet = readStandardSheet(json);

    expect(sheet.components.map((component) => component.designator)).toEqual([
      "C1",
      "J1",
      "Q1",
      "R1",
      "R2",
      "U1"
    ]);
    const u1 = sheet.components.find((component) => component.designator === "U1");
    expect(u1?.part).toContain("ESP32");
    expect(typeof u1?.x).toBe("number");
  });

  it("collects the sheet's nets", async () => {
    const json = JSON.parse(await readFile(`${GENERATED}/ble-sheet.json`, "utf8"));
    const sheet = readStandardSheet(json);
    expect(sheet.nets).toContain("NEIGHBOR_EVT");
    expect(sheet.nets).toContain("BLE_UART_TX");
    expect(sheet.nets).toContain("GND");
  });

  it("returns empty for something that is not a sheet", () => {
    expect(readStandardSheet({ nope: true })).toEqual({ components: [], nets: [] });
    expect(readStandardSheet(null)).toEqual({ components: [], nets: [] });
  });
});
