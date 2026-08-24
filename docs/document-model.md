# Document Model

What the bridge can and cannot change follows from how EasyEDA Pro stores a
document. This page records the parts that are not obvious from the tool list,
and the places where a tool returns an empty result rather than an error.

## A page references symbols; it does not contain them

A schematic page stores placements, not geometry:

```json
{"type":"COMPONENT","id":"e2"}||{"partId":"QI RX MODULE 5V.1","x":80,"y":80,...}
{"type":"ATTR","id":"e3"}||{"key":"Device","value":"3b05ac1a29246ae6","parentId":"e2",...}
```

Pins and body outlines live in the **project library**, keyed by that `Device`
uuid. `easyeda_set_document_source` writes the active document, so on a page it
can move parts, rewire, and relabel — and can never add a pin. Pins are a
library-symbol edit, which needs `lib_Symbol.updateDocumentSource()`.

| Record | Holds |
| --- | --- |
| `COMPONENT` | A placed instance; `partId` names the symbol |
| `ATTR` key=`Device` | Which library symbol the instance resolves to |
| `ATTR` key=`NET` | A net label, `parentId` pointing at its wire |
| `WIRE` | A container; geometry lives in the `LINE`s whose `lineGroup` is its id |
| `LINE` | Actual segment coordinates |
| `PIN` | Only ever inside a symbol document |

## Empty results that are not answers

`easyeda_get_component_pins`, `easyeda_trace_component`, and
`easyeda_find_unconnected_pins` return `[]` both for a document whose components
genuinely have no pins and for one whose pins the API cannot read.
`find_unconnected_pins` distinguishes them only by `confidence: "low"`, which
reads easily as "everything is connected."

`easyeda_get_document_source` answers the question directly. Its `recordTypes`
histogram counts primitives by type, so a document with `RECT` and `ATTR`
records and no `PIN` records is a document whose symbols are bare rectangles.

Net labels can be entirely intact in that state — they are page-level `ATTR`
records, unaffected by whatever happened to the symbols. A netlist that looks
right proves nothing about pins.

## Writes are normalized, not stored verbatim

The first `setDocumentSource` write makes the editor materialize derived
attributes: a `Symbol` attr per component and a `Relevance` attr per wire. On a
41-component sheet that moved the ATTR count from 402 to 552 with no change to
the design — 41 components, 110 wires, 114 net labels before and after.

It converges. A second write of the normalized source round-trips identically
except for `DOCHEAD` metadata (client id, timestamp, version). So compare record
counts across a write, never bytes.

## A write is not applied verbatim

`applied: true` means EasyEDA accepted the write, not that the document now
matches what was sent. Two behaviours seen on a live sheet:

- **A new `WIRE` group appended after the end of the document rejects the whole
  write.** Declared inline, among the existing wire records, the same group is
  accepted.
- **An in-place coordinate edit to an existing `LINE` is discarded** while every
  other change in the same write lands. A segment sent at x=1200 read back at
  x=1140, with no error and `applied: true`. Deletions and newly-created records
  are honored, so the way to move a wire is to delete its group and create a
  fresh one with new ids, repointing the net-label `ATTR` through `parentId`.

Always read back and check the specific records you changed.

Moving a component means moving four things: its `COMPONENT` record, every
`ATTR` whose `parentId` is that component, the stub `WIRE`/`LINE` group at each
pin, and the net-label `ATTR` at each stub's far end. Miss the stub and the pin
goes silently unconnected.

## Cloud-backed calls fail on a local project

An install configured `"type": "HALF_OFFLINE"` with a project held in a local
`.eprj2` resolves some calls against `https://pro.easyeda.com`. The lookups 404
because the resource is local-only, not because the network is down.

| Call | Behaviour |
| --- | --- |
| `dmt_Project.openProject` | resolves, does nothing — `/api/v4/projects/<uuid>` 404 |
| `dmt_Project.getAllProjectsUuid` | `[]` |
| `lib_Symbol.openInEditor` | throws — `/api/v2/components/<uuid>` 404 |
| `sys_FileManager.importProjectByProjectFile` | resolves, does nothing, logs nothing |
| `sys_FileSystem.getProjectsPaths`, `listFilesOfFileSystem` | hang |

Everything acting on the already-open document is unaffected: source read and
write, `SCH_Drc.check`, connection verification, device search, delete, and
`openDocument` once a project is loaded. The split is cloud resolution versus
local document work, not read versus write.

**The editor's log is where the cause appears.** `~/Documents/EasyEDA-Pro/logs/
warn/<date>.log` names the failing endpoint; the bridge sees only an `Error`
whose message is `"[object Object]"`. Read the log before forming a theory —
three rounds of argument-guessing preceded doing so.

## One client owns the bridge

The MCP server *hosts* the WebSocket on port 8765 rather than connecting to one.
A second server instance logs

```
[easyeda-mcp] WebSocket bridge port 8765 already in use; continuing without a bridge.
```

and then serves the full tool list backed by nothing: every call returns an
empty result and none of them error. Two MCP clients cannot share one editor.
Free the port in the other client, restart this one, and reconnect the extension.

`EASYEDA_MCP_WS_PORT` moves the bridge if the extension is pointed at the same
port, but the one-client constraint holds either way.

## Project files on disk

- `.epro2` — a zip containing a `.epru`
- `.epru` — JSON-lines, one primitive record per line, symbol documents and page
  documents concatenated with a `DOCHEAD` starting each
- `.eprj2` — SQLite. Its `documents` table is empty while the sheets are open in
  the editor, so it is not a shortcut to the live state.
