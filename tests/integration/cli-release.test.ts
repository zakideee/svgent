/** Check release identity against read-only GitHub observations. */
import { describe, expect, it } from "vitest";
import { type ReleaseContext, verifyReleaseState } from "../../scripts/verify-cli-release.mjs";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const CONTEXT: ReleaseContext = {
  repository: "zakideee/svgent",
  ref: "refs/heads/main",
  workflowRef: "zakideee/svgent/.github/workflows/release.yml@refs/heads/main",
  workflowSha: COMMIT,
  commit: COMMIT,
  tree: TREE,
  authMode: "oidc",
};
function observations() {
  const run = (id: number, workflow: string) => ({
    id,
    run_number: id,
    run_attempt: 2,
    check_suite_id: id + 100,
    head_sha: COMMIT,
    event: "push",
    head_branch: "main",
    path: `.github/workflows/${workflow}`,
    status: "completed",
    conclusion: "success",
  });
  const job = (id: number, name: string) => ({
    name,
    status: "completed",
    conclusion: "success",
    check_run_url: `https://api.github.com/check-runs/${id}`,
  });
  const check = (id: number, name: string, suite: number) => ({
    name,
    head_sha: COMMIT,
    status: "completed",
    conclusion: "success",
    app: { id: 15368 },
    check_suite: { id: suite },
    url: `https://api.github.com/check-runs/${id}`,
  });
  const consumerNames = [
    "consumer (ubuntu-latest, 20)",
    "consumer (ubuntu-latest, 24)",
    "consumer (windows-latest, 20)",
    "consumer (windows-latest, 24)",
  ];
  return new Map<string, unknown>([
    ["", { full_name: "zakideee/svgent", private: false, default_branch: "main" }],
    ["git/ref/heads/main", { object: { sha: COMMIT } }],
    [`commits/${COMMIT}`, { sha: COMMIT, commit: { tree: { sha: TREE } } }],
    [
      "environments/npm-publish",
      {
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: false,
            reviewers: [{ reviewer: { login: "zakideee" } }],
          },
        ],
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      },
    ],
    [
      "environments/npm-publish/deployment-branch-policies",
      { branch_policies: [{ name: "main", type: "branch" }] },
    ],
    [
      `actions/workflows/ci.yml/runs?head_sha=${COMMIT}&event=push&branch=main&per_page=100&page=1`,
      { workflow_runs: [run(1, "ci.yml")] },
    ],
    [
      `actions/workflows/security.yml/runs?head_sha=${COMMIT}&event=push&branch=main&per_page=100&page=1`,
      { workflow_runs: [run(2, "security.yml")] },
    ],
    [
      `actions/workflows/cli-consumer.yml/runs?head_sha=${COMMIT}&event=push&branch=main&per_page=100&page=1`,
      { workflow_runs: [run(3, "cli-consumer.yml")] },
    ],
    [
      "actions/runs/3/attempts/2/jobs?per_page=100&page=1",
      { jobs: consumerNames.map((name, index) => job(index + 10, name)) },
    ],
    ["actions/runs/1/attempts/2/jobs?per_page=100&page=1", { jobs: [job(1, "quality")] }],
    [
      "actions/runs/2/attempts/2/jobs?per_page=100&page=1",
      { jobs: [job(2, "gitleaks"), job(3, "workflow-lint")] },
    ],
    [
      `commits/${COMMIT}/check-runs?filter=all&per_page=100&page=1`,
      {
        check_runs: [
          check(1, "quality", 101),
          check(2, "gitleaks", 102),
          check(3, "workflow-lint", 102),
          ...consumerNames.map((name, index) => check(index + 10, name, 103)),
        ],
      },
    ],
    ["actions/runs/1", { run_attempt: 2, conclusion: "success" }],
    ["actions/runs/2", { run_attempt: 2, conclusion: "success" }],
    ["actions/runs/3", { run_attempt: 2, conclusion: "success" }],
  ]);
}
function reader(source: Map<string, unknown>) {
  return async (endpoint: string): Promise<unknown> => {
    if (!source.has(endpoint)) {
      throw new Error(`Missing test observation: ${endpoint}`);
    }
    return source.get(endpoint);
  };
}

describe("CLI release source guard", () => {
  it("accepts the exact public main workflow, tree, and current successful check attempts", async () => {
    await expect(verifyReleaseState(CONTEXT, reader(observations()))).resolves.toBeUndefined();
  });
  it.each([
    { repository: "zakideee/svgent-dev" },
    { ref: "refs/heads/feature" },
    { workflowSha: "c".repeat(40) },
    { workflowRef: "zakideee/svgent/.github/workflows/release.yml@refs/heads/feature" },
  ])("rejects a different dispatch identity: %j", async (override) => {
    await expect(
      verifyReleaseState({ ...CONTEXT, ...override }, reader(observations())),
    ).rejects.toThrow();
  });
  it("rejects a failed newer run even when an older run succeeded", async () => {
    const source = observations();
    const endpoint = `actions/workflows/ci.yml/runs?head_sha=${COMMIT}&event=push&branch=main&per_page=100&page=1`;
    const old = (source.get(endpoint) as { workflow_runs: Record<string, unknown>[] })
      .workflow_runs[0]!;
    source.set(endpoint, {
      workflow_runs: [old, { ...old, id: 4, run_number: 4, conclusion: "failure" }],
    });
    await expect(verifyReleaseState(CONTEXT, reader(source))).rejects.toThrow("latest");
  });
  it("rejects a same-name check from another application", async () => {
    const source = observations();
    const endpoint = `commits/${COMMIT}/check-runs?filter=all&per_page=100&page=1`;
    const response = source.get(endpoint) as { check_runs: Record<string, unknown>[] };
    response.check_runs[0]!.app = { id: 42 };
    await expect(verifyReleaseState(CONTEXT, reader(source))).rejects.toThrow("application");
  });
  it("rejects a rerun that starts during verification", async () => {
    const source = observations();
    source.set("actions/runs/1", { run_attempt: 3, conclusion: null });
    await expect(verifyReleaseState(CONTEXT, reader(source))).rejects.toThrow("attempt");
  });
  it("rejects main moving between the check observations", async () => {
    const source = observations();
    const read = reader(source);
    let mainReads = 0;
    await expect(
      verifyReleaseState(CONTEXT, async (endpoint) => {
        if (endpoint === "git/ref/heads/main" && ++mainReads > 1) {
          return { object: { sha: "c".repeat(40) } };
        }
        return read(endpoint);
      }),
    ).rejects.toThrow("main");
  });
  it("rejects an environment that permits another reviewer to approve alone", async () => {
    const source = observations();
    const environment = source.get("environments/npm-publish") as {
      protection_rules: { reviewers: { reviewer: { login: string } }[] }[];
    };
    environment.protection_rules[0]!.reviewers.push({ reviewer: { login: "another-maintainer" } });
    await expect(verifyReleaseState(CONTEXT, reader(source))).rejects.toThrow("approval");
  });
  it("requires a protected environment that restricts deployment branches", async () => {
    const source = observations();
    source.set("environments/npm-publish", {
      protection_rules: [],
      deployment_branch_policy: null,
    });
    await expect(verifyReleaseState(CONTEXT, reader(source))).rejects.toThrow("approval");
  });
});
