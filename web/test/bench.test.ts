import { describe, expect, it } from "vitest";
import { LEGACY_BENCH_KEY, PREFERENCE_KEY, migrateBrowserPreference } from "../lib/bench";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("browser preference migration", () => {
  it("starts empty and removes the legacy key", () => {
    const storage = new MemoryStorage();
    expect(migrateBrowserPreference(storage)).toBe("");
    expect(storage.getItem(LEGACY_BENCH_KEY)).toBeNull();
    expect(storage.getItem(PREFERENCE_KEY)).toBeNull();
  });

  it("moves only a validated legacy email and never preserves runtime records", () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_BENCH_KEY, JSON.stringify({
      email: " person@example.com ", wallet: "0x0000000000000000000000000000000000000001",
      pieces: [{ id: "saved" }], entries: [{ id: "entry" }], agreements: [{ pieceId: "saved" }]
    }));
    expect(migrateBrowserPreference(storage)).toBe("person@example.com");
    expect(storage.getItem(LEGACY_BENCH_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(PREFERENCE_KEY) || "null")).toEqual({ email: "person@example.com" });
  });

  it("keeps a newer valid preference when migration repeats", () => {
    const storage = new MemoryStorage();
    storage.setItem(PREFERENCE_KEY, JSON.stringify({ email: "new@example.com" }));
    storage.setItem(LEGACY_BENCH_KEY, JSON.stringify({ email: "old@example.com" }));
    expect(migrateBrowserPreference(storage)).toBe("new@example.com");
    expect(migrateBrowserPreference(storage)).toBe("new@example.com");
    expect(JSON.parse(storage.getItem(PREFERENCE_KEY) || "null")).toEqual({ email: "new@example.com" });
  });

  it.each(["not json", JSON.stringify({ email: 7 }), JSON.stringify({ email: "not-an-email" })])(
    "discards malformed or invalid legacy data (%s)",
    (legacy) => {
      const storage = new MemoryStorage();
      storage.setItem(LEGACY_BENCH_KEY, legacy);
      expect(migrateBrowserPreference(storage)).toBe("");
      expect(storage.getItem(LEGACY_BENCH_KEY)).toBeNull();
      expect(storage.getItem(PREFERENCE_KEY)).toBeNull();
    }
  );

  it("does not throw when storage is unavailable", () => {
    const unavailable = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); }
    };
    expect(() => migrateBrowserPreference(unavailable)).not.toThrow();
    expect(migrateBrowserPreference(unavailable)).toBe("");
  });
});
