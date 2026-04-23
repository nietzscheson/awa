import {
  extractAllTranscriptLines,
  extractTranscript,
  formatSessionWhen,
  isLikelyNonSpeechTranscript,
  looksLikeInterviewFinishedReply,
  replayVoiceButtonLabel,
  shortSessionLabel,
  sttErrorMessage,
  truncateDetail,
} from "../voiceChatUtils";

describe("voiceChatUtils", () => {
  describe("looksLikeInterviewFinishedReply", () => {
    it("detects Spanish interview completion wording", () => {
      expect(looksLikeInterviewFinishedReply("La entrevista ha concluido.")).toBe(true);
      expect(looksLikeInterviewFinishedReply("entrevista ha finalizado")).toBe(true);
    });

    it("detects English completion wording", () => {
      expect(looksLikeInterviewFinishedReply("The interview is complete.")).toBe(true);
    });

    it("returns false for ordinary answers", () => {
      expect(looksLikeInterviewFinishedReply("Soy ingeniero.")).toBe(false);
      expect(looksLikeInterviewFinishedReply("")).toBe(false);
    });
  });

  describe("isLikelyNonSpeechTranscript", () => {
    it("filters very short input", () => {
      expect(isLikelyNonSpeechTranscript("a")).toBe(true);
    });

    it("filters music-style captions", () => {
      expect(isLikelyNonSpeechTranscript("(música)")).toBe(true);
    });

    it("keeps plausible short parenthetical answers", () => {
      expect(isLikelyNonSpeechTranscript("(Nombre Apellido)")).toBe(false);
    });

    it("keeps normal speech", () => {
      expect(isLikelyNonSpeechTranscript("Hola, soy Cristian.")).toBe(false);
    });
  });

  describe("extractTranscript", () => {
    it("reads top-level text", () => {
      expect(extractTranscript({ text: "  hello  " })).toBe("hello");
    });

    it("reads first transcripts[].text", () => {
      expect(
        extractTranscript({
          transcripts: [{ text: "from array" }],
        }),
      ).toBe("from array");
    });

    it("returns empty for invalid payloads", () => {
      expect(extractTranscript(null)).toBe("");
      expect(extractTranscript("x")).toBe("");
    });
  });

  describe("extractAllTranscriptLines", () => {
    it("deduplicates repeated lines", () => {
      expect(
        extractAllTranscriptLines({
          text: "one",
          transcripts: [{ text: "one" }, { text: "two" }],
        }),
      ).toEqual(["one", "two"]);
    });
  });

  describe("shortSessionLabel", () => {
    it("leaves short ids unchanged", () => {
      expect(shortSessionLabel("abc")).toBe("abc");
    });

    it("truncates long ids", () => {
      expect(shortSessionLabel("1234567890abcdef")).toMatch(/^12345678…$/);
    });
  });

  describe("formatSessionWhen", () => {
    it("returns em dash for invalid input", () => {
      expect(formatSessionWhen(0)).toBe("—");
      expect(formatSessionWhen(Number.NaN)).toBe("—");
    });
  });

  describe("truncateDetail", () => {
    it("leaves short strings unchanged", () => {
      expect(truncateDetail("ok")).toBe("ok");
    });

    it("truncates long strings", () => {
      const s = "x".repeat(500);
      expect(truncateDetail(s, 10).length).toBe(11);
      expect(truncateDetail(s, 10).endsWith("…")).toBe(true);
    });
  });

  describe("sttErrorMessage", () => {
    it("prefers nested detail.message", () => {
      expect(sttErrorMessage({ detail: { message: "nested" } }, "fallback")).toBe("nested");
    });

    it("uses top-level message", () => {
      expect(sttErrorMessage({ message: "top" }, "fallback")).toBe("top");
    });

    it("falls back when unknown", () => {
      expect(sttErrorMessage({}, "fallback")).toBe("fallback");
    });
  });

  describe("replayVoiceButtonLabel", () => {
    it("uses Spanish by default locale tag", () => {
      expect(replayVoiceButtonLabel("es-MX")).toBe("Oír de nuevo");
    });

    it("uses English for en tags", () => {
      expect(replayVoiceButtonLabel("en-US")).toBe("Hear again");
    });
  });
});
