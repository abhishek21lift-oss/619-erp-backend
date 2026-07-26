# Whiteboards

Annotation canvases attachable to any entity in the app. Phase 1 ships boards
on PT clients; the storage model and API are entity-agnostic so other modules
attach without schema changes.

## What shipped (phase 1)

- Infinite canvas: pen, highlighter, eraser, select, rectangle, diamond,
  ellipse, arrow, line, text, images, frames, grid, zoom, pan, undo/redo,
  group/ungroup, layer order, lock, duplicate — provided by
  [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT).
- Autosave with optimistic-concurrency conflict detection.
- Version history: manual snapshots + restore (restore snapshots the current
  board first, so it is itself undoable).
- Attachments (PNG/JPG/WEBP/GIF/PDF) to R2, with magic-byte validation.
- Tenant isolation, role-gated writes, soft delete, and search by title or by
  the text written on the canvas.
- **Anatomy overlays** — 61 assets (body, muscles, skeleton, joints, ligaments,
  rehab, exercise form) inserted locked and behind existing annotations at a
  chosen opacity. Lives in the frontend repo: see `ANATOMY-REPORT.md` there for
  provenance and licensing of every asset.

## What did NOT ship, and why

Called out explicitly so nobody assumes these exist:

| Not shipped | Reason |
|---|---|
| Real-time multi-cursor collaboration | Needs a websocket/CRDT layer; neither repo has one. Deferred by decision. Optimistic concurrency (below) is the interim guard. |
| Per-board ACLs, share links, comments | Needs a `whiteboard_members` table + sharing UI. Phase 1 is org-scoped + role-gated. |
| Templates, mind-map mode, rehab timeline | Product surfaces on top of this foundation, not engine features. |
| PDF export | Excalidraw exports PNG/SVG/JSON natively; PDF needs a separate render step. |

Note on the anatomy artwork: it is clinical *schematic* quality — correct
structure and labelling, not rendered medical illustration. Fine for coaching
and client explanation; not a substitute for a licensed anatomical atlas.

## Storage model

The document is **one opaque JSONB snapshot per board**, not a row per shape.

A row-per-shape schema (`BoardObjects`) is the obvious design and the wrong
one: a 3,000-shape board becomes 3,000 rows per load, every drag is a write,
and you end up re-implementing the engine's own reconciliation. Figma, tldraw
and Excalidraw all store a document blob. What we extract relationally is only
what the application queries: the owning entity, who touched it, and
`search_text` (all canvas text, flattened) so global search can find a board by
what is written on it.

Limits enforced in `whiteboard.service.js`:

- `MAX_DOCUMENT_BYTES` = 5 MB, measured in **bytes** not string length —
  multi-byte text would otherwise slip past a `.length` check.
- `search_text` capped at 20,000 chars.
- Attachments capped at 8 MB (`WHITEBOARD_ATTACHMENT_MAX_BYTES`).

## Concurrency

`whiteboards.document_version` is a counter. Every save must present the
version it loaded:

```
PUT /api/whiteboards/:id/document
{ "document": { ... }, "document_version": 7 }
```

- Match → write succeeds, version becomes 8.
- Mismatch → **409 `VERSION_CONFLICT`**, nothing is written.

The client stops autosaving on 409 and offers a reload rather than guessing at
a merge. This is what keeps two tabs — or two trainers — from destroying each
other's work until real-time collaboration exists.

## API

All routes require auth. Writes require role `super_admin | admin | manager |
trainer`; `member` (a client) may not author annotations on their own record.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/whiteboards` | `?entity_type=&entity_id=&status=&limit=&offset=` — metadata only, no documents |
| GET | `/api/whiteboards/search` | `?q=` — title + canvas text |
| GET | `/api/whiteboards/:id` | full board incl. document and `can_edit` |
| POST | `/api/whiteboards` | create |
| PUT | `/api/whiteboards/:id/document` | autosave; 409 on stale version |
| PATCH | `/api/whiteboards/:id` | rename / archive |
| DELETE | `/api/whiteboards/:id` | soft delete |
| GET | `/api/whiteboards/:id/versions` | metadata only |
| POST | `/api/whiteboards/:id/versions` | snapshot |
| POST | `/api/whiteboards/:id/versions/:versionId/restore` | snapshots current first |
| POST | `/api/whiteboards/:id/attachments` | multipart `file` |
| GET | `/api/whiteboards/attachments/:id` | authorised stream |

Deliberately **not** wrapped in `userApiLimiter`: autosave is a frequent PUT
while drawing and would burn the shared per-user budget that ordinary calls
need — the same reasoning as `/api/search`. The canvas debounces client-side
(1500 ms) and serialises saves so only one is ever in flight.

## Security

- **RLS deny-all** on all three tables, matching migrations 059/090/100/104.
  Reachable only through the Express API, which connects as a BYPASSRLS role.
- Tenant scoping via `tenantScope()` — fail-closed; an org-less user matches no
  rows rather than leaking across tenants.
- Uploads are validated by **magic bytes**, not the declared Content-Type
  (which is attacker-controlled). Storage keys are server-generated UUIDs; the
  client filename is stored for display only and never used as a path.
- Attachments stream through the API so tenant ownership is re-checked on every
  fetch, rather than exposing bucket URLs.

## Frontend

- `WhiteboardCanvas` — one board: autosave, theme-following, save-state banner.
- `WhiteboardPanel` — entity-agnostic list/create/open/history wrapper:
  `<WhiteboardPanel entityType="pt_client" entityId={id} />`

### Self-hosted assets (important)

Excalidraw fetches its fonts from `https://esm.sh/...` at runtime by default.
Our CSP blocks that, and it puts a third party in the render path of an
authenticated clinical app. `scripts/copy-excalidraw-assets.mjs` runs on
`postinstall`, copies them to `public/excalidraw-assets/`, and the component
points the engine there via `window.EXCALIDRAW_ASSET_PATH`.

The CJK font (Xiaolai) is skipped — it is 13 MB of the 14 MB total. Remove it
from `SKIP` in that script if CJK canvas text is ever needed.

`public/excalidraw-assets/` is gitignored: it is generated, and committing it
would let it drift from the installed package version.

## Extension points

Attaching boards to another entity:

1. Add the value to `ENTITY_TYPES` in `whiteboard.service.js`.
2. Add it to the `entity_type` CHECK constraint (new migration).
3. Add it to `WhiteboardEntityType` in `src/lib/api.ts`.
4. Render `<WhiteboardPanel entityType="..." entityId={...} />`.

All three lists must move together — if they diverge the API accepts a value
Postgres then rejects at write time, producing a 500 where a 422 belongs.
`whiteboard.service.test.js` pins this.

AI features are deliberately not implemented and not stubbed. The seam when
they are is the document itself: plain JSON that a provider-agnostic service
can read (summarise, OCR, generate) and write back through the same
`saveDocument` path. No AI provider should ever be referenced from the canvas
component.

## Deploying

1. Backend: `npm run migrate` applies `111_whiteboards.sql` (idempotent —
   `CREATE TABLE IF NOT EXISTS` throughout).
2. Frontend: `npm install` triggers the postinstall asset copy. Vercel runs
   this automatically; no build-command change needed.
3. No new environment variables are required. `WHITEBOARD_ATTACHMENT_MAX_BYTES`
   is optional and defaults to 8 MB.
