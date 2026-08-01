import { isAbsolute, liveWsUrl, sessionUrl, toWsBase } from "@/lib/adkUrls";

describe("isAbsolute", () => {
  it.each(["http://localhost:8000", "https://adk.example.com", "HTTP://X"])(
    "treats %s as direct mode",
    (base) => expect(isAbsolute(base)).toBe(true),
  );

  it.each(["/adk", "adk", "/adk/nested"])("treats %s as same-origin", (base) =>
    expect(isAbsolute(base)).toBe(false),
  );
});

describe("toWsBase", () => {
  it("maps http→ws and https→wss, dropping a trailing slash", () => {
    expect(toWsBase("http://localhost:8000/")).toBe("ws://localhost:8000");
    expect(toWsBase("https://adk.example.com")).toBe("wss://adk.example.com");
  });

  it("leaves a relative base alone", () => {
    expect(toWsBase("/adk")).toBe("/adk");
  });
});

describe("sessionUrl", () => {
  it("encodes every path segment", () => {
    expect(sessionUrl("/adk", "streaming", "u 1", "s/2")).toBe(
      "/adk/apps/streaming/users/u%201/sessions/s%2F2",
    );
  });
});

describe("liveWsUrl", () => {
  it("uses the page origin for a proxied base", () => {
    // jsdom serves the suite from http://localhost.
    expect(liveWsUrl("/adk", "app_name=streaming")).toBe(
      "ws://localhost/adk/run_live?app_name=streaming",
    );
  });

  it("normalises a base given without a leading slash", () => {
    expect(liveWsUrl("adk", "x=1")).toBe("ws://localhost/adk/run_live?x=1");
  });

  it("targets the server directly for an absolute base", () => {
    expect(liveWsUrl("http://localhost:8000", "x=1")).toBe(
      "ws://localhost:8000/run_live?x=1",
    );
  });
});
