import {
  buildGoogleFontCssUrl,
  buildScriptPrompt,
  collectProjectCharacters,
  currentToolVersions,
  DEFAULT_PROJECT,
  deserializeProject,
  extractScriptJson,
  normalizeGoogleFontFamily,
  serializeProject,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

describe("script file I/O", () => {
  it("round-trips the default project without warnings", () => {
    const { project, warnings } = deserializeProject(serializeProject(DEFAULT_PROJECT));
    expect(warnings).toEqual([]);
    expect(project.title).toBe(DEFAULT_PROJECT.title);
    expect(project.messages.map((message) => message.role)).toEqual(
      DEFAULT_PROJECT.messages.map((message) => message.role),
    );
    expect(project.appearance).toEqual(DEFAULT_PROJECT.appearance);
    expect(project.timing).toEqual(DEFAULT_PROJECT.timing);
  });

  it("round-trips the TUI always-allow approval state", () => {
    const source = {
      ...DEFAULT_PROJECT,
      messages: [
        {
          id: "permission",
          role: "permission" as const,
          content: "Edit files",
          decision: "allow-always" as const,
        },
      ],
    };
    const { project, warnings } = deserializeProject(serializeProject(source));
    expect(warnings).toEqual([]);
    expect(project.messages[0]?.decision).toBe("allow-always");
  });

  it("repairs unknown versions, roles, and out-of-range values with warnings", () => {
    const { project, warnings } = deserializeProject(
      JSON.stringify({
        version: 99,
        surface: "hologram",
        modelLabel: "Claude Code",
        appearance: { theme: "unknown-theme", canvasWidth: 99_999, accent: "not-a-color" },
        timing: { thinkingMs: -5 },
        messages: [
          { role: "user", content: "ok" },
          { role: "narrator", content: "dropped" },
          "garbage",
        ],
      }),
    );
    expect(project.version).toBe(1);
    expect(project.surface).toBe("app");
    // Names are not policed; the declared basis in provenance carries the
    // fictional/reenactment distinction instead.
    expect(project.modelLabel).toBe("Claude Code");
    expect(project.appearance.theme).toBe("ink");
    expect(project.appearance.canvasWidth).toBe(2560);
    expect(project.appearance.accent).toBe(DEFAULT_PROJECT.appearance.accent);
    expect(project.timing.thinkingMs).toBe(400);
    expect(project.messages).toHaveLength(1);
    expect(project.messages[0]?.role).toBe("user");
    expect(warnings.length).toBeGreaterThanOrEqual(5);
  });

  it("round-trips per-image framing and clamps the image count with a warning", () => {
    const pixel = {
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      mediaType: "image/png",
      width: 1,
      height: 1,
      alt: "image",
    };
    const framed = { ...pixel, fit: "cover", focus: "top", size: "large" };
    const source = JSON.stringify({
      version: 1,
      messages: [{ role: "user", content: "many", images: [framed, pixel, pixel, pixel, pixel] }],
    });
    const { project, warnings } = deserializeProject(source);
    expect(project.messages[0]?.images).toHaveLength(4);
    expect(project.messages[0]?.images?.[0]).toMatchObject({ focus: "top", size: "large" });
    expect(warnings.length).toBe(1);
    const reread = deserializeProject(serializeProject(project));
    expect(reread.project.messages[0]?.images?.[0]).toMatchObject({ focus: "top", size: "large" });
  });

  it("round-trips the camera declaration and clamps its zoom", () => {
    const base = JSON.parse(serializeProject(DEFAULT_PROJECT));
    expect(base.camera).toEqual({ follow: false, zoom: 1.6, style: "sync", minShotMs: 0 });
    const { project, warnings } = deserializeProject(
      JSON.stringify({ ...base, camera: { follow: true, zoom: 9 } }),
    );
    expect(project.camera.follow).toBe(true);
    expect(project.camera.zoom).toBe(2.5);
    expect(warnings.some((warning) => /Camera zoom/u.test(warning))).toBe(true);
    const reloaded = deserializeProject(serializeProject(project)).project;
    expect(reloaded.camera).toEqual({ follow: true, zoom: 2.5, style: "sync", minShotMs: 0 });
  });

  it("keeps voice inputMode on user messages and drops it elsewhere", () => {
    const { project, warnings } = deserializeProject(
      JSON.stringify({
        ...JSON.parse(serializeProject(DEFAULT_PROJECT)),
        messages: [
          { role: "user", content: "spoken request", inputMode: "voice" },
          { role: "assistant", content: "reply", inputMode: "voice" },
        ],
      }),
    );
    expect(project.messages[0]?.inputMode).toBe("voice");
    expect(project.messages[1]?.inputMode).toBeUndefined();
    expect(warnings).toHaveLength(0);
    const reloaded = deserializeProject(serializeProject(project)).project;
    expect(reloaded.messages[0]?.inputMode).toBe("voice");
  });

  it("round-trips a declared reenactment and keeps its real model label", () => {
    const { project, warnings } = deserializeProject(
      JSON.stringify({
        ...JSON.parse(serializeProject(DEFAULT_PROJECT)),
        basis: "reenactment",
        modelLabel: "Claude Code",
      }),
    );
    expect(project.basis).toBe("reenactment");
    expect(project.modelLabel).toBe("Claude Code");
    expect(warnings).toHaveLength(0);
    const reloaded = deserializeProject(serializeProject(project)).project;
    expect(reloaded.basis).toBe("reenactment");
    expect(reloaded.modelLabel).toBe("Claude Code");
  });

  it("treats an undeclared script as fictional and keeps its label", () => {
    const { project } = deserializeProject(
      JSON.stringify({
        ...JSON.parse(serializeProject(DEFAULT_PROJECT)),
        modelLabel: "Claude Code",
      }),
    );
    expect(project.basis).toBe("fictional");
    expect(project.modelLabel).toBe("Claude Code");
  });

  it("reverts uploaded fonts on import and keeps google families", () => {
    const { project, warnings } = deserializeProject(
      JSON.stringify({
        ...JSON.parse(serializeProject(DEFAULT_PROJECT)),
        fonts: {
          sans: { source: "upload", fileName: "MyFont.woff2" },
          mono: { source: "google", family: "Fira Code" },
        },
      }),
    );
    expect(project.fonts.sans).toEqual({ source: "bundled" });
    expect(project.fonts.mono).toEqual({ source: "google", family: "Fira Code" });
    expect(warnings.some((warning) => /フォント|font/iu.test(warning))).toBe(true);
  });

  it("collects scene characters and builds a subset css2 url", () => {
    const characters = collectProjectCharacters(DEFAULT_PROJECT);
    // The default is the template script; 〇 is its placeholder mark and
    // しゅうせい is an IME reading that must reach the subset too.
    expect(characters).toContain("〇");
    expect(characters).toContain("ゅ");
    expect(characters).toContain("❯");
    // Chrome the renderers generate rather than the author typing it, and the
    // plain hyphen a hand-kept glyph list had quietly omitted.
    expect(characters).toContain("許");
    expect(characters).toContain("-");
    expect(new Set(characters).size).toBe([...characters].length);
    const url = buildGoogleFontCssUrl("Zen Maru Gothic", "abcロ");
    expect(url).toContain("family=Zen+Maru+Gothic:wght@400");
    expect(url).toContain(`text=${encodeURIComponent("abcロ")}`);
  });

  it("clamps spacing and repairs an unknown content alignment", () => {
    const { project, warnings } = deserializeProject(
      JSON.stringify({
        ...JSON.parse(serializeProject(DEFAULT_PROJECT)),
        appearance: {
          ...DEFAULT_PROJECT.appearance,
          spacingScale: 9,
          windowPaddingX: 999,
          contentAlign: "middle",
        },
      }),
    );
    expect(project.appearance.spacingScale).toBe(1.6);
    expect(project.appearance.windowPaddingX).toBe(80);
    expect(project.appearance.contentAlign).toBe("start");
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    const reloaded = deserializeProject(serializeProject(project)).project;
    expect(reloaded.appearance.spacingScale).toBe(1.6);
    expect(reloaded.appearance.contentAlign).toBe("start");
  });

  it("tells the generator every field it may set, and which characters exist", () => {
    for (const lang of ["ja", "en"] as const) {
      const prompt = buildScriptPrompt("テスト", lang);
      // Every per-message field a model can meaningfully choose.
      for (const field of ["language", "decision", "options", "chosenIndex", "inputMode"]) {
        expect(prompt).toContain(field);
      }
      // And the ones it must not, because the app owns them.
      for (const owned of ["appearance", "timing", "basis"]) {
        expect(prompt).toContain(owned);
      }
      // The bundled fonts carry no emoji and no other scripts, so a prompt
      // that omits this reliably produces tofu.
      expect(/絵文字|emoji/i.test(prompt)).toBe(true);
      expect(/ハングル|Hangul/.test(prompt)).toBe(true);
    }
  });

  it("normalizes pasted Google Fonts URLs and encoded names", () => {
    expect(normalizeGoogleFontFamily("https://fonts.google.com/specimen/M+PLUS+1p")).toBe(
      "M PLUS 1p",
    );
    expect(normalizeGoogleFontFamily("https://fonts.google.com/noto/specimen/Noto+Sans+JP")).toBe(
      "Noto Sans JP",
    );
    // Unparseable URLs stay visible instead of collapsing to "https".
    expect(normalizeGoogleFontFamily("https://example.com/whatever")).toBe(
      "https://example.com/whatever",
    );
    expect(
      normalizeGoogleFontFamily(
        "https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@400&text=abc",
      ),
    ).toBe("Zen Maru Gothic");
    expect(normalizeGoogleFontFamily("M+PLUS+Rounded+1c")).toBe("M PLUS Rounded 1c");
    expect(normalizeGoogleFontFamily("BIZ UDGothic:wght@700")).toBe("BIZ UDGothic");
    // Plain typing passes through so mid-word spaces are not eaten.
    expect(normalizeGoogleFontFamily("Zen Maru ")).toBe("Zen Maru ");
  });

  it("rejects non-JSON input with a readable error", () => {
    expect(() => deserializeProject("not json at all")).toThrow(/JSON/u);
  });

  describe("salvaging a script out of a chat reply", () => {
    // Carries a fenced code block inside an assistant message, which is what
    // the authoring prompt asks for and what fence-matching used to trip on.
    const script = serializeProject({
      ...DEFAULT_PROJECT,
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: 'Add the script:\n\n```json\n{\n  "scripts": { "build": "vite" }\n}\n```\n',
        },
      ],
    });
    const salvage = (reply: string): number | null => {
      const json = extractScriptJson(reply);
      return json === null ? null : deserializeProject(json).project.messages.length;
    };

    it("takes a bare JSON reply whole", () => {
      expect(salvage(script)).toBe(1);
    });

    it("takes the script out of a fenced reply with prose around it", () => {
      expect(salvage(`Here you go:\n\n\`\`\`json\n${script}\n\`\`\`\n\nLet me know.`)).toBe(1);
    });

    it("survives prose that carries braces of its own", () => {
      expect(salvage(`Set {mode} first:\n\`\`\`json\n${script}\n\`\`\``)).toBe(1);
    });

    it("skips JSON that is not a script and keeps looking", () => {
      const decoy = '```json\n{"scripts":{"a":"b"}}\n```';
      expect(salvage(`For reference:\n${decoy}\nThe script:\n\`\`\`json\n${script}\n\`\`\``)).toBe(
        1,
      );
    });

    it("reports no JSON when the reply carries none", () => {
      expect(extractScriptJson("Sorry, I could not produce one.")).toBeNull();
    });
  });

  describe("provenance", () => {
    // A script cannot otherwise say which build drew it, which fonts it drew
    // with, or which moment a report is about.
    const stamp = {
      ...currentToolVersions("9.8.7", "0.1.0"),
      fonts: {
        sans: { source: "upload" as const, fileName: "Custom.woff2", sha256: "abc123" },
        mono: { source: "bundled" as const },
      },
      capturedAtMs: 17_336,
      page: 0,
    };

    it("round-trips without ever becoming project state", () => {
      const back = deserializeProject(serializeProject(DEFAULT_PROJECT, stamp));
      expect(back.provenance).toEqual(stamp);
      expect(back.project).not.toHaveProperty("provenance");
      expect(back.warnings).toEqual([]);
    });

    it("carries an upload by hash, never by its bytes", () => {
      const written = serializeProject(DEFAULT_PROJECT, stamp);
      expect(written).toContain("abc123");
      expect(JSON.parse(written).provenance.fonts.sans).not.toHaveProperty("data");
    });

    it("opens a file with no block, or with an unreadable one", () => {
      expect(deserializeProject(serializeProject(DEFAULT_PROJECT)).provenance).toBeNull();
      const junk = JSON.parse(serializeProject(DEFAULT_PROJECT));
      junk.provenance = { app: 5, fonts: { sans: "no" }, capturedAtMs: "x" };
      const back = deserializeProject(JSON.stringify(junk));
      expect(back.provenance?.app).toBe("");
      expect(back.provenance?.fonts.sans).toEqual({ source: "bundled" });
      expect(back.provenance?.capturedAtMs).toBeUndefined();
      // An unreadable stamp is not an import failure: the script still opens.
      expect(back.warnings).toEqual([]);
    });
  });
});
