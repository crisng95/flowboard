# SPIKE — Chuyển Gemini sang chạy qua Extension bằng `flow:generateContent`

> Trạng thái: **Khảo sát (spike)** — chưa phải spec. Mục tiêu: xác định tính khả thi
> của việc thay thế `GeminiBrowserDriver` (Playwright/CDP scrape gemini.google.com)
> bằng một lời gọi `flow:generateContent` đi qua **cùng đường ống extension** mà
> Flow đang dùng cho ảnh/video.
>
> Liên quan: ADR-0001 (cloud-first, retire local agent), ADR-0002 (tách Control Plane),
> AUDIT_VA_ROADMAP.md.

---

## 1. Tóm tắt kết luận (TL;DR)

**Khả thi và nên làm.** Endpoint `POST https://aisandbox-pa.googleapis.com/v1/flow:generateContent`
nhận payload kiểu Gemini (`model`, `contents`/`parts` với text + `inlineData` base64,
`systemInstruction`, `thinkingConfig`, `recaptchaContext`) đi qua **đúng cổng
aisandbox-pa, đúng Bearer token `ya29...`, đúng cơ chế reCAPTCHA** mà extension đã
dùng cho `batchGenerateImages` / `batchAsyncGenerateVideo`.

Hệ quả:

- **Không cần** chạm vào `gemini.google.com`, không cần `batchexecute`, không cần
  Playwright/CDP port 9222, không cần scrape DOM.
- Tái sử dụng **gần như 100%** hạ tầng sẵn có: bắt token, giải captcha, vòng lặp
  cloud-worker, sanitize lỗi, retry.
- Chỉ cần thêm **một method `generateContent()`** vào `flow_api.js` và **một
  `task_type` mới** (vd `text_gen`) trong nhánh dispatch cloud-worker.
- Loại bỏ hoàn toàn `GeminiBrowserDriver` + phụ thuộc Playwright — đúng hướng
  cloud-first và retire local agent.

---

## 2. Đường ống Flow hiện tại (cái cần sao chép)

Toàn bộ lời gọi tạo ảnh/video đi theo cùng một khuôn mẫu trong
`extension/flow_api.js` + `extension/background.js`:

1. **Bearer token**: `background.js` lắng nghe `webRequest.onBeforeSendHeaders` trên
   `aisandbox-pa.googleapis.com/*` + `labs.google/*`, bắt header `Authorization: Bearer ya29...`,
   lưu vào `flowKey`. Token tự refresh khi mở tab Flow.

2. **reCAPTCHA**: trước khi gọi API, `solveCaptcha(requestId, action)` gửi message
   `GET_CAPTCHA` vào content-script → `injected.js` (MAIN world) gọi
   `window.grecaptcha.enterprise.execute(siteKey, { action })` → trả token. `injected.js`
   còn **tự quan sát** action mà trang Flow dùng (`OBSERVE_EVENT`) nên siteKey/action
   có thể được phát hiện động.

3. **Chèn token captcha**: trong `handleApiRequest`, token được nhét vào body tại các vị trí:
   - `body.clientContext.recaptchaContext.token`
   - `body.agentClientContext.recaptchaContext.token` (cho Omni)
   - `body.requests[].clientContext.recaptchaContext.token`

4. **Fetch**: `fetch(url, { method, headers: { authorization: Bearer flowKey }, credentials: 'include', body })`.
   `content-type: text/plain;charset=UTF-8`, `origin/referer: labs.google`.

5. **Cloud-worker mode**: `pollCloudWorkerOnce()` → `claim` job từ Control Plane Worker
   → `runCloudFlowJob()` dispatch theo `task_type` (`txt2img` / `edit_image` / `img2vid`
   / `txt2vid_omni`) → gọi method tương ứng của `FlowboardFlowApi` → upload kết quả lên
   R2 → `complete`.

`clientContext` chuẩn (từ `flow_api.js`):

```js
{
  projectId: String(projectId),
  recaptchaContext: { applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB', token: '' },
  sessionId: `;${Date.now()}`,
  tool: 'PINHOLE',
  userPaygateTier: 'PAYGATE_TIER_ONE',
}
```

---

## 3. `flow:generateContent` — hợp đồng quan sát được

Từ payload người dùng dán (fetch thật từ phiên Flow), endpoint nhận cấu trúc kiểu Gemini:

```jsonc
POST https://aisandbox-pa.googleapis.com/v1/flow:generateContent
{
  "model": "gemini-3-flash-preview",
  "contents": [
    { "role": "user",
      "parts": [
        { "text": "..." },
        { "inlineData": { "mimeType": "image/png", "data": "<base64>" } }
      ] }
  ],
  "systemInstruction": { "parts": [{ "text": "..." }] },
  "generationConfig": { "thinkingConfig": { /* ... */ } },
  "clientContext"|"recaptchaContext": { /* token reCAPTCHA */ }
}
```

Điểm mấu chốt:

- Cùng host `aisandbox-pa.googleapis.com`, cùng Bearer `ya29...`, cùng `?key=` (FLOW_API_KEY public).
- Có trường `recaptchaContext` → dùng đúng cơ chế giải captcha hiện có.
- Hỗ trợ **multimodal input** (text + ảnh base64) → đủ cho cả 2 consumer text-gen
  hiện tại của sản phẩm (xem mục 4).

### Vị trí `recaptchaContext` — ĐÃ XÁC NHẬN (từ fetch thật)

Body thật của `flow:generateContent` (đã giải mã từ `data_temple/fetch-model-phan-tich..txt`):

```jsonc
{
  "model": "gemini-3-flash-preview",
  "contents": [{ "role": "user", "parts": [{ "text": "..." }, { "inlineData": { "data": "<base64>" } }] }],
  "systemInstruction": { "parts": [{ "text": "..." }] },
  "thinkingConfig": { "thinkingLevel": "HIGH" },
  "requestContext": { "flowSdkInfo": { "appletId": "<uuid>", "appletVersionId": "<uuid>" } },
  "recaptchaContext": {
    "token": "0cAFcWeA...",
    "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB"
  }
}
```

→ **`recaptchaContext` nằm ở TOP-LEVEL của body** (cùng cấp với `model` / `contents` /
`systemInstruction`), **KHÔNG** nằm trong `clientContext`. Thực tế generateContent
**không có** `clientContext` (không `projectId` / `tool` / `userPaygateTier`); ngữ cảnh
được mang qua `requestContext.flowSdkInfo`.

So sánh 3 endpoint (3 vị trí khác nhau — đây là điểm dễ sai nhất):

| Endpoint | Vị trí token reCAPTCHA |
|---|---|
| `batchGenerateImages` / `batchAsyncGenerateVideo*` | `body.clientContext.recaptchaContext.token` **và** `body.requests[].clientContext.recaptchaContext.token` |
| **`flow:generateContent`** | **`body.recaptchaContext.token`** (top-level) + `applicationType: RECAPTCHA_APPLICATION_TYPE_WEB` |
| `flowAgent:runAppletAgentSse` | `body.agentClientContext.recaptchaContext.token` |

> ⚠️ Hệ quả code: `background.js → handleApiRequest` hiện chèn token vào 3 chỗ
> (`clientContext.recaptchaContext`, `agentClientContext.recaptchaContext`,
> `requests[].clientContext.recaptchaContext`) nhưng **CHƯA** xử lý top-level
> `recaptchaContext`. Cần thêm:
> ```js
> if (finalBody.recaptchaContext) finalBody.recaptchaContext.token = captchaToken;
> ```
>
> Còn lại cần xác nhận khi implement: **action string** của captcha cho generateContent
> (image dùng `IMAGE_GENERATION`, video `VIDEO_GENERATION`; generateContent có thể khác —
> phát hiện động qua `injected.js OBSERVE_EVENT`), và `appletId`/`appletVersionId` lấy từ đâu
> (có thể là hằng số của Flow applet, hoặc lấy từ phiên — cần kiểm tra; có khả năng để rỗng).

Endpoint thứ hai trong payload — `flowAgent:runAppletAgentSse` — là cho **agent đa lượt
SSE**, phức tạp hơn (giống đường `flowCreationAgent:streamChat` Omni đang dùng). **Để
ngoài phạm vi spike này**; chỉ cần khi muốn chat agent nhiều bước. `generateContent`
(một phát/một lần) đủ cho mọi nhu cầu text hiện tại.

---

## 4. Ai thực sự tiêu thụ text-gen trong sản phẩm?

Quan trọng để tránh hiểu nhầm: `GeminiBrowserDriver` + `GeminiExecutor` **chưa được nối
vào sản phẩm thật**. Chúng chỉ là scaffold của local worker (`__main__.py`, chạy khi
`EXT_PROVIDER=gemini`). Hai consumer text-gen thật sự là:

| Consumer | File | Hiện dùng gì |
|---|---|---|
| Auto-prompt (Generate khi chưa gõ prompt) | `services/prompt_synth.py` | `run_llm("auto_prompt", ...)` → Claude/Gemini-CLI/OpenAI |
| Vision brief (`aiBrief` cho ảnh upload/gen) | `services/vision.py` | `run_llm("vision", ...)` (multimodal) |

Cả hai đi qua registry `services/llm/` (người dùng chọn provider trong Settings). Đây mới
là chỗ **đáng** thay bằng "Gemini-qua-Flow" để đạt chi phí $0 (không tốn API key Claude/OpenAI,
không tốn quota Gemini API trả phí — dùng chính phiên Flow của user).

→ Giá trị thật của spike: thêm một **LLM provider mới** `flow_gemini` vào registry, gọi
`generateContent` qua extension. `GeminiBrowserDriver` chỉ là thứ bị thay thế/xoá, không
phải mục tiêu chính.

---

## 5. Kiến trúc đề xuất

```
prompt_synth / vision  ──run_llm("flow_gemini")──►  Control Plane (Worker)
                                                          │  enqueue request
                                                          │  provider="flow", task_type="text_gen"
                                                          ▼
                                            Extension cloud-worker poll/claim
                                                          │
                                            FlowboardFlowApi.generateContent()
                                              • solveCaptcha(GEMINI action)
                                              • build Gemini payload
                                              • fetch flow:generateContent (Bearer)
                                                          │
                                            complete(request, { text }) ──► Supabase/DB
```

Hai biến thể triển khai (chọn 1 khi viết spec):

- **(A) Đồng bộ ngắn** — text-gen nhanh (vài giây), có thể thêm endpoint Worker
  `POST /api/text/generate` chạy claim→complete trong một request (đơn giản cho caller).
- **(B) Theo job như ảnh/video** — enqueue request `task_type=text_gen`, poll completion.
  Nhất quán với pipeline hiện có, chịu được độ trễ, dễ retry. **Khuyến nghị (B)** để đồng bộ.

---

## 6. Thay đổi cần thiết (ước lượng)

### 6.1 Extension (`flow_api.js`)
Thêm method (đã sửa theo hợp đồng thật — `recaptchaContext` top-level, không `clientContext`):

```js
async generateContent(contents, options) {
  const opts = options || {};
  const captchaToken = await this.solveCaptcha?.(opts.captchaAction || 'IMAGE_GENERATION');
  if (!captchaToken) throw new Error('Missing reCAPTCHA token');

  const body = {
    model: opts.model || 'gemini-3-flash-preview',
    contents,                                   // [{ role, parts:[{text}|{inlineData:{data,mimeType}}] }]
    systemInstruction: opts.systemInstruction,  // optional { parts:[{text}] }
    thinkingConfig: opts.thinkingConfig,         // optional { thinkingLevel: 'HIGH' }
    requestContext: opts.requestContext,         // optional { flowSdkInfo: { appletId, appletVersionId } }
    recaptchaContext: {                          // ← TOP-LEVEL (đã xác nhận từ fetch thật)
      token: captchaToken,
      applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
    },
  };
  const resp = await fetch(`${FLOW_API_BASE}/v1/flow:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', authorization: this.bearerHeader(),
               origin: 'https://labs.google', referer: 'https://labs.google/' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`generateContent HTTP ${resp.status}`);
  return { raw: data, text: extractGeneratedText(data) };
}
```

+ helper `extractGeneratedText(data)` (đọc `candidates[].content.parts[].text`).
+ Trong `background.js handleApiRequest`: thêm nhánh chèn token vào **top-level**
  `finalBody.recaptchaContext.token` (hiện mới chỉ xử lý `clientContext` /
  `agentClientContext` / `requests[].clientContext`).

### 6.2 Cloud-worker dispatch (`background.js runCloudFlowJob`)
Thêm nhánh `task_type === 'text_gen'`: gọi `flowApi.generateContent(...)`, rồi
`cloud.complete(requestId, { provider:'flow', task_type:'text_gen', text }, [])`
(không có asset → mảng rỗng).

### 6.3 Control Plane Worker
- Cho phép `task_type=text_gen` (canvas.ts đã nhận `body.task_type`, chỉ cần validate).
- (Tuỳ chọn A) endpoint tiện ích `POST /api/text/generate`.

### 6.4 Agent / registry LLM
- Thêm provider `flow_gemini` vào `services/llm/` gọi Worker thay vì CLI.
- `prompt_synth` / `vision` không đổi (đi qua `run_llm`).

### 6.5 Dọn dẹp
- Đánh dấu deprecate rồi xoá `gemini_browser_driver.py`, `gemini_smoke.py`,
  `gemini_e2e_smoke.py`, test Playwright tương ứng. Gỡ phụ thuộc Playwright khỏi agent.

---

## 7. Rủi ro & câu hỏi mở

| # | Rủi ro / câu hỏi | Cách xử lý |
|---|---|---|
| 1 | Vị trí chính xác `recaptchaContext` trong body generateContent | Bắt 1 fetch thật → soi; thử cả clientContext + top-level |
| 2 | Captcha **action string** cho generateContent | Dùng `injected.js OBSERVE_EVENT` phát hiện động (đã có sẵn) |
| 3 | Có endpoint liệt kê model không? (payload runAppletAgentSse gợi ý dropdown model) | Khảo sát riêng; tạm hardcode danh sách model + cho cấu hình |
| 4 | Rate-limit / quota của flow:generateContent theo phiên Flow | Đo thực tế; tái dùng retry/backoff của cloud-worker |
| 5 | ToS Google Flow khi dùng cho text-gen ngoài UI | Ghi nhận rủi ro pháp lý (đã chấp nhận với ảnh/video) |
| 6 | Multimodal: kích thước inlineData base64 lớn (ảnh) | Resize/giới hạn trước khi gửi như vision hiện làm |

---

## 8. Đề xuất bước tiếp theo

1. **Xác nhận hợp đồng** (1 buổi): bắt 1 fetch `generateContent` thật, chốt vị trí
   `recaptchaContext` + captcha action + hình dạng response.
2. **Tạo spec** `gemini-via-flow-generatecontent` (requirements → design → tasks) theo
   biến thể (B) job-based.
3. Triển khai theo lát mỏng: `flow_api.generateContent` + 1 test → nhánh dispatch
   `text_gen` → provider `flow_gemini` trong registry → cắt `prompt_synth`/`vision`
   sang dùng nó → xoá Playwright driver.

> Sau khi chốt mục 1, tôi có thể dựng spec đầy đủ.
