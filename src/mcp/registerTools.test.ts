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
