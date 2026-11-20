import type { Batch } from "../model/assessment.ts";
import type { Invocation } from "./arguments.ts";
import { formatSize, quote } from "./human-output.ts";

// Inventory is read-only. A size estimate is NOT a deletion-safety verdict.
export function presentStorage(
  batch: Batch,
  invocation: Pick<Invocation, "json" | "lang">,
) {
  const repositories = [...batch.assessments].sort((left, right) =>
    (right.metadata.size_bytes ?? -1) - (left.metadata.size_bytes ?? -1) ||
    left.repository.path.localeCompare(right.repository.path),
  );
  const knownBytes = repositories.reduce(
    (sum, item) => sum + (item.metadata.size_bytes ?? 0),
    0,
  );
  const unknownSizeCount = repositories.filter(
    (item) => item.metadata.size_bytes === null,
  ).length;
  const summary = {
    scanned: repositories.length,
    total_size_bytes_estimate: knownBytes,
    size_unknown_count: unknownSizeCount,
    // Moving to a trash directory on the same filesystem does not reclaim space.
    note: "Sizes are logical estimates; status is not a deletion instruction.",
  };
  const result = {
    schema_version: 1,
    repositories: repositories.map((item) => ({
      path: item.repository.path,
      name: item.repository.name,
      size_bytes: item.metadata.size_bytes,
      last_commit_at: item.metadata.last_commit_at,
      last_commit_status: item.metadata.last_commit_status ?? "unavailable",
      status: item.status,
      reason_codes: [...new Set(item.reasons.map((reason) => reason.code))],
    })),
    summary,
    errors: batch.errors,
  };
  const ja = invocation.lang === "ja";
  const stdout = invocation.json
    ? JSON.stringify(result)
    : [
        ja
          ? `リポジトリ: ${summary.scanned}件 / 合計概算: ${formatSize(knownBytes, true)} / サイズ不明: ${unknownSizeCount}件`
          : `Repositories: ${summary.scanned} / Estimated total: ${formatSize(knownBytes, false)} / Unknown sizes: ${unknownSizeCount}`,
        "",
        ...result.repositories.map((item) =>
          `${formatSize(item.size_bytes, ja).padEnd(12)}  [${item.status}]  ${quote(item.path)}  ${item.last_commit_at ?? (item.last_commit_status === "none" ? "no commits" : "unknown date")}`,
        ),
        "",
        ja
          ? "容量は論理サイズの概算です。削除判断には inspect を使用してください。"
          : "Sizes are logical estimates. Use inspect before making deletion decisions.",
      ].join("\n");
  return {
    stdout,
    stderr: batch.errors.map((error) => `${error.code}: ${error.message}`).join("\n"),
    exitCode: (repositories.some((item) => item.status === "UNKNOWN") || batch.errors.length ? 1 : 0) as 0 | 1,
  };
}
