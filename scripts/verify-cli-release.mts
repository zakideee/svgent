/** Verify the public source and workflow checks selected for a CLI release. */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Exact workflow dispatch identity supplied by GitHub. */
export type ReleaseContext = {
  repository: string;
  ref: string;
  workflowRef: string;
  workflowSha: string;
  commit: string;
  tree: string;
  authMode: string;
};
/** Read-only GitHub JSON transport. */
export type ReadGitHub = (endpoint: string) => Promise<unknown>;

function record(candidate: unknown): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Unexpected GitHub response shape");
  }
  return candidate as Record<string, unknown>;
}
function array(candidate: unknown): unknown[] {
  if (!Array.isArray(candidate)) {
    throw new Error("Unexpected GitHub response list");
  }
  return candidate;
}
function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} does not match the release identity`);
  }
}
async function allPages(
  read: ReadGitHub,
  endpoint: string,
  key: string,
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  for (let page = 1; ; page += 1) {
    const batch = array(
      record(
        await read(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`),
      )[key],
    ).map(record);
    entries.push(...batch);
    if (batch.length < 100) {
      return entries;
    }
  }
}
async function mainAt(read: ReadGitHub, commit: string): Promise<void> {
  requireEqual(record(record(await read("git/ref/heads/main")).object).sha, commit, "Current main");
}

function assertContext(context: ReleaseContext): void {
  requireEqual(context.repository, "zakideee/svgent", "Repository");
  requireEqual(context.ref, "refs/heads/main", "Dispatch ref");
  requireEqual(
    context.workflowRef,
    "zakideee/svgent/.github/workflows/release.yml@refs/heads/main",
    "Workflow ref",
  );
  requireEqual(context.workflowSha, context.commit, "Workflow source");
  if (!/^[a-f\d]{40}$/u.test(context.commit) || !/^[a-f\d]{40}$/u.test(context.tree)) {
    throw new Error("Commit and tree must be full hashes");
  }
  if (context.authMode !== "oidc" && context.authMode !== "bootstrap") {
    throw new Error("Unknown publication mode");
  }
}
async function verifyEnvironment(read: ReadGitHub): Promise<void> {
  const environment = record(await read("environments/npm-publish"));
  const protections = array(environment.protection_rules).map(record);
  const required = protections.find((rule) => rule.type === "required_reviewers");
  if (
    !required ||
    array(required.reviewers).length !== 1 ||
    record(record(array(required.reviewers)[0]).reviewer).login !== "zakideee"
  ) {
    throw new Error("npm-publish must require the maintainer's approval");
  }
  requireEqual(required.prevent_self_review, false, "Maintainer self-approval");
  const policy = record(environment.deployment_branch_policy);
  if (policy.protected_branches === true) {
    return;
  }
  requireEqual(policy.custom_branch_policies, true, "Environment branch policy");
  const branches = array(
    record(await read("environments/npm-publish/deployment-branch-policies")).branch_policies,
  ).map(record);
  if (branches.length !== 1 || branches[0]?.name !== "main" || branches[0]?.type !== "branch") {
    throw new Error("npm-publish must select main only");
  }
}

async function verifyWorkflowChecks(
  read: ReadGitHub,
  commit: string,
  request: { workflow: string; names: string[] },
): Promise<void> {
  const { workflow, names } = request;
  const runs = await allPages(
    read,
    `actions/workflows/${workflow}/runs?head_sha=${commit}&event=push&branch=main`,
    "workflow_runs",
  );
  const current = runs
    .filter(
      (run) =>
        run.head_sha === commit &&
        run.event === "push" &&
        run.head_branch === "main" &&
        run.path === `.github/workflows/${workflow}`,
    )
    .sort((left, right) => Number(right.run_number) - Number(left.run_number))[0];
  if (!current || current.status !== "completed" || current.conclusion !== "success") {
    throw new Error(`${workflow} needs its latest main-push run to succeed`);
  }
  const runId = Number(current.id);
  const attempt = Number(current.run_attempt);
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Invalid check run identity");
  }
  const jobs = await allPages(read, `actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs");
  const checks = await allPages(read, `commits/${commit}/check-runs?filter=all`, "check_runs");
  for (const name of names) {
    const job = jobs.find((entry) => entry.name === name);
    if (!job || job.status !== "completed" || job.conclusion !== "success") {
      throw new Error(`Required job ${name} did not succeed`);
    }
    const check = checks.find((entry) => entry.name === name && entry.url === job.check_run_url);
    if (
      !check ||
      check.head_sha !== commit ||
      check.status !== "completed" ||
      check.conclusion !== "success" ||
      record(check.app).id !== 15368 ||
      record(check.check_suite).id !== current.check_suite_id
    ) {
      throw new Error(`Required check ${name} has the wrong source or application`);
    }
  }
  const after = record(await read(`actions/runs/${runId}`));
  requireEqual(after.run_attempt, attempt, "Latest check attempt");
  requireEqual(after.conclusion, "success", "Latest check conclusion");
}

/** Verify source, protected environment, and the exact main-push check identities. */
export async function verifyReleaseState(context: ReleaseContext, read: ReadGitHub): Promise<void> {
  assertContext(context);
  const repository = record(await read(""));
  requireEqual(repository.full_name, "zakideee/svgent", "Public repository");
  requireEqual(repository.private, false, "Repository visibility");
  requireEqual(repository.default_branch, "main", "Default branch");
  await mainAt(read, context.commit);
  const source = record(await read(`commits/${context.commit}`));
  requireEqual(source.sha, context.commit, "Release commit");
  requireEqual(record(record(source.commit).tree).sha, context.tree, "Release tree");
  await verifyEnvironment(read);
  await verifyWorkflowChecks(read, context.commit, { workflow: "ci.yml", names: ["quality"] });
  await verifyWorkflowChecks(read, context.commit, {
    workflow: "security.yml",
    names: ["gitleaks", "workflow-lint"],
  });
  await verifyWorkflowChecks(read, context.commit, {
    workflow: "cli-consumer.yml",
    names: [
      "consumer (ubuntu-latest, 20)",
      "consumer (ubuntu-latest, 24)",
      "consumer (windows-latest, 20)",
      "consumer (windows-latest, 24)",
    ],
  });
  await mainAt(read, context.commit);
}

async function main(): Promise<void> {
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new Error("Release requires an explicit dispatch");
  }
  const event = record(
    JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as unknown,
  );
  const inputs = record(event.inputs);
  requireEqual(inputs.target, "npm-cli", "Release target");
  requireEqual(inputs["settings-confirmed"], "true", "Maintainer settings confirmation");
  const context: ReleaseContext = {
    repository: process.env.GITHUB_REPOSITORY ?? "",
    ref: process.env.GITHUB_REF ?? "",
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? "",
    workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? "",
    commit: String(inputs["release-commit"]),
    tree: String(inputs["source-tree"]),
    authMode: String(inputs["auth-mode"]),
  };
  assertContext(context);
  requireEqual(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    context.commit,
    "Checkout",
  );
  requireEqual(
    execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    context.tree,
    "Checkout tree",
  );
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { stdio: "pipe" });
  const manifest = record(
    JSON.parse(await readFile("packages/cli/package.json", "utf8")) as unknown,
  );
  requireEqual(manifest.name, "@svgent/cli", "Package");
  requireEqual(manifest.version, "0.1.0", "Version");
  requireEqual(
    record(manifest.repository).url,
    "https://github.com/zakideee/svgent.git",
    "Package source URL",
  );
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("The workflow read token is unavailable");
  }
  const read: ReadGitHub = async (endpoint) => {
    const response = await fetch(
      `https://api.github.com/repos/zakideee/svgent${endpoint ? `/${endpoint}` : ""}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub read failed with HTTP ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  };
  await verifyReleaseState(context, read);
  const frontier = await fetch("https://registry.npmjs.org/@svgent%2fcli");
  if (frontier.status !== 404 && !frontier.ok) {
    throw new Error(`Registry read failed with HTTP ${frontier.status}`);
  }
  if (context.authMode === "bootstrap" && frontier.status !== 404) {
    throw new Error("Bootstrap requires an unpublished package");
  }
  if (context.authMode === "oidc" && frontier.status === 404) {
    throw new Error("OIDC requires an existing package and current publisher settings");
  }
  if (frontier.ok && record(record(await frontier.json()).versions)["0.1.0"] !== undefined) {
    throw new Error("The target version already exists");
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, commit: context.commit, tree: context.tree, target: "@svgent/cli@0.1.0", authMode: context.authMode })}\n`,
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
