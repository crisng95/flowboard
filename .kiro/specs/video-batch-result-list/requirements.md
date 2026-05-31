# Requirements Document

## Introduction

Tính năng này thay đổi cách hiển thị kết quả khi sinh video theo lô (batch) trên Flowboard.

Hiện tại, khi người dùng nối một danh sách prompt và một danh sách ảnh vào Video Node rồi chọn hệ số nhân xN, Video Node hiển thị toàn bộ N video trong một lưới (grid) ngay trên thẻ node (`showVariantGrid = mediaIds.length > 1` trong `VideoGeneratorNode.tsx`). Người dùng muốn hành vi này giống Image Node hơn: Video Node chỉ hiển thị video đầu tiên, còn toàn bộ N video được gom vào một List Node riêng để dễ duyệt và chọn.

Quyết định thiết kế đã được chốt với người dùng:

- List Node được tạo NGAY tại thời điểm người dùng bấm Generate (không phải lúc nối edge, cũng không phải sau khi render xong). Tại thời điểm bấm Generate, số lượng video N đã được biết chính xác (`finalPrompts.length` trong nhánh video của `runNodeDirect`), cùng với `batchMode` (zip/cross) và lựa chọn (selection).
- Chỉ tạo List Node khi thực sự là lô (N > 1). Nếu chỉ có 1 video (N = 1), giữ nguyên hành vi cũ: hiển thị 1 video trên Video Node và không tạo List Node.
- Sau khi tạo, hệ thống tự động nối một edge từ handle output `source-video` của Video Node tới handle input `target-video` của List Node mới, và đặt List Node cạnh Video Node.
- Khi từng video render xong, kết quả được đổ vào đúng ô (giữ đúng thứ tự) trong List Node, căn chỉnh prompt[i] ↔ video[i], kể cả khi có ô bị lỗi (null trong `media_ids` / `slot_errors`).
- List Node hiện render item video bằng thẻ `<img>` tĩnh (chỉ thumbnail + icon video), chưa play được. Phạm vi tính năng bao gồm nâng cấp List Node để hiển thị/phát được video item đúng cách.
- Tính năng phải hoạt động với cả hai model video: Veo và Omni Flash; và không được gây hồi quy (regress) với luồng single-video, luồng image, hay các edge/handle hiện có.

Phạm vi tài liệu này giới hạn ở hành vi tạo và đổ kết quả vào List Node cho batch video, cùng việc nâng cấp hiển thị video trong List Node. Tài liệu này không xử lý logic fan-out batch của Omni Flash (đã thuộc spec `video-batch-omni-fanout`).

## Glossary

- **Video_Node**: Node sinh video trên canvas v2 (`VideoGeneratorNode.tsx`), có các handle output gồm `source-video` (label "Generated Video").
- **List_Node**: Node danh sách trên canvas v2 (`ListNode.tsx`) chứa các item dạng image/video/text, có handle input `target-video`.
- **Batch_Result_List**: List Node được tự động tạo để chứa toàn bộ kết quả của một lần sinh video theo lô.
- **N**: Số lượng video của một lần sinh theo lô, bằng `finalPrompts.length` được tính trong nhánh video của `runNodeDirect` tại thời điểm bấm Generate.
- **Batch_Mode**: Chế độ ghép cặp prompt và ảnh khi sinh lô, nhận giá trị `zip` hoặc `cross` (`buildVideoBatchPairs`).
- **Generate_Action**: Hành động người dùng bấm nút Generate trên Video Node (gọi `runNodeGraph` → `runNodeDirect`).
- **Slot**: Một ô kết quả trong List Node, ứng với một vị trí positional trong mảng kết quả `media_ids` / `media_urls`.
- **Slot_Errors**: Mảng positional `slot_errors` do worker trả về, mỗi phần tử mô tả lỗi của Slot tương ứng (hoặc null khi không lỗi).
- **List_Item**: Một phần tử trong `listItems` của List Node, có hình dạng `{ id, kind, title, text, mediaId, flowMediaId, mediaUrl, imageUrl, mime, width, height, duration }`.
- **Source_Video_Handle**: Handle output `source-video` trên Video Node.
- **Target_Video_Handle**: Handle input `target-video` trên List Node.
- **Video_Model**: Model dùng để sinh video, nhận giá trị `veo` hoặc `omni_flash`.

## Requirements

### Requirement 1: Video Node chỉ hiển thị video đầu tiên khi sinh theo lô

**User Story:** Là người dùng sinh nhiều video theo lô, tôi muốn Video Node chỉ hiển thị video đầu tiên thay vì lưới tất cả video, để thẻ node gọn gàng và đồng nhất với Image Node.

#### Acceptance Criteria

1. WHILE một lần sinh theo lô có N lớn hơn 1, THE Video_Node SHALL hiển thị duy nhất video đầu tiên trong số N video.
2. WHILE một lần sinh theo lô có N lớn hơn 1, THE Video_Node SHALL không hiển thị lưới (grid) chứa nhiều video.
3. THE Video_Node SHALL lưu đầy đủ N kết quả trong `mediaIds` của node để các consumer khác và List Node có thể truy cập.
4. WHEN người dùng tương tác phát video đầu tiên trên Video_Node, THE Video_Node SHALL phát video đầu tiên theo hành vi preview hiện có (hover hoặc selected).
5. WHILE một lần sinh theo lô có N lớn hơn 1, THE Video_Node SHALL hiển thị video đầu tiên bằng bố cục single-video chuyên biệt, không phải bằng một lưới (grid) thu nhỏ xuống một phần tử.

### Requirement 2: Tự động tạo Batch Result List khi bấm Generate ở chế độ lô

**User Story:** Là người dùng, tôi muốn một List Node được tạo tự động ngay khi tôi bấm Generate ở chế độ lô, để toàn bộ video kết quả được gom về một nơi mà không cần tôi thao tác thủ công.

#### Acceptance Criteria

1. WHEN người dùng thực hiện Generate_Action trên Video_Node và N lớn hơn 1, THE Video_Node SHALL tạo một Batch_Result_List mới tại thời điểm bấm Generate.
2. WHEN Batch_Result_List được tạo, THE Video_Node SHALL khởi tạo List Node với đúng N ô placeholder giữ thứ tự ứng với N video sẽ sinh.
3. WHEN Batch_Result_List được tạo, THE Video_Node SHALL đặt Batch_Result_List ở vị trí cạnh Video_Node trên canvas.
4. WHEN Batch_Result_List được tạo, THE Video_Node SHALL tạo một edge nối từ Source_Video_Handle của Video_Node tới Target_Video_Handle của Batch_Result_List.
5. WHEN Batch_Result_List và edge được tạo, THE Video_Node SHALL lưu (persist) node và edge mới qua API để chúng tồn tại sau khi tải lại trang.
6. THE Batch_Result_List SHALL được tạo trước khi N video render xong, để các ô placeholder hiển thị trạng thái đang chờ kết quả.
7. IF việc tạo Batch_Result_List thất bại, THEN THE Video_Node SHALL hiển thị lỗi tường minh cho người dùng thay vì âm thầm bỏ qua.
8. IF việc tạo Batch_Result_List thất bại, THEN THE Video_Node SHALL ngăn lần sinh lô tiếp tục để tránh sinh kết quả không có nơi chứa.

### Requirement 3: Đổ kết quả video vào đúng ô theo thứ tự

**User Story:** Là người dùng, tôi muốn từng video render xong rơi vào đúng ô trong List Node theo thứ tự prompt, để tôi đối chiếu được prompt[i] với video[i].

#### Acceptance Criteria

1. WHEN video tại vị trí i render xong, THE Batch_Result_List SHALL đổ video đó vào Slot tại vị trí i, giữ nguyên thứ tự positional theo `media_ids`.
2. THE Batch_Result_List SHALL căn chỉnh sao cho Slot tại vị trí i tương ứng với prompt tại vị trí i của lần sinh theo lô.
3. IF phần tử tại vị trí i trong `media_ids` là null hoặc có lỗi trong Slot_Errors, THEN THE Batch_Result_List SHALL giữ vị trí i là một Slot lỗi và không dịch chuyển các Slot còn lại.
4. WHEN một Slot ứng với phần tử lỗi, THE Batch_Result_List SHALL hiển thị chỉ báo lỗi cho Slot đó dựa trên Slot_Errors tương ứng.
5. WHEN toàn bộ N video đã render xong, THE Batch_Result_List SHALL chứa đúng N List_Item theo thứ tự, trong đó mỗi List_Item thành công có `kind` bằng `video` và mang `mediaId` của video tương ứng.
6. WHEN toàn bộ N video đã render xong, THE Batch_Result_List SHALL hiển thị đầy đủ N List_Item kết quả cho người dùng truy cập, kể cả khi việc phân loại (categorization) một hoặc nhiều item gặp vấn đề.
7. IF việc phân loại một hoặc nhiều List_Item gặp lỗi, THEN THE Batch_Result_List SHALL vẫn hiển thị các item kết quả và SHALL không để danh sách rỗng.

### Requirement 4: Giữ nguyên hành vi khi không sinh theo lô

**User Story:** Là người dùng sinh một video đơn lẻ, tôi muốn hành vi cũ được giữ nguyên, để các luồng không phải lô không bị thay đổi ngoài ý muốn.

#### Acceptance Criteria

1. WHEN người dùng thực hiện Generate_Action và N bằng 1, THE Video_Node SHALL hiển thị video kết quả duy nhất trên thẻ node theo hành vi hiện có.
2. WHEN người dùng thực hiện Generate_Action và N bằng 1, THE Video_Node SHALL không tạo Batch_Result_List.
3. WHEN người dùng thực hiện Generate_Action và N bằng 1, THE Video_Node SHALL không tạo edge nối từ Source_Video_Handle tới một List Node mới.

### Requirement 5: List Node hiển thị và phát được video item

**User Story:** Là người dùng duyệt danh sách video trong List Node, tôi muốn xem và phát được từng video thay vì chỉ thấy thumbnail tĩnh, để đánh giá nội dung mà không cần mở viewer mỗi lần.

#### Acceptance Criteria

1. WHERE một List_Item có `kind` bằng `video`, THE List_Node SHALL render item đó bằng phần tử video có khả năng phát thay vì chỉ một ảnh tĩnh.
2. WHERE một List_Item có `kind` bằng `video`, THE List_Node SHALL hiển thị một poster hoặc khung hình đại diện trước khi video bắt đầu phát.
3. WHEN người dùng đưa con trỏ vào một video item (hover), THE List_Node SHALL bắt đầu phát video item đó.
4. WHEN con trỏ rời khỏi một video item đang phát, THE List_Node SHALL dừng phát và đưa video item đó về trạng thái poster.
5. IF con trỏ rời khỏi một video item không ở trạng thái đang phát, THEN THE List_Node SHALL giữ nguyên trạng thái hiện tại của video item đó và không thực hiện hành động dừng phát hay đặt lại poster.
6. THE List_Node SHALL giữ một chỉ báo trực quan (icon video) trên mỗi video item để phân biệt với image item.
7. WHEN người dùng double-click một video item, THE List_Node SHALL mở result viewer cho item đó theo hành vi hiện có.

### Requirement 6: Hành vi khi sinh lại nhiều lần

**User Story:** Là người dùng bấm Generate nhiều lần trên cùng một Video Node, tôi muốn kết quả các lần sinh được quản lý rõ ràng, để không bị lẫn lộn giữa các lô.

#### Acceptance Criteria

1. WHEN người dùng thực hiện Generate_Action ở chế độ lô và Video_Node đã có một Batch_Result_List được nối qua Source_Video_Handle từ lần trước, THE Video_Node SHALL tái sử dụng Batch_Result_List hiện có thay vì tạo node mới.
2. WHEN tái sử dụng Batch_Result_List hiện có cho một lần sinh lô mới, THE Video_Node SHALL xóa toàn bộ List_Item cũ trước, rồi thay thế bằng đúng N ô placeholder mới ứng với lần sinh hiện tại.
3. IF Video_Node chưa có Batch_Result_List nào được nối qua Source_Video_Handle, THEN THE Video_Node SHALL tạo một Batch_Result_List mới theo Requirement 2.

### Requirement 7: Tương thích cả hai model Veo và Omni Flash

**User Story:** Là người dùng, tôi muốn hành vi gom video vào List Node hoạt động bất kể tôi chọn Veo hay Omni Flash, để trải nghiệm nhất quán giữa các model.

#### Acceptance Criteria

1. WHERE Video_Model là `veo` và N lớn hơn 1, THE Video_Node SHALL tạo Batch_Result_List và đổ kết quả theo Requirement 2 và Requirement 3.
2. WHERE Video_Model là `omni_flash` và N lớn hơn 1, THE Video_Node SHALL tạo Batch_Result_List và đổ kết quả theo Requirement 2 và Requirement 3.
3. THE Batch_Result_List SHALL nhận kết quả theo cùng một giao kèo positional `media_ids` / `slot_errors` cho cả hai Video_Model.

### Requirement 8: Không gây hồi quy cho các luồng hiện có

**User Story:** Là người dùng đang sử dụng các luồng hiện có, tôi muốn tính năng mới không phá vỡ luồng image, luồng single-video, hay các kết nối edge hiện có, để công việc đang làm không bị ảnh hưởng.

#### Acceptance Criteria

1. WHEN người dùng sinh ảnh theo lô, THE Image generation flow SHALL giữ nguyên hành vi spawn node `add_reference` hiện có và không bị ảnh hưởng bởi logic tạo Batch_Result_List của video.
2. THE Video_Node SHALL giữ nguyên toàn bộ các handle hiện có gồm `source-video`, `source-start-image`, `source-end-image`, `source-audio`, `target-text`, `target-start-image`, và `target-end-image`.
3. WHEN một List Node được nối thủ công vào Video_Node qua Source_Video_Handle, THE List_Node SHALL tiếp tục lọc và nhận item có `kind` bằng `video` theo logic intake hiện có.
4. WHEN một List Node được nối thủ công vào Video_Node qua Source_Video_Handle và kiểu kết nối là video, THE List_Node SHALL nhận tất cả video item của kết nối đó và SHALL không từ chối video item vì các điều kiện validation khác khi kết nối và kiểu item đã đúng.
5. IF việc lọc (filter intake) cho một kết nối qua Source_Video_Handle sẽ không hoạt động, THEN THE Video_Node SHALL ngăn việc thiết lập kết nối đó để tránh tạo kết nối không nhận được item.
6. WHEN người dùng tải lại trang sau khi tạo Batch_Result_List, THE canvas SHALL khôi phục đúng Video_Node, Batch_Result_List, edge nối giữa chúng, và các List_Item đã có.
