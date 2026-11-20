import { describe, expect, test } from "bun:test";
import type { Batch } from "../model/assessment.ts";
import { presentStorage } from "./storage-output.ts";

const batch: Batch = {
  assessments: [
    {
      repository: { source: "ghq", root: "/repos", path: "/repos/small", name: "small" },
      status: "DIRTY",
      reasons: [],
      checked_at: "2026-11-20T00:00:00Z",
      metadata: { size_bytes: 10, last_commit_at: null, last_commit_status: "none", language: null },
      snapshot: null,
    },
    {
      repository: { source: "ghq", root: "/repos", path: "/repos/large", name: "large" },
      status: "SAFE",
      reasons: [],
      checked_at: "2026-11-20T00:00:00Z",
      metadata: { size_bytes: 1000, last_commit_at: "2026-01-01T00:00:00Z", last_commit_status: "available", language: null },
      snapshot: null,
    },
    {
      repository: { source: "ghq", root: "/repos", path: "/repos/unknown", name: "unknown" },
      status: "UNKNOWN",
      reasons: [],
      checked_at: "2026-11-20T00:00:00Z",
      metadata: { size_bytes: null, last_commit_at: null, last_commit_status: "unavailable", language: null },
      snapshot: null,
    },
  ],
  errors: [],
};

describe("storage inventory", () => {
  test("JSON ranks by size, retains unknown values and never exposes a deletion action", () => {
    const result = presentStorage(batch, { json: true, lang: "en" });
    const data = JSON.parse(result.stdout);
    expect(data.repositories.map((repo: { name: string }) => repo.name)).toEqual(["large", "small", "unknown"]);
    expect(data.summary.total_size_bytes_estimate).toBe(1010);
    expect(data.summary.size_unknown_count).toBe(1);
    expect(data.repositories[2].size_bytes).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("delete_command");
  });

  test("human text includes sizes, statuses and paths", () => {
    const result = presentStorage(batch, { json: false, lang: "ja" });
    expect(result.stdout).toContain("/repos/large");
    expect(result.stdout).toContain("SAFE");
    expect(result.stdout).toContain("サイズ不明");
  });
});
