import "@testing-library/jest-dom";

// jsdom has no media pipeline: `HTMLMediaElement.play()` logs "Not implemented"
// and returns undefined instead of a promise. Both the camera preview and the
// avatar call it, so stub it into a resolved promise to keep test output honest
// (a real failure there would otherwise hide in the noise).
Object.defineProperty(HTMLMediaElement.prototype, "play", {
  configurable: true,
  writable: true,
  value: jest.fn(async () => undefined),
});

// jsdom doesn't reliably expose crypto.randomUUID — provide a deterministic
// counter-based stub so components that mint ids render in tests.
if (typeof globalThis.crypto?.randomUUID !== "function") {
  let n = 0;
  const randomUUID = (() =>
    `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`) as Crypto["randomUUID"];
  const cryptoObj = (globalThis.crypto ?? {}) as Crypto;
  Object.defineProperty(cryptoObj, "randomUUID", {
    configurable: true,
    value: randomUUID,
  });
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: cryptoObj,
    });
  }
}
