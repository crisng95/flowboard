# ADR-0003 — Gỡ bỏ Tauri desktop build

- **Trạng thái**: Accepted (2026-06-01)
- **Liên quan**: ADR-0001 (cloud-first, retire local Python agent), ADR-0002 (tách Control Plane sang Cloudflare Worker)

## Bối cảnh

ADR-0002 (mục #4) đã **cố tình hoãn** quyết định số phận bản Tauri desktop tới
"giai đoạn khai tử agent". Giai đoạn đó là bây giờ.

Một cuộc điều tra kỹ (context-gatherer, 2026-06-01) cho ra phát hiện then chốt
làm thay đổi bản chất quyết định:

> **Tauri KHÔNG bọc Python agent.** `frontend/src-tauri/` là một bản
> **re-implement hoàn chỉnh bằng Rust** của chính local agent: SQLite riêng,
> HTTP server `127.0.0.1:8101` riêng, WS `127.0.0.1:9223` riêng (nói chuyện với
> Chrome extension), và một request worker gọi thẳng Google Flow
> (`aisandbox-pa.googleapis.com`). Không có sidecar/externalBin Python nào.

Hệ quả: "retire Python agent" (ADR-0001) **không tự động đụng Tauri** — Tauri là
một **backend thứ hai song song** mirror đúng kiến trúc local-agent đã bị khai tử
ở dạng Python. Giữ Tauri = nuôi backend chết thứ hai.

### Hiện trạng đo được

| Khía cạnh | Thực tế |
|---|---|
| Coupling frontend | **Nông** — 3 file (`api/client.ts`, `store/generation.ts`, `components/ForcedSetupGate.tsx`), 20 lời gọi `invoke()` gói trong 1 file, toàn `if (isTauri)` sạch |
| Tài sản Rust | ~2.700 dòng; **hardcoded Google API key**; **không auth**; không CI; không release pipeline; **không nằm trong `npm run build`** |
| Cloud path | Độc lập hoàn toàn với Tauri; đã là mặc định production (`app.flowboard.bond` → Worker + Supabase + extension cloud-worker) |
| Mất gì khi xoá | Chế độ desktop offline 1-máy: SQLite local + cache media local — đúng năng lực ADR-0001 đang khai tử |

## Quyết định

**Gỡ bỏ hoàn toàn Tauri desktop build.**

Lý do:
- Theo cloud-first (ADR-0001/0002), bản desktop offline là "con đường không chọn".
- Coupling nông khiến việc gỡ **rủi ro thấp, cơ học** (không phải tái cấu trúc).
- Giữ lại = sở hữu backend Rust chết thứ hai có **hardcoded key + không auth**
  (rủi ro bảo mật nếu ai đó build & phát tán), không CI/không release.
- "Biến thành thin client của Worker" khả thi nhưng gần như vô nghĩa — kết quả
  chẳng hơn gì ship web app.

## Đã thực hiện

1. Xoá toàn bộ `frontend/src-tauri/` (Rust backend ~2.700 dòng).
2. `frontend/src/api/client.ts`: gỡ `import { invoke }`; `getBaseUrl()` trả `""`
   luôn; gỡ nhánh `if (isTauri)` trong `api()` (giữ nguyên đường Supabase/cloud +
   guest-mode localDb); `uploadImage()` bỏ nhánh Tauri.
3. `frontend/src/store/generation.ts`: gộp 3 fork `isTauri` về đường browser/cloud
   (`dispatchEditDerived`, `ensureProjectId`, `dispatchGeneration`).
4. Xoá `components/ForcedSetupGate.tsx` (Tauri-only) + gỡ mount trong `App.tsx`.
5. `frontend/package.json`: gỡ `@tauri-apps/api`, `@tauri-apps/cli`.
6. `frontend/vite.config.ts`: gỡ dev proxy trỏ `127.0.0.1:8101` (đã chết).
7. Gỡ `vi.mock("@tauri-apps/api/core")` trong test.

Verify: `npm run lint` (tsc) xanh; `npm test` 47/47 pass; `npm run build` (vite)
thành công.

## Hệ quả / lưu ý

- **Edge case (chấp nhận)**: khi `supabase === null` (chỉ xảy ra ở dev cấu hình
  sai, thiếu `VITE_SUPABASE_URL`/`ANON_KEY`), nhánh paygate-tier gate local cũ đã
  bị gỡ — generation sẽ truyền `paygate_tier: null` thay vì chặn. Trong build
  production cloud-first, env luôn được cấu hình nên `supabase` non-null; đây
  đúng theo mô hình đã chọn.
- Dev proxy đã gỡ: dev build giờ nói chuyện với Worker qua URL tuyệt đối
  (`cloudApiBaseUrl`), `getBaseUrl()` = `""`.
- Không ảnh hưởng sản phẩm live (browser/cloud), `npm run build`, hay CI.
