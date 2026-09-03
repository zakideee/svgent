import { GENERATED_SAMPLE_IMAGES } from "@svgent/assets";
import {
  DEFAULT_PROJECT,
  defaultProjectFor,
  messageIdToken,
  type SessionMessage,
} from "@svgent/scene";

function withGeneratedFallback(
  messages: readonly SessionMessage[],
): Array<Omit<SessionMessage, "id">> {
  return messages.map(({ id: _id, ...message }) =>
    message.role === "image" && message.images === undefined
      ? { ...message, images: [GENERATED_SAMPLE_IMAGES.generic] }
      : { ...message },
  );
}

const LOGO_MOTION_MESSAGES: SessionMessage[] = [
  {
    id: "user-request",
    role: "user",
    content: "{{@src/assets/logo.svg|@src/as}} をふわっと[[出現|しゅつげん]]させたい。JSなしで。",
  },
  {
    id: "thinking-scan",
    role: "thinking",
    content: "既存のSVG構造とアニメーション方針を確認しています",
  },
  {
    id: "tool-search",
    role: "tool",
    language: "bash",
    content: 'rg -n "<svg|animate" src/assets',
  },
  {
    id: "permission-edit",
    role: "permission",
    content: "logo.svg を編集します",
  },
  {
    id: "assistant-implementation",
    role: "assistant",
    content: [
      "## SVGだけで実装しました",
      "",
      "- SMILの `<animate>` でJS不要",
      "- `r` を 0→24 に補間してふわっと出現",
      "- 塗りは `currentColor` でテーマ追従",
      "",
      "```svg",
      '<circle cx="24" cy="24" r="24" fill="currentColor">',
      '  <animate attributeName="r" from="0" to="24"',
      '    dur="0.4s" calcMode="spline" />',
      "</circle>",
      "```",
    ].join("\n"),
  },
  {
    id: "tool-test",
    role: "tool",
    language: "bash",
    content: "svgo logo.svg",
  },
  {
    id: "assistant-result",
    role: "assistant",
    content:
      "**1.2KB → 0.8KB に軽量化。** `prefers-reduced-motion` では静止表示にフォールバックします。",
  },
];

// Script presets
// ————————————————————————————————————————————————————————————————————————————

export type ScriptPresetVariant = {
  title: string;
  workspaceLabel: string;
  branchLabel: string;
  messages: Array<Omit<SessionMessage, "id">>;
};

export type ScriptPreset = {
  id: string;
  label: Record<"ja" | "en", string>;
  description: Record<"ja" | "en", string>;
  /**
   * One script per language, Japanese as the source and English as its
   * translation — subject, title and labels correspond, so a drift between the
   * two is visible rather than hidden. The exception is what a language alone
   * can show (ruby and IME conversion, long-word wrapping): that stays on its
   * own side and is meant to have no counterpart.
   */
  variants: Record<"ja" | "en", ScriptPresetVariant>;
};

export const SCRIPT_PRESETS: ScriptPreset[] = [
  {
    id: "template",
    label: { ja: "テンプレート", en: "Template" },
    description: {
      ja: "用途を決めない全要素入りのひな形。〇〇=主題 / □□=対象 / △△=補足を打ち替え、不要な行は削除",
      en: "A blank-slate scaffold with every element: replace TOPIC / TARGET / DETAIL; delete what you don't need",
    },
    variants: {
      ja: {
        title: "〇〇のセッション",
        workspaceLabel: "you/〇〇",
        branchLabel: "feat/〇〇",
        messages: withGeneratedFallback(DEFAULT_PROJECT.messages),
      },
      en: {
        title: "TOPIC session",
        workspaceLabel: "you/TOPIC",
        branchLabel: "feat/TOPIC",
        messages: withGeneratedFallback(defaultProjectFor("en").messages),
      },
    },
  },
  {
    id: "feature",
    label: { ja: "機能実装", en: "Feature" },
    description: {
      ja: "実装依頼から検索・許可・実装・テストまでの定番の流れ",
      en: "The classic flow: request, search, approval, implementation, tests",
    },
    variants: {
      ja: {
        title: "Logo motion in SVG",
        workspaceLabel: "fictional/brand-kit",
        branchLabel: "feat/logo-motion",
        messages: LOGO_MOTION_MESSAGES.map(({ id: _id, ...message }) => ({ ...message })),
      },
      en: {
        title: "Logo motion in SVG",
        workspaceLabel: "fictional/brand-kit",
        branchLabel: "feat/logo-motion",
        messages: [
          {
            role: "user",
            content: "I want {{@src/assets/logo.svg|@src/as}} to fade in. No JS.",
          },
          {
            role: "thinking",
            content: "Checking the existing SVG structure and how to animate it",
          },
          { role: "tool", language: "bash", content: 'rg -n "<svg|animate" src/assets' },
          { role: "permission", content: "Edit logo.svg" },
          {
            role: "assistant",
            content: [
              "## Done in SVG alone",
              "",
              "- SMIL `<animate>`, so no JS",
              "- `r` interpolates 0→24 for the fade-in",
              "- The fill is `currentColor`, so it follows the theme",
              "",
              "```svg",
              '<circle cx="24" cy="24" r="24" fill="currentColor">',
              '  <animate attributeName="r" from="0" to="24"',
              '    dur="0.4s" calcMode="spline" />',
              "</circle>",
              "```",
            ].join("\n"),
          },
          { role: "tool", language: "bash", content: "svgo logo.svg" },
          {
            role: "assistant",
            content:
              "**1.2 KB → 0.8 KB.** Under `prefers-reduced-motion` it falls back to a still frame.",
          },
        ],
      },
    },
  },
  {
    id: "bugfix",
    label: { ja: "バグ修正", en: "Bug fix" },
    description: {
      ja: "失敗テストの再現から原因特定、diffつきの修正まで",
      en: "Reproduce a failing test, find the cause, fix it with a diff",
    },
    variants: {
      ja: {
        title: "DateRange boundary fix",
        workspaceLabel: "fictional/booking-web",
        branchLabel: "fix/date-range-boundary",
        messages: [
          {
            role: "user",
            content:
              "[[日付|ひづけ]]ピッカー、[[終了日|しゅうりょうび]]に[[同じ日|おなじひ]]を[[選ぶ|えらぶ]]と[[落ちる|おちる]]。このブランチで[[直して|なおして]]。",
          },
          {
            role: "thinking",
            content: "再現手順と既存のバリデーションを確認しています",
            highlight: true,
          },
          { role: "tool", language: "bash", content: "pnpm test -- DateRange" },
          {
            role: "assistant",
            content:
              "## 原因\n\n`clampEnd` の比較が **開始日を含まない** `<` になっていました。境界日のテストも欠けています。",
          },
          {
            role: "choice",
            content: "どう直しますか?",
            options: [
              "比較を <= に直す — 原因を直接なおす",
              "呼び出し側で弾く — 影響は小さいが再発しやすい",
            ],
            chosenIndex: 0,
          },
          { role: "permission", content: "DateRangePicker.ts とテストを編集します" },
          {
            role: "assistant",
            content: [
              "修正 diff です。",
              "",
              "```diff",
              "@@ clampEnd()",
              "-if (end < start) {",
              "-  return start;",
              "+if (end <= start) {",
              "+  return addDays(start, 1);",
              " }",
              "```",
            ].join("\n"),
          },
          { role: "tool", language: "bash", content: "pnpm test -- DateRange" },
          {
            role: "assistant",
            content: "**8件のテストが通りました。** 境界日の regression テストも追加しています。",
          },
        ],
      },
      en: {
        title: "DateRange boundary fix",
        workspaceLabel: "fictional/booking-web",
        branchLabel: "fix/date-range-boundary",
        messages: [
          {
            role: "user",
            content:
              "The date picker crashes when the end date is the same day as the start. Fix it on this branch.",
          },
          {
            role: "thinking",
            content: "Reproducing it and reading the existing validation",
            highlight: true,
          },
          { role: "tool", language: "bash", content: "pnpm test -- DateRange" },
          {
            role: "assistant",
            content:
              "## Cause\n\n`clampEnd` compared with `<`, which **excludes the start date**. The boundary case has no test either.",
          },
          {
            role: "choice",
            content: "How should it be fixed?",
            options: [
              "Change the comparison to <= — fixes the cause directly",
              "Reject it at the call site — smaller blast radius, easier to regress",
            ],
            chosenIndex: 0,
          },
          { role: "permission", content: "Edit DateRangePicker.ts and its tests" },
          {
            role: "assistant",
            content: [
              "Here is the fix.",
              "",
              "```diff",
              "@@ clampEnd()",
              "-if (end < start) {",
              "-  return start;",
              "+if (end <= start) {",
              "+  return addDays(start, 1);",
              " }",
              "```",
            ].join("\n"),
          },
          { role: "tool", language: "bash", content: "pnpm test -- DateRange" },
          {
            role: "assistant",
            content: "**8 tests green.** A regression test for the boundary date is in as well.",
          },
        ],
      },
    },
  },
  {
    id: "conference",
    label: { ja: "カンファ宣伝", en: "Conference" },
    description: {
      ja: "キービジュアル生成つきのカンファ告知。画像ブロックが目を引く構成",
      en: "A conference announcement with a generated key visual — the image block carries it",
    },
    variants: {
      ja: {
        title: "VectorConf 20XX",
        workspaceLabel: "vectorconf/website",
        branchLabel: "announce/20xx",
        messages: [
          {
            role: "user",
            content: "VectorConfの[[告知|こくち]]、ビジュアルつきで[[出して|だして]]。",
          },
          { role: "thinking", content: "開催概要とキービジュアルの構図を考えています" },
          {
            role: "image",
            content: "VectorConf 20XX キービジュアル、幾何学的なベクターの波、夜明けの配色",
            images: [GENERATED_SAMPLE_IMAGES.vectorConf],
          },
          {
            role: "assistant",
            content: [
              "## VectorConf 20XX",
              "",
              "- **●/●● (●)** 会場: ○○メッセ",
              "- キーノート: *SVGで作るリアルタイムUI*",
              "",
              "> CFP は ●/●● まで受付中!",
            ].join("\n"),
          },
        ],
      },
      en: {
        title: "VectorConf 20XX",
        workspaceLabel: "vectorconf/website",
        branchLabel: "announce/20xx",
        messages: [
          {
            role: "user",
            content: "Put out the VectorConf announcement, with a visual.",
          },
          { role: "thinking", content: "Working out the details and the key visual" },
          {
            role: "image",
            content: "VectorConf 20XX key visual, geometric vector waves, daybreak palette",
            images: [GENERATED_SAMPLE_IMAGES.vectorConf],
          },
          {
            role: "assistant",
            content: [
              "## VectorConf 20XX",
              "",
              "- **●/●● (●)** at the ○○ Messe",
              "- Keynote: *Real-time UI in SVG*",
              "",
              "> The CFP is open until ●/●●!",
            ].join("\n"),
          },
        ],
      },
    },
  },
  {
    id: "showcase",
    label: { ja: "作ったもの紹介", en: "Showcase" },
    description: {
      ja: "自作ツールをエージェントに紹介させ、追い質問でエンジンまで掘る二段構成(svgent→boundsvg)",
      en: "Pitch what you built, then a follow-up digs into the engine underneath (svgent → boundsvg)",
    },
    variants: {
      ja: {
        title: "Introducing svgent",
        workspaceLabel: "you/svgent",
        branchLabel: "main",
        messages: [
          {
            role: "user",
            content:
              "[[自作|じさく]]のツール、README[[用|よう]]にいい[[感じ|かんじ]]に[[紹介|しょうかい]]して。",
          },
          { role: "tool", language: "bash", content: "gh repo view --json name,description" },
          {
            role: "assistant",
            content: [
              "## svgent",
              "",
              "- 創作のcoding-agent sessionを演出して **SVG / GIF / MP4** に書き出し",
              "- TUI / App の2サーフェス、diff演出・IME入力再現",
              "",
              "**Star歓迎です!**",
            ].join("\n"),
          },
          { role: "user", content: "この[[描画|びょうが]]って[[何|なに]]でやってるの?" },
          {
            role: "image",
            content: "boundsvg の描画パイプライン、ベクターからラスタへ、ダークトーン",
            images: [GENERATED_SAMPLE_IMAGES.boundsvgPipeline],
          },
          {
            role: "assistant",
            content: [
              "エンジンも自作の **boundsvg** です。",
              "",
              "- 宣言的シーンを SVG / PNG / 動画に等価レンダリング",
              "- Rust+WASM の組版(禁則・ルビ・縦書き)",
              "- いま見ているこの描画そのものが boundsvg の出力",
            ].join("\n"),
          },
        ],
      },
      en: {
        title: "Introducing svgent",
        workspaceLabel: "you/svgent",
        branchLabel: "main",
        messages: [
          {
            role: "user",
            content: "Introduce the tool I built, nicely, for the README.",
          },
          { role: "tool", language: "bash", content: "gh repo view --json name,description" },
          {
            role: "assistant",
            content: [
              "## svgent",
              "",
              "- Stages a fictional coding-agent session and writes it out as **SVG / GIF / MP4**",
              "- Two surfaces, app and terminal, with diff staging and IME input playback",
              "",
              "**Stars welcome!**",
            ].join("\n"),
          },
          { role: "user", content: "What is doing the drawing?" },
          {
            role: "image",
            content: "The boundsvg rendering pipeline, vector through to raster, dark tones",
            images: [GENERATED_SAMPLE_IMAGES.boundsvgPipeline],
          },
          {
            role: "assistant",
            content: [
              "Its own engine, **boundsvg**.",
              "",
              "- One declarative scene rendered equivalently to SVG, PNG and video",
              "- Rust and WASM typesetting: line-breaking rules, ruby, vertical writing",
              "- The rendering you are looking at is boundsvg's own output",
            ].join("\n"),
          },
        ],
      },
    },
  },
  {
    id: "qa",
    label: { ja: "AIに質問", en: "Ask AI" },
    description: {
      ja: "ちょっとした質問に短く答えるQ&A風。SNS向けの小ネタに",
      en: "A short, casual Q&A exchange — good for social posts",
    },
    variants: {
      ja: {
        title: "Quick question",
        workspaceLabel: "personal/notes",
        branchLabel: "daily",
        messages: [
          {
            role: "user",
            content: "SVGのviewBoxを1[[行|ぎょう]]で[[説明|せつめい]]して。",
          },
          { role: "thinking", content: "要点を整理しています" },
          {
            role: "assistant",
            content: [
              "**中身の座標系を宣言する属性** です。表示サイズと切り離されるので、どの大きさで置いても比率が崩れません。",
              "",
              "```svg",
              '<svg viewBox="0 0 24 24" width="96"></svg>',
              "```",
            ].join("\n"),
          },
          {
            role: "user",
            content:
              "なるほど、[[拡大|かくだい]]しても[[崩れない|くずれない]][[理由|りゆう]]がこれか!",
          },
        ],
      },
      en: {
        title: "Quick question",
        workspaceLabel: "personal/notes",
        branchLabel: "daily",
        messages: [
          { role: "user", content: "Explain the SVG viewBox in one line." },
          { role: "thinking", content: "Boiling it down" },
          {
            role: "assistant",
            content: [
              "**The attribute that declares the coordinate system inside** — decoupled from the display size, so the proportions hold at any scale.",
              "",
              "```svg",
              '<svg viewBox="0 0 24 24" width="96"></svg>',
              "```",
            ].join("\n"),
          },
          { role: "user", content: "So that is why it survives being scaled up!" },
        ],
      },
    },
  },
];

export function instantiatePreset(preset: ScriptPreset, lang: "ja" | "en"): SessionMessage[] {
  return preset.variants[lang].messages.map((message, index) => ({
    ...message,
    id: `${preset.id}-${messageIdToken()}-${index}`,
  }));
}
