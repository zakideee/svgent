import {
  buildTimeline,
  deserializeProject,
  paginateMessages,
  type SvgentProject,
  serializeProject,
} from "@svgent/scene";
import { applyScenePatch, type PatchChange, type ScenePatchOperation } from "./patches.js";

type DraftOutlineMessage = {
  id: string;
  role: string;
  characterCount: number;
  hasLocalTiming: boolean;
};

type DraftSnapshot = {
  draftHandle: string;
  revision: number;
  expiresAt: string;
  title: string;
  surface: string;
  pageCount: number;
  pageDurationsMs: number[];
  messages: DraftOutlineMessage[];
};

type DraftCreated = DraftSnapshot & {
  warnings: string[];
};

export type PatchProposal = {
  proposalHandle: string;
  draftHandle: string;
  baseRevision: number;
  expiresAt: string;
  changes: PatchChange[];
  affectedMessageIds: string[];
  before: SvgentProject;
  after: SvgentProject;
  operations: ScenePatchOperation[];
};

type DraftRecord = {
  handle: string;
  revision: number;
  expiresAtMs: number;
  project: SvgentProject;
  history: SvgentProject[];
};

type ProposalRecord = PatchProposal & {
  expiresAtMs: number;
};

type DraftStoreOptions = {
  defaultTtlMs?: number;
  maximumTtlMs?: number;
  maximumDrafts?: number;
  now?: () => number;
};

const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const MAXIMUM_TTL_MS = 2 * 60 * 60 * 1_000;
const MAXIMUM_DRAFTS = 32;
const MAXIMUM_HISTORY = 20;

function mintHandle(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function cloneProject(project: SvgentProject): SvgentProject {
  return structuredClone(project);
}

function projectPageDurations(project: SvgentProject): number[] {
  return paginateMessages(project).map((messages) => buildTimeline(project, messages).durationMs);
}

function snapshot(record: DraftRecord): DraftSnapshot {
  return {
    draftHandle: record.handle,
    revision: record.revision,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    title: record.project.title,
    surface: record.project.surface,
    pageCount: paginateMessages(record.project).length,
    pageDurationsMs: projectPageDurations(record.project),
    messages: record.project.messages.map((message) => ({
      id: message.id,
      role: message.role,
      characterCount: Array.from(message.content).length,
      hasLocalTiming: message.timing !== undefined,
    })),
  };
}

export class DraftStore {
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly proposals = new Map<string, ProposalRecord>();
  private readonly defaultTtlMs: number;
  private readonly maximumTtlMs: number;
  private readonly maximumDrafts: number;
  private readonly now: () => number;

  constructor(options: DraftStoreOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maximumTtlMs = options.maximumTtlMs ?? MAXIMUM_TTL_MS;
    this.maximumDrafts = options.maximumDrafts ?? MAXIMUM_DRAFTS;
    this.now = options.now ?? Date.now;
  }

  private boundedTtl(ttlMs: number | undefined): number {
    const requested = ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(requested) || requested < 60_000) {
      throw new Error("ttlMs must be at least 60000");
    }
    return Math.min(requested, this.maximumTtlMs);
  }

  private prune(): void {
    const nowMs = this.now();
    for (const [handle, draft] of this.drafts) {
      if (draft.expiresAtMs <= nowMs) {
        this.drafts.delete(handle);
      }
    }
    for (const [handle, proposal] of this.proposals) {
      if (proposal.expiresAtMs <= nowMs || !this.drafts.has(proposal.draftHandle)) {
        this.proposals.delete(handle);
      }
    }
  }

  private requireDraft(handle: string): DraftRecord {
    this.prune();
    const record = this.drafts.get(handle);
    if (!record) {
      throw new Error("Draft handle is unknown or expired");
    }
    return record;
  }

  create(scriptJson: string, ttlMs?: number): DraftCreated {
    this.prune();
    if (this.drafts.size >= this.maximumDrafts) {
      throw new Error(`At most ${this.maximumDrafts} live drafts are allowed`);
    }
    const { project, warnings } = deserializeProject(scriptJson);
    const handle = mintHandle("draft");
    const record: DraftRecord = {
      handle,
      revision: 1,
      expiresAtMs: this.now() + this.boundedTtl(ttlMs),
      project: cloneProject(project),
      history: [],
    };
    this.drafts.set(handle, record);
    return { ...snapshot(record), warnings };
  }

  inspect(handle: string): DraftSnapshot {
    return snapshot(this.requireDraft(handle));
  }

  project(handle: string): SvgentProject {
    return cloneProject(this.requireDraft(handle).project);
  }

  propose(
    draftHandle: string,
    expectedRevision: number,
    operations: readonly ScenePatchOperation[],
  ): PatchProposal {
    const draft = this.requireDraft(draftHandle);
    if (draft.revision !== expectedRevision) {
      throw new Error(`Revision conflict: expected ${expectedRevision}, current ${draft.revision}`);
    }
    const applied = applyScenePatch(draft.project, operations);
    if (applied.changes.length === 0) {
      throw new Error("The patch would not change the draft");
    }
    const proposalHandle = mintHandle("proposal");
    const expiresAtMs = Math.min(draft.expiresAtMs, this.now() + this.defaultTtlMs);
    const proposal: ProposalRecord = {
      proposalHandle,
      draftHandle,
      baseRevision: draft.revision,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      changes: applied.changes,
      affectedMessageIds: applied.affectedMessageIds,
      before: cloneProject(draft.project),
      after: cloneProject(applied.project),
      operations: structuredClone([...operations]),
    };
    this.proposals.set(proposalHandle, proposal);
    return this.cloneProposal(proposal);
  }

  private cloneProposal(proposal: ProposalRecord): PatchProposal {
    return {
      proposalHandle: proposal.proposalHandle,
      draftHandle: proposal.draftHandle,
      baseRevision: proposal.baseRevision,
      expiresAt: proposal.expiresAt,
      changes: structuredClone(proposal.changes),
      affectedMessageIds: [...proposal.affectedMessageIds],
      before: cloneProject(proposal.before),
      after: cloneProject(proposal.after),
      operations: structuredClone(proposal.operations),
    };
  }

  proposal(handle: string): PatchProposal {
    this.prune();
    const proposal = this.proposals.get(handle);
    if (!proposal) {
      throw new Error("Proposal handle is unknown or expired");
    }
    return this.cloneProposal(proposal);
  }

  apply(proposalHandle: string, expectedRevision: number): DraftSnapshot {
    const proposal = this.proposal(proposalHandle);
    const draft = this.requireDraft(proposal.draftHandle);
    if (draft.revision !== expectedRevision || proposal.baseRevision !== expectedRevision) {
      throw new Error(
        `Revision conflict: proposal is based on ${proposal.baseRevision}, current ${draft.revision}`,
      );
    }
    draft.history.push(cloneProject(draft.project));
    if (draft.history.length > MAXIMUM_HISTORY) {
      draft.history.shift();
    }
    draft.project = cloneProject(proposal.after);
    draft.revision += 1;
    this.proposals.delete(proposalHandle);
    return snapshot(draft);
  }

  undo(draftHandle: string, expectedRevision: number): DraftSnapshot {
    const draft = this.requireDraft(draftHandle);
    if (draft.revision !== expectedRevision) {
      throw new Error(`Revision conflict: expected ${expectedRevision}, current ${draft.revision}`);
    }
    const previous = draft.history.pop();
    if (!previous) {
      throw new Error("This draft has no applied patch to undo");
    }
    draft.project = previous;
    draft.revision += 1;
    return snapshot(draft);
  }

  export(draftHandle: string): string {
    return serializeProject(this.requireDraft(draftHandle).project);
  }

  close(draftHandle: string): boolean {
    const deleted = this.drafts.delete(draftHandle);
    for (const [handle, proposal] of this.proposals) {
      if (proposal.draftHandle === draftHandle) {
        this.proposals.delete(handle);
      }
    }
    return deleted;
  }
}
