# ADR-0002 — Tách Control Plane khỏi Local Agent

- Trạng thái: **Đang thực hiện** (2026-06-01)
- Liên quan: `ADR-0001` (cloud-first, khai tử Local Agent), `docs/AUDIT_VA_ROADMAP.md`

## Bối cảnh

Khi rà soát để tách Control Plane khỏi FastAPI Local Agent, phát hiện Control Plane **đã được tách sẵn** thành một Cloudflare Worker riêng:

- `cloudflare/control-plane-worker/` — Hono + zod + aws4fetch, deploy lên domain `api.flowboard.bond` (`wrangler.toml`).
- Worker phủ: health, assets (sign-read/sign-upload/upload qua R2 binding), beta, canvas (boards/nodes/edges/requests CRUD), pairing (register/rotate), extension (claim/heartbeat/progress/project/sign-upload/confirm-upload/complete/fail).
- **Web frontend** (`cloudApiBaseUrl` mặc định `https://api.flowboard.bond`) và **extension cloud-worker mode** đã trỏ vào Worker → phần này coi như đã tách.

Phụ thuộc FastAPI control-plane còn sót lại chỉ ở: (a) Tauri desktop build (`api/client.ts` gọi `127.0.0.1:8101`), (b) extension `local-bridge` mode (dev), (c) Worker thiếu cron recover-stale, (d) ngữ nghĩa `create_or_reset_request` (Worker `POST /api/requests` chỉ INSERT, không reset job lỗi).

## Quyết định

Worker là Control Plane chính thức (production). FastAPI control-plane sẽ bị gỡ sau khi không còn traffic.

## Đã làm (commit trong nhánh này)

1. **Sửa bug chặn compile của Worker** (`extension.ts` claim hydration `id: eq.,` → `id: eq.${requestId}`). Trước đó Worker **không compile/deploy được** (TS1003) — blocker P0 cho hướng cloud-first.
2. **Bù parity cron recover-stale**: thêm `scheduled()` handler + `[triggers] crons = ["*/2 * * * *"]` trong `wrangler.toml`, gọi RPC `recover_stale_requests` bằng service-role. Thay cho `POST /api/cron/recover-stale` của FastAPI.

## Việc còn lại (chưa làm — cần phối hợp deploy/quyết định)

3. **Xác nhận ngữ nghĩa `create_or_reset_request`**: hoặc thêm route Worker gọi RPC này, hoặc xác nhận `POST /api/requests` (INSERT thẳng) là đủ và bỏ ngữ nghĩa reset job lỗi/hủy. → cần quyết định sản phẩm.
4. **Trỏ Tauri desktop build về Worker**: `api/client.ts` hiện gọi `127.0.0.1:8101` khi chạy Tauri. Phải đổi nhánh này (hoặc bỏ build Tauri theo ADR-0001 cloud-first). → bước lớn nhất.
5. **Chuyển extension khỏi local-bridge**: đảm bảo người dùng dùng cloud-worker mode (URL `api.flowboard.bond`).
6. **Gỡ router control-plane khỏi FastAPI** (sau khi traffic = 0): xoá `app.include_router(control_plane.router)` + import ở `main.py:12`; xoá `routes/control_plane.py`, `services/control_plane.py`, tests liên quan. Giữ lại `routes/media.py`, `routes/upload.py`, `services/media.py`, worker/processor, extension_worker, WS server, `/api/ext/callback` (không phụ thuộc control_plane_service).
7. **Deploy Worker**: `wrangler deploy` + set secrets (`wrangler secret put SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY`). Sau khi rotate key ở ADR-0001, dùng giá trị mới.

## Lưu ý kỹ thuật

- Worker ký R2 bằng `aws4fetch` (presign) + R2 binding `ASSETS_BUCKET` cho `.put()`/`.head()` (verify upload) — chặt hơn FastAPI (chỉ boto3 presign, không verify). Đây là lý do nên hợp nhất về Worker.
- Worker `/api/extension/claim` re-read request row sau claim để lấy đủ `input_data` — giờ đã đúng sau fix bug.
- Cron mỗi 2 phút nằm trong hạn mức free-tier Cloudflare (Cron Triggers miễn phí); cân nhắc giãn ra nếu cần.
