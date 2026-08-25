declare const eda: EasyEdaApi;
import {
  buildSchematicSnapshot,
  findUnconnectedPins,
  getComponentPins,
  listSchematicComponents,
  traceComponent,
  traceNet,
  validateSchematicArea,
  verifyConnections,
  type RawSchematicData,
  type SchematicSnapshot
} from "../../src/schematic/analysis.js";
import {
  PROTOCOL_VERSION,
  evaluateProtocolCompatibility,
  type ProtocolCompatibility
} from "../../src/protocol/messages.js";
import { getBridgeConfig, getBridgeUri } from "./bridgeConfig.js";

type EasyEdaApi = Record<string, any>;

type BridgeCallMessage = {
  kind: "call";
  requestId: string;
  method: string;
  params?: Record<string, any>;
  timeoutMs?: number;
};

type BridgeResultMessage = {
  kind: "result";
  requestId: string;
  result: unknown;
};

type BridgeErrorMessage = {
  kind: "error";
  requestId: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

const WS_ID = "easyeda-mcp-bridge";
const EXTENSION_VERSION = "0.3.2";
const bridgeConfig = getBridgeConfig();

type ConnectionPhase = "idle" | "connecting" | "connected" | "blocked";

type ConnectionState = {
  phase: ConnectionPhase;
  attemptIndex: number;
  lastError?: BridgeErrorMessage["error"];
  lastOpenAt?: string;
  lastStatusAt?: string;
  lastHandshakeAt?: string;
  lastAttemptAt?: string;
  connectedOnce: boolean;
  compatibility: ProtocolCompatibility;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  openTimeoutTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
};

const connectionState: ConnectionState = {
  phase: "idle",
  attemptIndex: 0,
  connectedOnce: false,
  compatibility: evaluateProtocolCompatibility(PROTOCOL_VERSION)
};

const handlers: Record<string, (params: Record<string, any>) => Promise<unknown> | unknown> = {
  getContext,
  findComponent,
  findNet,
  schematicSnapshot,
  listSchematicComponents: listSchematicComponentsTool,
  listSchematicComponentsTool,
  getComponentPins: getComponentPinsTool,
  getComponentPinsTool,
  traceNet: traceNetTool,
  traceNetTool,
  traceComponent: traceComponentTool,
  traceComponentTool,
  findUnconnectedPins: findUnconnectedPinsTool,
  findUnconnectedPinsTool,
  validateSchematicArea: validateSchematicAreaTool,
  validateSchematicAreaTool,
  verifyConnections: verifyConnectionsTool,
  verifyConnectionsTool,
  navigateComponent,
  navigateRegion,
  zoomBoard,
  exportBom,
  exportNetlist,
  exportGerber,
  exportPdf,
  getDocumentSource,
  setDocumentSource,
  getNetlist,
  schematicCheck,
  listSchematics,
  deleteSchematic,
  importProject,
  findLibraryDevice,
  getSymbolSource,
  updateSymbolSource,
  openProject,
  openDocument,
  closeDocument,
  apiInventory,
  callApi,
  confirmedAction
};

export function activate(status?: "onStartupFinished", arg?: string): void {
  log("warn", `EasyEDA MCP Bridge activated: ${status ?? "manual"} ${arg ?? ""}`);
  void ensureBridgeConnected({ reason: "activation", manual: false });
}

export function connect(): void {
  void ensureBridgeConnected({ reason: "manual-connect", manual: true, resetAttempts: true });
}

export function reconnect(): void {
  resetConnectionTimers();
  connectionState.phase = "idle";
  connectionState.attemptIndex = 0;
  void ensureBridgeConnected({ reason: "manual-reconnect", manual: true, resetAttempts: true });
}

export async function showStatus(): Promise<void> {
  const diagnostics = await collectDiagnostics();
  showMessage("EasyEDA MCP Bridge Status", formatStatusSummary(diagnostics));
}

export async function runDiagnostics(): Promise<void> {
  const diagnostics = await collectDiagnostics();
  showMessage("EasyEDA MCP Bridge Diagnostics", formatDiagnostics(diagnostics));
}

async function ensureBridgeConnected(options: { reason: string; manual: boolean; resetAttempts?: boolean }): Promise<void> {
  if (options.resetAttempts) {
    connectionState.attemptIndex = 0;
  }

  if (connectionState.phase === "connecting") {
    return;
  }

  if (connectionState.phase === "connected" && !options.manual) {
    return;
  }

  await startBridge(options);
}

async function startBridge(options: { reason: string; manual: boolean }): Promise<void> {
  ensureApi("sys_WebSocket", "register");
  resetConnectionTimers();
  connectionState.phase = "connecting";
  connectionState.lastAttemptAt = new Date().toISOString();

  const wsUri = getBridgeUri(bridgeConfig);
  const attemptIndex = connectionState.attemptIndex;
  const openTimeoutMs = bridgeConfig.openTimeoutMs;
  connectionState.openTimeoutTimer = setTimeout(() => {
    const error = apiError("bridge_open_timeout", `Timed out waiting for EasyEDA MCP Bridge to open ${wsUri}.`);
    handleConnectionFailure(normalizeError(error), {
      manual: options.manual,
      shouldRetry: true
    });
  }, openTimeoutMs);

  try {
    eda.sys_WebSocket.register(
      WS_ID,
      wsUri,
      async (event: MessageEvent<string>) => {
        await handleMessage(event.data);
      },
      async () => {
        connectionState.phase = "connected";
        connectionState.lastOpenAt = new Date().toISOString();
        connectionState.lastHandshakeAt = connectionState.lastOpenAt;
        connectionState.lastError = undefined;
        connectionState.compatibility = evaluateProtocolCompatibility(PROTOCOL_VERSION);
        connectionState.attemptIndex = 0;
        clearOpenTimeout();
        send({
          kind: "hello",
          client: "easyeda-pro-extension",
          version: EXTENSION_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          compatibility: connectionState.compatibility,
          capabilities: detectCapabilities(),
          status: await getStatus()
        });
        startHeartbeat();
        if (!connectionState.connectedOnce || options.manual) {
          connectionState.connectedOnce = true;
          showMessage("EasyEDA MCP Bridge", `Connected to ${wsUri}.`);
        }
      }
    );
  } catch (error) {
    handleConnectionFailure(normalizeError(error), {
      manual: options.manual,
      shouldRetry: true
    });
    return;
  }

  log("warn", `Bridge connection attempt ${attemptIndex + 1} started for ${options.reason} -> ${wsUri}`);
}

async function handleMessage(raw: string): Promise<void> {
  let message: BridgeCallMessage;
  try {
    message = JSON.parse(raw) as BridgeCallMessage;
  } catch (error) {
    log("warn", "Ignored malformed MCP bridge message", error);
    return;
  }

  if (message.kind !== "call" || !message.requestId || !message.method) {
    return;
  }

  try {
    const handler = handlers[message.method];
    if (!handler) {
      throw apiError("unknown_method", `Unsupported MCP bridge method: ${message.method}`);
    }
    const result = await handler(message.params ?? {});
    send({
      kind: "result",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    send({
      kind: "error",
      requestId: message.requestId,
      error: normalizeError(error)
    });
  }
}

function send(message: Record<string, unknown>): void {
  ensureApi("sys_WebSocket", "send");
  try {
    eda.sys_WebSocket.send(WS_ID, JSON.stringify(message));
  } catch (error) {
    handleConnectionFailure(normalizeError(error), {
      manual: false,
      shouldRetry: true
    });
    throw error;
  }
}

async function getStatus(): Promise<Record<string, unknown>> {
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  return {
    connected: connectionState.phase === "connected",
    connectionState: connectionState.phase,
    extensionVersion: EXTENSION_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    compatibility: connectionState.compatibility,
    capabilities: detectCapabilities(),
    activeDocumentType: inferDocumentType(documentInfo),
    projectName: pickString(documentInfo, ["projectName", "project", "parentName"]),
    documentName: pickString(documentInfo, ["name", "title", "documentName"]),
    message: connectionState.lastError?.message,
    documentInfo: sanitize(documentInfo),
    updatedAt: new Date().toISOString()
  };
}

async function emitStatusUpdate(): Promise<void> {
  send({
    kind: "status",
    compatibility: connectionState.compatibility,
    status: await getStatus()
  });
  connectionState.lastStatusAt = new Date().toISOString();
}

function startHeartbeat(): void {
  if (connectionState.heartbeatTimer) {
    clearInterval(connectionState.heartbeatTimer);
  }
  connectionState.heartbeatTimer = setInterval(() => {
    void emitStatusUpdate().catch((error) => {
      handleConnectionFailure(normalizeError(error), {
        manual: false,
        shouldRetry: true
      });
    });
  }, bridgeConfig.heartbeatIntervalMs);
}

function clearOpenTimeout(): void {
  if (connectionState.openTimeoutTimer) {
    clearTimeout(connectionState.openTimeoutTimer);
    connectionState.openTimeoutTimer = undefined;
  }
}

function resetConnectionTimers(): void {
  clearOpenTimeout();
  if (connectionState.reconnectTimer) {
    clearTimeout(connectionState.reconnectTimer);
    connectionState.reconnectTimer = undefined;
  }
  if (connectionState.heartbeatTimer) {
    clearInterval(connectionState.heartbeatTimer);
    connectionState.heartbeatTimer = undefined;
  }
}

function handleConnectionFailure(
  error: BridgeErrorMessage["error"],
  options: { manual: boolean; shouldRetry: boolean }
): void {
  clearOpenTimeout();
  if (connectionState.heartbeatTimer) {
    clearInterval(connectionState.heartbeatTimer);
    connectionState.heartbeatTimer = undefined;
  }

  connectionState.lastError = error;
  connectionState.compatibility = evaluateProtocolCompatibility(PROTOCOL_VERSION);
  connectionState.phase = isPermissionLikeError(error) ? "blocked" : "idle";

  // The editor almost always starts before the MCP server does, so the first
  // few attempts fail by definition. Giving up after the configured list meant
  // the bridge stayed down until someone clicked Connect -- for the whole life
  // of the editor, however long after the server appeared. Retrying forever at
  // the final delay lets it attach on its own, which also covers a server
  // restart and a new editor window.
  const lastIndex = bridgeConfig.reconnectDelayMs.length - 1;
  const wasExhausted = connectionState.attemptIndex >= lastIndex;
  const shouldRetry = options.shouldRetry && connectionState.phase !== "blocked";

  if (shouldRetry) {
    const nextAttempt = Math.min(connectionState.attemptIndex + 1, lastIndex);
    const delayMs = bridgeConfig.reconnectDelayMs[nextAttempt];
    connectionState.attemptIndex = nextAttempt;
    connectionState.reconnectTimer = setTimeout(() => {
      connectionState.reconnectTimer = undefined;
      void ensureBridgeConnected({
        reason: wasExhausted ? "retry-steady" : "retry",
        manual: false
      });
    }, delayMs);
  }

  // Announce once, when the fast attempts are spent. Retrying forever must not
  // mean a dialog forever.
  const firstGiveUp = !wasExhausted && connectionState.attemptIndex >= lastIndex;
  if (options.manual || firstGiveUp || !shouldRetry || connectionState.phase === "blocked") {
    showMessage("EasyEDA MCP Bridge", [
      error.message,
      "",
      ...diagnosticHints(error)
    ].join("\n"));
  }
}

async function collectDiagnostics(): Promise<Record<string, unknown>> {
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  return {
    bridge: {
      uri: getBridgeUri(bridgeConfig),
      config: bridgeConfig
    },
    websocket: {
      registerAvailable: Boolean(eda.sys_WebSocket?.register),
      sendAvailable: Boolean(eda.sys_WebSocket?.send)
    },
    connection: {
      phase: connectionState.phase,
      connectedOnce: connectionState.connectedOnce,
      lastAttemptAt: connectionState.lastAttemptAt,
      lastOpenAt: connectionState.lastOpenAt,
      lastHandshakeAt: connectionState.lastHandshakeAt,
      lastStatusAt: connectionState.lastStatusAt,
      lastError: connectionState.lastError,
      compatibility: connectionState.compatibility
    },
    activeDocument: {
      available: Boolean(documentInfo),
      type: inferDocumentType(documentInfo),
      projectName: pickString(documentInfo, ["projectName", "project", "parentName"]),
      documentName: pickString(documentInfo, ["name", "title", "documentName"])
    },
    nextSteps: diagnosticHints(connectionState.lastError)
  };
}

function formatStatusSummary(diagnostics: Record<string, unknown>): string {
  const connection = diagnostics.connection as Record<string, unknown>;
  const document = diagnostics.activeDocument as Record<string, unknown>;
  return [
    `Bridge URI: ${getBridgeUri(bridgeConfig)}`,
    `Connection phase: ${String(connection.phase ?? "unknown")}`,
    `Last open: ${String(connection.lastOpenAt ?? "never")}`,
    `Document: ${String(document.documentName ?? document.projectName ?? "none")}`
  ].join("\n");
}

function formatDiagnostics(diagnostics: Record<string, unknown>): string {
  const websocket = diagnostics.websocket as Record<string, unknown>;
  const connection = diagnostics.connection as Record<string, unknown>;
  const document = diagnostics.activeDocument as Record<string, unknown>;
  const nextSteps = Array.isArray(diagnostics.nextSteps) ? diagnostics.nextSteps as string[] : [];

  return [
    `Bridge URI: ${getBridgeUri(bridgeConfig)}`,
    `WebSocket register available: ${String(websocket.registerAvailable)}`,
    `WebSocket send available: ${String(websocket.sendAvailable)}`,
    `Connection phase: ${String(connection.phase ?? "unknown")}`,
    `Last open: ${String(connection.lastOpenAt ?? "never")}`,
    `Last status: ${String(connection.lastStatusAt ?? "never")}`,
    `Compatibility: ${String((connection.compatibility as Record<string, unknown>)?.compatible ?? false)}`,
    `Document: ${String(document.documentName ?? document.projectName ?? "none")}`,
    nextSteps.length > 0 ? `Next steps:\n- ${nextSteps.join("\n- ")}` : "Next steps: none"
  ].join("\n");
}

function diagnosticHints(error?: BridgeErrorMessage["error"]): string[] {
  if (isPermissionLikeError(error)) {
    return [
      "Enable external interaction/WebSocket permission for the extension in EasyEDA Pro.",
      "Reload the extension and let it auto-connect again."
    ];
  }

  if (error?.code === "bridge_open_timeout") {
    return [
      "Make sure the MCP server is running locally.",
      `Confirm the bridge endpoint is reachable at ${getBridgeUri(bridgeConfig)}.`
    ];
  }

  return [
    "Keep EasyEDA Pro open while the MCP server is running.",
    "Use Reconnect or Run Diagnostics from the extension menu if the bridge stays unavailable."
  ];
}

function isPermissionLikeError(error?: BridgeErrorMessage["error"]): boolean {
  const message = `${error?.message ?? ""} ${error?.code ?? ""}`.toLowerCase();
  return message.includes("permission") || message.includes("external interaction") || message.includes("sys_websocket");
}

async function getContext(): Promise<Record<string, unknown>> {
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  const splitScreenTree = await optionalCall(() => eda.dmt_EditorControl.getSplitScreenTree());
  const pcbNets = await optionalCall(() => getPcbNetNames());
  const pcbComponents = await optionalCall(() => getPcbComponents());
  const schComponents = await optionalCall(() => getSchematicComponents());

  return {
    status: await getStatus(),
    documentInfo: sanitize(documentInfo),
    splitScreenTree: sanitize(splitScreenTree),
    counts: {
      pcbNets: Array.isArray(pcbNets) ? pcbNets.length : undefined,
      pcbComponents: Array.isArray(pcbComponents) ? pcbComponents.length : undefined,
      schematicComponents: Array.isArray(schComponents) ? schComponents.length : undefined
    },
    betaApi: true
  };
}

async function findComponent(params: Record<string, any>): Promise<Record<string, unknown>> {
  const query = String(params.query ?? "").toLowerCase();
  const limit = Number(params.limit ?? 20);
  const pcb = (await optionalCall(() => getPcbComponents())) ?? [];
  const schematic = (await optionalCall(() => getSchematicComponents())) ?? [];
  const all = [
    ...toArray(pcb).map((item) => ({ source: "pcb", item })),
    ...toArray(schematic).map((item) => ({ source: "schematic", item }))
  ];
  const matches = all.filter(({ item }) => JSON.stringify(item).toLowerCase().includes(query)).slice(0, limit);

  return {
    query,
    count: matches.length,
    matches: matches.map(({ source, item }) => ({ source, component: simplifyPrimitive(item) })),
    betaApi: true
  };
}

async function findNet(params: Record<string, any>): Promise<Record<string, unknown>> {
  const query = String(params.query ?? "").toLowerCase();
  const limit = Number(params.limit ?? 20);
  const names = toArray(await getPcbNetNames()).filter((name) => String(name).toLowerCase().includes(query)).slice(0, limit);
  const nets = [];
  for (const name of names) {
    const detail = await optionalCall(() => eda.pcb_Net.getNet(name));
    const length = await optionalCall(() => eda.pcb_Net.getNetLength(name));
    nets.push({
      name,
      detail: sanitize(detail),
      length
    });
  }

  return {
    query,
    count: nets.length,
    nets,
    betaApi: true
  };
}

async function schematicSnapshot(params: Record<string, any>): Promise<SchematicSnapshot> {
  return collectSchematicSnapshot({
    includeRaw: params.includeRaw !== false,
    allPages: params.allPages !== false
  });
}

async function listSchematicComponentsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw === true, allPages: params.allPages !== false });
  const components = listSchematicComponents(snapshot, stringOrUndefined(params.query), Number(params.limit ?? 100));
  return {
    components,
    count: components.length,
    totalComponents: snapshot.counts.components,
    confidence: snapshot.confidence,
    warnings: snapshot.warnings,
    betaApi: true
  };
}

async function getComponentPinsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = getComponentPins(snapshot, String(params.query ?? ""));
  return {
    ...result,
    betaApi: true
  };
}

async function traceNetTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = traceNet(snapshot, String(params.query ?? ""));
  return {
    ...result,
    betaApi: true
  };
}

async function traceComponentTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = traceComponent(snapshot, String(params.query ?? ""));
  return {
    ...result,
    betaApi: true
  };
}

async function findUnconnectedPinsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = findUnconnectedPins(snapshot, {
    includePowerPins: params.includePowerPins !== false,
    limit: Number(params.limit ?? 100)
  });
  return {
    ...result,
    betaApi: true
  };
}

async function validateSchematicAreaTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = validateSchematicArea(snapshot, {
    components: Array.isArray(params.components) ? params.components.map(String) : undefined,
    nets: Array.isArray(params.nets) ? params.nets.map(String) : undefined,
    includeGlobalChecks: params.includeGlobalChecks !== false
  });
  return {
    ...result,
    snapshotCounts: snapshot.counts,
    snapshotWarnings: snapshot.warnings,
    betaApi: true
  };
}

async function verifyConnectionsTool(params: Record<string, any>): Promise<Record<string, unknown>> {
  const snapshot = await collectSchematicSnapshot({ includeRaw: params.includeRaw !== false, allPages: params.allPages !== false });
  const result = verifyConnections(snapshot, Array.isArray(params.checks) ? params.checks : [], {
    maxHops: Number(params.maxHops ?? 4)
  });
  return {
    ...result,
    snapshotCounts: snapshot.counts,
    snapshotWarnings: snapshot.warnings,
    betaApi: true
  };
}

async function navigateComponent(params: Record<string, any>): Promise<Record<string, unknown>> {
  const result = await findComponent({ query: params.query, limit: 1 });
  const first = (result.matches as any[])?.[0];
  if (!first) {
    throw apiError("component_not_found", `No component matched "${params.query}".`);
  }

  const primitiveId = first.component.primitiveId ?? first.component.id ?? first.component.uuid;
  if (!primitiveId) {
    return {
      navigated: false,
      reason: "Matched component did not expose a primitive id.",
      match: first,
      betaApi: true
    };
  }

  const primitiveApi = first.source === "pcb" ? eda.pcb_Primitive : eda.sch_Primitive;
  const bbox = await optionalCall(() => primitiveApi.getPrimitivesBBox([primitiveId]));
  const region = normalizeBBox(bbox);
  if (region) {
    await zoomToRegion(region.left, region.right, region.top, region.bottom);
  }

  return {
    navigated: Boolean(region),
    primitiveId,
    region,
    match: first,
    betaApi: true
  };
}

async function navigateRegion(params: Record<string, any>): Promise<Record<string, unknown>> {
  if (isNumber(params.x) && isNumber(params.y)) {
    if (eda.pcb_Document?.navigateToCoordinates) {
      await eda.pcb_Document.navigateToCoordinates(params.x, params.y);
      return { navigated: true, mode: "coordinates", x: params.x, y: params.y };
    }
    if (eda.dmt_EditorControl?.zoomTo) {
      await eda.dmt_EditorControl.zoomTo(params.x, params.y, params.scaleRatio ?? 1);
      return { navigated: true, mode: "zoomTo", x: params.x, y: params.y, betaApi: true };
    }
  }

  for (const key of ["left", "right", "top", "bottom"]) {
    if (!isNumber(params[key])) {
      throw apiError("invalid_region", "Provide either x/y coordinates or left/right/top/bottom region values.");
    }
  }

  await zoomToRegion(params.left, params.right, params.top, params.bottom);
  return {
    navigated: true,
    mode: "region",
    region: {
      left: params.left,
      right: params.right,
      top: params.top,
      bottom: params.bottom
    },
    betaApi: true
  };
}

async function zoomBoard(): Promise<Record<string, unknown>> {
  ensureApi("pcb_Document", "zoomToBoardOutline");
  await eda.pcb_Document.zoomToBoardOutline();
  return {
    zoomed: true,
    betaApi: true
  };
}

async function exportBom(params: Record<string, any>): Promise<Record<string, unknown>> {
  const fileName = params.fileName ?? `easyeda-bom-${timestamp()}`;
  const format = params.format ?? "csv";
  const api = pickManufactureApi(params.scope, "getBomFile");
  const file = await api.getBomFile(fileName, format);
  return saveApiFile(file, `${fileName}.${format}`, true);
}

async function exportNetlist(params: Record<string, any>): Promise<Record<string, unknown>> {
  const fileName = params.fileName ?? `easyeda-netlist-${timestamp()}`;
  const api = pickManufactureApi(params.scope, "getNetlistFile");
  const file = await api.getNetlistFile(fileName, params.netlistType);
  return saveApiFile(file, `${fileName}.net`, true);
}

async function exportGerber(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("pcb_ManufactureData", "getGerberFile");
  const fileName = params.fileName ?? `easyeda-gerber-${timestamp()}`;
  const file = await eda.pcb_ManufactureData.getGerberFile(fileName);
  return saveApiFile(file, `${fileName}.zip`, true);
}

async function exportPdf(params: Record<string, any>): Promise<Record<string, unknown>> {
  const fileName = params.fileName ?? `easyeda-export-${timestamp()}`;
  if (params.scope === "schematic" || (!eda.pcb_ManufactureData?.getPdfFile && eda.sch_ManufactureData?.getExportDocumentFile)) {
    const file = await eda.sch_ManufactureData.getExportDocumentFile(fileName, "pdf");
    return saveApiFile(file, `${fileName}.pdf`, true);
  }
  ensureApi("pcb_ManufactureData", "getPdfFile");
  const file = await eda.pcb_ManufactureData.getPdfFile(fileName);
  return saveApiFile(file, `${fileName}.pdf`, true);
}

/**
 * Document source is EasyEDA Pro's own serialization of the open document: one
 * JSON-lines record per primitive (DOCHEAD, CANVAS, PART, RECT, PIN, WIRE,
 * COMPONENT, ...). Reading it is the only way to learn the exact record shape
 * the editor accepts, and writing it is the only whole-document write the
 * extension API offers -- sch_PrimitiveComponent.create() places library
 * devices and cannot build a symbol with custom pins.
 */
/**
 * The netlist is EasyEDA's own answer about connectivity, which is worth more
 * than any geometry the bridge infers: it comes from the netlister the editor
 * itself uses. Returned as text rather than saved through sys_FileSystem so the
 * caller can parse it without a save dialog.
 *
 * SCH_Netlist.getNetlist is documented obsolete but hands back a plain string,
 * so it is tried first; the file-based API needs its type argument and returns
 * nothing useful without one, which is why an earlier netlist export here came
 * back empty.
 */
/**
 * Each import lands as its own schematic holding one page, so removing an
 * obsolete import means deleting the schematic; deleting only the page leaves
 * an empty schematic behind. Listing exists so the caller can confirm which
 * uuid is which before destroying either.
 */
/**
 * The last manual step in the ingest loop. sys_FileManager.importProjectByProjectFile
 * takes the same EasyEDA Standard JSON the generators already emit -- fileType
 * "EasyEDA" is the Standard edition format, not Pro's own.
 *
 * The API wants a File, which only exists inside the editor's browser context,
 * so the caller sends text over the bridge and it is wrapped here.
 */
/**
 * Finding real parts is what turns a sheet of generic boxes into one that can
 * produce a netlist: EasyEDA refuses the netlist export until components carry
 * footprints, and only a library device brings one.
 *
 * Three lookups, because the useful question differs by situation: by LCSC id
 * when the BOM already names the part, by uuid when a component references one,
 * and by keyword when neither is known yet.
 */
/**
 * A symbol's source is where PIN records live, so this is the only way to change
 * a pin without re-importing the whole sheet. Reading one requires opening it,
 * which moves the editor off whatever the user was looking at -- so the tab is
 * closed again unless the caller asks to keep it.
 */
/**
 * Several APIs act on whatever document is active, and a fresh editor can sit
 * with nothing open at all -- so the caller needs a way to put a sheet on screen
 * rather than asking a person to click it.
 */
/**
 * Every capability added today started with guessing which method existed and
 * what it wanted, then spending an install cycle to find out. The editor knows
 * the answer -- `eda` is right there -- so ask it.
 */
async function apiInventory(params: Record<string, any>): Promise<Record<string, unknown>> {
  const filter = typeof params.namespace === "string" ? params.namespace.toLowerCase() : undefined;
  const namespaces: Record<string, string[]> = {};

  for (const key of Object.keys(eda ?? {})) {
    if (filter && !key.toLowerCase().includes(filter)) {
      continue;
    }
    const value = (eda as Record<string, any>)[key];
    if (!value || typeof value !== "object") {
      continue;
    }
    const methods: string[] = [];
    for (const name of listMembers(value)) {
      if (typeof value[name] === "function") {
        methods.push(name);
      }
    }
    if (methods.length) {
      namespaces[key] = methods.sort();
    }
  }

  return { namespaces, namespaceCount: Object.keys(namespaces).length, betaApi: true };
}

/** Methods can live on the prototype, so own keys alone under-report the surface. */
function listMembers(value: object): string[] {
  const names = new Set<string>(Object.keys(value));
  let proto = Object.getPrototypeOf(value);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== "constructor") {
        names.add(name);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

/**
 * Calls any eda API by dotted path. This exists so a hypothesis about the API
 * can be tested in one call rather than one release: several capabilities here
 * cost an install cycle each purely to discover an argument shape.
 */
async function callApi(params: Record<string, any>): Promise<Record<string, unknown>> {
  const path = params.path;
  if (typeof path !== "string" || !path.includes(".")) {
    throw apiError("bad_path", 'callApi needs a dotted path such as "dmt_Project.openProject".');
  }
  const [namespace, method] = path.split(".");
  ensureApi(namespace, method);

  // Some APIs take a File, which cannot cross the bridge as JSON. A marker
  // object is materialized here instead, so an import can be probed without
  // shipping a new build for every argument shape tried.
  const args = (Array.isArray(params.args) ? params.args : []).map(reviveArg);
  const result = await (eda as Record<string, any>)[namespace][method](...args);

  return {
    path,
    args: sanitize(args),
    // An API that resolves with undefined is this editor's usual way of failing,
    // so the caller needs to see the difference between that and a real value.
    resultType: result === undefined ? "undefined" : result === null ? "null" : typeof result,
    result: sanitize(result),
    betaApi: true
  };
}

async function openProject(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("dmt_Project", "openProject");
  const uuid = requireUuid(params.uuid, "openProject");
  await eda.dmt_Project.openProject(uuid);
  const projectInfo = await optionalCall(() => eda.dmt_Project.getCurrentProjectInfo());
  return { uuid, project: sanitize(projectInfo), betaApi: true };
}

/**
 * Opening a sheet and opening a project are separate calls, and the sheet one
 * fails silently -- returning undefined, raising nothing -- when the project
 * holding it is not loaded. Passing projectUuid loads it first.
 */
async function openDocument(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("dmt_EditorControl", "openDocument");
  const uuid = requireUuid(params.uuid, "openDocument");

  if (typeof params.projectUuid === "string" && params.projectUuid) {
    await optionalCall(() =>
      eda.dmt_Project?.openProject ? eda.dmt_Project.openProject(params.projectUuid) : undefined
    );
  }

  const tabId = await eda.dmt_EditorControl.openDocument(uuid, params.splitScreenId);
  if (!tabId) {
    const project = await optionalCall(() => eda.dmt_Project?.getCurrentProjectInfo());
    throw apiError(
      "document_not_opened",
      `openDocument returned no tab for ${uuid}. The usual cause is that its project is not open -- pass projectUuid, or open the project first.`,
      { currentProject: sanitize(project) }
    );
  }

  if (params.activate !== false && tabId) {
    await optionalCall(() =>
      eda.dmt_EditorControl?.activateDocument ? eda.dmt_EditorControl.activateDocument(tabId) : undefined
    );
  }

  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  return { uuid, tabId, activeDocument: sanitize(documentInfo), betaApi: true };
}

async function closeDocument(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("dmt_EditorControl", "closeDocument");
  const tabId = params.tabId;
  if (typeof tabId !== "string" || !tabId.trim()) {
    throw apiError("missing_tab_id", "closeDocument requires a tabId.");
  }
  await eda.dmt_EditorControl.closeDocument(tabId);
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  return { tabId, closed: true, activeDocument: sanitize(documentInfo), betaApi: true };
}

async function getSymbolSource(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("lib_Symbol", "openInEditor");
  ensureApi("sys_FileManager", "getDocumentSource");
  const symbolUuid = requireUuid(params.symbolUuid, "getSymbolSource");
  const libraryUuid = typeof params.libraryUuid === "string" ? params.libraryUuid : "";

  const tabId = await eda.lib_Symbol.openInEditor(symbolUuid, libraryUuid);
  try {
    const source = await eda.sys_FileManager.getDocumentSource();
    if (typeof source !== "string") {
      throw apiError("unexpected_source", `getDocumentSource returned ${typeof source} for symbol ${symbolUuid}.`);
    }
    return { symbolUuid, libraryUuid, tabId, source, byteLength: source.length, betaApi: true };
  } finally {
    if (!params.keepOpen && tabId) {
      await optionalCall(() =>
        eda.dmt_EditorControl?.closeDocument ? eda.dmt_EditorControl.closeDocument(tabId) : undefined
      );
    }
  }
}

/**
 * Writes a symbol back to the library. Like setDocumentSource this reports
 * refusal by returning false rather than raising, so `applied` is the field that
 * says whether it landed.
 */
async function updateSymbolSource(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("lib_Symbol", "updateDocumentSource");
  const symbolUuid = requireUuid(params.symbolUuid, "updateSymbolSource");
  const libraryUuid = typeof params.libraryUuid === "string" ? params.libraryUuid : "";
  const source = params.source;
  if (typeof source !== "string" || !source.trim()) {
    throw apiError("missing_source", "updateSymbolSource requires a non-empty source string.");
  }

  let tabId: string | undefined;
  if (params.openFirst) {
    tabId = await optionalCall(() => eda.lib_Symbol.openInEditor(symbolUuid, libraryUuid));
  }

  try {
    const applied = await eda.lib_Symbol.updateDocumentSource(symbolUuid, libraryUuid, source);
    return {
      symbolUuid,
      libraryUuid,
      applied: applied === true,
      byteLength: source.length,
      reason: applied === true ? undefined : "EasyEDA rejected the symbol source; the symbol is unchanged.",
      betaApi: true
    };
  } finally {
    if (params.openFirst && !params.keepOpen && tabId) {
      await optionalCall(() =>
        eda.dmt_EditorControl?.closeDocument ? eda.dmt_EditorControl.closeDocument(tabId) : undefined
      );
    }
  }
}

/** `{ __file: { content, name, type } }` becomes a real File. */
function reviveArg(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("__file" in (value as Record<string, unknown>))) {
    return value;
  }
  if (typeof File === "undefined") {
    throw apiError("no_file_api", "File is unavailable in this context.");
  }
  const spec = (value as { __file: Record<string, unknown> }).__file ?? {};
  const content = typeof spec.content === "string" ? spec.content : "";
  const name = typeof spec.name === "string" ? spec.name : "probe.json";
  const type = typeof spec.type === "string" ? spec.type : "application/json";
  return new File([content], name, { type });
}

function requireUuid(value: unknown, caller: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw apiError("missing_uuid", `${caller} requires a symbolUuid.`);
  }
  return value;
}

async function findLibraryDevice(params: Record<string, any>): Promise<Record<string, unknown>> {
  const libraryUuid = params.libraryUuid;

  if (Array.isArray(params.lcscIds) && params.lcscIds.length) {
    ensureApi("lib_Device", "getByLcscIds");
    const devices = await eda.lib_Device.getByLcscIds(params.lcscIds, libraryUuid, false);
    return { mode: "lcscIds", devices: sanitize(devices), betaApi: true };
  }

  if (typeof params.uuid === "string" && params.uuid) {
    ensureApi("lib_Device", "get");
    const device = await eda.lib_Device.get(params.uuid, libraryUuid);
    return { mode: "uuid", devices: sanitize(device ? [device] : []), betaApi: true };
  }

  ensureApi("lib_Device", "search");
  const devices = await eda.lib_Device.search(
    params.query,
    libraryUuid,
    params.classification,
    params.symbolType,
    params.limit ?? 20,
    params.page ?? 1
  );
  return { mode: "search", devices: sanitize(devices), betaApi: true };
}

async function importProject(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("sys_FileManager", "importProjectByProjectFile");
  const content = params.content;
  if (typeof content !== "string" || !content.trim()) {
    throw apiError("missing_content", "importProject requires the file content as a string.");
  }
  if (typeof File === "undefined") {
    throw apiError("no_file_api", "File is unavailable in this context, so the import cannot be constructed.");
  }

  const fileName = params.fileName ?? `import-${timestamp()}.json`;
  const fileType = params.fileType ?? "EasyEDA";
  const file = new File([content], fileName, { type: "application/json" });

  const before = await optionalCall(() => eda.dmt_Schematic?.getAllSchematicsInfo());
  const result = await eda.sys_FileManager.importProjectByProjectFile(
    file,
    fileType,
    params.props,
    params.saveTo,
    params.librariesImportSetting
  );
  const after = await optionalCall(() => eda.dmt_Schematic?.getAllSchematicsInfo());

  const count = (value: unknown) => (Array.isArray(value) ? value.length : undefined);
  return {
    fileName,
    fileType,
    byteLength: content.length,
    result: sanitize(result),
    schematicsBefore: count(before),
    schematicsAfter: count(after),
    betaApi: true
  };
}

async function listSchematics(): Promise<Record<string, unknown>> {
  ensureApi("dmt_Schematic", "getAllSchematicsInfo");
  const schematics = await eda.dmt_Schematic.getAllSchematicsInfo();
  const pages = await optionalCall(() =>
    eda.dmt_Schematic?.getAllSchematicPagesInfo ? eda.dmt_Schematic.getAllSchematicPagesInfo() : undefined
  );
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  return {
    schematics: sanitize(schematics),
    pages: sanitize(pages),
    activeDocument: sanitize(documentInfo),
    betaApi: true
  };
}

/**
 * Deletion is by explicit uuid only. There is no "delete the current document"
 * form on purpose: the active document is whatever the user last clicked, and
 * that is the wrong thing to aim an irreversible operation at.
 */
async function deleteSchematic(params: Record<string, any>): Promise<Record<string, unknown>> {
  const scope = params.scope === "page" ? "page" : "schematic";
  const uuid = params.uuid;
  if (typeof uuid !== "string" || !uuid.trim()) {
    throw apiError("missing_uuid", "deleteSchematic requires an explicit uuid.");
  }

  const method = scope === "page" ? "deleteSchematicPage" : "deleteSchematic";
  ensureApi("dmt_Schematic", method);

  const before = await optionalCall(() => eda.dmt_Schematic.getAllSchematicsInfo());
  const result = await eda.dmt_Schematic[method](uuid);
  const after = await optionalCall(() => eda.dmt_Schematic.getAllSchematicsInfo());

  const count = (value: unknown) => (Array.isArray(value) ? value.length : undefined);
  return {
    scope,
    uuid,
    result: sanitize(result),
    schematicsBefore: count(before),
    schematicsAfter: count(after),
    betaApi: true
  };
}

async function getNetlist(params: Record<string, any>): Promise<Record<string, unknown>> {
  const type = params.netlistType ?? "Protel2";

  const direct = await optionalCall(() =>
    eda.sch_Netlist?.getNetlist ? eda.sch_Netlist.getNetlist(type) : undefined
  );
  if (typeof direct === "string" && direct.trim()) {
    return { netlist: direct, netlistType: type, source: "sch_Netlist.getNetlist", betaApi: true };
  }

  const fileName = params.fileName ?? `easyeda-netlist-${timestamp()}`;
  const api = pickManufactureApi(params.scope ?? "schematic", "getNetlistFile");
  const file = await api.getNetlistFile(fileName, type);
  const text = await fileToText(file);
  if (!text) {
    throw apiError(
      "empty_netlist",
      `Netlist export returned no text for type "${type}". Try another ESYS_NetlistType (EasyEDA, JLCEDA, Protel2, PADS, Allegro).`
    );
  }
  return { netlist: text, netlistType: type, source: "getNetlistFile", betaApi: true };
}

async function fileToText(value: unknown): Promise<string | undefined> {
  const file = extractFile(value);
  if (typeof file === "string") {
    return file;
  }
  if (file && typeof (file as Blob).text === "function") {
    return await (file as Blob).text();
  }
  return undefined;
}

/**
 * SCH_Drc.check answers with a bare boolean unless verbose detail is requested,
 * and even then may report only aggregate counts per severity. Both shapes are
 * normalized here so the caller does not have to guess which it received.
 */
async function schematicCheck(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("sch_Drc", "check");
  const strict = params.strict !== false;
  const openPanel = params.openPanel === true;
  const raw = await eda.sch_Drc.check(strict, openPanel, true);

  if (typeof raw === "boolean") {
    return { passed: raw, violations: [], detail: "none", strict, betaApi: true };
  }

  const entries = (Array.isArray(raw) ? raw : [raw]).filter(
    (entry) => entry !== undefined && entry !== null
  );

  // EasyEDA answers either with one record per violation or with a bucket per
  // severity carrying a count. Counting buckets as violations reports 45
  // problems as 2, so the two shapes are separated rather than merged.
  const aggregates: Array<{ severity: string; count: number }> = [];
  const violations: unknown[] = [];

  for (const entry of entries) {
    if (typeof entry === "string") {
      violations.push({ description: entry });
      continue;
    }
    const record = isRecord(entry) ? entry : undefined;
    const count = record && typeof record.count === "number" ? record.count : undefined;
    const severity = record ? pickString(record, ["type", "severity", "level"]) : undefined;
    if (count !== undefined && severity && Object.keys(record ?? {}).length <= 3) {
      aggregates.push({ severity, count });
      continue;
    }
    violations.push(sanitize(entry));
  }

  const aggregateTotal = aggregates.reduce((sum, entry) => sum + entry.count, 0);
  const violationCount = violations.length + aggregateTotal;

  return {
    passed: violationCount === 0,
    violations,
    aggregates,
    violationCount,
    detail: violations.length ? "verbose" : aggregates.length ? "aggregate" : "none",
    hint: violations.length === 0 && aggregates.length
      ? "EasyEDA reported counts only. Re-run with openPanel to read the individual violations in the editor."
      : undefined,
    strict,
    betaApi: true
  };
}

async function getDocumentSource(): Promise<Record<string, unknown>> {
  ensureApi("sys_FileManager", "getDocumentSource");
  const source = await eda.sys_FileManager.getDocumentSource();
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  if (typeof source !== "string") {
    throw apiError("unexpected_source", `getDocumentSource returned ${typeof source}, expected string.`);
  }
  return {
    source,
    byteLength: source.length,
    documentInfo: sanitize(documentInfo),
    betaApi: true
  };
}

/**
 * Replaces the whole open document. Returns false -- not an error -- when the
 * editor rejects the source as malformed, so the caller must check `applied`
 * rather than assuming a resolved promise means the write landed.
 */
async function setDocumentSource(params: Record<string, any>): Promise<Record<string, unknown>> {
  ensureApi("sys_FileManager", "setDocumentSource");
  const source = params.source;
  if (typeof source !== "string" || !source) {
    throw apiError("missing_source", "setDocumentSource requires a non-empty source string.");
  }
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  const applied = await eda.sys_FileManager.setDocumentSource(source);
  return {
    applied: applied === true,
    byteLength: source.length,
    documentInfo: sanitize(documentInfo),
    reason: applied === true ? undefined : "EasyEDA rejected the source; the document is unchanged.",
    betaApi: true
  };
}

async function confirmedAction(params: Record<string, any>): Promise<Record<string, unknown>> {
  const action = String(params.action ?? "");
  const documentInfo = await optionalCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo());
  const documentUuid = pickString(documentInfo, ["uuid", "documentUuid", "id"]);

  if (action === "save") {
    if (eda.pcb_Document?.save) {
      await eda.pcb_Document.save(documentUuid);
      return { action, saved: true, documentUuid };
    }
    if (eda.sch_Document?.save) {
      await eda.sch_Document.save(documentUuid);
      return { action, saved: true, documentUuid };
    }
  }

  if (action === "importChanges") {
    ensureApi("pcb_Document", "importChanges");
    await eda.pcb_Document.importChanges(params.uuid ?? documentUuid);
    return { action, imported: true, documentUuid: params.uuid ?? documentUuid };
  }

  if (action === "autoroute") {
    ensureApi("pcb_Document", "importAutoRouteJsonFile");
    if (!params.params?.file) {
      throw apiError("missing_file", "autoroute requires params.file from an EasyEDA-compatible autoroute JSON/SES file.");
    }
    await eda.pcb_Document.importAutoRouteJsonFile(params.params.file);
    return { action, imported: true, betaApi: true };
  }

  if (action === "autolayout") {
    ensureApi("pcb_Document", "importAutoLayoutJsonFile");
    if (!params.params?.file) {
      throw apiError("missing_file", "autolayout requires params.file from an EasyEDA-compatible autolayout JSON file.");
    }
    await eda.pcb_Document.importAutoLayoutJsonFile(params.params.file);
    return { action, imported: true, betaApi: true };
  }

  throw apiError("unsupported_action", `Unsupported or unavailable confirmed action: ${action}.`);
}

function detectCapabilities(): Record<string, boolean> {
  return {
    websocket: Boolean(eda.sys_WebSocket?.register && eda.sys_WebSocket?.send),
    pcbDocument: Boolean(eda.pcb_Document),
    schDocument: Boolean(eda.sch_Document),
    pcbManufactureData: Boolean(eda.pcb_ManufactureData),
    schManufactureData: Boolean(eda.sch_ManufactureData),
    fileSystem: Boolean(eda.sys_FileSystem?.saveFile),
    documentSourceRead: Boolean(eda.sys_FileManager?.getDocumentSource),
    documentSourceWrite: Boolean(eda.sys_FileManager?.setDocumentSource),
    netlist: Boolean(eda.sch_Netlist?.getNetlist || eda.sch_ManufactureData?.getNetlistFile),
    schematicCheck: Boolean(eda.sch_Drc?.check),
    schematicDelete: Boolean(eda.dmt_Schematic?.deleteSchematic),
    projectImport: Boolean(eda.sys_FileManager?.importProjectByProjectFile),
    librarySearch: Boolean(eda.lib_Device?.search || eda.lib_Device?.getByLcscIds),
    symbolSourceRead: Boolean(eda.lib_Symbol?.openInEditor),
    symbolSourceWrite: Boolean(eda.lib_Symbol?.updateDocumentSource),
    documentOpen: Boolean(eda.dmt_EditorControl?.openDocument),
    projectOpen: Boolean(eda.dmt_Project?.openProject)
  };
}

async function getPcbComponents(): Promise<unknown[]> {
  ensureApi("pcb_PrimitiveComponent", "getAll");
  return toArray(await eda.pcb_PrimitiveComponent.getAll());
}

async function getSchematicComponents(): Promise<unknown[]> {
  ensureApi("sch_PrimitiveComponent", "getAll");
  return toArray(await eda.sch_PrimitiveComponent.getAll(undefined, true));
}

async function collectSchematicSnapshot(options: { includeRaw: boolean; allPages: boolean }): Promise<SchematicSnapshot> {
  ensureApi("sch_PrimitiveComponent", "getAll");
  const components = toArray(await eda.sch_PrimitiveComponent.getAll(undefined, options.allPages));
  const pinsByComponent: Record<string, unknown[]> = {};

  if (eda.sch_PrimitiveComponent?.getAllPinsByPrimitiveId) {
    for (const component of components) {
      const componentRecord = component && typeof component === "object" ? component as Record<string, unknown> : {};
      const primitiveId = stringOrUndefined(componentRecord.primitiveId ?? componentRecord.id ?? componentRecord.uuid);
      if (!primitiveId) {
        continue;
      }
      const pins = await optionalCall(() => eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId));
      pinsByComponent[primitiveId] = toArray(pins);
    }
  }

  const rawData: RawSchematicData = {
    components,
    pinsByComponent,
    wires: await optionalCall(() => eda.sch_PrimitiveWire?.getAll ? eda.sch_PrimitiveWire.getAll() : []),
    texts: await optionalCall(() => eda.sch_PrimitiveText?.getAll ? eda.sch_PrimitiveText.getAll() : []),
    includeRaw: options.includeRaw
  };
  return buildSchematicSnapshot(rawData);
}

async function getPcbNetNames(): Promise<unknown[]> {
  ensureApi("pcb_Net", "getAllNetsName");
  if (eda.pcb_Net.getAllNetsName) {
    return toArray(await eda.pcb_Net.getAllNetsName());
  }
  return toArray(await eda.pcb_Net.getAllNetName());
}

async function zoomToRegion(left: number, right: number, top: number, bottom: number): Promise<void> {
  if (eda.pcb_Document?.navigateToRegion) {
    await eda.pcb_Document.navigateToRegion(left, right, top, bottom);
    return;
  }
  ensureApi("dmt_EditorControl", "zoomToRegion");
  await eda.dmt_EditorControl.zoomToRegion(left, right, top, bottom);
}

function pickManufactureApi(scope: string | undefined, method: string): any {
  if (scope === "schematic") {
    ensureApi("sch_ManufactureData", method);
    return eda.sch_ManufactureData;
  }
  if (scope === "pcb") {
    ensureApi("pcb_ManufactureData", method);
    return eda.pcb_ManufactureData;
  }
  if (eda.pcb_ManufactureData?.[method]) {
    return eda.pcb_ManufactureData;
  }
  ensureApi("sch_ManufactureData", method);
  return eda.sch_ManufactureData;
}

async function saveApiFile(file: unknown, fallbackFileName: string, betaApi: boolean): Promise<Record<string, unknown>> {
  const normalizedFile = extractFile(file);
  if (!normalizedFile) {
    return {
      saved: false,
      file: sanitize(file),
      reason: "EasyEDA returned a non-File value; returning it without saving.",
      betaApi
    };
  }

  ensureApi("sys_FileSystem", "saveFile");
  const fileName = (normalizedFile as File).name || fallbackFileName;
  const saveResult = await eda.sys_FileSystem.saveFile(normalizedFile, fileName);
  return {
    saved: true,
    fileName,
    saveResult: sanitize(saveResult),
    betaApi
  };
}

function extractFile(value: unknown): unknown {
  if (typeof File !== "undefined" && value instanceof File) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((item) => typeof File !== "undefined" && item instanceof File) ?? value[0];
  }
  if (value && typeof value === "object" && "file" in value) {
    return (value as { file: unknown }).file;
  }
  return value;
}

function simplifyPrimitive(value: unknown): Record<string, unknown> {
  const item = sanitize(value) as Record<string, unknown>;
  return {
    primitiveId: item.primitiveId ?? item.id ?? item.uuid,
    designator: item.designator ?? item.name ?? item.displayName ?? item.prefix,
    value: item.value ?? item.comment ?? item.title,
    footprint: item.footprint ?? item.package ?? item.packageName,
    x: item.x,
    y: item.y,
    layer: item.layer,
    raw: item
  };
}

function normalizeBBox(value: unknown): { left: number; right: number; top: number; bottom: number } | undefined {
  const item = Array.isArray(value) ? value[0] : value;
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const box = item as Record<string, unknown>;
  const left = numeric(box.left ?? box.minX ?? box.x1);
  const right = numeric(box.right ?? box.maxX ?? box.x2);
  const top = numeric(box.top ?? box.minY ?? box.y1);
  const bottom = numeric(box.bottom ?? box.maxY ?? box.y2);
  if ([left, right, top, bottom].every((number) => number !== undefined)) {
    return { left, right, top, bottom } as { left: number; right: number; top: number; bottom: number };
  }
  return undefined;
}

function ensureApi(objectName: string, methodName: string): void {
  if (!eda[objectName]?.[methodName]) {
    throw apiError("api_unavailable", `EasyEDA Pro API eda.${objectName}.${methodName} is unavailable in this context.`);
  }
}

function apiError(code: string, message: string, details?: unknown): Error & { code: string; details?: unknown } {
  const error = new Error(message) as Error & { code: string; details?: unknown };
  error.code = code;
  error.details = details;
  return error;
}

function normalizeError(error: unknown): BridgeErrorMessage["error"] {
  if (error instanceof Error) {
    const coded = error as Error & { code?: string; details?: unknown };
    return {
      code: coded.code ?? "easyeda_extension_error",
      message: error.message,
      details: sanitize(coded.details)
    };
  }
  // EasyEDA rejects with plain objects, and String() renders those as
  // "[object Object]" -- which is what the caller sees instead of the failure.
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message =
      pickString(record, ["message", "msg", "error", "reason", "description"]) ??
      safeJson(record) ??
      "EasyEDA returned an error object with no message.";
    return {
      code: pickString(record, ["code", "errorCode", "name"]) ?? "easyeda_extension_error",
      message,
      details: sanitize(error)
    };
  }
  return {
    code: "easyeda_extension_error",
    message: String(error)
  };
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text && text !== "{}" ? text.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

async function optionalCall<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    log("warn", "Optional EasyEDA API call failed", error);
    return undefined;
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[MaxDepth]";
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (typeof File !== "undefined" && value instanceof File) {
    return {
      name: value.name,
      size: value.size,
      type: value.type
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (typeof item !== "function") {
      output[key] = sanitize(item, depth + 1);
    }
  }
  return output;
}

function pickString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inferDocumentType(documentInfo: unknown): string {
  const record = isRecord(documentInfo) ? documentInfo : undefined;
  const numericType = record
    ? [
      record.documentType,
      record.doctype,
      record.type
    ].find((value) => typeof value === "number")
    : undefined;

  if (numericType === 1) return "schematic";
  if (numericType === 2) return "pcb";

  const raw = JSON.stringify(documentInfo ?? {}).toLowerCase();
  if (raw.includes("pcb")) return "pcb";
  if (raw.includes("sch") || raw.includes("schematic")) return "schematic";
  if (raw.includes("footprint")) return "footprint";
  if (raw.includes("symbol")) return "symbol";
  return "unknown";
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function log(level: "warn" | "error", message: string, details?: unknown): void {
  if (eda.sys_Log?.[level]) {
    eda.sys_Log[level](`[easyeda-mcp] ${message}`, details);
    return;
  }
  console[level](`[easyeda-mcp] ${message}`, details);
}

function showMessage(title: string, message: string): void {
  if (eda.sys_Dialog?.showInformationMessage) {
    eda.sys_Dialog.showInformationMessage(message, title);
    return;
  }
  log("warn", `${title}: ${message}`);
}
