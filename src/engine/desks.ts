import type { Desk } from "./types";

/**
 * Desk allowlists — candidates verified to exist on 2026-11-12 (see docs/desks/*.md).
 * Inclusion is not an endorsement. Handles are matched exactly; look-alikes are rejected.
 * Only `vn_stocks` is planned as a live desk; the others run on declared fixtures.
 */

const btc: Desk = {
  id: "btc_ta",
  name: "BTC — on-chain & technical",
  live: false,
  staleAfterHours: 72,
  sources: [
    { id: "glassnode", name: "Glassnode", org: "glassnode", type: "analyst", handles: ["x:@glassnode"], domains: ["glassnode.com"] },
    { id: "cryptoquant", name: "CryptoQuant", org: "cryptoquant", type: "analyst", handles: ["x:@cryptoquant_com", "x:@ki_young_ju"], domains: ["cryptoquant.com"] },
    { id: "coinmetrics", name: "Coin Metrics", org: "coinmetrics", type: "analyst", handles: ["x:@coinmetrics"], domains: ["coinmetrics.io", "docs.coinmetrics.io"] },
    { id: "mempool", name: "mempool.space", org: "mempool", type: "primary", handles: ["x:@mempool"], domains: ["mempool.space"] },
    { id: "coinglass", name: "CoinGlass", org: "coinglass", type: "analyst", handles: ["x:@coinglass_com"], domains: ["coinglass.com"] },
    { id: "k33", name: "K33 Research", org: "k33", type: "analyst", handles: ["x:@K33Research"], domains: ["k33.com"] },
    { id: "farside", name: "Farside Investors", org: "farside", type: "analyst", handles: ["x:@FarsideUK"], domains: ["farside.co.uk"] },
    { id: "willywoo", name: "Willy Woo", org: "willywoo", type: "analyst", handles: ["x:@willywoo"] },
    { id: "checkmate", name: "Checkmate", org: "checkmate", type: "analyst", handles: ["x:@_Checkmatey_"] },
    { id: "brandt", name: "Peter Brandt", org: "factor", type: "analyst", handles: ["x:@PeterLBrandt"] },
  ],
  officialBodies: [],
};

const macro: Desk = {
  id: "macro_whitehouse",
  name: "Macro + White House",
  live: false,
  staleAfterHours: 48,
  sources: [
    { id: "whitehouse", name: "The White House", org: "whitehouse", type: "primary", handles: ["x:@WhiteHouse", "x:@POTUS"], domains: ["whitehouse.gov"] },
    { id: "fed", name: "Federal Reserve Board", org: "fed_board", type: "primary", handles: ["x:@federalreserve"], domains: ["federalreserve.gov"] },
    { id: "treasury", name: "U.S. Treasury", org: "treasury", type: "primary", handles: ["x:@USTreasury"], domains: ["treasury.gov", "home.treasury.gov"] },
    { id: "bls", name: "BLS", org: "bls", type: "primary", handles: ["x:@BLS_gov"], domains: ["bls.gov"] },
    { id: "bea", name: "BEA", org: "bea", type: "primary", handles: ["x:@BEA_News"], domains: ["bea.gov"] },
    { id: "cbo", name: "CBO", org: "cbo", type: "primary", handles: ["x:@USCBO"], domains: ["cbo.gov"] },
    { id: "fred", name: "St. Louis Fed (FRED)", org: "stlouisfed", type: "primary", handles: ["x:@stlouisfed"], domains: ["fred.stlouisfed.org", "stlouisfed.org"] },
    { id: "imf", name: "IMF", org: "imf", type: "primary", handles: ["x:@IMFNews"], domains: ["imf.org"] },
    { id: "bis", name: "BIS", org: "bis", type: "primary", handles: ["x:@BIS_org"], domains: ["bis.org"] },
  ],
  officialBodies: [
    { id: "white_house", patterns: ["white house", "nhà trắng", "potus", "president", "tổng thống"], sources: ["whitehouse"] },
    { id: "fed", patterns: ["\\bfed\\b", "fomc", "federal reserve", "cắt lãi", "rate cut"], sources: ["fed"] },
    { id: "cpi", patterns: ["\\bcpi\\b", "lạm phát", "unemployment", "thất nghiệp", "payrolls"], sources: ["bls"] },
    { id: "gdp", patterns: ["\\bgdp\\b", "\\bpce\\b"], sources: ["bea"] },
  ],
};

const goldWar: Desk = {
  id: "gold_war",
  name: "Gold & war / geopolitics",
  live: false,
  staleAfterHours: 48,
  sources: [
    { id: "reuters", name: "Reuters", org: "reuters", type: "outlet", handles: ["x:@Reuters", "x:@ReutersBiz"], domains: ["reuters.com"] },
    { id: "ap", name: "Associated Press", org: "ap", type: "outlet", handles: ["x:@AP"], domains: ["apnews.com"] },
    { id: "un", name: "United Nations", org: "un", type: "primary", handles: ["x:@UN"], domains: ["un.org"] },
    { id: "iaea", name: "IAEA", org: "iaea", type: "primary", handles: ["x:@iaeaorg"], domains: ["iaea.org"] },
    { id: "icrc", name: "ICRC", org: "icrc", type: "primary", handles: ["x:@ICRC"], domains: ["icrc.org"] },
    { id: "nato", name: "NATO", org: "nato", type: "primary", handles: ["x:@NATO"], domains: ["nato.int"] },
    { id: "state", name: "U.S. State Dept", org: "state", type: "primary", handles: ["x:@StateDept"], domains: ["state.gov"] },
    { id: "war", name: "U.S. Dept of War", org: "war", type: "primary", handles: ["x:@DeptofWar"], domains: ["war.gov"] },
    { id: "wgc", name: "World Gold Council", org: "wgc", type: "primary", handles: ["x:@GOLDCOUNCIL"], domains: ["gold.org"] },
    { id: "cme", name: "CME Group", org: "cme", type: "primary", handles: ["x:@CMEGroup"], domains: ["cmegroup.com"] },
    // Cross-desk primaries so gold claims attributed to Washington can be checked here too.
    { id: "whitehouse", name: "The White House", org: "whitehouse", type: "primary", handles: ["x:@WhiteHouse", "x:@POTUS"], domains: ["whitehouse.gov"] },
    { id: "treasury", name: "U.S. Treasury", org: "treasury", type: "primary", handles: ["x:@USTreasury"], domains: ["treasury.gov"] },
  ],
  officialBodies: [
    { id: "nato", patterns: ["nato", "article 5", "điều 5"], sources: ["nato"] },
    { id: "pentagon", patterns: ["pentagon", "department of war", "war declared", "tuyên chiến"], sources: ["war", "state"] },
    { id: "white_house", patterns: ["white house", "nhà trắng", "potus", "president", "tổng thống"], sources: ["whitehouse"] },
    { id: "un", patterns: ["security council", "hội đồng bảo an", "\\bun\\b"], sources: ["un"] },
  ],
};

const vnStocks: Desk = {
  id: "vn_stocks",
  name: "Chứng khoán Việt Nam (công bố chính thức)",
  live: true,
  staleAfterHours: 120,
  sources: [
    { id: "ssc", name: "UBCKNN", org: "ssc", type: "primary", handles: ["fb:StateSecuritiesCommission"], domains: ["ssc.gov.vn", "congbothongtin.ssc.gov.vn", "ids.ssc.gov.vn"] },
    { id: "hose", name: "HOSE", org: "hose", type: "primary", handles: ["fb:HochiminhStockExchange"], domains: ["hsx.vn"] },
    { id: "hnx", name: "HNX", org: "hnx", type: "primary", handles: ["fb:HanoiStockExchange2005"], domains: ["hnx.vn"] },
    { id: "vsdc", name: "VSDC", org: "vsdc", type: "primary", domains: ["vsdc.vn"] },
    { id: "sbv", name: "Ngân hàng Nhà nước", org: "sbv", type: "primary", handles: ["fb:giaoductaichinh.official", "fb:cic.sbv"], domains: ["sbv.gov.vn"] },
    { id: "vietnamplus", name: "VietnamPlus", org: "ttxvn", type: "outlet", handles: ["fb:VietnamPlus", "x:@VietnamPlus"], domains: ["vietnamplus.vn"] },
    { id: "baodautu", name: "Báo Đầu tư", org: "baodautu", type: "outlet", handles: ["fb:baodautu.vn"], domains: ["baodautu.vn"] },
    { id: "baochinhphu", name: "Báo Chính phủ", org: "chinhphu", type: "outlet", handles: ["fb:baochinhphu.vn", "fb:thongtinchinhphu"], domains: ["baochinhphu.vn"] },
    { id: "vneconomy", name: "VnEconomy", org: "vneconomy", type: "outlet", handles: ["fb:vneconomy.vn", "x:@vneconomy"], domains: ["vneconomy.vn"] },
  ],
  officialBodies: [
    // Company events must be backed by an exchange / regulator disclosure.
    { id: "disclosure", patterns: ["cổ tức", "dividend", "lợi nhuận", "kết quả kinh doanh", "bị phạt", "xử phạt", "hạn chế giao dịch", "đình chỉ", "hủy niêm yết", "bổ nhiệm", "miễn nhiệm"], sources: ["hose", "hnx", "ssc", "vsdc"] },
    { id: "sbv", patterns: ["ngân hàng nhà nước", "nhnn", "lãi suất điều hành", "tỷ giá trung tâm"], sources: ["sbv"] },
  ],
};

const usStocks: Desk = {
  id: "us_stocks",
  name: "U.S. stocks (filings / exchanges / regulators)",
  live: false,
  staleAfterHours: 72,
  sources: [
    { id: "sec", name: "SEC / EDGAR", org: "sec", type: "primary", handles: ["x:@SECGov"], domains: ["sec.gov", "efts.sec.gov", "investor.gov"] },
    { id: "nyse", name: "NYSE", org: "nyse", type: "primary", handles: ["x:@NYSE"], domains: ["nyse.com"] },
    { id: "nasdaq", name: "Nasdaq", org: "nasdaq", type: "primary", handles: ["x:@Nasdaq"], domains: ["nasdaqtrader.com", "nasdaq.com"] },
    { id: "finra", name: "FINRA", org: "finra", type: "primary", handles: ["x:@FINRA"], domains: ["finra.org"] },
    { id: "cftc", name: "CFTC", org: "cftc", type: "primary", handles: ["x:@CFTC"], domains: ["cftc.gov"] },
    { id: "pcaob", name: "PCAOB", org: "pcaob", type: "primary", handles: ["x:@PCAOB_News"], domains: ["pcaobus.org"] },
    { id: "reuters", name: "Reuters", org: "reuters", type: "outlet", handles: ["x:@ReutersBiz", "x:@Reuters"], domains: ["reuters.com"] },
    { id: "wsj", name: "WSJ", org: "wsj", type: "outlet", handles: ["x:@WSJ", "x:@WSJmarkets"], domains: ["wsj.com"] },
    { id: "bloomberg", name: "Bloomberg", org: "bloomberg", type: "outlet", handles: ["x:@business"], domains: ["bloomberg.com"] },
    { id: "ft", name: "Financial Times", org: "ft", type: "outlet", handles: ["x:@FT"], domains: ["ft.com"] },
  ],
  officialBodies: [
    { id: "sec", patterns: ["\\bsec\\b", "8-k", "10-k", "10-q", "form 4", "charged", "kiện"], sources: ["sec"] },
    { id: "halt", patterns: ["halt", "tạm dừng giao dịch"], sources: ["nasdaq", "nyse"] },
  ],
};

export const DESKS: Record<string, Desk> = Object.fromEntries(
  [btc, macro, goldWar, vnStocks, usStocks].map((d) => [d.id, d]),
);

export function getDesk(id: string): Desk {
  const d = DESKS[id];
  if (!d) throw new Error(`unknown desk: ${id}`);
  return d;
}
