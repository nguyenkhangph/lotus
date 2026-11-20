import { expect } from "chai";
import { HnxRssProvider, HoseNewsProvider, VnExchangeProvider, hoseSlug } from "../src/evidence/providers";
import { getDesk } from "../src/engine/desks";
import { scoreClaim } from "../src/engine/score";

// Shape and items copied from api.hsx.vn (news/cate, Tin tổ chức niêm yết), 20/11/2026.
const NOW = Date.parse("2026-11-20T04:30:00Z"); // 11:30 in Vietnam
const page = {
  success: true,
  data: {
    paging: { pageIndex: 1, pageSize: 200, totalCount: 3, totalPages: 1 },
    list: [
      { id: 2515417, title: "GDA: Thông báo về ngày đăng ký cuối cùng chi trả cổ tức năm 2025 bằng cổ phiếu", postedDate: 1795169933, summary: "<p>Sở Giao dịch Chứng khoán TP.HCM thông báo về ngày đăng ký cuối cùng chi trả cổ tức năm 2025 bằng cổ phiếu của Công ty Cổ phần Tôn Đông Á như sau:</p>" },
      { id: 2515409, title: "SJS: Thông báo ngày ĐKCC để thực hiện quyền mua chứng khoán cho cổ đông hiện hữu", postedDate: 1795168471, summary: "<p>Công ty Cổ phần SJ Group công bố Thông báo ngày ĐKCC như sau:</p>" },
      { id: 2515424, title: "CVPB2616: Quyết định về việc hủy niêm yết chứng quyền có bảo đảm", postedDate: 1795170165, summary: "<p>…của Công ty Cổ phần Chứng khoán TP. Hồ Chí Minh…</p>" },
    ],
  },
};
const urls: string[] = [];
const client = { get: async (u: string) => (urls.push(u), JSON.stringify(page)) };

describe("HOSE listed-company disclosures (api.hsx.vn)", () => {
  it("builds the hsx.vn article slug the site uses", () => {
    expect(hoseSlug("GDA: Thông báo về ngày đăng ký cuối cùng chi trả cổ tức năm 2025 bằng cổ phiếu"))
      .to.equal("gda-thong-bao-ve-ngay-dang-ky-cuoi-cung-chi-tra-co-tuc-nam-2025-bang-co-phieu");
  });

  it("counts a disclosure only when its title starts with exactly the claim's ticker", async () => {
    const p = new HoseNewsProvider(client, 0, 1, () => NOW);
    const items = await p.fetch({ text: "GDA chia cổ tức", desk: "vn_stocks" }, getDesk("vn_stocks"));
    expect(items).to.have.length(1);
    expect(items[0].stance).to.equal("supports");
    expect(items[0].url).to.equal("https://www.hsx.vn/vi/tin-tuc/gda-thong-bao-ve-ngay-dang-ky-cuoi-cung-chi-tra-co-tuc-nam-2025-bang-co-phieu/2515417");
    expect(items[0].publishedAt).to.equal("2026-11-20T03:18:53.000Z"); // 10:18:53 Vietnam time
    expect(urls[0]).to.contain("aliasCate=tin-tuc%2Ftin-to-chuc-niem-yet").and.contain("endDate=2026-11-20");
    const r = scoreClaim({ text: "GDA chia cổ tức", desk: "vn_stocks", asOf: "2026-11-20T04:30:00Z" }, getDesk("vn_stocks"), items);
    expect(r.verdict).to.equal("SUPPORTED");
    expect(r.score).to.equal(45);
  });

  it("an HNX/UPCoM ticker (FOX) gets nothing from HOSE; covered warrants (CVPB2616) never match a 3-letter ticker", async () => {
    const p = new HoseNewsProvider(client, 0, 1, () => NOW);
    expect(await p.fetch({ text: "FOX chia cổ tức", desk: "vn_stocks" }, getDesk("vn_stocks"))).to.deep.equal([]);
    expect(await p.fetch({ text: "VPB hủy niêm yết", desk: "vn_stocks" }, getDesk("vn_stocks"))).to.deep.equal([]);
  });

  it("several distinct disclosures of one ticker are one source, not an echo (GDA: record date + issuance)", () => {
    const mk = (id: string, text: string, at: string) => ({ id, platform: "rss" as const, url: `https://www.hsx.vn/vi/tin-tuc/x/${id}`, publishedAt: at, text, stance: "supports" as const });
    const items = [
      mk("2515417", "GDA: Thông báo về ngày đăng ký cuối cùng chi trả cổ tức năm 2025 bằng cổ phiếu — Sở Giao dịch Chứng khoán TP.HCM thông báo về ngày đăng ký cuối cùng chi trả cổ tức năm 2025 bằng cổ phiếu của Công ty Cổ phần Tôn Đông Á như sau:", "2026-11-20T03:18:53Z"),
      mk("2514465", "GDA: Thông báo phát hành CP để trả cổ tức — Công ty Cổ phần Tôn Đông Á công bố Thông báo phát hành CP để trả cổ tức như sau:", "2026-11-16T03:29:29Z"),
      mk("2514463", "GDA: Thông báo ngày ĐKCC thực hiện quyền trả cổ tức bằng cổ phiếu — Công ty Cổ phần Tôn Đông Á công bố Thông báo ngày ĐKCC thực hiện quyền trả cổ tức bằng cổ phiếu như sau:", "2026-11-16T03:28:33Z"),
    ];
    const r = scoreClaim({ text: "GDA chia cổ tức", desk: "vn_stocks", asOf: "2026-11-20T04:30:00Z" }, getDesk("vn_stocks"), items);
    expect(r.verdict).to.equal("SUPPORTED");
    expect(r.score).to.equal(45);
    expect(r.echoIndex).to.equal(0);
  });

  it("a dead API yields nothing, never invented evidence", async () => {
    const dead = new HoseNewsProvider({ get: async () => { throw new Error("TLS"); } }, 0, 1, () => NOW);
    expect(await dead.fetch({ text: "GDA chia cổ tức", desk: "vn_stocks" }, getDesk("vn_stocks"))).to.deep.equal([]);
  });

  it("the VN router asks both exchanges; only the listing venue answers, so they never stack", async () => {
    const hnxDead = new HnxRssProvider({ get: async () => { throw new Error("down"); } }, 0, ["feed.rss"]);
    const vn = new VnExchangeProvider([hnxDead, new HoseNewsProvider(client, 0, 1, () => NOW)]);
    const items = await vn.fetch({ text: "GDA chia cổ tức", desk: "vn_stocks" }, getDesk("vn_stocks"));
    expect(items.map((i) => i.id)).to.deep.equal(["hose:2515417"]);
  });
});
