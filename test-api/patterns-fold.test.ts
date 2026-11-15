import { expect } from "chai";
import { SHILL_PATTERNS, TRADE_REQUEST_PATTERNS, matchesAny } from "../src/engine/patterns";

describe("Vietnamese without diacritics", () => {
  it("refuses trade requests typed without accents", () => {
    expect(matchesAny("Nen mua ETH ngay khong?", TRADE_REQUEST_PATTERNS)).to.equal(true);
    expect(matchesAny("co nen vao tien luc nay", TRADE_REQUEST_PATTERNS)).to.equal(true);
    expect(matchesAny("gia muc tieu HPG la bao nhieu", TRADE_REQUEST_PATTERNS)).to.equal(true);
  });
  it("still flags shill language without accents", () => {
    expect(matchesAny("keo thom, vao lenh ngay", SHILL_PATTERNS)).to.equal(true);
  });
  it("does not flag an ordinary claim", () => {
    expect(matchesAny("FOX chia co tuc", TRADE_REQUEST_PATTERNS)).to.equal(false);
    expect(matchesAny("FOX chia cổ tức", SHILL_PATTERNS)).to.equal(false);
  });
});
