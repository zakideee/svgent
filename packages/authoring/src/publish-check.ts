import { IMAGE_ROLES, modelLabelIssue, type SvgentProject } from "@svgent/scene";

type PublishIssueSeverity = "warning" | "error";

type PublishIssue = {
  code: string;
  severity: PublishIssueSeverity;
  path: string;
  message: string;
};

type PublishCheck = {
  safeToExport: boolean;
  reviewRequired: boolean;
  issues: PublishIssue[];
  provenance: {
    /** Always true: the artifact is an authored rendering, not a capture. */
    simulated: true;
    basis: SvgentProject["basis"];
    sourceKind: "authored-or-summarized";
    transformations: ["typos-corrected", "tool-activity-summarized", "identifiers-removed"];
  };
};

type ContentRule = {
  code: string;
  severity: PublishIssueSeverity;
  pattern: RegExp;
  message: string;
};

const CONTENT_RULES: readonly ContentRule[] = [
  {
    code: "credential-like-value",
    severity: "error",
    pattern:
      /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.)/u,
    message: "Contains a value that looks like a credential or private key.",
  },
  {
    code: "email-address",
    severity: "error",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    message: "Contains a value that looks like an email address.",
  },
  {
    code: "local-path",
    severity: "error",
    pattern: /(?:\/Users\/[^\s/]+|\/home\/[^\s/]+|[A-Z]:\\Users\\[^\s\\]+)/iu,
    message: "Contains a local path that could identify the author.",
  },
  {
    code: "private-url",
    severity: "error",
    pattern:
      /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|[^\s/]+\.(?:local|internal))(?:[/:]|\b)/iu,
    message: "Contains a value that looks like an internal or local URL.",
  },
];

const RAW_TOOL_PATTERN =
  /(?:^|\n)\s*(?:pnpm|npm|yarn|git|rg|grep|sed|curl|wget|cat|rm|cp|mv|node|python|npx)\b/iu;

function inspectContent(content: string, path: string): PublishIssue[] {
  return CONTENT_RULES.flatMap((rule): PublishIssue[] =>
    rule.pattern.test(content)
      ? [{ code: rule.code, severity: rule.severity, path, message: rule.message }]
      : [],
  );
}

export function checkProjectForPublication(project: SvgentProject): PublishCheck {
  const issues: PublishIssue[] = [];
  if (modelLabelIssue(project.modelLabel) !== null) {
    issues.push({
      code: "invalid-model-label",
      severity: "error",
      path: "modelLabel",
      message: "Provide a model label between 1 and 40 characters.",
    });
  }
  const textFields = [
    ["title", project.title],
    ["workspaceLabel", project.workspaceLabel],
    ["branchLabel", project.branchLabel],
  ] as const;
  for (const [path, value] of textFields) {
    issues.push(...inspectContent(value, path));
  }
  for (const message of project.messages) {
    const path = `messages.${message.id}.content`;
    issues.push(...inspectContent(message.content, path));
    if (message.role === "tool" && RAW_TOOL_PATTERN.test(message.content)) {
      issues.push({
        code: "raw-tool-detail",
        severity: "warning",
        path,
        message: "Prefer a short summary of intent and outcome over a raw command.",
      });
    }
    if (
      message.role === "thinking" &&
      (message.content.includes("\n") || Array.from(message.content).length > 80)
    ) {
      issues.push({
        code: "thinking-too-detailed",
        severity: "warning",
        path,
        message: "Keep thinking to a short visible status, not a reasoning trace.",
      });
    }
    if (!IMAGE_ROLES.includes(message.role) && (message.images?.length ?? 0) > 0) {
      // Never rendered on either surface, yet still exported at full
      // weight — and invisible content is exactly what publication review
      // exists to surface.
      issues.push({
        code: "hidden-images",
        severity: "warning",
        path: `messages.${message.id}.images`,
        message: "This role never renders images; they only add invisible weight to the script.",
      });
    }
  }
  return {
    safeToExport: issues.every((issue) => issue.severity !== "error"),
    reviewRequired: issues.length > 0,
    issues,
    provenance: {
      simulated: true,
      basis: project.basis,
      sourceKind: "authored-or-summarized",
      transformations: ["typos-corrected", "tool-activity-summarized", "identifiers-removed"],
    },
  };
}
