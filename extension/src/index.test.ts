import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

type WebSocketRegistration = {
  onMessage?: (event: MessageEvent<string>) => Promise<void>;
  onOpen?: () => Promise<void>;
};

function component(designator: string, primitiveId: string, value = designator): Record<string, unknown> {
  return {
    designator,
    primitiveId,
    name: value,
    x: 0,
    y: 0
  };
}

function pin(pinNumber: string, pinName: string, x: number, y: number): Record<string, unknown> {
  return {
    primitiveId: `$pin-${pinNumber}-${pinName}`,
    pinNumber,
    pinName,
    x,
    y
  };
}

function wire(net: string | undefined, path: number[][]): Record<string, unknown> {
  return {
    primitiveId: `$wire-${net ?? "unnamed"}-${path.length}`,
    net,
    line: path
  };
}

describe("EasyEDA extension bridge handlers", () => {
  let sentMessages: Array<{ id: string; message: string }> = [];
  let registration: WebSocketRegistration;
  let dialogMessages: Array<{ title: string; message: string }> = [];
  let savedDocumentUuids: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    sentMessages = [];
    registration = {};
    dialogMessages = [];
    savedDocumentUuids = [];

    vi.stubGlobal("eda", {
      sys_WebSocket: {
        register: vi.fn((_id: string, _uri: string, onMessage: WebSocketRegistration["onMessage"], onOpen: WebSocketRegistration["onOpen"]) => {
          registration = { onMessage, onOpen };
        }),
        send: vi.fn((id: string, message: string) => {
          sentMessages.push({ id, message });
        })
      },
      sys_Dialog: {
        showInformationMessage: vi.fn((message: string, title: string) => {
          dialogMessages.push({ title, message });
        })
      },
      sys_Log: {
        warn: vi.fn(),
        error: vi.fn()
      },
      dmt_SelectControl: {
        getCurrentDocumentInfo: vi.fn(async () => ({
          uuid: "doc-123",
          type: "schematic",
          name: "Power Supply.Schematic"
        }))
      },
      dmt_EditorControl: {
        getSplitScreenTree: vi.fn(async () => []),
        zoomToRegion: vi.fn(async () => undefined)
      },
      sch_PrimitiveComponent: {
        getAll: vi.fn(async () => [component("U5", "$u5", "TP4057"), component("R7", "$r7", "2k"), component("C4", "$c4", "4.7uF")]),
        getAllPinsByPrimitiveId: vi.fn(async (primitiveId: string) => {
          const pinsByPrimitive: Record<string, unknown[]> = {
            $u5: [
              pin("1", "BAT", 60, 0),
              pin("2", "VCC", 20, 0),
              pin("6", "PROG", 90, 20)
            ],
            $r7: [
              pin("1", "1", 90, 20),
              pin("2", "2", 90, 40)
            ],
            $c4: [
              pin("1", "1", 20, 0),
              pin("2", "2", 20, 20)
            ]
          };
          return pinsByPrimitive[primitiveId] ?? [];
        })
      },
      sch_PrimitiveWire: {
        getAll: vi.fn(async () => [
          wire("VBUS", [[0, 0, 20, 0]]),
          wire("VBAT_LIPO", [[60, 0, 80, 0]]),
          wire(undefined, [[90, 20, 100, 20]]),
          wire("GND", [[20, 20, 20, 40], [20, 40, 90, 40]])
        ])
      },
      sch_PrimitiveText: {
        getAll: vi.fn(async () => [])
      },
      sch_Document: {
        save: vi.fn(async (uuid: string) => {
          savedDocumentUuids.push(uuid);
        })
      }
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("auto-connects on activation and sends hello on open", async () => {
    const extension = await import("./index.js");

    extension.activate("onStartupFinished");
    expect(registration.onOpen).toBeTypeOf("function");

    await registration.onOpen?.();

    const helloMessage = JSON.parse(sentMessages.at(0)?.message ?? "{}");
    expect(helloMessage.kind).toBe("hello");
    expect(helloMessage.protocolVersion).toBe("0.1.0");
    expect(helloMessage.compatibility).toMatchObject({
      compatible: true,
      expectedProtocolVersion: "0.1.0"
    });
  });

  it("infers schematic type from numeric documentType in status", async () => {
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      dmt_SelectControl: {
        getCurrentDocumentInfo: vi.fn(async () => ({
          uuid: "doc-123",
          documentType: 1
        }))
      }
    });

    const extension = await import("./index.js");

    extension.activate("onStartupFinished");
    await registration.onOpen?.();

    const helloMessage = JSON.parse(sentMessages.at(0)?.message ?? "{}");
    expect(helloMessage.status.activeDocumentType).toBe("schematic");
  });

  it("responds to verifyConnections requests with structured results", async () => {
    const extension = await import("./index.js");

    extension.connect();
    await registration.onOpen?.();

    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "verify-1",
        method: "verifyConnections",
        params: {
          checks: [
            {
              id: "u5-vcc",
              type: "pin_on_net",
              component: "U5",
              pinName: "VCC",
              net: "VBUS"
            },
            {
              id: "u5-prog",
              type: "pull_to_net",
              signal: { component: "U5", pinName: "PROG" },
              net: "GND",
              through: { kind: "resistor" }
            }
          ]
        }
      })
    } as MessageEvent<string>);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.kind).toBe("result");
    expect(resultMessage.requestId).toBe("verify-1");
    expect(resultMessage.result.summary).toMatchObject({
      passed: 2,
      failed: 0,
      unknown: 0
    });
    expect(resultMessage.result.checks.map((check: { status: string }) => check.status)).toEqual(["pass", "pass"]);
  });

  it("executes confirmed save actions and returns success payload", async () => {
    const extension = await import("./index.js");

    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "save-1",
        method: "confirmedAction",
        params: {
          action: "save"
        }
      })
    } as MessageEvent<string>);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(savedDocumentUuids).toEqual(["doc-123"]);
    expect(resultMessage.kind).toBe("result");
    expect(resultMessage.result).toMatchObject({
      action: "save",
      saved: true,
      documentUuid: "doc-123"
    });
  });

  it("returns the document source with its byte length", async () => {
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      sys_FileManager: {
        getDocumentSource: vi.fn(async () => '{"type":"PIN"}||{}|')
      }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({ kind: "call", requestId: "src-1", method: "getDocumentSource", params: {} })
    } as MessageEvent<string>);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.kind).toBe("result");
    expect(resultMessage.result).toMatchObject({
      source: '{"type":"PIN"}||{}|',
      byteLength: 19
    });
  });

  it("reports a rejected setDocumentSource as applied:false", async () => {
    // EasyEDA answers malformed source with false rather than an exception.
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      sys_FileManager: {
        getDocumentSource: vi.fn(async () => "OLD"),
        setDocumentSource: vi.fn(async () => false)
      }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "src-2",
        method: "setDocumentSource",
        params: { source: "NEW" }
      })
    } as MessageEvent<string>);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.result).toMatchObject({ applied: false });
    expect(resultMessage.result.reason).toMatch(/unchanged/i);
  });

  it("refuses setDocumentSource without a source string", async () => {
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      sys_FileManager: {
        setDocumentSource: vi.fn(async () => true)
      }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({
        kind: "call",
        requestId: "src-3",
        method: "setDocumentSource",
        params: {}
      })
    } as MessageEvent<string>);

    const resultMessage = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(resultMessage.kind).toBe("error");
    expect(resultMessage.error.code).toBe("missing_source");
  });

  describe("schematic check", () => {
    it("counts violations inside severity buckets rather than counting the buckets", async () => {
      // A live sheet answered [{type:"fatalError",count:41},{type:"warn",count:4}].
      // Treating each bucket as one violation reported 45 problems as 2.
      vi.stubGlobal("eda", {
        ...(globalThis as { eda: Record<string, unknown> }).eda,
        sch_Drc: {
          check: vi.fn(async () => [
            { type: "fatalError", count: 41 },
            { type: "warn", count: 4 }
          ])
        }
      });

      const extension = await import("./index.js");
      extension.connect();
      await registration.onMessage?.({
        data: JSON.stringify({ kind: "call", requestId: "drc-1", method: "schematicCheck", params: {} })
      } as MessageEvent<string>);

      const result = JSON.parse(sentMessages.at(-1)?.message ?? "{}").result;
      expect(result.violationCount).toBe(45);
      expect(result.detail).toBe("aggregate");
      expect(result.passed).toBe(false);
    });

    it("passes through per-violation detail when EasyEDA gives it", async () => {
      vi.stubGlobal("eda", {
        ...(globalThis as { eda: Record<string, unknown> }).eda,
        sch_Drc: {
          check: vi.fn(async () => ["R1 has no footprint", "U3 pin P- is floating"])
        }
      });

      const extension = await import("./index.js");
      extension.connect();
      await registration.onMessage?.({
        data: JSON.stringify({ kind: "call", requestId: "drc-2", method: "schematicCheck", params: {} })
      } as MessageEvent<string>);

      const result = JSON.parse(sentMessages.at(-1)?.message ?? "{}").result;
      expect(result.violationCount).toBe(2);
      expect(result.detail).toBe("verbose");
    });

    it("reports a clean sheet from a bare boolean", async () => {
      vi.stubGlobal("eda", {
        ...(globalThis as { eda: Record<string, unknown> }).eda,
        sch_Drc: { check: vi.fn(async () => true) }
      });

      const extension = await import("./index.js");
      extension.connect();
      await registration.onMessage?.({
        data: JSON.stringify({ kind: "call", requestId: "drc-3", method: "schematicCheck", params: {} })
      } as MessageEvent<string>);

      const result = JSON.parse(sentMessages.at(-1)?.message ?? "{}").result;
      expect(result.passed).toBe(true);
      expect(result.detail).toBe("none");
    });
  });

  it("renders an object rejection instead of [object Object]", async () => {
    // EasyEDA rejects with plain objects. String() turns those into
    // "[object Object]", which is what the caller sees instead of the failure.
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      sch_Drc: {
        check: vi.fn(async () => {
          throw { code: "no_document", message: "No schematic is open." };
        })
      }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({ kind: "call", requestId: "err-1", method: "schematicCheck", params: {} })
    } as MessageEvent<string>);

    const message = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(message.kind).toBe("error");
    expect(message.error.message).toBe("No schematic is open.");
    expect(message.error.code).toBe("no_document");
  });

  it("falls back to JSON when an object rejection carries no message", async () => {
    vi.stubGlobal("eda", {
      ...(globalThis as { eda: Record<string, unknown> }).eda,
      sch_Drc: {
        check: vi.fn(async () => {
          throw { status: 500, detail: "upstream" };
        })
      }
    });

    const extension = await import("./index.js");
    extension.connect();
    await registration.onMessage?.({
      data: JSON.stringify({ kind: "call", requestId: "err-2", method: "schematicCheck", params: {} })
    } as MessageEvent<string>);

    const message = JSON.parse(sentMessages.at(-1)?.message ?? "{}");
    expect(message.error.message).toContain("upstream");
  });

  it("shows diagnostics with connection and document details", async () => {
    const extension = await import("./index.js");

    extension.connect();
    await extension.runDiagnostics();

    expect(dialogMessages.at(-1)).toMatchObject({
      title: "EasyEDA MCP Bridge Diagnostics"
    });
    expect(dialogMessages.at(-1)?.message).toContain("Bridge URI: ws://127.0.0.1:8765");
    expect(dialogMessages.at(-1)?.message).toContain("Connection phase:");
    expect(dialogMessages.at(-1)?.message).toContain("Document: Power Supply.Schematic");
  });
});

describe("extension version", () => {
  it("matches the manifest", async () => {
    // EXTENSION_VERSION is hardcoded rather than read from extension.json --
    // the bundle has no loader for it -- so the two drift silently and the
    // bridge reports a version that is not the one running.
    const manifest = JSON.parse(await readFile(new URL("../extension.json", import.meta.url), "utf8"));
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const declared = /const EXTENSION_VERSION = "([^"]+)"/.exec(source)?.[1];
    expect(declared).toBe(manifest.version);
  });
});
