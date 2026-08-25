/**
 * A tool list says what exists, not what works. Several capabilities here resolve
 * successfully while doing nothing, which costs a session to discover one at a
 * time — so the diagnosis states them up front, with the evidence and the route
 * that does work.
 */

export type Limitation = {
  /** What a caller would try. */
  capability: string;
  /** What actually happens. */
  behaviour: string;
  /** Why, as far as it has been established. */
  cause: string;
  /** What to do instead. */
  instead: string;
};

export type Readiness = {
  projectLoaded: boolean;
  documentOpen: boolean;
  schematicCount?: number;
  blocking: string[];
};

/**
 * Established against EasyEDA Pro 3.2.149 in HALF_OFFLINE mode with a local
 * .eprj2 project. Every entry was reproduced, not inferred from documentation —
 * the documentation was wrong or silent on most of them.
 */
export const KNOWN_LIMITATIONS: Limitation[] = [
  {
    capability: "easyeda_import_schematic",
    behaviour: "Resolves with no effect and writes no log entry, so it never attempts the work.",
    cause:
      "sys_FileManager.importProjectByProjectFile works when given saveTo {operation:'Existing Project', existingProjectUuid}. Without it the call is a silent no-op, which is what made it look inert. It does not bind footprints on a local project even with associateFootprint:true -- components arrive carrying an Origin Footprint name only, and the DRC still reports one fatal error each.",
    instead: "Import through File -> Import in the editor."
  },
  {
    capability: "easyeda_open_project",
    behaviour: "Resolves with no effect; the editor stays on its Start Page.",
    cause: "dmt_Project.openProject resolves the uuid against pro.easyeda.com, which 404s for a local project.",
    instead: "Open the project from the Start Page, or run `open <path>.eprj2` from a shell."
  },
  {
    capability: "easyeda_get_symbol_source / easyeda_set_symbol_source",
    behaviour: "Throws with an unhelpful message for a project-local symbol.",
    cause: "lib_Symbol.openInEditor fetches the symbol from pro.easyeda.com, which 404s because the symbol exists only in the local project library.",
    instead: "Fix pins in the generator and re-import the sheet."
  },
  {
    capability: "easyeda_get_netlist",
    behaviour: "Refused while components have no footprints.",
    cause: "EasyEDA declines the netlist export until every component carries a footprint; a generic box symbol has none.",
    instead: "Place real library devices first — easyeda_find_library_device returns their footprint uuids."
  },
  {
    capability: "Pin-level reads (get_component_pins, trace_component, find_unconnected_pins)",
    behaviour: "Return an empty list both when there are no pins and when they cannot be read.",
    cause: "The distinction appears only as confidence: 'low', which reads as 'nothing wrong'.",
    instead: "Check the PIN count in easyeda_get_document_source's recordTypes histogram."
  }
];

/**
 * Everything below the document level fails while no project is loaded, and it
 * fails by returning nothing rather than by erroring — so this is worth stating
 * before any other diagnosis is believed.
 */
export function assessReadiness(input: {
  connected: boolean;
  schematicCount?: number;
  activeDocumentType?: string;
}): Readiness {
  const projectLoaded = (input.schematicCount ?? 0) > 0;
  const documentOpen = Boolean(
    input.activeDocumentType && input.activeDocumentType !== "unknown"
  );

  const blocking: string[] = [];
  if (!input.connected) {
    blocking.push(
      "The extension is not connected. Loading a project unmounts it — its menu disappears and the bridge drops. Opening any schematic in the editor remounts it and reconnects. That click cannot be made through the bridge, since nothing reaches a dead extension."
    );
  } else if (!projectLoaded) {
    blocking.push(
      "No project is loaded. Every document API returns undefined or an empty list until one is, including easyeda_open_document. Open the project from the Start Page."
    );
  } else if (!documentOpen) {
    blocking.push(
      "A project is loaded but no document is open. Call easyeda_open_document with a page uuid from easyeda_list_schematics."
    );
  }

  return { projectLoaded, documentOpen, schematicCount: input.schematicCount, blocking };
}
