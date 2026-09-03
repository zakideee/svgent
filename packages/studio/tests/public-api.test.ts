import {
  createLocalStoragePersistence,
  Studio,
  type StudioPersistence,
  type StudioProps,
} from "@svgent/studio";
import { describe, expect, it } from "vitest";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("Studio public API", () => {
  it("exposes the high-level facade without leaf modules", () => {
    expect(typeof Studio).toBe("function");
  });

  it("namespaces the browser persistence adapter", () => {
    const storage = memoryStorage();
    const persistence = createLocalStoragePersistence("host-one", storage);

    persistence.setItem("project", "one");
    expect(storage.getItem("host-one-project")).toBe("one");
    expect(persistence.getItem("project")).toBe("one");
    persistence.removeItem("project");
    expect(storage.length).toBe(0);
  });

  it("allows hosts to disable or replace persistence", () => {
    const custom: StudioPersistence = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    const disabled: StudioProps = { persistence: false };
    const replaced: StudioProps = { persistence: custom };

    expect(disabled.persistence).toBe(false);
    expect(replaced.persistence).toBe(custom);
  });
});
