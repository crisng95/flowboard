# ADR-0001 — Phạm vi thương mại & hướng kiến trúc

- Trạng thái: **Đã chấp nhận** (2026-06-01)
- Liên quan: `docs/AUDIT_VA_ROADMAP.md` (mục 0.1)

## Bối cảnh

Sản phẩm hiện tồn tại hai mặt phẳng dữ liệu gần như tách rời: Local Agent Plane (FastAPI + SQLite, một người dùng/máy, không auth) và Cloud Control Plane (Supabase + R2, multi-tenant, RLS). Cần chốt phạm vi thương mại để định hướng toàn bộ lộ trình.

## Quyết định

1. **Cloud-first cho giai đoạn ra mắt.** Ưu tiên bản Cloud SaaS multi-tenant để quảng bá, cho số đông người dùng trải nghiệm rộng rãi (free trial).
2. **Tối ưu chi phí vận hành ~0đ.** Cloud phải được thiết kế để chạy được trong giới hạn các gói free-tier (Supabase Free: DB 0.5GB, Storage 1GB, Egress 5GB; Cloudflare R2/Workers free) và phục vụ số lượng người test tối đa trong khi vẫn nằm trong hạn mức 0đ.
3. **Kích cầu sang gói thuê bao tháng + bản local.** Sau giai đoạn trải nghiệm, chuyển người dùng sang đăng ký gói tháng và dùng bản local.
4. **Khai tử Local Python Agent.** Agent (`agent/flowboard/*` đường sinh nội dung cục bộ qua WS + SQLite) hiện không còn được sử dụng → sẽ loại bỏ. Lưu ý: các route Control Plane (`routes/control_plane.py`, `services/control_plane.py`) hiện đang nằm trong cùng app agent và **vẫn cần cho đường cloud** — phải tách/di trú trước khi gỡ agent, không xóa thẳng.

## Hệ quả

- **Phase 2 (multi-tenant, billing, pháp lý) trở thành bắt buộc** cho mục tiêu thương mại.
- Thêm một hạng mục kiến trúc mới: **tách Control Plane khỏi Local Agent** rồi **retire Local Agent** (đưa vào Phase riêng, không thuộc Phase 0).
- Mọi thiết kế cloud phải kèm ràng buộc ngân sách 0đ: hạn mức lưu trữ/egress, dọn rác asset, nén/transform phía client, cache hợp lý.
- Billing: cần cổng thanh toán (vd Stripe) + bảng `subscriptions` + mô hình entitlement riêng của Flowboard (độc lập với tier Google Flow).

## Điều CHƯA quyết (cần chốt ở bước sau)

- Cổng thanh toán cụ thể (Stripe vs Lemon Squeezy vs khác) và mô hình giá.
- Ranh giới tính năng giữa free trial và gói tháng.
- Lộ trình và thời điểm chính thức gỡ Local Agent (sau khi Control Plane đã tách độc lập).
