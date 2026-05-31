# Flowboard — Báo cáo Rà soát Toàn diện & Lộ trình Nâng cấp lên Chuẩn Thương mại

> Tài liệu này tổng hợp kết quả rà soát toàn bộ sản phẩm (canvas + node, backend agent, browser extension/automation, cloud/auth/billing, frontend state/pipeline) và đề xuất lộ trình nâng cấp có ưu tiên. Mọi phát hiện đều dựa trên đọc mã nguồn thực tế, có dẫn chiếu file. Tài liệu này KHÔNG thay đổi mã nguồn.

Ngày lập: 2026-06-01 · Phạm vi: `flowboard/` (bỏ qua bản sao cũ `flowboard-merge-lab/`).

---

## 1. Tóm tắt điều hành (Executive Summary)

Flowboard hiện là một **ứng dụng desktop một-người-dùng-trên-một-máy** đã chạy ổn cho mục đích cục bộ, nhưng để đạt **chuẩn thương mại (multi-tenant SaaS)** thì còn nhiều khoảng trống chặn (blocker) ở cả 4 trục: an toàn/bảo mật, độ tin cậy, khả năng mở rộng, và trải nghiệm.

Vấn đề kiến trúc lớn nhất — và cần quyết định trước tiên — là sản phẩm đang tồn tại **hai mặt phẳng dữ liệu (data plane) gần như tách rời**:

- **Local Agent Plane** (bản đang ship): FastAPI trên `127.0.0.1:8101` + SQLite, ID dạng số nguyên, **không có `user_id`, không auth, không RLS**. Thiết kế cho 1 người dùng/máy.
- **Cloud Control Plane** (SaaS "Beta", mới đi dây một phần): Supabase Postgres + Cloudflare R2, ID dạng UUID, có `user_id`, RLS + composite-FK đầy đủ, mô hình hàng đợi claim/lease/heartbeat.

Không thể "ra mắt thương mại multi-tenant" trên Local Plane, và Cloud Plane thì chưa được tích hợp trọn vẹn. **Quyết định phạm vi thương mại là việc số 0** — mọi hạng mục bên dưới phụ thuộc vào lựa chọn này.

### Mức độ sẵn sàng theo trục (đánh giá định tính)

| Trục | Hiện trạng | Mức sẵn sàng thương mại |
|------|-----------|--------------------------|
| Bảo mật / Secrets | Secrets cloud bị commit trong cây làm việc; key Google hardcode; cron token mặc định | 🔴 Chặn |
| Auth / Multi-tenant | Local: không auth. Cloud: RLS tốt nhưng backend chạy `service_role` bypass RLS | 🔴 Chặn |
| Billing / Entitlement | Không có hệ thống tính phí; chỉ đọc tier của Google Flow; chỉ có donation | 🔴 Chặn (nếu cần doanh thu) |
| Độ tin cậy pipeline | Polling không retry/persist lỗi; 3 vòng poll trùng lặp; zombie poll | 🟠 Rủi ro cao |
| Khả năng mở rộng | SQLite + worker đơn tiến trình + state in-memory | 🟠 Trần cứng |
| Tự động hóa Flow | Phụ thuộc API riêng tư của Google; không retry 429/5xx; token hết hạn giữa job | 🟠 Mong manh |
| UX canvas/node | Thiếu error state, fake progress, thiếu Ctrl+Z/C/V, control "chết" hiển thị | 🟠 Chưa đạt chuẩn |
| Dữ liệu / Migration | Không có công cụ migration chính thức; có 1 thao tác DROP phá dữ liệu | 🟠 Rủi ro |

🔴 = blocker thương mại · 🟠 = cần xử lý trước/ngay sau khi ra mắt · 🟢 = chấp nhận được.

---

## 2. Tổng quan kiến trúc & luồng dữ liệu

### 2.1 Luồng sinh nội dung (Local Plane — đường đang ship)

```
Frontend (Zustand store)
  → POST /api/requests  (tạo Request, status=queued)
  → WorkerController (asyncio.Queue, 1 consumer, tuần tự)
  → handler (gen_image / gen_video / gen_video_omni / edit_image / variant / storyboard)
  → flow_sdk → flow_client.api_request  (JSON qua WebSocket :9223)
  → Chrome Extension thực thi fetch có xác thực tới aisandbox-pa.googleapis.com
  → kết quả POST về /api/ext/callback (xác thực X-Callback-Secret)
  → frontend poll GET /api/requests/{id} mỗi 1500ms cho tới done/failed/timeout/canceled
```

Tham chiếu: `agent/flowboard/main.py`, `worker/processor.py`, `services/flow_client.py`, `extension/background.js`, `frontend/src/store/generation.ts`.

### 2.2 Luồng Cloud (Control Plane — SaaS Beta)

```
Frontend (Supabase JWT) → POST /api/control-plane/requests (RPC create_or_reset_request)
  → hàng đợi requests trên Postgres (claim/lease/heartbeat/progress/complete/fail)
  → Extension ở "cloud-worker mode" poll /api/extension/claim, tự gọi Flow API, upload R2
```

Tham chiếu: `agent/flowboard/routes/control_plane.py`, `services/control_plane.py`, `data_temple/migrations.sql`, `extension/background.js` (cloud poll), `extension/flow_api.js`.

### 2.3 Nhận xét cốt lõi

- Hai engine sinh nội dung và hai mô hình hàng đợi **độc lập, song song**, dễ phân kỳ.
- `services/events.py::BoardBus` được định nghĩa nhưng **không được import ở đâu** → không có cập nhật realtime; frontend đang poll thay thế.
- `pipeline_executor` và planner sinh background task riêng, lại poll DB → tăng độ trễ và tải.

---

## 3. Kiểm kê Node & rà soát tính năng

Runtime đang dùng là **UI V2** (`localStorage.flowboard_ui = "v2"`). `NodeCard.tsx` (1677 dòng) vẫn route cho vài type khi tắt V2.

| Node | type id | Component (dòng) | Input handle | Output handle | Sinh nội dung? | Lỗ hổng chính |
|------|---------|------------------|--------------|---------------|----------------|----------------|
| Text | `text` | TextNode (241) | — | `source` | Không | Không có giới hạn ký tự; `DualResizeHandle` trùng lặp với Note |
| Note | `note` | NoteNode (782) | — | — | Không | `document.execCommand` đã deprecated; innerHTML chưa sanitize (rủi ro XSS nếu board chia sẻ) |
| Add Reference | `add_reference` | AddReferenceNode (494) | — | `source` | Có | Palette gắn "Soon"/disabled nhưng thực tế đã đi dây đầy đủ → tín hiệu sản phẩm mâu thuẫn |
| Image Generator | `reference` | ImageGeneratorNode (586) | `target-text`, `target-image` | `source` | Có | **Không render error state**; nút Settings (gear) không có onClick; `imageCount` chết khi nối list; progress giả |
| Variant | `variant` | VariantNode (790) | `target-text`, `target-image` | `source` | Có | 4/6 mode disabled; Resolution hard-disabled; `console.log` còn sót; không đọc list source |
| List | `list` | ListNode (1132) | `target-text/-video/-image` | `source-text/-video/-image` | Import/chạy graph | Toán độ rộng phụ thuộc DOM magic-number; lỗi upload chỉ `console.error` |
| Video Generator | `video` | VideoGeneratorNode (822) | 4 target | 4 source | Có | **Không render error state**; handle `source-audio`/`source-end-image` không có consumer; offset handle magic-number; min-width 520 |
| Group | `group` | GroupNodeShell (493) | — | — | Không | Palette màu khác Note (theming lệch); duplicate nuốt lỗi từng con |

**Hạ tầng dùng chung:** `NodeShell` (chỉ Text/Upload dùng), `v2/shared/*` (26 file). **Kiểm thử:** chỉ 2 file test cho 8 loại node.

---

## 4. Phát hiện theo từng phân hệ (kèm mức độ)

Quy ước mức độ: **P0** = blocker an toàn/bảo mật/pháp lý · **P1** = rủi ro cao về tin cậy/dữ liệu · **P2** = chất lượng/UX/khả năng mở rộng · **P3** = nợ kỹ thuật.

### 4.1 Bảo mật & Secrets

- **[P0] Secrets cloud nằm trong cây làm việc** — `agent/.env.staging` chứa Supabase **service_role key** (bypass toàn bộ RLS), R2 access key/secret, user UUID. Dù `.gitignore` đã loại trừ và `git ls-files` cho thấy chưa track, **giá trị bí mật vẫn nằm plaintext trên đĩa** và được `config.py::_load_env_file` nạp. → Phải xoay vòng (rotate) ngay và đưa ra khỏi repo.
- **[P0] Default cứng trong `config.py`**: `SUPABASE_URL` thật, `CONTROL_PLANE_CRON_TOKEN = "default_cron_secret_token_123"`. Nếu prod không override token, endpoint `/api/cron/recover-stale` bị gọi tự do (so sánh constant-time vô nghĩa khi token là hằng số công khai).
- **[P0] Google API key hardcode** trong `services/flow_client.py` (`_FLOW_API_KEY = "AIzaSy..."`) và `extension/flow_api.js`.
- **[P0] Token nhạy cảm lưu plaintext ở client**: extension lưu Bearer token Google + pairing secret trong `chrome.storage.local` (đọc được bởi extension khác có quyền `storage`); pairing secret còn được echo lại trong UI popup.

### 4.2 Backend Agent (FastAPI + worker)

- **[P0] Không có auth ứng dụng trên API cục bộ** — mọi route `/api/boards|nodes|edges|requests|upload|...` không xác thực. Chấp nhận được cho desktop loopback, là blocker nếu hosted.
- **[P0] CORS `allow_origins=["*"]` + `allow_credentials=True`** (`main.py`) — cấu hình sai/nguy hiểm, mở rộng bề mặt tấn công khi không có auth.
- **[P1] Không retry & không bền vững (durable) ở hàng đợi cục bộ** — `extension_disconnected` hoặc 1 lỗi Flow là fail cả request; không requeue. Hàng đợi là `asyncio.Queue` in-memory → row `queued` mất khỏi queue khi crash sẽ "treo" mãi (boot recovery chỉ xử lý `running`). Không có reaper job kẹt khi process còn sống.
- **[P1] `boto3`/`botocore` được import nhưng thiếu trong `pyproject.toml`/`requirements.txt`** — cài sạch sẽ lỗi import ở đường control-plane. Ngoài ra boto3 presign chạy blocking trên event loop.
- **[P1] Không có framework migration** — `init_db()` dùng `create_all` + `ALTER TABLE ADD COLUMN` thủ công + một `DROP` phá dữ liệu bảng `asset` cũ. Không có version table, không rollback, không backfill.
- **[P2] Quan sát được (observability) yếu** — log plain-text, không có request-id correlation, không metrics/tracing, không readiness probe kiểm tra DB. Còn endpoint debug `/api/media/_debug/assets` và dead code `events.BoardBus`.
- **[P2] PostgREST URL ghép bằng f-string** (`services/control_plane.py`) — giá trị không URL-encode, nên dùng `params=` của httpx.
- **[P3] File quá lớn**: `worker/processor.py` (1417), `services/prompt_synth.py` (1401), `services/flow_sdk.py` (1215); handler `gen_video`/`gen_video_omni` gần như trùng lặp.

### 4.3 Browser Extension & Automation Flow/Gemini

- **[P1] Không retry/backoff khi Flow trả 429/5xx** — job fail tức thì, bỏ qua `Retry-After`.
- **[P1] Phụ thuộc cứng vào API riêng tư & DOM của Google Flow** — endpoint không tài liệu + enum model-key hay đổi; parser "deep-walk" theo heuristic, fail âm thầm khi response đổi cấu trúc.
- **[P1] Không tự phục hồi khi token hết hạn giữa job**.
- **[P2] Quan sát mỏng** — chỉ một `lastError` bị cắt ngắn, cảnh báo mất asset bị nuốt, không telemetry.
- **[P2] Bản extension cũ thừa** — `data_temple/extension/extension/*` là bản v0.0.5 chỉ-bridge, hardcode site key reCAPTCHA; nên xóa để tránh nhầm lẫn (bản active là `flowboard/extension/*` v0.0.6).
- **[P2] Test E2E/smoke đều opt-in** sau env-flag, yêu cầu Chrome/token/Supabase/R2 thật → CI chỉ phủ đường mock.

### 4.4 Cloud / Auth / Billing / Storage

- **[P0] Backend chạy `service_role` → bypass RLS hoàn toàn.** RLS không phải biên thực thi thật; chỉ cần một query thiếu filter `user_id` là rò rỉ chéo tenant.
- **[P1] Đường claim fallback phá vỡ cam kết** — `_claim_next_request_fallback` (khi thiếu RPC) chọn job `queued` cũ nhất và PATCH sang `running` **không kiểm tra pairing active, không giới hạn concurrency** → môi trường staging-thiếu-migration có thể giao job cho client chưa pair và vượt cap.
- **[P0] Không có hệ thống billing** — `PAYGATE_TIER_ONE/TWO` là tier của **Google Flow** (đọc từ `/v1/credits`), Flowboard không thu phí, không gate tính năng của mình. Monetization duy nhất là donation (Ko-fi/PayPal honor-system).
- **[P1] Không có hạn mức lưu trữ (quota)** — `assets.byte_size` tồn tại nhưng không tổng hợp/kiểm tra; cache cục bộ (`services/media.py`, upload) không TTL/eviction; asset mồ côi không GC; `retention_state` không được code nào dùng. Free-tier Supabase (DB 0.5GB, Storage 1GB, Egress 5GB) sẽ chạm trần âm thầm.
- **[P0] Thiếu pháp lý vận hành** — không có xóa tài khoản (right-to-erasure GDPR/CCPA), không export dữ liệu, không privacy policy; prompt người dùng được lưu vào `assets`/`request_events`.
- **[P1] Verify JWT là round-trip mạng mỗi request** (`verify_supabase_jwt` gọi `/auth/v1/user`), không verify chữ ký cục bộ, không cache → trễ + phụ thuộc uptime Supabase Auth.
- **[P2] Không có migration discipline/backup** — một file `migrations.sql` "V9" dán tay vào SQL editor; README hướng dẫn "Run without RLS" (rủi ro).

### 4.5 Frontend State & Generation Pipeline

- **[P1] `refineImage` là "zombie poll"** (`generation.ts`) — không cap retry, không guard `active[rfId]`, nên `cancelGeneration`/xóa node không dừng được; tự hồi sinh mỗi lần `getRequest` resolve → leak timer.
- **[P1] `pipeline.ts` poll vô hạn khi lỗi** — catch chỉ `console.warn` rồi reschedule mãi.
- **[P1] Trạng thái lỗi/timeout không được persist** — nhánh `failed/timeout/canceled` chỉ `updateNodeData` + `set({error})`, không `patchNode`; nhánh `done` chỉ persist khi có media. → Node lỗi quay về trạng thái cũ sau reload (trông như chưa từng chạy).
- **[P1] Ánh xạ UUID→số 48-bit dễ va chạm** (`client.ts::uuidToNumericId` lấy 12 hex đầu) — board/node/edge/request dùng chung một không gian số; va chạm → rebind im lặng sang sai thực thể (poll sai request, patch sai node). `resolveToUuid` khi miss lại gửi nguyên số như UUID → 404 sau khi mất localStorage.
- **[P1] `refreshBoardState` full-replace mỗi 1.5s trong pipeline run** — đè kết quả optimistic chưa kịp persist và **xóa toàn bộ undo/redo stack mỗi tick**.
- **[P2] `batchResultListId` chỉ in-memory** — reload/refresh giữa dispatch và done làm mất nơi đổ kết quả video batch.
- **[P2] Catch im lặng tràn lan** — nhiều `patchNode().catch(() => {})` và catch-ignore ở mutation board → phân kỳ in-memory↔server không có tín hiệu.
- **[P3] Ba vòng poll trùng lặp** với ngữ nghĩa retry/cancel khác nhau; hàm khổng lồ (`dispatchGeneration` ~570 dòng, `runNodeDirect` ~440, `api()` ~370); `console.log` còn sót (1232, 1983).

### 4.6 Canvas / UX

- **[P1] Image/Video generator không render error state** — generation set `status:"error"` + message nhưng card bỏ qua; người dùng chỉ thấy banner toàn cục, rồi bấm lại mù.
- **[P1] Progress giả** — mọi `simulatedProgress` là timer ngẫu nhiên cap 98%, không phải tiến trình thật → đánh mất niềm tin ở job video dài.
- **[P1] Thiếu phím tắt nền tảng** — không có Ctrl+Z/Ctrl+Y (undo chỉ qua toolbar), không có copy/paste node.
- **[P2] Control "chết" vẫn hiển thị** — Variant Resolution hard-disabled, 4/6 mode Variant, gear Settings của Image (no-op), badge "Soon" của Add-Reference dù đã chạy, handle Video không consumer.
- **[P2] Hiệu năng** — node gọi `getState().nodes`/`useEdges()` trong render (phá memo), nhiều `setInterval` progress chạy đồng thời, snapshot full-board mỗi 260ms; không virtualization.
- **[P2] Không hỗ trợ mobile/touch**; theming/brand lệch (Flowboard vs Concepta; 2 palette màu).
- **[P2] Mô hình kết nối thiếu** — không phát hiện chu trình (A→B→A), fan-in nhiều nguồn bị cắt im lặng (chỉ lấy `.find()` đầu tiên).
- **[P3] Trùng lặp lớn** — 4 bản resize-handle, 2 bản FluidGradient, `flowAspectToCss` lặp lại; file quá lớn.

---

## 5. Top rủi ro xuyên suốt (xếp hạng)

1. **[P0] Quyết định phạm vi thương mại chưa rõ** (Local desktop vs Cloud SaaS) — chặn mọi hạng mục khác.
2. **[P0] Secrets bị lộ/commit + default yếu** — rò rỉ data-plane.
3. **[P0] `service_role` bypass RLS** — một query thiếu filter là rò rỉ chéo tenant.
4. **[P0] Không có billing/entitlement** — không có cơ chế doanh thu/paywall phòng thủ được.
5. **[P0] Thiếu pháp lý** (xóa tài khoản, export, privacy) — chặn ra mắt EU/CA.
6. **[P1] Pipeline thiếu retry/persist lỗi + zombie poll + clobber optimistic** — kết quả/độ tin cậy không ổn định.
7. **[P1] Ánh xạ ID 48-bit + fallback sai** — hỏng dữ liệu im lặng.
8. **[P1] Automation Flow mong manh** (không retry 429/5xx, token hết hạn, phụ thuộc API riêng tư).
9. **[P1] Không scale ngang** (SQLite + worker đơn + state in-memory).
10. **[P1] UX chưa đạt chuẩn** (thiếu error state, progress giả, thiếu phím tắt).

---

## 6. Lộ trình nâng cấp có ưu tiên

> Mỗi hạng mục ghi **Effort (S/M/L)** và **Impact (Cao/TB/Thấp)**. Các Phase được sắp theo thứ tự phụ thuộc: Phase 0 phải xong trước; Phase 1–2 có thể chạy song song một phần.

### Phase 0 — Quyết định & Vá an toàn khẩn (1–2 tuần)

> Cập nhật 2026-06-01: phần code đã triển khai (xem ADR-0001). Trạng thái: ✅ xong (code) · ⚠️ cần bạn thao tác thủ công bên ngoài.

| # | Hạng mục | Effort | Impact | Trạng thái |
|---|----------|--------|--------|-----------|
| 0.1 | **Chốt phạm vi thương mại** → Cloud-first SaaS, tối ưu 0đ, kích cầu gói tháng + local; **khai tử Local Agent** (xem `ADR-0001`) | M | Cao | ✅ Đã quyết (ADR-0001) |
| 0.2 | **Gỡ secrets khỏi code**: `config.py` không còn default cứng cho `SUPABASE_URL`/keys; thêm `agent/.env.example`; secrets nạp env-only | S | Cao | ✅ Code xong · ⚠️ Cần **rotate key thật** trên dashboard Supabase/Cloudflare (xem mục dưới) |
| 0.3 | Fail-startup khi `FLOWBOARD_ENV=prod` mà secret/cron-token thiếu hoặc còn placeholder; Google Flow key chuyển sang `FLOW_API_KEY` env-overridable | S | Cao | ✅ Xong |
| 0.4 | Thay CORS `*`+credentials bằng allowlist (`FLOWBOARD_CORS_ORIGINS`) | M | Cao | ✅ Xong (phần API cục bộ; auth bearer per-install dời sang Phase 2) |
| 0.5 | Gỡ endpoint debug `/api/media/_debug/assets` và dead code `services/events.py::BoardBus` | S | TB | ✅ Xong |

**⚠️ Việc cần bạn tự làm (ngoài phạm vi sửa code):**
- **Rotate** Supabase `service_role` key, R2 access key/secret trên dashboard tương ứng (key cũ đã từng nằm plaintext trong `agent/.env.staging` trên đĩa — coi như đã lộ). Sau khi rotate, cập nhật giá trị mới vào `.env.staging` (local) hoặc secret manager (prod).
- Đặt `FLOWBOARD_ENV=prod` + các secret thật ở môi trường hosted; đặt `CONTROL_PLANE_CRON_TOKEN` thành chuỗi ngẫu nhiên dài; đặt `FLOWBOARD_CORS_ORIGINS` thành origin frontend thật.
- Lưu ý: `agent/.env.staging` chưa từng bị commit (đã kiểm tra git history) nên **không cần scrub git history**.

> **Hạng mục kiến trúc mới (từ ADR-0001, đưa vào Phase riêng):** Tách Control Plane (`routes/control_plane.py` + `services/control_plane.py`) khỏi Local Agent rồi **retire Local Agent**. KHÔNG xóa thẳng vì đường cloud còn phụ thuộc Control Plane.
>
> **Cập nhật 2026-06-01 (xem `ADR-0002`):** Control Plane **đã tách sẵn** thành Cloudflare Worker `cloudflare/control-plane-worker/` (deploy `api.flowboard.bond`); web frontend + extension cloud-worker đã trỏ vào đó. Đã sửa: (1) bug chặn compile Worker (`extension.ts` claim hydration `id: eq.,`) — trước đó Worker không deploy được; (2) bù parity cron recover-stale (`scheduled()` + `[triggers]`). Còn lại: trỏ Tauri build về Worker, xác nhận `create_or_reset_request`, gỡ router control-plane khỏi FastAPI, deploy Worker.

### Phase 1 — Nền tảng tin cậy & dữ liệu (2–4 tuần)

> Cập nhật 2026-06-01: đang triển khai theo batch nhỏ, mỗi batch verify (tsc + vitest) và commit riêng.

| # | Hạng mục | Effort | Impact | Trạng thái |
|---|----------|--------|--------|-----------|
| 1.1 | **Hợp nhất 3 vòng poll** thành một `pollRequest()` cancellable, có retry cap + terminal switch dùng chung (sửa zombie `refineImage` + ngữ nghĩa canceled/timeout) | M | Cao | ✅ Xong (Batch C, `f0d2bd8`) — refineImage + dispatchEditDerived dùng `pollRequest`; dispatchGeneration giữ loop riêng có chủ đích |
| 1.2 | **Persist trạng thái lỗi/timeout** qua `patchNode`; bọc `updateNodeData` critical bằng `commitNodeData` (set + patch + surface lỗi) | M | Cao | ✅ Xong (Batch B, `276a812`) |
| 1.3 | **Sửa ánh xạ ID** — dùng ID server-authoritative hoặc full-width; `resolveToUuid` *throw* khi miss; thêm phát hiện va chạm; unit test adapter | M | Cao | ✅ Xong (Batch C, `8c19f1c`) |
| 1.4 | Hàng đợi bền vững: re-enqueue row `queued` khi boot; reaper job `running` quá hạn; retry có backoff cho lỗi tạm thời | M | Cao |
| 1.4 | Hàng đợi bền vững: re-enqueue row `queued` khi boot; reaper job `running` quá hạn; retry có backoff cho lỗi tạm thời | M | Cao | ⬜ Chưa (Batch D) |
| 1.5 | `refreshBoardState` **merge thay vì full-replace**; giữ undo stack; pipeline chỉ refresh delta trạng thái | M | Cao | ✅ Xong (`d4fe684`) — bảo toàn node đang poll + giữ undo history; có test |
| 1.6 | Thêm `boto3`/`botocore` vào manifest + chạy presign qua threadpool | S | Cao | ✅ Xong (Batch A, `40de013`) — dep đã thêm; presign là crypto cục bộ (không cần threadpool), đã cache client |
| 1.7 | Đưa **Alembic/Supabase CLI migrations** + version table; thêm CHECK/enum cho status/type; đồng bộ vocabulary node-type giữa `routes/nodes.py` và `pipeline_executor` | M | Cao | ⬜ Chưa (Batch D) |
| 1.8 | Persist `batchResultListId`; thêm retry cap + surface lỗi cho `pipeline.ts` | S | TB | ✅ Xong (Batch A+B) |

### Phase 2 — Multi-tenant, Billing & Pháp lý (chỉ nếu chọn Cloud SaaS) (4–8 tuần)

| # | Hạng mục | Effort | Impact |
|---|----------|--------|--------|
| 2.1 | Verify Supabase JWT cục bộ (chữ ký theo JWKS) + cache; bỏ round-trip `/auth/v1/user` mỗi request | S | Cao |
| 2.2 | **Audit mọi query `service_role`** bắt buộc có predicate `user_id`; thêm wrapper inject/assert filter | M | Cao |
| 2.3 | Gỡ/siết `_claim_next_request_fallback` (bắt buộc pairing + concurrency, hoặc fail cứng khi thiếu RPC) | S | Cao |
| 2.4 | **Triển khai billing/entitlement thật** (Stripe + bảng `subscriptions`) nếu có tính năng trả phí | L | Cao |
| 2.5 | Quota lưu trữ (tổng `byte_size`/user, enforce ở `sign-upload`) + R2 lifecycle/GC theo `retention_state` | M | Cao |
| 2.6 | **Xóa tài khoản** (cascade + purge R2) + export dữ liệu; publish privacy policy; định nghĩa retention prompt | M | Cao |
| 2.7 | Backup/restore + sửa hướng dẫn "Run without RLS"; rate limiting cho endpoint control-plane công khai | M | TB |

### Phase 3 — Độ bền Automation Flow (2–4 tuần)

| # | Hạng mục | Effort | Impact |
|---|----------|--------|--------|
| 3.1 | Thêm **retry/backoff tôn trọng `Retry-After`** cho Flow 429/5xx ở cả extension và worker | M | Cao |
| 3.2 | Tự phục hồi token hết hạn giữa job (re-capture + resume) | M | Cao |
| 3.3 | Tách lớp adapter Flow API riêng + version/feature-flag cho enum model-key; parser có schema rõ ràng thay heuristic | M | TB |
| 3.4 | Telemetry lỗi automation (mã lỗi theo stage, đếm, lý do); xóa bản extension cũ `data_temple/...` | S | TB |
| 3.5 | CI chạy được smoke ở chế độ mock + hợp đồng (contract) cho parser response | M | TB |

### Phase 4 — UX & Chất lượng Canvas (3–5 tuần)

| # | Hạng mục | Effort | Impact |
|---|----------|--------|--------|
| 4.1 | **Error overlay inline** cho Image/Video/Text generator (dùng `shared/ErrorOverlay.tsx` đã có) | S | Cao |
| 4.2 | **Progress thật** (poll trạng thái/percent từ store; fallback spinner indeterminate) | M | Cao |
| 4.3 | **Lớp phím tắt canvas**: Ctrl+Z/Ctrl+Shift+Z, Ctrl+C/V/D, arrow-nudge | M | Cao |
| 4.4 | Ẩn/kích hoạt control "chết" (Variant modes/Resolution, gear Image, badge Add-Reference, handle Video thừa) | S | TB |
| 4.5 | Sanitize HTML của Note (DOMPurify) + kế hoạch rời `document.execCommand` | M | TB |
| 4.6 | Hardening kết nối: phát hiện chu trình, định nghĩa fan-in, surface "nhiều nguồn" thay vì cắt im lặng | M | TB |
| 4.7 | Pass hiệu năng: memo selector thay `getState().nodes`, gom timer progress, throttle snapshot | M | TB |
| 4.8 | Thống nhất theming/brand (Flowboard vs Concepta; 1 palette dùng chung) | M | TB |

### Phase 5 — Nợ kỹ thuật & Khả năng bảo trì (liên tục)

| # | Hạng mục | Effort | Impact |
|---|----------|--------|--------|
| 5.1 | Trích 1 `DualResizeHandle`/corner-resize và 1 `FluidGradientOverlay` dùng chung (xóa bản trùng) | M | TB |
| 5.2 | Tách `dispatchGeneration`/`runNodeDirect`/`api()` thành builder theo kind + routing table | L | TB |
| 5.3 | Tách file lớn backend (`processor.py`, `prompt_synth.py`, `flow_sdk.py`) theo handler | M | Thấp |
| 5.4 | Trích magic-number vào module `constants`; bật eslint `no-console` cho `src/canvas`; gỡ `console.log` sót | S | Thấp |
| 5.5 | Logging có cấu trúc (JSON) + request-id + `/metrics` (Prometheus) + tracing (OpenTelemetry) + readiness probe | M | TB |
| 5.6 | Mở rộng test: per-node interaction, connection-validation, undo/redo, cancel/delete-mid-poll, error persistence, id-adapter | L | TB |

---

## 7. Quick wins (đạt giá trị cao, công sức thấp — nên làm ngay)

- **0.2/0.3** Xoay vòng secrets + gỡ default cứng. *(S · Cao)*
- **4.1** Error overlay inline cho Image/Video (component đã có sẵn). *(S · Cao)*
- **1.6** Thêm `boto3` vào manifest. *(S · Cao)*
- **4.4** Ẩn control "chết". *(S · TB)*
- **0.5** Gỡ endpoint debug + dead code. *(S · TB)*
- **5.4 / Phase1** Gỡ 3 `console.log` còn sót trong hot path. *(S · Thấp)*
- **1.8** Persist `batchResultListId`. *(S · TB)*

---

## 8. Khuyến nghị về thứ tự thực thi

1. **Làm Phase 0 trước tiên** — không có quyết định phạm vi và vá secrets thì mọi việc khác đều rủi ro hoặc lãng phí.
2. **Phase 1 song song với Phase 4.1–4.4** — nền tảng tin cậy backend/store có thể tiến hành cùng các quick-win UX, vì chúng ít đụng nhau về file.
3. **Phase 2 chỉ khởi động nếu chọn Cloud SaaS** ở 0.1; nếu chọn "Local desktop pro", phần lớn Phase 2 chuyển thành "không áp dụng" và trọng tâm dồn về Phase 3/4.
4. **Phase 3** nên đi cùng Phase 1 vì độ bền automation là điều kiện cần để pipeline tin cậy có ý nghĩa.
5. **Phase 5** chạy nền liên tục, ưu tiên 5.6 (test) để khóa các sửa lỗi Phase 1.

---

## Phụ lục A — Tham chiếu file chính

- Frontend store/pipeline: `frontend/src/store/generation.ts` (2674 dòng), `board.ts` (2001), `api/client.ts` (1626), `store/pipeline.ts`.
- Canvas/node: `frontend/src/canvas/Board.tsx`, `canvas/AddNodePalette.tsx`, `canvas/v2/*`, `components/ResultViewer*.tsx`, `shared/ErrorOverlay.tsx`.
- Backend: `agent/flowboard/main.py`, `config.py`, `worker/processor.py`, `routes/*`, `services/{flow_client,flow_sdk,control_plane,media,events}.py`, `db/{models,session}.py`.
- Extension/automation: `extension/{background.js,flow_api.js,manifest.json,rules.json,popup.js,asset_utils.js}`, `agent/flowboard/extension_worker/*`.
- Cloud/data: `data_temple/{migrations.sql,README_DB_BASELINE.md,smoke_tests.sql,supabase-dung-luong.txt}`, `frontend/src/cloud/{supabase.ts,CloudPortal.tsx}`, `components/{AccountPanel,AuthGateModal,ForcedSetupGate}.tsx`.

## Phụ lục B — Phương pháp & giới hạn

- Phát hiện dựa trên **đọc mã tĩnh**; không chạy ứng dụng hay test trong đợt rà soát này. Các nhận định về độ tin cậy/khả năng mở rộng suy ra từ đường mã được dẫn chiếu.
- Bỏ qua thư mục `flowboard-merge-lab/` (bản sao cũ).
- Tài liệu này là đầu vào lập kế hoạch; chưa phải spec triển khai. Khi chọn hạng mục để làm, nên chuyển thành spec (requirements/design/tasks) riêng.
