/**
 * Several studios in one document share one drawer of device storage and one
 * registry of blob URLs. What is saved, what was restored, and which URLs are
 * still readable must each answer for one studio, not for whichever mounted
 * last.
 */
import { readFile } from "node:fs/promises";
import { serializeProject } from "@svgent/scene";
import { describe, expect, it } from "vitest";
import { storageNamespaceFor } from "../src/App.js";
import { freshProjectFor, initialProject, restoreNoticeText } from "../src/autosave.js";
import { createExportUrls } from "../src/exports.js";
import {
  claimPersistenceNamespace,
  createLocalStoragePersistence,
  ownsPersistenceNamespace,
  readOnlyPersistence,
  releasePersistenceNamespace,
  type StudioPersistence,
  subscribeToPersistenceNamespaces,
} from "../src/persistence.js";
import type { StudioProductConfig } from "../src/public-types.js";

const PRODUCT: StudioProductConfig = {
  name: "svgent",
  version: "0",
  engineVersion: "0",
  storageKeyPrefix: "svgent",
};

/** A Storage the test can read raw keys out of. */
function recordingStorage(): { keys: Map<string, string>; storage: Storage } {
  const keys = new Map<string, string>();
  return {
    keys,
    storage: {
      getItem: (key: string) => keys.get(key) ?? null,
      setItem: (key: string, value: string) => {
        keys.set(key, value);
      },
      removeItem: (key: string) => {
        keys.delete(key);
      },
      clear: () => keys.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage,
  };
}

function memoryPersistence(seed: Record<string, string> = {}): StudioPersistence & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

describe("a studio's restore state belongs to that studio", () => {
  /*
   * The flags used to live in module variables that `initialProject` reset on
   * every call, so the second studio to initialise answered for both: it could
   * not be asked what *it* opened on. Two initialisations, read afterwards, is
   * the shape the old code could not satisfy.
   */
  it("answers for each initialisation, not for the last one", () => {
    const saved = memoryPersistence({
      project: serializeProject(freshProjectFor("en")),
      "autosave-omitted-images": "3",
    });
    const empty = memoryPersistence();

    const restored = initialProject(saved, "en");
    const fresh = initialProject(empty, "en");

    expect(restored.restored).toBe(true);
    expect(restored.omittedImages).toBe(3);
    expect(fresh.restored).toBe(false);
    expect(fresh.omittedImages).toBe(0);
  });

  it("reads a corrupt autosave as a fresh start", () => {
    const opened = initialProject(memoryPersistence({ project: "{" }), "en");
    expect(opened.restored).toBe(false);
  });

  it("names the omitted images it was handed", () => {
    const t = {
      restoreNotice: "Restored.",
      restoreNoImages: (count: number) => `${count} images left out.`,
    } as Parameters<typeof restoreNoticeText>[0];
    expect(restoreNoticeText(t, 0)).toBe("Restored.");
    expect(restoreNoticeText(t, 2)).toBe("Restored. 2 images left out.");
  });

  it("keeps no restore state of its own", async () => {
    const source = await readFile(new URL("../src/autosave.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^let /mu);
  });
});

describe("one namespace, one writer", () => {
  it("hands the drawer to whoever joined the queue first", () => {
    const first = Symbol("first");
    const second = Symbol("second");
    claimPersistenceNamespace("svgent", first);
    claimPersistenceNamespace("svgent", second);
    expect(ownsPersistenceNamespace("svgent", first)).toBe(true);
    expect(ownsPersistenceNamespace("svgent", second)).toBe(false);
    releasePersistenceNamespace("svgent", first);
    releasePersistenceNamespace("svgent", second);
  });

  /*
   * The failure this replaces is worse than the overwrite it was meant to
   * prevent: two studios open, the second stops saving, the host then unmounts
   * the first — and the only studio left silently keeps nothing, for as long
   * as the session lasts.
   */
  it("promotes the next studio when the writer leaves", () => {
    const leaving = Symbol("leaving");
    const waiting = Symbol("waiting");
    claimPersistenceNamespace("svgent", leaving);
    claimPersistenceNamespace("svgent", waiting);
    expect(ownsPersistenceNamespace("svgent", waiting)).toBe(false);
    releasePersistenceNamespace("svgent", leaving);
    expect(ownsPersistenceNamespace("svgent", waiting)).toBe(true);
    releasePersistenceNamespace("svgent", waiting);
  });

  it("says nobody owns a namespace no studio has joined", () => {
    expect(ownsPersistenceNamespace("svgent-unclaimed", Symbol("nobody"))).toBe(false);
  });

  it("separates namespaces so a studio given its own id still writes", () => {
    const a = Symbol("a");
    const b = Symbol("b");
    claimPersistenceNamespace("svgent-left", a);
    claimPersistenceNamespace("svgent-right", b);
    expect(ownsPersistenceNamespace("svgent-left", a)).toBe(true);
    expect(ownsPersistenceNamespace("svgent-right", b)).toBe(true);
    releasePersistenceNamespace("svgent-left", a);
    releasePersistenceNamespace("svgent-right", b);
  });

  it("ignores a release from a studio that never joined", () => {
    const holder = Symbol("holder");
    claimPersistenceNamespace("svgent", holder);
    releasePersistenceNamespace("svgent", Symbol("stranger"));
    expect(ownsPersistenceNamespace("svgent", holder)).toBe(true);
    releasePersistenceNamespace("svgent", holder);
  });

  it("joins once, so a repeated claim never takes a second place in the queue", () => {
    const first = Symbol("first");
    const second = Symbol("second");
    claimPersistenceNamespace("svgent", first);
    claimPersistenceNamespace("svgent", second);
    claimPersistenceNamespace("svgent", second);
    releasePersistenceNamespace("svgent", first);
    expect(ownsPersistenceNamespace("svgent", second)).toBe(true);
    releasePersistenceNamespace("svgent", second);
    expect(ownsPersistenceNamespace("svgent", second)).toBe(false);
  });

  it("tells the studios watching when the queue changes", () => {
    const seen: number[] = [];
    const stop = subscribeToPersistenceNamespaces(() => seen.push(seen.length));
    const owner = Symbol("owner");
    claimPersistenceNamespace("svgent", owner);
    releasePersistenceNamespace("svgent", owner);
    stop();
    claimPersistenceNamespace("svgent", owner);
    releasePersistenceNamespace("svgent", owner);
    expect(seen).toHaveLength(2);
  });

  it("opens on what is saved but never writes over it", () => {
    const saved = memoryPersistence({ project: "kept" });
    const reader = readOnlyPersistence(saved);
    expect(reader.getItem("project")).toBe("kept");
    reader.setItem("project", "overwritten");
    reader.removeItem("project");
    expect(saved.entries.get("project")).toBe("kept");
  });

  /*
   * The one assertion standing between an existing user and their autosave: a
   * studio given no `instanceId` has to keep the exact keys it used before.
   */
  it("leaves the drawer's name alone for a studio with no instanceId", () => {
    expect(storageNamespaceFor({ ...PRODUCT, storageKeyPrefix: "svgent" }, undefined)).toBe(
      "svgent",
    );
    expect(storageNamespaceFor({ ...PRODUCT, storageKeyPrefix: "svgent" }, "left")).toBe(
      "svgent-left",
    );
    const device = recordingStorage();
    createLocalStoragePersistence("svgent", device.storage).setItem("project", "saved");
    expect([...device.keys.keys()]).toEqual(["svgent-project"]);
  });
});

describe("a finished render's URL outlives another studio's export", () => {
  /*
   * The registry used to be one module-level map that any runner could clear,
   * so one studio starting an export revoked the URL another studio's preview
   * was reading. It is owned now, which also means a blob that never reaches a
   * registry has no owner to release it — minting and releasing live together
   * so there is nowhere to forget.
   */
  it("gives up only the URLs it minted", () => {
    const mine = createExportUrls();
    const theirs = createExportUrls();
    const myBlob = new Blob(["a"]);
    const theirBlob = new Blob(["b"]);
    const myUrl = mine.url(myBlob);
    const theirUrl = theirs.url(theirBlob);
    expect(myUrl).not.toBe(theirUrl);

    mine.releaseAll();

    // A released blob is minted afresh; another owner's is untouched.
    expect(mine.url(myBlob)).not.toBe(myUrl);
    expect(theirs.url(theirBlob)).toBe(theirUrl);
    mine.releaseAll();
    theirs.releaseAll();
  });

  it("answers with one URL per blob", () => {
    const urls = createExportUrls();
    const blob = new Blob(["a"]);
    expect(urls.url(blob)).toBe(urls.url(blob));
    urls.releaseAll();
  });
});
