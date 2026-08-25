import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { hasExplicitMutationConfirmation, registerEasyEdaTools } from "./registerTools.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function makeClient(bridge: { endpoint: string; getStatus: () => unknown; call: ReturnType<typeof vi.fn> }): Promise<Client> {
  const server = new McpServer({
    name: "test-server",
    version: "0.0.0"
  });
  registerEasyEdaTools(server, bridge as never);

  const client = new Client({
    name: "test-client",
    version: "0.0.0"
  });
  clients.push(client);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  return client;
}

describe("mutation confirmation guard", () => {
  it("accepts explicit confirmation phrases", () => {
    expect(hasExplicitMutationConfirmation("confirma salvar")).toBe(true);
    expect(hasExplicitMutationConfirmation("I confirm this save")).toBe(true);
  });

  it("rejects vague or missing confirmation", () => {
    expect(hasExplicitMutationConfirmation("pode salvar")).toBe(false);
    expect(hasExplicitMutationConfirmation("save it")).toBe(false);
  });

  it("blocks mutating actions without explicit confirmation", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn()
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_confirmed_action",
      arguments: {
        action: "save",
        confirmation: "pode salvar"
      }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain('Action "save" was blocked');
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("forwards confirmed actions to the bridge", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn(async () => ({ saved: true, documentUuid: "doc-123" }))
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_confirmed_action",
      arguments: {
        action: "save",
        confirmation: "confirma salvar",
        timeoutMs: 12_345
      }
    });

    expect(bridge.call).toHaveBeenCalledWith("confirmedAction", {
      action: "save",
      confirmation: "confirma salvar",
      params: undefined
    }, 12_345);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      action: "save",
      result: {
        saved: true,
        documentUuid: "doc-123"
      }
    });
  });

  it("forwards verify_connections checks and preserves structured results", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn(async () => ({
        checks: [
          {
            id: "u5-vcc",
            type: "pin_on_net",
            status: "pass",
            message: "Pin is on expected net.",
            evidence: {
              reason: "matched node",
              nodeIds: ["node:1"],
              nets: ["VBUS"]
            }
          }
        ],
        summary: {
          passed: 1,
          warnings: 0,
          failed: 0,
          unknown: 0
        },
        confidence: "high"
      }))
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_verify_connections",
      arguments: {
        checks: [
          {
            id: "u5-vcc",
            type: "pin_on_net",
            component: "U5",
            pinName: "VCC",
            net: "VBUS"
          }
        ],
        maxHops: 6,
        timeoutMs: 20_000
      }
    });

    expect(bridge.call).toHaveBeenCalledWith("verifyConnections", {
      checks: [
        {
          id: "u5-vcc",
          type: "pin_on_net",
          component: "U5",
          pinName: "VCC",
          net: "VBUS"
        }
      ],
      includeRaw: false,
      allPages: true,
      maxHops: 6
    }, 20_000);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      result: {
        summary: {
          passed: 1,
          failed: 0
        },
        confidence: "high"
      }
    });
  });

  it("returns a doctor report without calling the bridge RPC layer", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({
        connected: false,
        connectionState: "disconnected",
        message: "Extension not connected.",
        updatedAt: new Date().toISOString()
      }),
      call: vi.fn()
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_doctor",
      arguments: {}
    });

    expect(bridge.call).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("diagnostics");
    expect(result.structuredContent).toMatchObject({
      doctor: {
        bridge: {
          endpoint: "ws://127.0.0.1:8765"
        },
        extension: {
          connected: false
        }
      }
    });
  });

  it("marks the active document as available when documentInfo exists", async () => {
    const bridge = {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({
        connected: true,
        connectionState: "connected",
        activeDocumentType: "schematic",
        documentInfo: {
          documentType: 1,
          uuid: "doc-123"
        },
        updatedAt: new Date().toISOString()
      }),
      call: vi.fn()
    };
    const client = await makeClient(bridge);

    const result = await client.callTool({
      name: "easyeda_doctor",
      arguments: {}
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      doctor: {
        activeDocument: {
          available: true,
          type: "schematic"
        }
      }
    });
  });
});

describe("api probing", () => {
  function bridgeWith(call: ReturnType<typeof vi.fn>) {
    return {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call
    };
  }

  it("refuses a direct API call without explicit confirmation", async () => {
    const call = vi.fn();
    const client = await makeClient(bridgeWith(call));
    const result = await client.callTool({
      name: "easyeda_call_api",
      arguments: { path: "dmt_Project.openProject", args: ["x"], confirmation: "do it" }
    });

    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("surfaces resultType so an undefined resolve is not read as success", async () => {
    // openProject and openDocument both resolved with undefined while doing
    // nothing, which read as success for three calls running.
    const client = await makeClient(bridgeWith(vi.fn(async () => ({ path: "x.y", resultType: "undefined" }))));
    const result = await client.callTool({
      name: "easyeda_call_api",
      arguments: { path: "x.y", confirmation: "confirmed: probe" }
    });

    expect(result.content?.[0]?.text).toContain("returned undefined");
  });
});

describe("library device search", () => {
  const DEVICE = {
    name: "AP63205QWU-7",
    uuid: "5cf4f756",
    libraryUuid: "0819f05c",
    symbolUuid: "aea4f0f9",
    footprintName: "SOT-23-6",
    footprintUuid: "044d8cf8",
    manufacturer: "DIODES",
    manufacturerId: "AP63205QWU-7",
    supplierId: "C5248537",
    description: "a very long parametric description ".repeat(20),
    otherProperty: { Datasheet: "https://example/ds.pdf", "JLCPCB Part Class": "Extended Part", Features: "x".repeat(400) }
  };

  function client() {
    return makeClient({
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call: vi.fn(async () => ({ mode: "search", devices: [DEVICE] }))
    });
  }

  it("returns identifying fields, not the parametric table", async () => {
    // A real two-result search ran to roughly 4KB of parametrics; at limit 20
    // the response is unusable.
    const result = await (await client()).callTool({
      name: "easyeda_find_library_device",
      arguments: { query: "AP63205" }
    });

    const device = (result.structuredContent as any).devices[0];
    expect(device).toMatchObject({ lcscId: "C5248537", footprintUuid: "044d8cf8", symbolUuid: "aea4f0f9" });
    expect(device.otherProperty).toBeUndefined();
    expect(device.description).toBeUndefined();
  });

  it("returns the whole record when asked", async () => {
    const result = await (await client()).callTool({
      name: "easyeda_find_library_device",
      arguments: { query: "AP63205", detail: "full" }
    });

    expect((result.structuredContent as any).devices[0].otherProperty).toBeDefined();
  });
});

describe("symbol source tools", () => {
  const SYMBOL = '{"type":"PIN","ticket":1,"id":"e0"}||{"pinNumber":"1"}|';

  function bridgeWith(call: ReturnType<typeof vi.fn>) {
    return {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call
    };
  }

  it("reports the PIN count, which is the reason to read a symbol at all", async () => {
    const client = await makeClient(bridgeWith(vi.fn(async () => ({ source: SYMBOL }))));
    const result = await client.callTool({
      name: "easyeda_get_symbol_source",
      arguments: { symbolUuid: "94eb853d90cef179" }
    });

    expect((result.structuredContent as any).recordTypes).toEqual({ PIN: 1 });
    expect(result.content?.[0]?.text).toContain("1 PIN record");
  });

  it("refuses to write a symbol without an explicit confirmation", async () => {
    const call = vi.fn();
    const client = await makeClient(bridgeWith(call));
    const result = await client.callTool({
      name: "easyeda_set_symbol_source",
      arguments: { symbolUuid: "abc", source: SYMBOL, confirmation: "ok go" }
    });

    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("backs the symbol up before replacing it", async () => {
    const call = vi.fn(async (method: string) =>
      method === "getSymbolSource" ? { source: "OLD SYMBOL" } : { applied: true }
    );
    const client = await makeClient(bridgeWith(call as never));
    const result = await client.callTool({
      name: "easyeda_set_symbol_source",
      arguments: { symbolUuid: "abc", source: SYMBOL, confirmation: "confirmed: add pins" }
    });

    const structured = result.structuredContent as any;
    expect(structured.applied).toBe(true);
    expect(await readFile(structured.backupPath, "utf8")).toBe("OLD SYMBOL");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["getSymbolSource", "updateSymbolSource"]);
  });

  it("surfaces a rejected symbol write as applied:false", async () => {
    const call = vi.fn(async (method: string) =>
      method === "getSymbolSource" ? { source: "OLD" } : { applied: false, reason: "bad symbol" }
    );
    const client = await makeClient(bridgeWith(call as never));
    const result = await client.callTool({
      name: "easyeda_set_symbol_source",
      arguments: { symbolUuid: "abc", source: SYMBOL, confirmation: "confirmed: add pins", skipBackup: true }
    });

    expect((result.structuredContent as any).applied).toBe(false);
    expect((result.structuredContent as any).reason).toBe("bad symbol");
  });
});

describe("verify_connections evidence trimming", () => {
  function bridgeWith(call: ReturnType<typeof vi.fn>) {
    return {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call
    };
  }

  const RESULT = {
    checks: [
      { id: "a", status: "pass", evidence: { matchedPins: ["lots", "of", "detail"] } },
      { id: "b", status: "fail", evidence: { reason: "why it failed" } }
    ],
    summary: { passed: 1, failed: 1, unknown: 0 }
  };

  it("keeps evidence on failures and drops it from passes", async () => {
    // A 40-check batch with evidence on every entry ran to 200KB, which is the
    // whole reason this default exists.
    const client = await makeClient(bridgeWith(vi.fn(async () => RESULT)));
    const result = await client.callTool({
      name: "easyeda_verify_connections",
      arguments: { checks: [{ type: "pin_connected", component: "R1" }] }
    });

    const checks = (result.structuredContent as any).result.checks;
    expect(checks[0].evidence).toBeUndefined();
    expect(checks[1].evidence).toEqual({ reason: "why it failed" });
  });

  it("keeps everything when asked", async () => {
    const client = await makeClient(bridgeWith(vi.fn(async () => RESULT)));
    const result = await client.callTool({
      name: "easyeda_verify_connections",
      arguments: { checks: [{ type: "pin_connected", component: "R1" }], evidence: "all" }
    });

    const checks = (result.structuredContent as any).result.checks;
    expect(checks[0].evidence).toBeDefined();
  });

  it("drops all evidence when asked", async () => {
    const client = await makeClient(bridgeWith(vi.fn(async () => RESULT)));
    const result = await client.callTool({
      name: "easyeda_verify_connections",
      arguments: { checks: [{ type: "pin_connected", component: "R1" }], evidence: "none" }
    });

    const checks = (result.structuredContent as any).result.checks;
    expect(checks[1].evidence).toBeUndefined();
  });
});

describe("import schematic", () => {
  it("refuses to import without an explicit confirmation", async () => {
    const call = vi.fn();
    const client = await makeClient({
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call
    });

    const result = await client.callTool({
      name: "easyeda_import_schematic",
      arguments: { filePath: "/tmp/sheet.json", confirmation: "sure" }
    });

    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("delete schematic", () => {
  function bridgeWith(call: ReturnType<typeof vi.fn>) {
    return {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call
    };
  }

  it("refuses to delete without an explicit confirmation", async () => {
    const call = vi.fn();
    const client = await makeClient(bridgeWith(call));

    const result = await client.callTool({
      name: "easyeda_delete_schematic",
      arguments: { uuid: "240b9c508235f5e1", confirmation: "yes please" }
    });

    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("deletes by uuid and reports the schematic count either side", async () => {
    const call = vi.fn(async () => ({ scope: "schematic", uuid: "abc", schematicsBefore: 2, schematicsAfter: 1 }));
    const client = await makeClient(bridgeWith(call));

    const result = await client.callTool({
      name: "easyeda_delete_schematic",
      arguments: { uuid: "abc", confirmation: "confirmed: delete the superseded import" }
    });

    expect(result.isError).toBeFalsy();
    expect(call).toHaveBeenCalledWith("deleteSchematic", { uuid: "abc", scope: "schematic" }, 30_000);
    expect(result.structuredContent).toMatchObject({ result: { schematicsAfter: 1 } });
  });
});

describe("document source tools", () => {
  const SOURCE = '{"type":"PIN","ticket":1,"id":"e0"}||{}|';

  function bridgeWith(call: ReturnType<typeof vi.fn>) {
    return {
      endpoint: "ws://127.0.0.1:8765",
      getStatus: () => ({ connected: true, updatedAt: new Date().toISOString() }),
      call
    };
  }

  it("saves the source to disk and summarizes it instead of returning it wholesale", async () => {
    const call = vi.fn(async () => ({ source: SOURCE, documentInfo: { uuid: "doc-1" } }));
    const client = await makeClient(bridgeWith(call));

    const result = await client.callTool({
      name: "easyeda_get_document_source",
      arguments: {}
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.recordTypes).toEqual({ PIN: 1 });
    expect(structured.source).toBeUndefined();
    expect(typeof structured.path).toBe("string");
    expect(await readFile(structured.path as string, "utf8")).toBe(SOURCE);
  });

  it("refuses a source with no EasyEDA Pro records", async () => {
    // Writing EasyEDA Standard generator JSON here returned applied:true and
    // left the document holding only DOCHEAD and CANVAS -- a populated sheet
    // wiped by a call that reported success.
    const call = vi.fn();
    const client = await makeClient(bridgeWith(call));

    const result = await client.callTool({
      name: "easyeda_set_document_source",
      arguments: {
        source: JSON.stringify({ head: { docType: "1" }, shape: ["W~1 2 3 4~"] }),
        confirmation: "confirmed: write it"
      }
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/no EasyEDA Pro records/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("allows a deliberately empty document when asked", async () => {
    const call = vi.fn(async (method: string) =>
      method === "getDocumentSource" ? { source: "OLD" } : { applied: true }
    );
    const client = await makeClient(bridgeWith(call as never));

    const result = await client.callTool({
      name: "easyeda_set_document_source",
      arguments: { source: "nothing parsable", confirmation: "confirmed: blank it", allowEmpty: true }
    });

    expect(result.isError).toBeFalsy();
    expect(call).toHaveBeenCalled();
  });

  it("refuses to write without an explicit confirmation", async () => {
    const call = vi.fn();
    const client = await makeClient(bridgeWith(call));

    const result = await client.callTool({
      name: "easyeda_set_document_source",
      arguments: { source: SOURCE, confirmation: "go ahead" }
    });

    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("backs the current document up before replacing it", async () => {
    const call = vi.fn(async (method: string) =>
      method === "getDocumentSource" ? { source: "OLD" } : { applied: true }
    );
    const client = await makeClient(bridgeWith(call as never));

    const result = await client.callTool({
      name: "easyeda_set_document_source",
      arguments: { source: SOURCE, confirmation: "confirmed: replace it" }
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.applied).toBe(true);
    expect(await readFile(structured.backupPath as string, "utf8")).toBe("OLD");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["getDocumentSource", "setDocumentSource"]);
  });

  it("surfaces a rejected write as applied:false rather than success", async () => {
    // EasyEDA signals malformed source by returning false, not by throwing, so
    // a resolved promise must not be read as a landed write.
    const call = vi.fn(async (method: string) =>
      method === "getDocumentSource" ? { source: "OLD" } : { applied: false, reason: "bad format" }
    );
    const client = await makeClient(bridgeWith(call as never));

    const result = await client.callTool({
      name: "easyeda_set_document_source",
      arguments: { source: SOURCE, confirmation: "confirmed: replace it", skipBackup: true }
    });

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.applied).toBe(false);
    expect(structured.reason).toBe("bad format");
  });

  it("rejects ambiguous input that names both a file and inline source", async () => {
    const call = vi.fn();
    const client = await makeClient(bridgeWith(call));

    const result = await client.callTool({
      name: "easyeda_set_document_source",
      arguments: { source: SOURCE, filePath: "/tmp/x.epru", confirmation: "confirmed: replace it" }
    });

    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});
