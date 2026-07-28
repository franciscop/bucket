import { escapeXml, unescapeXml } from "./xml.ts";

describe("escapeXml", () => {
  it("escapes the five XML entities", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
    expect(escapeXml("plain.txt")).toBe("plain.txt");
  });
});

describe("unescapeXml", () => {
  it("decodes the five XML entities", () => {
    expect(unescapeXml("a&amp;b&lt;c&gt;d&quot;e&apos;f")).toBe(`a&b<c>d"e'f`);
    expect(unescapeXml("plain.txt")).toBe("plain.txt");
  });
  it("decodes numeric character references", () => {
    expect(unescapeXml("a&#38;b&#x26;c")).toBe("a&b&c");
  });
  it("round-trips with escapeXml", () => {
    const name = `weird &<>"' file & more.txt`;
    expect(unescapeXml(escapeXml(name))).toBe(name);
  });
  it("leaves unknown entities alone", () => {
    expect(unescapeXml("a&nope;b")).toBe("a&nope;b");
  });
});
