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
| Bot Telegram: phiếu duyệt có nút ✅/❌, `/check`, `/status`, `/lock` (khoá bằng khoá guardian), chỉ nhận lệnh từ chủ hũ, quá giờ không duyệt thì tự từ chối | `src/telegram/bot.ts` | ✅ |
| Dashboard: hũ on-chain, khoản chờ duyệt, kết quả, sổ biên nhận, red team | `src/web/` (mở `http://localhost:8402`) | ✅ |
| Hoàn tiền on-chain phần chênh của giá `upto` (TREASURY → hũ) | `src/agent/jar.ts`, `src/app.ts` | ✅ |
| Câu hỏi mua/bán và "kèo" bị từ chối **miễn phí**, trước khi báo giá | `src/app.ts` | ✅ |
| Scheme `exact` settle được qua facilitator x402 chuẩn trên Avalanche (PayAI, Ultravioleta DAO, x402-rs) | `src/x402/facilitator.ts` | ✅ (chưa chạy thật với facilitator ngoài) |
| Verify hợp đồng trên Snowtrace (Routescan) | `scripts/verify.ts` | ✅ (chạy `npm run verify:fuji`) |
| Test E2E trên EVM của Hardhat: agent → duyệt → hũ trả → API xác minh → neo biên nhận → hoàn tiền | `test/e2e.test.ts` | ✅ |

## Đang chạy trên Avalanche Fuji

Ba hợp đồng đều **đã verify mã nguồn (Exact Match)** trên Snowtrace:

| Hợp đồng | Địa chỉ |
|---|---|
| LotusJarFactory | [`0xCD336298223605c0c6c792Bcd7bd2a3F4DCc9546`](https://testnet.snowtrace.io/address/0xCD336298223605c0c6c792Bcd7bd2a3F4DCc9546#code) |
| LotusReceipts | [`0xD8cDc230225448b005DBCE3B935ac53e2057DAd8`](https://testnet.snowtrace.io/address/0xD8cDc230225448b005DBCE3B935ac53e2057DAd8#code) |
| LotusJar (hũ demo) | [`0x805113113EC069205f59d72137c01244BfAA9619`](https://testnet.snowtrace.io/address/0x805113113EC069205f59d72137c01244BfAA9619#code) |

Một vòng chạy thật, duyệt từ Telegram (13/11/2026), với nhận định *"Did the White House put a 100% tariff on gold exports today?"*, kết quả `MISSING_EVIDENCE`:

1. Hũ trả 0.45 test USDC sau khi chủ hũ bấm ✅ Duyệt: [tx](https://testnet.snowtrace.io/tx/0x93ebb66362d3f762c7bf32a8252a5a8c0a52de7c314a9b0bfab03c243a53f33c)
2. Hash biên nhận được neo lên `LotusReceipts`: [tx](https://testnet.snowtrace.io/tx/0xfc2b3ca62870e9d108711ea42ebb2e13e804d571277827e471d8794bec549bf1)
3. TREASURY hoàn 0.40 USDC chưa dùng về hũ (giá `upto`, không có nguồn nào được giao): [tx](https://testnet.snowtrace.io/tx/0x340757dcae6155cf0b098de77f3d6357201acff90ca3bc68dbab058e1902d7ac)

Nhận định *"NATO has invoked Article 5"* ra `MISSING_EVIDENCE` với `FLOOD`, chỉ số buồng vang 0.846: [thanh toán](https://testnet.snowtrace.io/tx/0x8584484ae0951f28c4be239ace6a9dd39ef82fc8994777cbe3e1853cc1f861e0) · [biên nhận](https://testnet.snowtrace.io/tx/0x0bad1dab7a32e3a19873b8899d6174587457a25b477330ba89436b93f8b04f92)

Kill switch: giao dịch `Lock` gửi từ ví guardian (lệnh `/lock` trên Telegram), sau đó `Unlock` gửi từ ví chủ hũ. Xem tab Transactions của [hũ](https://testnet.snowtrace.io/address/0x805113113EC069205f59d72137c01244BfAA9619).

## Chạy thử

```bash
npm install --legacy-peer-deps
npm test              # 26 test hợp đồng + E2E + bot, 9 test API
npm run redteam       # bảng đạt/không đạt + hash của bộ kết quả
npm run dev           # API + dashboard + bot Telegram trên :8402 (GET /, /catalog, POST /v1/score, /receipts)
npm run jar -- status # xem hũ; `lock` / `unlock` (unlock chỉ bằng khoá chủ hũ)
npm run verify:fuji   # verify mã nguồn hợp đồng trên Snowtrace
```

Cần Node ≥ 22.15. Các script chạy với `--use-system-ca` vì `hnx.vn` không gửi kèm chứng chỉ trung gian: Windows và `curl` tự bù được, còn Node mặc định thì không.

Hardhat biên dịch bằng `solc` lấy từ npm (`node_modules/solc`), nên chạy được cả khi mạng chặn binaries.soliditylang.org.

### Deploy lên Fuji

1. Lấy test AVAX và test USDC: https://faucet.circle.com, https://team1vn.xyz/faucet.html
2. `cp .env.example .env`, rồi điền `DEPLOYER_PRIVATE_KEY`, `TREASURY_ADDRESS`, `APPROVER_ADDRESS`, `GUARDIAN_ADDRESS`
3. `npm run deploy:fuji`, rồi chép địa chỉ in ra vào `.env`
4. Gửi test USDC vào `JAR_ADDRESS`
5. `npm run dev`, sau đó ở terminal khác chạy `npm run demo:agent -- "US CPI rose last month" macro_whitehouse`

### Bot Telegram

1. Tạo bot qua @BotFather và điền `TELEGRAM_BOT_TOKEN` vào `.env`.
2. Chạy `npm run dev`, mở bot rồi gửi `/start`. Bot trả lời bằng chat id của bạn.
3. Điền `TELEGRAM_OWNER_ID=<số đó>` vào `.env` rồi chạy lại `npm run dev`.
4. Gửi một nhận định bất kỳ, ví dụ `NATO has invoked Article 5`. Bot gửi phiếu duyệt, bạn bấm ✅ Duyệt là hũ trả tiền và kết quả quay về kèm link Snowtrace.

Muốn dùng `/lock`, điền thêm `GUARDIAN_PRIVATE_KEY` (ví GUARDIAN cần khoảng 0.01 test AVAX). Muốn hoàn tiền on-chain, điền `TREASURY_PRIVATE_KEY` (ví TREASURY cũng cần khoảng 0.01 test AVAX).

## Cam kết thiết kế

- **LLM không giữ khoá và không chuyển tiền.** Agent chỉ chuyển tiếp lệnh chi đã được người dùng (hoặc khoá duyệt của bot) ký.
- **Hỏng là chặn (fail-closed).** Vượt cap, sai token, sai `payTo`, chữ ký hết hạn, nonce đã dùng hoặc hũ đang khoá đều làm giao dịch revert, không khớp một phần.
- **Báo giá gắn với đúng một yêu cầu.** `requestHash = keccak256(method, route, body chuẩn hoá)`. Đổi nội dung là báo giá vô hiệu (RT-21).
- **Bằng chứng là dữ liệu, không phải lệnh.** Câu "SYSTEM: …" nằm trong nguồn bị đánh dấu nhiễm (`PROMPT_INJECTION`) và bỏ qua.
- **Không giá mục tiêu, không khuyến nghị mua/bán, không dự báo.** Câu hỏi kiểu "có nên mua…" nhận `REFUSE`.
- **Giá `upto`:** `base + perSource × số nguồn độc lập đã giao`, có trần. Phần chênh (`refundDue`) được TREASURY chuyển lại về hũ on-chain ngay sau khi trả lời (khi đã cấu hình `TREASURY_PRIVATE_KEY`).
- **Từ chối không tính tiền.** Câu "có nên mua…", giá mục tiêu hay "kèo" bị từ chối trước khi báo giá 402.
- **Người duyệt cuối cùng là con người.** Phiếu duyệt không ai trả lời sẽ tự bị từ chối, và chỉ chủ hũ mới mở lại được hũ đã khoá.

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
src/agent/      runner (luồng của agent mua bằng chứng), hub (hàng chờ duyệt), jar (đọc/khoá/hoàn tiền)
src/telegram/   bot Telegram (Bot API qua fetch, không thêm thư viện)
src/web/        dashboard (một file HTML)
src/buyer/      preflight, chặn lệch oracle
src/evidence/   FixtureProvider, HnxRssProvider
src/ledger.ts   sổ biên nhận băm nối tiếp
redteam/        22 kịch bản + runner
scripts/        deploy Fuji, client demo cho agent
docs/           kế hoạch gốc (Echo Score)
```
