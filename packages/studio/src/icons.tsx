/** Inline SVG icons shared across the studio chrome. */

import type { MessageRole } from "@svgent/scene";

/**
 * Role glyph for a script message row. The color comes from the parent so
 * it always matches the row's role stripe; the shape carries the role for
 * anyone who cannot rely on color alone.
 */
export function RoleIcon({ role }: { role: MessageRole }) {
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  switch (role) {
    case "user":
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="5.2" r="2.5" {...stroke} />
          <path d="M3.4 13.6a4.7 4.7 0 0 1 9.2 0" {...stroke} />
        </svg>
      );
    case "thinking":
      // A thought cloud: "thinking" is reasoning in progress, where a bulb
      // says the idea already arrived. The scalloped outline and the
      // near-vertical tail dots matter — a clean ellipse over diagonal
      // dots reads as a magnifier at 14px, and a tailless cloud as upload.
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M5 9.9 a2.3 2.3 0 0 1-1.2-4.2 3.1 3.1 0 0 1 5.9-1.2 2.5 2.5 0 0 1 2.5 3.9 2.2 2.2 0 0 1-2 1.5 Z"
            {...stroke}
          />
          <circle cx="5" cy="12.2" r="1" fill="currentColor" />
          <circle cx="3.2" cy="14.2" r="0.6" fill="currentColor" />
        </svg>
      );
    case "tool":
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M9.8 4.2a.67.67 0 0 0 0 .93l1.07 1.07a.67.67 0 0 0 .93 0l2.51-2.51a4 4 0 0 1-5.29 5.29l-4.6 4.6a1.41 1.41 0 0 1-2-2l4.6-4.6a4 4 0 0 1 5.29-5.29L9.8 4.2z"
            {...stroke}
          />
        </svg>
      );
    case "permission":
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M8 1.8 13 3.6v4.2c0 3.2-2.2 5.4-5 6.4-2.8-1-5-3.2-5-6.4V3.6Z" {...stroke} />
        </svg>
      );
    case "assistant":
      // A robot head, deliberately generic: the previous four-point star
      // matched a real product's mark, which the product boundary forbids.
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="3" y="5.2" width="10" height="7.6" rx="2" {...stroke} />
          <circle cx="6.1" cy="9" r="0.95" fill="currentColor" />
          <circle cx="9.9" cy="9" r="0.95" fill="currentColor" />
          <path d="M8 5.2 V3.6" {...stroke} />
          <circle cx="8" cy="2.7" r="0.85" fill="currentColor" />
        </svg>
      );
    case "image":
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="2" y="2.8" width="12" height="10.4" rx="1.5" {...stroke} />
          <circle cx="5.6" cy="6.3" r="1" fill="currentColor" />
          <path d="M3.6 12 7 8.4l2.1 2.3 1.7-1.8 1.9 3.1" {...stroke} />
        </svg>
      );
    case "choice":
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="3.6" cy="5" r="1.4" {...stroke} />
          <circle cx="3.6" cy="5" r="0.5" fill="currentColor" />
          <circle cx="3.6" cy="11" r="1.4" {...stroke} />
          <path d="M6.8 5h6M6.8 11h6" {...stroke} />
        </svg>
      );
    default:
      return null;
  }
}

export function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
        <line
          key={angle}
          x1="8"
          y1="1"
          x2="8"
          y2="2.8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          transform={`rotate(${angle} 8 8)`}
        />
      ))}
    </svg>
  );
}

export function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M13.2 10.4A6 6 0 0 1 5.6 2.8a6 6 0 1 0 7.6 7.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * GitHub's own mark, unmodified. The trademark guidelines allow it as a link
 * to a repository but not redrawn, so this is the official geometry rather
 * than a stroke icon in the family the rest of this file follows; only the
 * fill follows the surrounding text colour.
 */
export function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

export function WidthIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M1.5 8h13M4.5 4.8 1.2 8l3.3 3.2M11.5 4.8 14.8 8l-3.3 3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function UploadIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M8 9.6V2.4M4.8 5.6 8 2.4l3.2 3.2M2.8 12.2h10.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d={direction === "up" ? "M3.5 10 8 5.5 12.5 10" : "M3.5 6 8 10.5 12.5 6"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M8 2v7.2M4.8 6.4 8 9.6l3.2-3.2M2.8 12.2h10.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M6.2 3.5H3.5v9h9V9.8M9.5 2.5h4v4M13.2 2.8 7.6 8.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Wizard surface previews as SVG: a fixed viewBox scales to any card size,
 * where a hand-positioned HTML mock drifts apart whenever its box shrinks.
 * "slice" keeps the composition edge-to-edge at odd aspect ratios.
 */
export function SurfaceArtApp() {
  return (
    <svg viewBox="0 0 200 96" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect x={12} y={10} width={30} height={9} rx={4.5} fill="var(--panel-3)" />
      {[158, 172, 186].map((x) => (
        <rect
          key={x}
          x={x}
          y={10}
          width={9}
          height={9}
          rx={2.5}
          fill="none"
          stroke="var(--faint)"
          strokeWidth={1.3}
        />
      ))}
      <rect x={92} y={30} width={96} height={12} rx={6} fill="var(--violet)" opacity={0.85} />
      <rect x={12} y={50} width={110} height={9} rx={4.5} fill="var(--panel-3)" />
      <rect
        x={12}
        y={68}
        width={176}
        height={18}
        rx={9}
        fill="none"
        stroke="var(--border)"
        strokeWidth={1.4}
      />
      <circle cx={24} cy={77} r={6} fill="none" stroke="var(--faint)" strokeWidth={1.3} />
      <path
        d="M24 74.5v5M21.5 77h5"
        stroke="var(--faint)"
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      <rect x={36} y={73.5} width={110} height={7} rx={3.5} fill="var(--panel-3)" />
      <circle cx={176} cy={77} r={7} fill="var(--violet)" />
      <path
        d="M176 80.5v-7m0 0-2.8 2.8m2.8-2.8 2.8 2.8"
        fill="none"
        stroke="#fff"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SurfaceArtTui() {
  return (
    <svg viewBox="0 0 200 96" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <circle cx={14} cy={12} r={4} fill="#f37b83" />
      <circle cx={27} cy={12} r={4} fill="#f0b35a" />
      <circle cx={40} cy={12} r={4} fill="#64d79f" />
      <rect x={54} y={8} width={70} height={8} rx={4} fill="var(--panel-3)" />
      <text x={12} y={41} fill="var(--green)" fontFamily="var(--mono)" fontSize={11}>
        ❯ pnpm build
      </text>
      <text x={12} y={57} fill="var(--faint)" fontFamily="var(--mono)" fontSize={10}>
        done · exit 0 · 1.3s
      </text>
      <rect
        x={10}
        y={66}
        width={180}
        height={20}
        rx={5}
        fill="none"
        stroke="var(--violet)"
        strokeWidth={1.4}
      />
      <text x={18} y={80.5} fill="var(--green)" fontFamily="var(--mono)" fontSize={11}>
        ❯
      </text>
      <rect x={31} y={71} width={2.5} height={10} fill="var(--violet)" />
    </svg>
  );
}

/** Play triangle for the loop toggle's stopped state. */
export function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M5.2 3.2v9.6L13.2 8Z" fill="currentColor" />
    </svg>
  );
}

/** Pause bars for the loop toggle's playing state. */
export function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect x="4" y="3.2" width="2.8" height="9.6" rx="1" fill="currentColor" />
      <rect x="9.2" y="3.2" width="2.8" height="9.6" rx="1" fill="currentColor" />
    </svg>
  );
}

/** Frame-step: a triangle nudging against a stop bar, one per direction. */
export function StepIcon({ direction }: { direction: "back" | "forward" }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      {direction === "back" ? (
        <>
          <rect x="3.2" y="3.2" width="2" height="9.6" rx="0.9" fill="currentColor" />
          <path d="M12.8 3.2v9.6L6.4 8Z" fill="currentColor" />
        </>
      ) : (
        <>
          <path d="M3.2 3.2v9.6L9.6 8Z" fill="currentColor" />
          <rect x="10.8" y="3.2" width="2" height="9.6" rx="0.9" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/** Clipboard with a clip tab: copy-to-clipboard, distinct from the ⧉ duplicate glyph. */
export function ClipboardIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect
        x={3.2}
        y={2.8}
        width={9.6}
        height={11.4}
        rx={2}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
      />
      <rect x={5.9} y={1.4} width={4.2} height={2.8} rx={1} fill="currentColor" />
      <path
        d="M5.8 7.6h4.4M5.8 10.4h3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Six-dot grip: the visible "grab here" affordance on the reorder handle. */
export function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      {[4.5, 8, 11.5].flatMap((cy) =>
        [5.5, 10.5].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.3" fill="currentColor" />
        )),
      )}
    </svg>
  );
}

/** A trash can: deleting the whole card, unmistakably not a field clear. */
export function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d="M2.8 4.4h10.4M6.2 4.4V3a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.4M4.2 4.4l.7 8.4a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.7-8.4M6.6 7v3.9M9.4 7v3.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Pager arrows drawn as geometry — text glyphs sit low in the line box. */
export function ArrowIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d={direction === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
