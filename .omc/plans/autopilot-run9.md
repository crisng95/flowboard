# Run 9 — Phase 3 closing: upload + character node

Branch: `claude/build-flowboard-canvas-gUlV5`
Scope: image upload to Google Flow + character_media_ids in image generation, so character nodes can condition image nodes.

## What ships

### Backend
- `FlowSDK.upload_image(image_base64, mime_type, project_id, file_name) -> {raw, media_id}` — POSTs to `/v1/flow/uploadImage` via `flow_client.api_request`. Extracts `data.media.name` as the Flow media_id. No captcha required.
- `FlowSDK.gen_image(..., character_media_ids: list[str] | None = None)` — when present, adds `imageInputs: [{name, imageInputType: "IMAGE_INPUT_TYPE_REFERENCE"}, ...]` to the request item.
- `_handle_gen_image` worker handler — forwards optional `character_media_ids` from request params to `gen_image`.
- New route `POST /api/upload` (multipart):
  - `file`: image file, `image/*` mime only, ≤ 10 MB.
  - `project_id`: form field, required (Flow upload is project-scoped).
  - Reads bytes, base64-encodes, calls `FlowSDK.upload_image`.
  - On success: writes bytes to `MEDIA_CACHE_DIR/<media_id>.<ext>`, upserts `Asset(uuid_media_id=media_id, kind="image", local_path=..., mime=...)`. No `url` field — these are local-origin.
  - Returns `{media_id, mime, size}`.

### Frontend
- `api/client.ts`: `uploadImage(file: File, projectId: string)` returning `{media_id, mime, size}`.
- `canvas/NodeCard.tsx` `CharacterBody`: drop zone + click-to-upload. On file selected → upload → `updateNodeData({mediaId})` + `patchNode` for persistence. When `mediaId` present, render `<img src={mediaUrl(mediaId)}>` with the same retry pattern as `ImageBody`.
- `store/generation.ts` `dispatchGeneration` (kind=image): walk board edges to find character nodes targeting this image node, collect their `mediaId` values, pass as `character_media_ids` in `createRequest` params.

### Tests
- `test_upload.py`:
  - `test_upload_rejects_non_image_mime` (text/plain → 415)
  - `test_upload_rejects_oversize` (mock size > 10 MB → 413)
  - `test_upload_rejects_missing_project_id` (→ 422)
  - `test_upload_happy_path` (stub `flow_sdk.upload_image`, asserts file cached + Asset row)
- `test_requests.py` additions:
  - `test_handle_gen_image_passes_character_media_ids` (stub gen_image, assert kwargs)
- Existing pytest must still pass (113/113 baseline).

## Out of scope (Run 10+)
- Edit-image flow (`IMAGE_INPUT_TYPE_BASE_IMAGE` for source) — Phase 9
- Upscale video — Phase 9
- URL refresh on fifeUrl expiry — separate run
- Pipeline executor / ghost nodes — Phase 5
- Removing orphan `events.py`/`board_bus` debug endpoint — separate cleanup run
- Historical chat plan join — separate fix

## Verification
- `pytest agent/tests` → all green (target 117/117 = 113 baseline + 4 new)
- `tsc --noEmit` → clean
- Manual smoke: create character node → drop image → see uploaded image → connect to image node → generate → image conditioned on character

## Files touched
- `agent/flowboard/services/flow_sdk.py` — upload_image, gen_image character_media_ids
- `agent/flowboard/worker/processor.py` — _handle_gen_image forwards character_media_ids
- `agent/flowboard/routes/upload.py` — NEW
- `agent/flowboard/main.py` — register upload router
- `agent/tests/test_upload.py` — NEW
- `agent/tests/test_requests.py` — character_media_ids test
- `frontend/src/api/client.ts` — uploadImage
- `frontend/src/store/generation.ts` — character_media_ids passthrough
- `frontend/src/canvas/NodeCard.tsx` — CharacterBody upload UI
