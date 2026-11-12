# Lotus 🪷

**Lotus chấm bằng chứng đằng sau các nhận định thị trường**, trả phí theo kiểu x402 bằng test USDC trên **Avalanche Fuji**.
Khi không kiểm chứng được, Lotus trả `MISSING EVIDENCE`. Từ chối trả lời là một kết quả hợp lệ.

> Hoa sen mọc từ bùn mà không nhuốm bùn. Lotus lọc bằng chứng sạch giữa bùn tin đồn, "kèo" và tin giả.

Bài dự thi **Team1 Vietnam UniHack 2026** (Avalanche). Hạn nộp: 21/11/2026, 23:59 giờ Việt Nam.

## Lotus làm gì

```
Người dùng ─► Agent (không giữ khoá) ─► POST /v1/score ─► 402 + báo giá gắn requestHash
                                   │
                                   ├─► Preflight phía người mua: pay / review / do_not_pay
                                   ├─► Phiếu duyệt (terminal → Telegram) ─► người dùng ký Spend (EIP-712)
                                   ├─► LotusJar (policy contract) kiểm tra cap / whitelist / nonce / hạn / khoá ─► trả USDC
                                   └─► Gửi lại kèm X-PAYMENT (tx hash) ─► API xác minh log on-chain
                                                                          │
              Nguồn (HNX RSS sống + fixture khai báo) ─► Bộ quy tắc ─► kết luận + điểm + chỉ số buồng vang
                                                                          │
                                         Biên nhận băm nối tiếp (JSONL) ─► neo hash lên LotusReceipts (Fuji)
```

| Thành phần | File | Trạng thái |
|---|---|---|
| Hũ có policy (cap theo lệnh/ngày/tổng, whitelist token **theo địa chỉ**, whitelist `payTo`, chữ ký EIP-712 từng lệnh, nonce một lần, hạn chữ ký, cửa sổ huỷ, kill switch, tự khoá khi dồn lệnh) | `contracts/LotusJar.sol` | ✅ 18 test |
| Factory (API chỉ tin log từ hũ do factory tạo) | `contracts/LotusJarFactory.sol` | ✅ |
| Neo biên nhận (chỉ hash lên chuỗi) | `contracts/LotusReceipts.sol` | ✅ |
| API x402: 402 → xác minh → chấm → biên nhận; scheme `exact` (EIP-3009) và `lotus-jar` | `src/app.ts`, `src/x402/` | ✅ |
| Bộ quy tắc: đếm nguồn độc lập, buồng vang, tin cũ, mạo danh, tài khoản mới / tương tác ảo, prompt injection, "kèo" tiếng Việt, mâu thuẫn số liệu và đơn vị, quy kết cho cơ quan chính thức phải có nguồn sơ cấp | `src/engine/` | ✅ |
| Preflight người mua + chặn khi hai nguồn giá lệch | `src/buyer/` | ✅ |
| Bàn sống chứng khoán VN (RSS công bố HNX) + fixture 4 bàn còn lại | `src/evidence/`, `data/fixtures/` | ✅ (chưa chạy thật với HNX từ máy build) |
| Red Team 22 kịch bản (28 kiểm tra) | `redteam/` | ✅ 28/28 |
| Bot Telegram duyệt / huỷ / khoá | — | ⏳ việc tiếp theo |
| UI hũ kiểu Lotus Pay | — | ⏳ |

## Chạy thử

```bash
npm install --legacy-peer-deps
npm test              # 18 test hợp đồng + 8 test API
npm run redteam       # bảng đạt/không đạt + hash của bộ kết quả
npm run dev           # API trên :8402 (GET /catalog, POST /v1/score, GET /receipts)
```

Hardhat biên dịch bằng `solc` lấy từ npm (`node_modules/solc`), nên chạy được cả khi mạng chặn binaries.soliditylang.org.

### Deploy lên Fuji

1. Lấy test AVAX và test USDC: https://faucet.circle.com, https://team1vn.xyz/faucet.html
2. `cp .env.example .env`, rồi điền `DEPLOYER_PRIVATE_KEY`, `TREASURY_ADDRESS`, `APPROVER_ADDRESS`, `GUARDIAN_ADDRESS`
3. `npm run deploy:fuji`, rồi chép địa chỉ in ra vào `.env`
4. Gửi test USDC vào `JAR_ADDRESS`
5. `npm run dev`, sau đó ở terminal khác chạy `npm run demo:agent -- "US CPI rose last month" macro_whitehouse`

## Cam kết thiết kế

- **LLM không giữ khoá và không chuyển tiền.** Agent chỉ chuyển tiếp lệnh chi đã được người dùng (hoặc khoá duyệt của bot) ký.
- **Hỏng là chặn (fail-closed).** Vượt cap, sai token, sai `payTo`, chữ ký hết hạn, nonce đã dùng hoặc hũ đang khoá đều làm giao dịch revert, không khớp một phần.
- **Báo giá gắn với đúng một yêu cầu.** `requestHash = keccak256(method, route, body chuẩn hoá)`. Đổi nội dung là báo giá vô hiệu (RT-21).
- **Bằng chứng là dữ liệu, không phải lệnh.** Câu "SYSTEM: …" nằm trong nguồn bị đánh dấu nhiễm (`PROMPT_INJECTION`) và bỏ qua.
- **Không giá mục tiêu, không khuyến nghị mua/bán, không dự báo.** Câu hỏi kiểu "có nên mua…" nhận `REFUSE`.
- **Giá `upto`:** `base + perSource × số nguồn độc lập đã giao`, có trần. Phần chênh được ghi vào `refundDue` trên biên nhận.

## Giới hạn

- **Không phải tư vấn tài chính hay đầu tư.** Lotus chấm *nhận định*, không chấm con người, và không đưa giá mục tiêu.
- **Chỉ chạy testnet (Avalanche Fuji, test USDC).** Tài sản mã hoá không phải phương tiện thanh toán hợp pháp tại Việt Nam. Lotus không nhận tiền gửi và không hứa lợi nhuận.
- **Trên chuỗi chỉ lưu hash**, không lưu tên, nội dung nhận định hay nội dung nguồn.
- **Một bàn sống** (chứng khoán VN qua RSS công bố của HNX). Bốn bàn còn lại dùng **fixture được ghi rõ là dữ liệu mẫu** (`deskLive: false`, mỗi mục có `synthetic: true`).
- Bàn sống hiện ghép theo mã CK cộng từ khoá sự kiện, chưa đọc nội dung file công bố. Thiếu khớp thì kết quả là `MISSING EVIDENCE`, không bao giờ đoán.
- Danh sách nguồn là ứng viên đã xác minh *tồn tại* ngày 12/11/2026, không phải cam kết độ tin cậy.
- Chưa kiểm chứng feed oracle nào đang chạy trên Fuji. Bộ chặn lệch giá (`src/buyer/oracle.ts`) chỉ dùng cho hũ lệnh tuỳ chọn, và đó không phải tín hiệu giao dịch.
- Nhóm không phải luật sư và chưa kiểm chứng văn bản pháp luật hiện hành. Các câu hỏi đã gửi ban tổ chức: *(điền câu trả lời)*.

## Cấu trúc

```
contracts/      LotusJar, LotusJarFactory, LotusReceipts (+ MockToken cho test)
src/engine/     desks (allowlist 5 bàn), patterns, score (bộ quy tắc)
src/x402/       quote + verify (exact / lotus-jar), kết nối Fuji, chain giả cho test
src/buyer/      preflight, chặn lệch oracle
src/evidence/   FixtureProvider, HnxRssProvider
src/ledger.ts   sổ biên nhận băm nối tiếp
redteam/        22 kịch bản + runner
scripts/        deploy Fuji, client demo cho agent
docs/           kế hoạch gốc (Echo Score)
```
