import * as z from "zod/v4";
import type { EasyEdaBridge } from "../bridge/EasyEdaBridge.js";
import { ok, fail } from "./toolResult.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROTOCOL_VERSION, type EditorStatus } from "../protocol/messages.js";
import { diffNetlist, parseProtel2Netlist, summarizeNetlist } from "./netlist.js";
import { defaultConfigPath, listLocalProjects } from "./localProjects.js";
import {
  defaultSourcePath,
  fileStamp,
  headLines,
  readSourceFile,
  summarizeSource,
  writeSourceFile
} from "./documentSource.js";

const DefaultTimeoutSchema = z.number().int().positive().max(120_000).default(10_000);
const EndpointRefSchema = z.union([
  z.object({
    component: z.string().min(1),
    pin: z.string().min(1).optional(),
    pinName: z.string().min(1).optional()
  }),
  z.object({
    net: z.string().min(1)
  })
]);
const PassiveConstraintSchema = z.object({
  kind: z.enum(["resistor", "capacitor", "inductor", "diode", "led", "passive"]).optional(),
  component: z.string().min(1).optional(),
  value: z.string().min(1).optional()
});
const ConnectionCheckSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("pin_connected"),
    component: z.string().min(1),
    pin: z.string().min(1).optional(),
    pinName: z.string().min(1).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("pin_on_net"),
    component: z.string().min(1),
    pin: z.string().min(1).optional(),
    pinName: z.string().min(1).optional(),
    net: z.string().min(1)
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("same_node"),
    left: EndpointRefSchema,
    right: EndpointRefSchema
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("path_exists"),
    from: EndpointRefSchema,
    to: EndpointRefSchema,
    through: PassiveConstraintSchema.optional(),
    maxHops: z.number().int().positive().max(20).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("path_absent"),
    from: EndpointRefSchema,
    to: EndpointRefSchema,
    through: PassiveConstraintSchema.optional(),
    maxHops: z.number().int().positive().max(20).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("pull_to_net"),
    signal: EndpointRefSchema,
    net: z.string().min(1),
    through: PassiveConstraintSchema,
    maxHops: z.number().int().positive().max(20).optional()
  }),
  z.object({
    id: z.string().min(1).optional(),
    type: z.literal("decoupled_to_net"),
    power: EndpointRefSchema,
    referenceNet: z.string().min(1),
    capacitorValue: z.string().min(1).optional(),
    maxHops: z.number().int().positive().max(20).optional()
  })
]);

const mutatingConfirmationRegex = /\bconfirma\b|\bconfirmo\b|\bconfirmed\b|\bi confirm\b/i;

export function hasExplicitMutationConfirmation(confirmation: string): boolean {
  return mutatingConfirmationRegex.test(confirmation);
}

export function registerEasyEdaTools(server: McpServer, bridge: EasyEdaBridge): void {
  server.registerTool(
    "easyeda_live_status",
    {
      title: "EasyEDA Pro live status",
      description: "Checks whether the EasyEDA Pro extension is connected and reports active document/capability information.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const status = bridge.getStatus();
      const summary = status.connected
        ? status.compatibility?.compatible === false
          ? "EasyEDA Pro extension is connected, but its bridge protocol is incompatible."
          : "EasyEDA Pro extension is connected."
        : "EasyEDA Pro extension is not connected.";
      return ok(summary, {
        status,
        bridgeEndpoint: bridge.endpoint
      });
    }
  );

  server.registerTool(
    "easyeda_doctor",
    {
      title: "EasyEDA Pro bridge diagnostics",
      description: "Returns a structured diagnosis of the local MCP bridge, EasyEDA Pro extension connection state, protocol compatibility, active document context, and suggested next steps.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const status = bridge.getStatus();
      const hasDocumentContext = Boolean(status.documentName || status.projectName || status.documentInfo);
      const nextSteps = doctorNextSteps(status);
      const summary = status.connected
        ? status.compatibility?.compatible === false
          ? "Bridge diagnostics found a protocol compatibility problem."
          : "Bridge diagnostics look healthy."
        : "Bridge diagnostics found that the EasyEDA Pro extension is disconnected.";
      return ok(summary, {
        doctor: {
          server: {
            name: "easyeda-pro-mcp",
            version: "0.1.0",
            protocolVersion: PROTOCOL_VERSION
          },
          bridge: {
            endpoint: bridge.endpoint
          },
          extension: {
            connected: status.connected,
            connectionState: status.connectionState ?? (status.connected ? "connected" : "disconnected"),
            version: status.extensionVersion,
            protocolVersion: status.protocolVersion,
            compatibility: status.compatibility ?? {
              compatible: false,
              expectedProtocolVersion: PROTOCOL_VERSION,
              actualProtocolVersion: status.protocolVersion,
              reason: "The extension has not reported protocol compatibility yet."
            }
          },
          activeDocument: {
            available: hasDocumentContext,
            type: status.activeDocumentType ?? "unknown",
            projectName: status.projectName,
            documentName: status.documentName
          },
          status,
          nextSteps
        }
      });
    }
  );

  registerReadTool(server, bridge, {
    name: "easyeda_get_context",
    title: "Get EasyEDA Pro editor context",
    description: "Summarizes active project, active document, selection, and editor context from the open EasyEDA Pro instance.",
    method: "getContext",
    inputSchema: {
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Fetched EasyEDA Pro context."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_find_component",
    title: "Find EasyEDA Pro component",
    description: "Finds a component by designator, name, value, footprint, or property in the active EasyEDA Pro project.",
    method: "findComponent",
    inputSchema: {
      query: z.string().min(1).describe("Designator, value, name, footprint, or property text to search for."),
      limit: z.number().int().positive().max(100).default(20),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Searched EasyEDA Pro components."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_find_net",
    title: "Find EasyEDA Pro net",
    description: "Finds a net by name and returns available connections or metadata from the active project.",
    method: "findNet",
    inputSchema: {
      query: z.string().min(1).describe("Net name or partial net name to search for."),
      limit: z.number().int().positive().max(100).default(20),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Searched EasyEDA Pro nets."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_schematic_snapshot",
    title: "Get EasyEDA Pro schematic snapshot",
    description: "Returns a structured snapshot of the active schematic: components, pins, nets, wires, labels, and confidence metadata.",
    method: "schematicSnapshot",
    inputSchema: {
      includeRaw: z.boolean().default(true).describe("Include compact raw EasyEDA API data for fallback reasoning."),
      allPages: z.boolean().default(true).describe("Collect all schematic pages when EasyEDA Pro exposes them."),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Fetched EasyEDA Pro schematic snapshot."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_list_schematic_components",
    title: "List schematic components",
    description: "Lists normalized schematic components with designator, value/name, footprint, position, and key properties.",
    method: "listSchematicComponents",
    inputSchema: {
      query: z.string().min(1).optional().describe("Optional text filter against component fields."),
      limit: z.number().int().positive().max(500).default(100),
      includeRaw: z.boolean().default(false),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Listed EasyEDA Pro schematic components."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_get_component_pins",
    title: "Get schematic component pins",
    description: "Returns all known pins for a schematic component, including pin number, pin name, position, and net when available.",
    method: "getComponentPins",
    inputSchema: {
      query: z.string().min(1).describe("Component designator or text query, such as U1, USB1, or regulator part number."),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Fetched schematic component pins."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_trace_net",
    title: "Trace schematic net",
    description: "Shows the pins, components, wires, labels, and ports associated with a schematic net.",
    method: "traceNet",
    inputSchema: {
      query: z.string().min(1).describe("Net name or partial net name, such as GND, VCC_5V, or SDA."),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Traced schematic net."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_trace_component",
    title: "Trace schematic component",
    description: "Groups a schematic component's connections by pin and net, with evidence for each connection.",
    method: "traceComponent",
    inputSchema: {
      query: z.string().min(1).describe("Component designator or text query, such as U1 or USB1."),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Traced schematic component."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_find_unconnected_pins",
    title: "Find unconnected schematic pins",
    description: "Identifies schematic pins without a confirmed net in the normalized EasyEDA Pro data.",
    method: "findUnconnectedPins",
    inputSchema: {
      includePowerPins: z.boolean().default(true).describe("When false, suppress pins whose names look like power pins."),
      limit: z.number().int().positive().max(500).default(100),
      includeRaw: z.boolean().default(true),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Found schematic pins without confirmed nets."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_validate_schematic_area",
    title: "Validate schematic area",
    description: "Runs generic read-only schematic checks against selected components/nets or the whole schematic.",
    method: "validateSchematicArea",
    inputSchema: {
      components: z.array(z.string().min(1)).optional().describe("Optional component designators or queries to focus on."),
      nets: z.array(z.string().min(1)).optional().describe("Optional net names or queries to focus on."),
      includeGlobalChecks: z.boolean().default(true),
      includeRaw: z.boolean().default(false),
      allPages: z.boolean().default(true),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Validated EasyEDA Pro schematic area."
  });

  server.registerTool(
    "easyeda_verify_connections",
    {
      title: "Verify schematic connections",
      description:
        "Runs read-only connection assertions against the active schematic: pin/net checks, same-node, and passive paths through resistors, capacitors, inductors, diodes or LEDs. By default only failing checks carry their evidence, since a passing check's evidence is rarely read and a batch of 40 with evidence on every one runs to hundreds of kilobytes.",
      inputSchema: {
        checks: z.array(ConnectionCheckSchema).min(1).max(50).describe("Structured connection assertions to verify against the active schematic."),
        evidence: z
          .enum(["failing", "none", "all"])
          .default("failing")
          .describe("Which checks keep their evidence block. 'failing' is almost always what you want."),
        includeRaw: z.boolean().default(false),
        allPages: z.boolean().default(true),
        maxHops: z.number().int().positive().max(20).default(4),
        timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ checks, evidence, includeRaw, allPages, maxHops, timeoutMs }) => {
      try {
        const result = (await bridge.call(
          "verifyConnections",
          { checks, includeRaw, allPages, maxHops },
          timeoutMs
        )) as { checks?: Array<Record<string, unknown>>; summary?: Record<string, number> };

        const trimmed = (result?.checks ?? []).map((check) => {
          const keep =
            evidence === "all" || (evidence === "failing" && check.status !== "pass");
          return keep ? check : { ...check, evidence: undefined };
        });

        const summary = result?.summary ?? {};
        const failed = Number(summary.failed ?? 0) + Number(summary.unknown ?? 0);
        const headline = failed
          ? `${summary.passed ?? 0} passed, ${failed} not passing.`
          : `All ${summary.passed ?? trimmed.length} checks passed.`;

        return ok(headline, { result: { ...result, checks: trimmed } });
      } catch (error) {
        return fail(error);
      }
    }
  );

  registerReadTool(server, bridge, {
    name: "easyeda_navigate_component",
    title: "Navigate to EasyEDA Pro component",
    description: "Navigates/highlights a component in the EasyEDA Pro editor when the extension can locate it.",
    method: "navigateComponent",
    inputSchema: {
      query: z.string().min(1).describe("Component designator or search query."),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Requested EasyEDA Pro component navigation."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_navigate_region",
    title: "Navigate to EasyEDA Pro region",
    description: "Navigates to coordinates or a rectangular region in the active EasyEDA Pro PCB/document.",
    method: "navigateRegion",
    inputSchema: {
      x: z.number().optional(),
      y: z.number().optional(),
      left: z.number().optional(),
      top: z.number().optional(),
      right: z.number().optional(),
      bottom: z.number().optional(),
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Requested EasyEDA Pro region navigation."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_zoom_board",
    title: "Zoom EasyEDA Pro board outline",
    description: "Zooms the active PCB editor to the board outline.",
    method: "zoomBoard",
    inputSchema: {
      timeoutMs: DefaultTimeoutSchema
    },
    summary: "Requested EasyEDA Pro board zoom."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_export_bom",
    title: "Export EasyEDA Pro BOM",
    description: "Exports a BOM from the active EasyEDA Pro project through the extension.",
    method: "exportBom",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      format: z.enum(["csv", "xlsx", "json"]).default("csv"),
      scope: z.enum(["pcb", "schematic", "auto"]).default("auto"),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Requested EasyEDA Pro BOM export."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_export_netlist",
    title: "Export EasyEDA Pro netlist",
    description: "Exports a netlist from the active EasyEDA Pro schematic or PCB through the extension.",
    method: "exportNetlist",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      scope: z.enum(["pcb", "schematic", "auto"]).default("auto"),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Requested EasyEDA Pro netlist export."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_export_gerber",
    title: "Export EasyEDA Pro Gerber",
    description: "Exports Gerber fabrication files from the active EasyEDA Pro PCB through the extension.",
    method: "exportGerber",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      timeoutMs: DefaultTimeoutSchema.default(60_000)
    },
    summary: "Requested EasyEDA Pro Gerber export."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_export_pdf",
    title: "Export EasyEDA Pro PDF",
    description: "Exports a PDF from the active EasyEDA Pro document through the extension.",
    method: "exportPdf",
    inputSchema: {
      fileName: z.string().min(1).optional(),
      scope: z.enum(["pcb", "schematic", "auto"]).default("auto"),
      timeoutMs: DefaultTimeoutSchema.default(60_000)
    },
    summary: "Requested EasyEDA Pro PDF export."
  });

  server.registerTool(
    "easyeda_get_document_source",
    {
      title: "Read EasyEDA Pro document source",
      description:
        "Reads the active document's native EasyEDA Pro source (JSON-lines primitive records) and saves it to a local file. Returns a record-type histogram and the first lines rather than the whole document, so large sheets stay readable. The histogram is the reliable way to tell whether symbols carry pins: a page holds COMPONENT references and ATTR key=NET labels, while PIN records live only in library symbol documents, and every pin-level tool returns [] both for a document without pins and for one it cannot read.",
      inputSchema: {
        outPath: z
          .string()
          .min(1)
          .optional()
          .describe("Where to save the source. Defaults to a timestamped file under the system temp directory."),
        headLineCount: z.number().int().min(0).max(200).default(20),
        inline: z
          .boolean()
          .default(false)
          .describe("Return the full source in the response. Leave false for anything but a small document."),
        timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ outPath, headLineCount, inline, timeoutMs }) => {
      try {
        const result = (await bridge.call("getDocumentSource", {}, timeoutMs)) as {
          source: string;
          documentInfo?: unknown;
        };
        const source = result?.source ?? "";
        const path = await writeSourceFile(outPath ?? defaultSourcePath("snapshot", fileStamp(new Date())), source);
        const summary = summarizeSource(source);
        return ok(`Read EasyEDA Pro document source (${summary.byteLength} bytes) and saved it to ${path}.`, {
          path,
          ...summary,
          documentInfo: result?.documentInfo,
          head: headLineCount ? headLines(source, headLineCount) : undefined,
          source: inline ? source : undefined
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_set_document_source",
    {
      title: "Replace EasyEDA Pro document source",
      description:
        "Replaces the active document's entire source. Takes a backup of the current source first. EasyEDA reports malformed input by refusing the write, so check `applied` rather than assuming success -- and note that `applied: true` still does not mean the document matches what was sent: read back and verify the records you changed. Two behaviours have been observed: a new WIRE group appended after the end of the document gets the whole write rejected, while the same group declared inline among existing wire records is accepted; and an in-place coordinate edit to an existing LINE is silently discarded while the rest of the write lands, so delete the WIRE and its LINEs and create a fresh group with new ids instead. Writes the ACTIVE document only: a schematic page references symbols by uuid, so this can move, rewire and relabel but cannot add a pin -- that needs lib_Symbol.updateDocumentSource on the library symbol. The editor also materializes derived attributes on write (a Symbol attr per component, a Relevance attr per wire), so the source read back will not match what was sent byte-for-byte; it converges after one write. Compare record counts, not bytes.",
      inputSchema: {
        filePath: z.string().min(1).optional().describe("Local file holding the new document source."),
        source: z.string().min(1).optional().describe("Inline source. Prefer filePath for anything sizeable."),
        confirmation: z
          .string()
          .describe("Must explicitly confirm, e.g. 'confirmed: replace the scratch sheet'."),
        backupPath: z.string().min(1).optional().describe("Where to save the pre-write backup."),
        skipBackup: z
          .boolean()
          .default(false)
          .describe("Skip the safety backup. Only for a document you are willing to lose."),
        timeoutMs: DefaultTimeoutSchema.default(60_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ filePath, source, confirmation, backupPath, skipBackup, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(
            new Error(
              "Refused to replace the document. The confirmation text must explicitly confirm, e.g. \"confirmed: replace the scratch sheet\"."
            )
          );
        }
        if (!filePath && !source) {
          return fail(new Error("Provide either filePath or source."));
        }
        if (filePath && source) {
          return fail(new Error("Provide filePath or source, not both."));
        }

        const nextSource = source ?? (await readSourceFile(filePath as string));

        // The write replaces the whole document, so a backup is worth more than
        // the round trip it costs. Failing to back up aborts the write.
        let savedBackupPath: string | undefined;
        if (!skipBackup) {
          const current = (await bridge.call("getDocumentSource", {}, timeoutMs)) as { source?: string };
          savedBackupPath = await writeSourceFile(
            backupPath ?? defaultSourcePath("backup", fileStamp(new Date())),
            current?.source ?? ""
          );
        }

        const result = (await bridge.call("setDocumentSource", { source: nextSource }, timeoutMs)) as {
          applied?: boolean;
          reason?: string;
        };

        if (!result?.applied) {
          return ok(`EasyEDA rejected the source; the document is unchanged.${savedBackupPath ? ` Backup at ${savedBackupPath}.` : ""}`, {
            applied: false,
            reason: result?.reason ?? "EasyEDA returned false.",
            backupPath: savedBackupPath,
            ...summarizeSource(nextSource)
          });
        }

        return ok(`Replaced the EasyEDA Pro document source.${savedBackupPath ? ` Backup at ${savedBackupPath}.` : ""}`, {
          applied: true,
          backupPath: savedBackupPath,
          ...summarizeSource(nextSource)
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_get_netlist",
    {
      title: "Read the EasyEDA Pro netlist",
      description:
        "Exports the schematic netlist from EasyEDA's own netlister and parses it into nets and pins. This is the authoritative connectivity answer -- unlike the pin and trace tools, it is not inferred from geometry. Optionally diffs the result against an expected net map so a wiring mistake is reported rather than merely displayed.",
      inputSchema: {
        netlistType: z
          .enum(["Protel2", "EasyEDA", "JLCEDA", "PADS", "Allegro", "DISA", "DSNET"])
          .default("Protel2")
          .describe("ESYS_NetlistType. Protel2 is the format this tool can parse."),
        expected: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe('Intended net map, e.g. {"GND": ["R1-2", "U1-4"]}. Pin order is ignored.'),
        outPath: z.string().min(1).optional().describe("Where to save the raw netlist text."),
        includeNets: z
          .boolean()
          .default(false)
          .describe("Return every net and its pins. Leave false on a large sheet; the summary and diff usually suffice."),
        timeoutMs: DefaultTimeoutSchema.default(60_000)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ netlistType, expected, outPath, includeNets, timeoutMs }) => {
      try {
        const result = (await bridge.call("getNetlist", { netlistType }, timeoutMs)) as {
          netlist?: string;
          source?: string;
        };
        const text = result?.netlist ?? "";
        const path = await writeSourceFile(
          outPath ?? defaultSourcePath("snapshot", `netlist-${fileStamp(new Date())}`),
          text
        );

        const parsed = netlistType === "Protel2" ? parseProtel2Netlist(text) : { nets: [], components: [], parsed: false };
        if (!parsed.parsed) {
          return ok(`Exported the netlist to ${path}, but could not parse it as ${netlistType}.`, {
            path,
            netlistType,
            source: result?.source,
            parsed: false,
            hint: "Only Protel2 is parsed. The raw text is saved at the path above."
          });
        }

        const summary = summarizeNetlist(parsed);
        const diff = expected ? diffNetlist(parsed, expected) : undefined;
        const headline = diff
          ? diff.ok
            ? `Netlist matches all ${Object.keys(expected ?? {}).length} expected nets.`
            : `Netlist differs from intent: ${diff.missingNets.length} missing, ${diff.pinMismatches.length} with wrong pins.`
          : `Netlist has ${summary.netCount} nets over ${summary.componentCount} components.`;

        return ok(headline, {
          path,
          netlistType,
          source: result?.source,
          parsed: true,
          ...summary,
          diff,
          nets: includeNets ? parsed.nets : undefined
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_schematic_check",
    {
      title: "Run the EasyEDA Pro schematic rule check",
      description:
        "Runs EasyEDA's native schematic design-rule check (SCH_Drc.check) and returns its violations. Requests verbose detail; EasyEDA sometimes answers with counts only, in which case `detail` says so and per-violation detail is visible in the editor panel.",
      inputSchema: {
        strict: z.boolean().default(true).describe("Uniform strict checking."),
        openPanel: z
          .boolean()
          .default(false)
          .describe("Open the check panel in EasyEDA Pro. Off by default so the tool does not steal focus."),
        timeoutMs: DefaultTimeoutSchema.default(60_000)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ strict, openPanel, timeoutMs }) => {
      try {
        const result = (await bridge.call("schematicCheck", { strict, openPanel }, timeoutMs)) as {
          passed?: boolean;
          violationCount?: number;
          detail?: string;
        };
        const headline = result?.passed
          ? "Schematic check passed."
          : `Schematic check reported ${result?.violationCount ?? "some"} violation(s).`;
        return ok(headline, { result });
      } catch (error) {
        return fail(error);
      }
    }
  );

  registerReadTool(server, bridge, {
    name: "easyeda_list_schematics",
    title: "List EasyEDA Pro schematics and pages",
    description:
      "Lists the project's schematics and sheets with their uuids. Each import lands as its own schematic holding one page, so this is how you tell an obsolete import from the current one before deleting either.",
    method: "listSchematics",
    inputSchema: {
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Listed EasyEDA Pro schematics."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_api_inventory",
    title: "List the EasyEDA Pro API surface",
    description:
      "Enumerates the namespaces and method names the live `eda` object actually exposes. Use this before assuming a capability is missing: the bridge's tool list is much narrower than the editor's API, and documentation for it has repeatedly been wrong about names and behaviour.",
    method: "apiInventory",
    inputSchema: {
      namespace: z.string().min(1).optional().describe("Case-insensitive substring filter, e.g. 'project' or 'lib_'."),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Listed the EasyEDA Pro API surface."
  });

  server.registerTool(
    "easyeda_call_api",
    {
      title: "Call an EasyEDA Pro API directly",
      description:
        "Calls any eda API by dotted path, e.g. 'dmt_Project.getAllProjectsUuid'. For probing behaviour that no wrapper covers yet -- it reports resultType separately, because an API resolving with undefined is this editor's usual way of failing. It can call mutating methods, so it requires explicit confirmation.",
      inputSchema: {
        path: z.string().min(1).describe("Dotted path, e.g. 'dmt_Project.openProject'."),
        args: z
          .array(z.unknown())
          .default([])
          .describe('Positional arguments. Use {"__file":{"content":"...","name":"x.json"}} where the API wants a File.'),
        fileArg: z
          .object({ index: z.number().int().min(0), filePath: z.string().min(1), name: z.string().min(1).optional() })
          .optional()
          .describe("Read a local file and pass it as a File at this argument index, so large content need not be inlined."),
        confirmation: z
          .string()
          .describe("Must explicitly confirm, e.g. 'confirmed: probe getAllProjectsUuid'."),
        timeoutMs: DefaultTimeoutSchema.default(60_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ path, args, fileArg, confirmation, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(new Error(`Refused to call ${path}. The confirmation text must explicitly confirm.`));
        }
        const finalArgs = [...args];
        if (fileArg) {
          const content = await readSourceFile(fileArg.filePath);
          finalArgs[fileArg.index] = {
            __file: { content, name: fileArg.name ?? fileArg.filePath.split("/").pop() }
          };
        }
        const result = (await bridge.call("callApi", { path, args: finalArgs }, timeoutMs)) as { resultType?: string };
        return ok(`Called ${path} (returned ${result?.resultType ?? "unknown"}).`, { result });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_list_local_projects",
    {
      title: "List local EasyEDA Pro projects",
      description:
        "Lists the project files the editor can see, with the uuid dmt_Project.openProject expects. Read from EasyEDA's own config (APP_PROJECT_DIR, the same list its Recent Projects tab is built from) and the project files themselves, not through the editor: EasyEDA's file-enumeration APIs hang when called from the extension, and every document API goes dark while no project is loaded -- which is exactly when enumeration is needed. Most recently modified first.",
      inputSchema: {
        configPath: z.string().min(1).optional().describe("Defaults to ~/Documents/EasyEDA-Pro/config.json."),
        maxDepth: z.number().int().min(1).max(6).default(3).describe("How deep to search each project directory."),
        timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ configPath, maxDepth }) => {
      try {
        const path = configPath ?? defaultConfigPath();
        const projects = await listLocalProjects(path, maxDepth);
        const unreadable = projects.filter((project) => project.error).length;
        const note = unreadable ? ` ${unreadable} could not be read.` : "";
        return ok(`Found ${projects.length} local project(s).${note}`, { configPath: path, projects });
      } catch (error) {
        return fail(error);
      }
    }
  );

  registerReadTool(server, bridge, {
    name: "easyeda_open_project",
    title: "Open a project in EasyEDA Pro",
    description:
      "Loads a project into the editor. Opening a project and opening a sheet are separate calls: with no project loaded, easyeda_open_document returns no tab and raises nothing. Project uuids come from easyeda_list_schematics as parentProjectUuid.",
    method: "openProject",
    inputSchema: {
      uuid: z.string().min(1),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Opened an EasyEDA Pro project."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_open_document",
    title: "Open a document in the EasyEDA Pro editor",
    description:
      "Opens a schematic page (or other document) by uuid and makes it active. Several APIs act on whatever document is active, and a freshly restarted editor can have nothing open -- so call this rather than asking someone to click a tab. Page uuids come from easyeda_list_schematics.",
    method: "openDocument",
    inputSchema: {
      uuid: z.string().min(1).describe("Document uuid — a schematic PAGE uuid, not the schematic's."),
      projectUuid: z
        .string()
        .min(1)
        .optional()
        .describe("Open this project first. Opening a sheet fails silently when its project is not loaded; parentProjectUuid comes from easyeda_list_schematics."),
      activate: z.boolean().default(true).describe("Bring the opened tab to the front."),
      splitScreenId: z.string().min(1).optional(),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Opened a document in EasyEDA Pro."
  });

  registerReadTool(server, bridge, {
    name: "easyeda_close_document",
    title: "Close an EasyEDA Pro editor tab",
    description:
      "Closes a tab by its id, as returned by easyeda_open_document. Closes the tab only; nothing is deleted.",
    method: "closeDocument",
    inputSchema: {
      tabId: z.string().min(1),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
    },
    summary: "Closed an EasyEDA Pro tab."
  });

  server.registerTool(
    "easyeda_get_symbol_source",
    {
      title: "Read a library symbol's source",
      description:
        "Reads a library symbol's native source and saves it to a local file. This is where PIN records live -- a schematic page holds only references -- so it is the only view that shows whether a symbol actually has pins. Find the symbolUuid from easyeda_get_component_pins with includeRaw, under the component's symbol.uuid; libraryUuid is often empty for a project-local symbol. Reading opens the symbol in the editor and closes it again unless keepOpen is set.",
      inputSchema: {
        symbolUuid: z.string().min(1),
        libraryUuid: z.string().default("").describe("Empty for project-local symbols."),
        outPath: z.string().min(1).optional(),
        headLineCount: z.number().int().min(0).max(200).default(20),
        keepOpen: z.boolean().default(false).describe("Leave the symbol open in the editor afterwards."),
        timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ symbolUuid, libraryUuid, outPath, headLineCount, keepOpen, timeoutMs }) => {
      try {
        const result = (await bridge.call(
          "getSymbolSource",
          { symbolUuid, libraryUuid, keepOpen },
          timeoutMs
        )) as { source?: string; tabId?: string };
        const source = result?.source ?? "";
        const path = await writeSourceFile(
          outPath ?? defaultSourcePath("snapshot", `symbol-${symbolUuid}-${fileStamp(new Date())}`),
          source
        );
        const summary = summarizeSource(source);
        const pins = summary.recordTypes.PIN ?? 0;
        return ok(
          `Read symbol ${symbolUuid} (${summary.byteLength} bytes, ${pins} PIN record(s)) to ${path}.`,
          { path, symbolUuid, libraryUuid, ...summary, head: headLineCount ? headLines(source, headLineCount) : undefined }
        );
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_set_symbol_source",
    {
      title: "Replace a library symbol's source",
      description:
        "Replaces a library symbol, which is how a pin is added or corrected without re-importing the sheet. Backs the symbol up first. Like the document write, EasyEDA reports refusal by returning false, so check `applied` -- and read back afterwards, since an accepted write is not proof the symbol matches what was sent. Every placed instance of the symbol changes at once.",
      inputSchema: {
        symbolUuid: z.string().min(1),
        libraryUuid: z.string().default(""),
        filePath: z.string().min(1).optional().describe("Local file holding the new symbol source."),
        source: z.string().min(1).optional().describe("Inline source. Prefer filePath."),
        confirmation: z.string().describe("Must explicitly confirm, e.g. 'confirmed: add pins to the Q3 symbol'."),
        backupPath: z.string().min(1).optional(),
        skipBackup: z.boolean().default(false),
        openFirst: z
          .boolean()
          .default(false)
          .describe("Open the symbol before writing. Try this if a write is refused; the documented flow opens first."),
        timeoutMs: DefaultTimeoutSchema.default(60_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ symbolUuid, libraryUuid, filePath, source, confirmation, backupPath, skipBackup, openFirst, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(new Error(`Refused to replace symbol ${symbolUuid}. The confirmation text must explicitly confirm.`));
        }
        if (!filePath && !source) {
          return fail(new Error("Provide either filePath or source."));
        }
        if (filePath && source) {
          return fail(new Error("Provide filePath or source, not both."));
        }
        const nextSource = source ?? (await readSourceFile(filePath as string));

        let savedBackupPath: string | undefined;
        if (!skipBackup) {
          const current = (await bridge.call(
            "getSymbolSource",
            { symbolUuid, libraryUuid },
            timeoutMs
          )) as { source?: string };
          savedBackupPath = await writeSourceFile(
            backupPath ?? defaultSourcePath("backup", `symbol-${symbolUuid}-${fileStamp(new Date())}`),
            current?.source ?? ""
          );
        }

        const result = (await bridge.call(
          "updateSymbolSource",
          { symbolUuid, libraryUuid, source: nextSource, openFirst },
          timeoutMs
        )) as { applied?: boolean; reason?: string };

        const backupNote = savedBackupPath ? ` Backup at ${savedBackupPath}.` : "";
        if (!result?.applied) {
          return ok(`EasyEDA rejected the symbol source; symbol ${symbolUuid} is unchanged.${backupNote}`, {
            applied: false,
            reason: result?.reason ?? "EasyEDA returned false.",
            backupPath: savedBackupPath,
            ...summarizeSource(nextSource)
          });
        }
        return ok(`Replaced symbol ${symbolUuid}.${backupNote} Read it back to confirm the records you changed.`, {
          applied: true,
          backupPath: savedBackupPath,
          ...summarizeSource(nextSource)
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_find_library_device",
    {
      title: "Find an EasyEDA/LCSC library device",
      description:
        "Looks up library devices by LCSC id, by uuid, or by keyword. A device is what carries a footprint, and EasyEDA refuses to export a netlist until components have footprints -- so this is the step that turns a sheet of generic boxes into a verifiable one. Returns the identifying fields by default; a full device record carries its entire parametric table and runs to kilobytes each.",
      inputSchema: {
      query: z.string().min(1).optional().describe("Keyword search, e.g. 'AP63205' or 'AO3400'."),
      lcscIds: z.array(z.string().min(1)).optional().describe("Exact LCSC ids, e.g. ['C7420417']. Preferred when the BOM names the part."),
      uuid: z.string().min(1).optional().describe("Device uuid, e.g. from a component's Device attribute."),
      libraryUuid: z.string().min(1).optional(),
      classification: z.string().min(1).optional(),
      limit: z.number().int().positive().max(100).default(20),
      page: z.number().int().positive().default(1),
      detail: z
        .enum(["summary", "full"])
        .default("summary")
        .describe("'full' returns each device's whole parametric table. Only for one already-chosen part."),
      timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ detail, timeoutMs, ...params }) => {
      try {
        const result = (await bridge.call("findLibraryDevice", params, timeoutMs)) as {
          mode?: string;
          devices?: Array<Record<string, any>>;
        };
        const devices = result?.devices ?? [];
        const shaped =
          detail === "full"
            ? devices
            : devices.map((device) => ({
                name: device?.name,
                uuid: device?.uuid,
                libraryUuid: device?.libraryUuid,
                symbolUuid: device?.symbolUuid,
                footprintName: device?.footprintName,
                footprintUuid: device?.footprintUuid,
                manufacturerPart: device?.manufacturerId,
                manufacturer: device?.manufacturer,
                lcscId: device?.supplierId,
                datasheet: device?.otherProperty?.Datasheet,
                partClass: device?.otherProperty?.["JLCPCB Part Class"]
              }));

        return ok(`Found ${shaped.length} device(s) by ${result?.mode ?? "search"}.`, {
          mode: result?.mode,
          detail,
          devices: shaped
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_import_schematic",
    {
      title: "Import a schematic file into EasyEDA Pro",
      description:
        "Imports an EasyEDA Standard JSON sheet (the format the generators emit) into the open project, removing the last manual step from the ingest loop. fileType 'EasyEDA' is the Standard edition format; 'EasyEDA Pro' is the Pro project format. Verify the result afterwards -- an import that lands can still produce symbols without pins.",
      inputSchema: {
        filePath: z.string().min(1).describe("Local path to the sheet JSON to import."),
        fileType: z
          .enum(["EasyEDA", "EasyEDA Pro", "JLCEDA", "JLCEDA Pro", "KiCad", "EAGLE", "OrCAD", "Allegro", "PADS", "LTspice"])
          .default("EasyEDA")
          .describe("Source format. The generators emit EasyEDA Standard, which is 'EasyEDA'."),
        intoCurrentProject: z
          .boolean()
          .default(true)
          .describe("Import into the open project rather than creating a new one."),
        confirmation: z
          .string()
          .describe("Must explicitly confirm, e.g. 'confirmed: import sheet 2'."),
        props: z.record(z.string(), z.unknown()).optional().describe("Import-window options, passed through untouched."),
        timeoutMs: DefaultTimeoutSchema.default(120_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ filePath, fileType, intoCurrentProject, confirmation, props, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(new Error('Refused to import. The confirmation text must explicitly confirm, e.g. "confirmed: import sheet 2".'));
        }
        const content = await readSourceFile(filePath);

        // The project uuid usually rides along on the active document, but the
        // editor can sit with nothing open -- in which case the schematics list
        // still knows which project they belong to.
        const status = bridge.getStatus() as { documentInfo?: { parentProjectUuid?: string } };
        let projectUuid = status?.documentInfo?.parentProjectUuid;
        if (!projectUuid && intoCurrentProject) {
          const listed = (await bridge.call("listSchematics", {}, timeoutMs)) as {
            schematics?: Array<{ parentProjectUuid?: string }>;
          };
          projectUuid = listed?.schematics?.find((entry) => entry?.parentProjectUuid)?.parentProjectUuid;
        }

        const saveTo = intoCurrentProject && projectUuid
          ? { operation: "Existing Project", projectUuid }
          : undefined;

        const result = (await bridge.call(
          "importProject",
          { content, fileName: filePath.split("/").pop(), fileType, props, saveTo },
          timeoutMs
        )) as { schematicsBefore?: number; schematicsAfter?: number };

        const before = result?.schematicsBefore;
        const after = result?.schematicsAfter;
        const moved =
          typeof before === "number" && typeof after === "number"
            ? ` Schematics went from ${before} to ${after}.`
            : " Could not confirm a new schematic appeared -- list them to check.";

        return ok(`Imported ${filePath} as ${fileType}.${moved}`, { result });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_delete_schematic",
    {
      title: "Delete an EasyEDA Pro schematic or sheet",
      description:
        "Permanently deletes a schematic (or one sheet) by uuid. Irreversible: EasyEDA offers no undo across this API, so read the document's source to a file first if it may be wanted again. Deleting a schematic removes its pages; deleting only a page can leave an empty schematic behind.",
      inputSchema: {
        uuid: z
          .string()
          .min(1)
          .describe("The schematic or page uuid, from easyeda_list_schematics. Required; there is no 'current document' form."),
        scope: z
          .enum(["schematic", "page"])
          .default("schematic")
          .describe("'schematic' removes the schematic and its pages; 'page' removes one sheet."),
        confirmation: z
          .string()
          .describe("Must explicitly confirm and name what is being deleted, e.g. 'confirmed: delete the superseded power-module-2s import'."),
        timeoutMs: DefaultTimeoutSchema.default(30_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ uuid, scope, confirmation, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(
            new Error(
              `Refused to delete ${uuid}. The confirmation text must explicitly confirm, e.g. "confirmed: delete the superseded import".`
            )
          );
        }
        const result = (await bridge.call("deleteSchematic", { uuid, scope }, timeoutMs)) as {
          schematicsBefore?: number;
          schematicsAfter?: number;
        };
        const before = result?.schematicsBefore;
        const after = result?.schematicsAfter;
        const moved =
          typeof before === "number" && typeof after === "number"
            ? ` Schematics went from ${before} to ${after}.`
            : "";
        return ok(`Deleted ${scope} ${uuid}.${moved}`, { result });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_confirmed_action",
    {
      title: "Confirmed EasyEDA Pro action",
      description: "Runs a mutating EasyEDA Pro action only when the confirmation text explicitly confirms the action.",
      inputSchema: {
        action: z.enum(["save", "importChanges", "autoroute", "autolayout"]),
        confirmation: z.string().describe("Must include an explicit confirmation phrase such as 'confirma salvar'."),
        params: z.record(z.string(), z.unknown()).optional(),
        timeoutMs: DefaultTimeoutSchema.default(60_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ action, confirmation, params, timeoutMs }) => {
      try {
        if (!hasExplicitMutationConfirmation(confirmation)) {
          return fail(new Error(`Action "${action}" was blocked. The confirmation text must explicitly include a confirmation phrase such as "confirma salvar".`));
        }
        const result = await bridge.call("confirmedAction", { action, confirmation, params }, timeoutMs);
        return ok(`Executed confirmed EasyEDA Pro action: ${action}.`, {
          action,
          result
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
}

function doctorNextSteps(status: EditorStatus): string[] {
  if (!status.connected) {
    return [
      "Open EasyEDA Pro.",
      "Install or reload the EasyEDA MCP extension.",
      "Enable external interaction/WebSocket permission in EasyEDA Pro.",
      "Keep the MCP server running and wait for the extension to auto-connect."
    ];
  }

  if (status.compatibility?.compatible === false) {
    return [
      "Rebuild and reload the EasyEDA Pro extension.",
      "Restart the MCP client session so it reloads the latest tool catalog.",
      "Verify that the extension and MCP server are built from the same repository state."
    ];
  }

  if (!status.documentName && !status.projectName) {
    return [
      "Open a schematic or PCB document in EasyEDA Pro.",
      "Run easyeda_get_context or easyeda_live_status again after the document finishes loading."
    ];
  }

  return [
    "The bridge looks healthy.",
    "Use easyeda_live_status for quick checks and easyeda_get_context for deeper editor state."
  ];
}

type ReadToolConfig = {
  name: string;
  title: string;
  description: string;
  method: string;
  inputSchema: z.ZodRawShape;
  summary: string;
};

function registerReadTool(
  server: McpServer,
  bridge: EasyEdaBridge,
  config: ReadToolConfig
): void {
  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    } as never,
    async (args: Record<string, unknown>) => {
      try {
        const { timeoutMs, ...params } = args as Record<string, unknown> & { timeoutMs?: number };
        const result = await bridge.call(config.method, params, timeoutMs);
        return ok(config.summary, {
          result
        });
      } catch (error) {
        return fail(error);
      }
    }
  );
}
