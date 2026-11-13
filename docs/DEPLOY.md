# Đưa demo Lotus lên public

Demo công khai ở **chế độ chỉ đọc** (`PUBLIC_DEMO=1`):
- Dashboard đọc hũ và sổ biên nhận trực tiếp từ Avalanche Fuji, kèm báo cáo red team.
- `POST /v1/score` trả **HTTP 402** kèm điều khoản thanh toán x402, ai cũng thử được bằng `curl`.
- Người xem **không thấy** nội dung các khoản đang chờ duyệt, **không gửi được** nhận định và **không duyệt chi được**.
- Muốn có quyền đầy đủ, mở `/?token=<DASHBOARD_TOKEN>`.

Request đi qua tunnel hoặc reverse proxy luôn bị coi là đến từ bên ngoài, kể cả khi kết nối xuất phát từ `127.0.0.1`.

## Cách 0: Vercel (miễn phí, link cố định, không "ngủ")

Bản Vercel chạy `api/index.ts` → `src/public.ts`, là một app **chỉ đọc** và **không nạp bất kỳ private key nào**. Bot Telegram và luồng trả tiền vẫn chạy trên máy bạn bằng `npm run dev`.

1. Chép sổ biên nhận thật vào repo, như bước 1 của Cách 1 bên dưới (`data/demo/ledger.jsonl`), rồi push.
2. Vào https://vercel.com, đăng nhập bằng GitHub, chọn **Add New → Project**, rồi **Import** repo `lotus`.
3. **Framework Preset:** `Other`. Không sửa Build/Output, vì `vercel.json` đã cấu hình sẵn.
4. **Environment Variables** (đều là địa chỉ công khai):
   | Tên | Giá trị |
   |---|---|
   | `TREASURY_ADDRESS` | `0xa917992F4228115cAb572933A2dc9124585ba500` |
   | `JAR_FACTORY_ADDRESS` | `0xCD336298223605c0c6c792Bcd7bd2a3F4DCc9546` |
   | `JAR_ADDRESS` | `0x805113113EC069205f59d72137c01244BfAA9619` |
5. Bấm **Deploy**. Bạn sẽ có link dạng `https://lotus-xxx.vercel.app`.

**Không** thêm `DEPLOYER_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`, `APPROVER_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`… lên Vercel.

## Cách 1: Render (có link cố định)

1. Chép sổ biên nhận thật vào repo. Sổ này chỉ chứa hash, kết luận và địa chỉ hũ, không có khoá:
   ```powershell
   mkdir data\demo
   copy data\ledger.jsonl data\demo\ledger.jsonl
   git add data/demo/ledger.jsonl
   git commit -m "Demo ledger snapshot"
   git push origin main
   ```
2. Vào https://render.com, đăng nhập bằng GitHub, chọn **New → Blueprint**, rồi chọn repo `lotus`. Render tự đọc `render.yaml`.
3. Khi được hỏi `DASHBOARD_TOKEN`, điền một chuỗi ngẫu nhiên dài hoặc để trống. **Không điền private key nào.**
4. Đợi build xong (khoảng 3–5 phút). Bạn sẽ có link dạng `https://lotus-demo.onrender.com`.
5. Thêm link vào README và vào mục **Website** của repo trên GitHub.

Gói miễn phí sẽ "ngủ" sau khoảng 15 phút không có ai truy cập, và lần mở đầu sau đó mất khoảng 30–60 giây. Nên mở link một lần trước khi giám khảo xem.

## Cách 2: Tunnel từ máy bạn (nhanh, nhưng máy phải luôn bật)

```powershell
$env:PUBLIC_DEMO="1"; npm run dev
# terminal khác:
cloudflared tunnel --url http://localhost:8402
```
Link `https://….trycloudflare.com` sẽ đổi mỗi lần chạy lại tunnel.
