import { describe, expect, it } from "vitest";
import { KNOWN_LIMITATIONS, assessReadiness } from "./limitations.js";

describe("assessReadiness", () => {
  it("blocks on the connection before anything else", () => {
    const readiness = assessReadiness({ connected: false, schematicCount: 3, activeDocumentType: "schematic" });
    expect(readiness.blocking).toHaveLength(1);
    expect(readiness.blocking[0]).toMatch(/not connected/i);
  });

  it("names the missing project when connected with nothing loaded", () => {
    // The failure mode this exists for: every document API returns undefined or
    // an empty list, none of them error, and the cause is invisible.
    const readiness = assessReadiness({ connected: true, schematicCount: 0, activeDocumentType: "unknown" });
    expect(readiness.projectLoaded).toBe(false);
    expect(readiness.blocking[0]).toMatch(/No project is loaded/);
  });

  it("distinguishes a loaded project with no open document", () => {
    const readiness = assessReadiness({ connected: true, schematicCount: 1, activeDocumentType: "unknown" });
    expect(readiness.projectLoaded).toBe(true);
    expect(readiness.documentOpen).toBe(false);
    expect(readiness.blocking[0]).toMatch(/no document is open/i);
  });

  it("reports nothing blocking when a document is open", () => {
    const readiness = assessReadiness({ connected: true, schematicCount: 1, activeDocumentType: "schematic" });
    expect(readiness.blocking).toEqual([]);
    expect(readiness.documentOpen).toBe(true);
  });

  it("treats an unreadable schematic count as no project rather than assuming one", () => {
    const readiness = assessReadiness({ connected: true, activeDocumentType: "unknown" });
    expect(readiness.projectLoaded).toBe(false);
  });
});

describe("KNOWN_LIMITATIONS", () => {
  it("gives every entry a cause and a working alternative", () => {
    // An entry that says only "this is broken" sends the reader looking for a
    // workaround that has already been found.
    for (const limitation of KNOWN_LIMITATIONS) {
      expect(limitation.capability.length).toBeGreaterThan(0);
      expect(limitation.behaviour.length).toBeGreaterThan(0);
      expect(limitation.cause.length).toBeGreaterThan(0);
      expect(limitation.instead.length).toBeGreaterThan(0);
    }
  });

  it("covers the capabilities that resolve successfully while doing nothing", () => {
    const names = KNOWN_LIMITATIONS.map((entry) => entry.capability).join(" ");
    expect(names).toMatch(/import_schematic/);
    expect(names).toMatch(/open_project/);
    expect(names).toMatch(/symbol_source/);
    expect(names).toMatch(/netlist/);
  });
});
