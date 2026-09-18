# Flow moved, and took the API with it

Google moved Flow from `labs.google/fx/tools/flow` to **`flow.google.com`** and
rewrote the frontend. Flowboard spoke a REST API that no longer has a caller,
and the auth it depended on stopped existing. This is what broke, what replaced
it, and what has no replacement.

## What actually broke

The old path was `POST aisandbox-pa.googleapis.com/...` carrying a
`Bearer ya29.…` that the extension sniffed off the page with `webRequest`. The
rewritten frontend is Angular and signs every call with the **session cookie
plus a per-page `at` token**, against one endpoint:

```
POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute
```

No `Authorization` header appears anywhere. The token was not expired — it had
stopped being minted. Two symptoms, one cause:

- `CAPTCHA_FAILED: NO_FLOW_TAB` — the extension matched only the old URL, so it
  could not see the Flow tab that was right there.
- `paygate_tier_unknown` on every dispatch — the stored Bearer aged out and
  nothing replaced it, so `/v1/credits` could never resolve a tier.

Refreshing the tab cannot fix either. If `token_age_s` only ever climbs across
tab reloads, the token is not stale, it is gone.

## The RPC map

| step | rpcid | notes |
|---|---|---|
| generate image | `ogiZ0b` | signed CDN url comes back inline |
| generate video (i2v) | `eb1hJf` | returns an operation id |
| reference-to-video (Omni) | `MZZa6b` | `abra_r2v_<duration>s` |
| poll an operation | `jwpduf` | status `CAE` means finished |
| operation → media id | `Zzl0ze` | the project listing; past 17 MB |
| media id → signed urls | `as29s` | `/video/` plus a poster `/image/` |
| upload an image | `maseQ` | base64 inline, **carries a captcha** |

Unchanged across the migration: the reCAPTCHA site key, and the `GEM_PIX_2` /
`NARWHAL` image model names.

## How it works now

`flow_batch.py` builds request envelopes and reads responses. It never touches
the network, because nothing outside the browser can sign a Flow request:

```
f.req = [[[rpcid, "<inner payload as a JSON string>", null, "generic"]]]
```

`flow_client.batch_rpc()` hands that to the extension over the WebSocket, and
`background.js` runs it via `chrome.scripting.executeScript` in the MAIN world
of a signed-in `flow.google.com` tab, where `at` / `f.sid` / `bl` live. A
generate also needs a **single-use** reCAPTCHA, minted in the page moments
before the request leaves — a replayed one comes back
`PUBLIC_ERROR_UNUSUAL_ACTIVITY`.

Consequence worth stating plainly: **nothing here works headless, and one
signed-in `https://flow.google.com/` tab has to stay open.**

`flow_batch.py` is kept byte-identical to flowkit's copy of the same module,
so an upstream fix diffs cleanly instead of needing a re-port. Flowboard's own
model policy therefore does *not* live there — `flow_sdk.py` resolves a
nickname to a wire id and passes it in explicitly.

## Configuration

Two things that used to be discovered at runtime now have to be declared,
because the Bearer token they were read from is no longer minted at all:

```bash
FLOWBOARD_FLOW_PROJECT_ID=<uuid of a project you made in the Flow UI>
FLOWBOARD_PAYGATE_TIER=PAYGATE_TIER_TWO   # TWO = Ultra, ONE = Pro
```

`FLOWBOARD_PAYGATE_TIER` is not cosmetic — it still selects the video
checkpoint, so an unrecognised value fails loudly at dispatch rather than
quietly changing which model renders.

## Not ported

No payload for these has ever been captured off the new UI, so they answer
with a `NO_FLOW_PROJECT` / `UNSUPPORTED_ON_BATCH_API` prefix instead of
reaching for the dead Bearer:

- **Creating a Flow project.** `project.createProject` was labs.google tRPC.
  `create_project` hands back the pinned project marked `reused: true`, so
  boards now share one Flow workspace instead of owning one each.
- **Listing a user's Flow projects.** Also tRPC. `GET /api/flow/projects`
  still reports every board's binding but sets `exists_on_flow: null`
  (unknown), and `POST /api/flow/projects/sync-up` answers `501` — it could
  "succeed" by binding every board to the one pinned project, which would
  record a shared workspace as if each board owned it.
- **Identity, credits and the paygate tier.** All rode on the same token.
  `/api/auth/me` reports `identity_available: false` and the configured tier
  with `paygate_tier_source: "configured"`.

`flow_key_present: false` in `/api/health` is now the **normal, healthy**
state. Nothing on this transport captures a bearer token.

## The traps, each of which cost hours upstream

1. **The poll's third uuid is a scene, not the media.** Feeding it to `as29s`
   answers NOT_FOUND forever. The media id lives only in the project listing.
2. **`Media not found.` in a poll is a complaint, not a verdict.** Jobs report
   it and still deliver a finished clip. Treating it as fatal killed live runs.
3. **Status may never reach `CAE`** on a job that finished, and old operations
   decay to a bare id. The listing decides; the poll is a hint.
4. **A media id arrives before the clip is fetchable.** `as29s` serves the
   poster image first and grows the `/video/` url later. Finish on the id
   alone and you save a still picture.
5. **The listing outgrows any response cap.** At 17 MB it was truncated at
   8 MB, so roughly half of all new operations looked like failures depending
   on where their id sorted. The extension filters in the page and returns an
   800-byte window around the operation id instead.
6. **Slot 4 of an image request item is the aspect ratio, not a variant
   count.** `count=1` looked correct because 1 there means square. Variants
   come from repeating the RPC. Image: 1 square, 2 portrait 9:16, 3 landscape
   16:9, 4 is 3:4, 5 is 4:3.
7. **Video aspect uses a different encoding** — 1 portrait, 2 landscape — in
   its own slot. The numbers collide with the image scheme, so conflating them
   renders the wrong shape and Flow reports nothing wrong.
8. **Accepted ≠ used.** Reference images sit in their own slot as
   `[mediaId, null, null, null, 1]`; type 2 is the BASE_IMAGE being edited.
   Wrong arrangements in that same slot are accepted without complaint and
   then ignored. Prove a reference with a prompt that never names the subject.
9. **Model policy travels with the code.** `flow_batch` defaults to a
   different image model than Flowboard does; the nickname is resolved in
   `flow_sdk` before the call so this project's choice survives a re-port.
10. **Concurrent captcha mints interfere.** An image dispatch fires up to four
    RPCs at once and each needs its own single-use token, so `injected.js`
    serialises `grecaptcha.enterprise.execute` calls.

## Testing it

`tests/batch_harness.py` decodes the `f.req` envelope and names the positional
slots, because asserting on the SDK's return value alone would happily pass
while a value sat in the wrong slot. That is the whole point of traps 6-8: the
request is well-formed either way.
