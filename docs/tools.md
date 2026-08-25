# Tools Reference

Use this page when you know what you want to do and need the right MCP tool.

## Fast Picker

| Goal | Start with |
| --- | --- |
| Check whether the bridge works | `easyeda_doctor` |
| See what is open in EasyEDA Pro | `easyeda_get_context` |
| Find a part | `easyeda_find_component` |
| Find a net | `easyeda_find_net` |
| Inspect the whole schematic | `easyeda_schematic_snapshot` |
| List schematic parts | `easyeda_list_schematic_components` |
| Inspect one part's pins | `easyeda_get_component_pins` |
| Trace a signal or power rail | `easyeda_trace_net` |
| Trace everything around one part | `easyeda_trace_component` |
| Find likely wiring gaps | `easyeda_find_unconnected_pins` |
| Run generic schematic checks | `easyeda_validate_schematic_area` |
| Check exact connection rules | `easyeda_verify_connections` |
| Move the editor to a part | `easyeda_navigate_component` |
| Export manufacturing files | `easyeda_export_bom`, `easyeda_export_netlist`, `easyeda_export_gerber`, `easyeda_export_pdf` |
| Save/import/autoroute/autolayout | `easyeda_confirmed_action` |
| Read the document's own source | `easyeda_get_document_source` |
| Replace the document's source | `easyeda_set_document_source` |
| Import a generated sheet | `easyeda_import_schematic` |
| List schematics and sheets | `easyeda_list_schematics` |
| Delete a schematic or sheet | `easyeda_delete_schematic` |
| Find a real part (LCSC) | `easyeda_find_library_device` |
| **Start here in a new session** | `easyeda_doctor` |
| Put a sheet on screen | `easyeda_open_document` |
| Read a symbol (where pins live) | `easyeda_get_symbol_source` |
| Fix a symbol's pins | `easyeda_set_symbol_source` |
| Check connectivity against intent | `easyeda_get_netlist` |
| Run the schematic rule check | `easyeda_schematic_check` |

## Recommended First Flow

Run these in order when starting a session:

1. `easyeda_doctor`
2. `easyeda_get_context`
3. `easyeda_schematic_snapshot`
4. `easyeda_trace_component` or `easyeda_trace_net`

## Tool Groups

- status and context
- search and inspection
- schematic analysis
- navigation and export
- explicitly confirmed actions

## Status and Context

### `easyeda_live_status`

Checks whether the EasyEDA Pro extension is connected and returns current bridge and editor status information.

Use this for a quick yes/no connection check.

### `easyeda_doctor`

Returns a structured diagnosis of the local MCP bridge, extension connection state, protocol compatibility, active document availability, and recommended next steps.

Use this first when anything feels broken.

### `easyeda_get_context`

Returns a broader summary of the current editor context, including active document details and some available counts for project data.

Use this to confirm the AI is looking at the right EasyEDA Pro document.

## Search and Inspection

### `easyeda_find_component`

Searches the active project for components matching a designator, name, value, footprint, or property text.

Good queries: `U1`, `USB1`, `TPS`, `regulator`, or a footprint name.

### `easyeda_find_net`

Searches nets by name and returns available net metadata and connections.

Good queries: `GND`, `VCC_5V`, `SDA`, `VBUS`, `D+`, or `CC1`.

## Schematic Analysis

### `easyeda_schematic_snapshot`

Builds a structured, normalized snapshot of the active schematic, including components, pins, wires, labels, nets, counts, warnings, and confidence metadata.

This is the best starting point for schematic-level analysis.

### `easyeda_list_schematic_components`

Lists normalized schematic components with key fields such as designator, value, name, footprint, position, and selected properties.

Use it to inventory the schematic or filter for a family of parts.

### `easyeda_get_component_pins`

Returns the pins known for a component, including pin number, pin name, position, and net when available.

Use it before writing exact checks with `easyeda_verify_connections`.

### `easyeda_trace_net`

Traces a net and returns the pins, components, wires, labels, and related evidence associated with it.

Use it to inspect a signal, power rail, or named net.

### `easyeda_trace_component`

Traces a component's connections grouped by pin and net.

Use it to review how one device is wired.

### `easyeda_find_unconnected_pins`

Finds pins that do not have a confirmed net in the normalized schematic data.

Use it to find likely missing wires or symbol connectivity issues.

### `easyeda_validate_schematic_area`

Runs generic read-only schematic checks against selected components, selected nets, or the whole schematic.

The current validation layer may report findings such as:

- `pin_without_net`
- `single_pin_net`
- `single_node_net`
- `similar_power_net_names`
- `power_net_without_detected_capacitor`

### `easyeda_verify_connections`

Runs structured connection assertions against the active schematic.

Use this when you want targeted checks such as:

- whether a pin is connected at all
- whether a pin is on a specific net
- whether two endpoints resolve to the same node
- whether a path exists or does not exist
- whether a signal is pulled to a reference net through a resistor or other passive component
- whether a power node appears decoupled to a reference net

Supported assertion types include:

- `pin_connected`
- `pin_on_net`
- `same_node`
- `path_exists`
- `path_absent`
- `pull_to_net`
- `decoupled_to_net`

Example shape:

```json
{
  "checks": [
    {
      "type": "pin_on_net",
      "component": "USB1",
      "pinName": "GND",
      "net": "GND"
    },
    {
      "type": "path_exists",
      "from": { "component": "USB1", "pinName": "CC1" },
      "to": { "net": "GND" },
      "through": { "kind": "resistor", "value": "5.1k" }
    }
  ]
}
```

## Navigation and Export

### `easyeda_navigate_component`

Requests navigation to a component in the EasyEDA Pro editor.

Use it after search or trace when you want to inspect the part visually.

### `easyeda_navigate_region`

Navigates to coordinates or a rectangular region in the active document.

Use it when:

- you already know the coordinate target
- you want to zoom into a specific area

### `easyeda_zoom_board`

Zooms the active PCB editor to the board outline.

### `easyeda_export_bom`

Exports a BOM from the active project.

Supported formats:

- `csv`
- `xlsx`
- `json`

### `easyeda_export_netlist`

Exports a netlist from the active schematic or PCB context.

### `easyeda_export_gerber`

Exports Gerber fabrication data from the active PCB.

### `easyeda_export_pdf`

Exports a PDF from the active schematic or PCB document.

## Project Lifecycle

The ingest loop — generate, import, verify, replace — runs end to end through
these without leaving the tool.

### `easyeda_import_schematic`

Imports a sheet file into the open project. `fileType: "EasyEDA"` is the
**Standard** edition JSON the generators emit; `"EasyEDA Pro"` is Pro's own
project format. The result reports the schematic count either side, because an
import that resolves is not evidence that a schematic appeared.

Verify afterwards. An import can land and still produce symbols without pins —
see [Document Model](/document-model) for how to tell.

### `easyeda_list_schematics`

Schematics and sheets with their uuids. Each import lands as its own schematic
holding one page, so this is how an obsolete import is told from the current one.

### `easyeda_delete_schematic`

Deletes by explicit uuid; there is deliberately no "current document" form,
since the active document is whatever was last clicked. Irreversible — read the
source to a file first if it may be wanted again.

### `easyeda_find_library_device`

Looks up devices by LCSC id, uuid, or keyword. A device is what carries a
footprint, and the netlist export stays refused until components have them.

## Library Symbols

A schematic page references symbols; the pins are in the symbol. These two reach
that second document, which is why a broken pin no longer means re-importing the
whole sheet.

### `easyeda_get_symbol_source`

Reads one symbol and reports its record histogram. `PIN` count is the number
worth looking at: a symbol that imported as a bare rectangle has `RECT` and
`ATTR` records and no `PIN` at all.

Find `symbolUuid` from `easyeda_get_component_pins` with `includeRaw: true`,
under the component's `symbol.uuid`. `libraryUuid` is usually empty for a
project-local symbol.

Reading opens the symbol in the editor, which moves the view off whatever was
active; the tab is closed again afterwards unless `keepOpen` is set.

### `easyeda_set_symbol_source`

Writes a symbol back. **Every placed instance changes at once** — that is the
point when correcting pins, and a hazard when the symbol is shared.

Backs up first, and reports refusal through `applied` rather than raising. Read
back afterwards: as with the document write, an accepted write is not proof the
symbol matches what was sent. If a write is refused, retry with `openFirst`,
which follows EasyEDA's documented order.

## Verification

Connectivity reported by the pin and trace tools is inferred from geometry. These
two tools are not: both come from EasyEDA's own engines, and they are what a
change should be checked against before it is believed.

### `easyeda_get_netlist`

Exports the schematic netlist and parses it into nets and pins. Pass `expected`
— a net-to-pins map — to diff the design against its intent:

```json
{ "expected": { "PACK_NEG": ["U3-P-", "Q3-S"] } }
```

The diff separates two failures that need different fixes. A **missing net**
means the label never landed. A **pin mismatch** means it landed on the wrong
pin. Nets present in the design but absent from `expected` are listed and do not
fail the diff, since intent is usually partial.

`singleEndedNets` names nets reaching fewer than two pins — a net that connects
nothing, and the cheapest real defect a netlist exposes.

Only `Protel2` is parsed; other `ESYS_NetlistType` values are saved as raw text
with `parsed: false`. The type argument is required by EasyEDA — omitting it is
why an earlier netlist export here returned nothing at all.

### `easyeda_schematic_check`

Runs `SCH_Drc.check` and returns its violations. Verbose detail is requested,
but EasyEDA sometimes answers with counts only; `detail` reports which was
received, and `"none"` with `passed: false` means the per-violation list is
visible only in the editor panel.

`openPanel` is off by default so a check does not steal focus.

## Document Source

See [Document Model](/document-model) for what a page holds versus what a
library symbol holds, and why that decides whether an edit is possible here.

EasyEDA Pro serializes a document as JSON-lines primitive records -- one per
`DOCHEAD`, `CANVAS`, `PART`, `RECT`, `PIN`, `WIRE`, `COMPONENT`. These two tools
read and replace that source directly, which is the only whole-document write
the extension API offers: `sch_PrimitiveComponent.create()` places existing
library devices and cannot build a symbol with custom pins.

### `easyeda_get_document_source`

Saves the active document's source to a local file and returns a record-type
histogram with the first lines, rather than the whole document.

The histogram answers questions no component-level tool can. A sheet whose
symbols imported as bare rectangles reports `RECT` and `ATTR` records and no
`PIN` records at all -- while `easyeda_get_component_pins` returns `[]` for that
document and for a healthy one it simply cannot read.

| Field | Meaning |
| --- | --- |
| `path` | Where the full source was saved |
| `recordTypes` | Count per primitive type |
| `lineCount`, `byteLength` | Document size |
| `head` | First `headLineCount` lines (default 20) |

Pass `inline: true` to get the whole source back in the response. Only do that
for a small document.

### `easyeda_set_document_source`

Replaces the entire active document. Takes `filePath` or `source`, plus the same
explicit `confirmation` the other mutating tools require.

Before writing, it reads the current source and saves it to `backupPath`
(default: a timestamped file in the system temp directory), and aborts if that
backup cannot be written. Pass `skipBackup: true` only for a document you are
willing to lose.

**Check `applied`.** EasyEDA reports malformed source by returning `false`, not
by raising an error, so a resolved call is not by itself a landed write:

```json
{
  "applied": false,
  "reason": "EasyEDA rejected the source; the document is unchanged.",
  "backupPath": "/tmp/easyeda-mcp/document-backup-20260824T204643.epru"
}
```

## Explicitly Confirmed Actions

### `easyeda_confirmed_action`

Runs a mutating EasyEDA Pro action only when the confirmation text explicitly confirms the action.

Supported actions:

- `save`
- `importChanges`
- `autoroute`
- `autolayout`

The confirmation text must include an explicit confirmation phrase such as:

- `I confirm`
- `confirmed`
- `confirma`
- `confirmo`

Example shape:

```json
{
  "action": "save",
  "confirmation": "I confirm"
}
```

## Practical Usage Pattern

A useful workflow is often:

1. `easyeda_live_status`
2. `easyeda_doctor`
3. `easyeda_get_context`
4. `easyeda_schematic_snapshot`
5. `easyeda_trace_component` or `easyeda_trace_net`
6. `easyeda_verify_connections` for targeted assertions
7. `easyeda_navigate_component` if you need to inspect the area visually
