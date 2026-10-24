import type { Batch } from "../model/assessment.ts";
import type { Invocation } from "./arguments.ts";

export function present(batch: Batch, invocation: Invocation) {
	const all = [...batch.assessments].sort((a, b) =>
		a.repository.path < b.repository.path
			? -1
			: a.repository.path > b.repository.path
				? 1
				: 0,
	);
	const shown = all.filter(
		(item) =>
			!invocation.status || item.status.toLowerCase() === invocation.status,
	);
	const summary = {
		safe_size_bytes_estimate: all
			.filter((item) => item.status === "SAFE")
			.reduce((total, item) => total + (item.metadata.size_bytes ?? 0), 0),
		safe_size_unknown_count: all.filter(
			(item) => item.status === "SAFE" && item.metadata.size_bytes === null,
		).length,
		scanned: all.length,
		returned: shown.length,
		safe: 0,
		dirty: 0,
		protected: 0,
		unknown: 0,
	};
	for (const item of all)
		summary[
			item.status.toLowerCase() as "safe" | "dirty" | "protected" | "unknown"
		]++;
	const repositories = shown.map(
		({ repository, status, reasons, checked_at, metadata }) => ({
			...repository,
			status,
			reasons: [...reasons].sort((a, b) =>
				a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
			),
			checked_at,
			metadata,
		}),
	);
	const stdout = invocation.json
		? JSON.stringify({
				schema_version: 1,
				repositories,
				summary,
				errors: batch.errors,
			})
		: [
				...repositories.flatMap((repo) => [
					`${repo.status} ${JSON.stringify(repo.path)}`,
					...(invocation.operation === "inspect"
						? [
								`  Source: ${repo.source}; root: ${JSON.stringify(repo.root)}; name: ${JSON.stringify(repo.name)}`,
								`  Checked at: ${repo.checked_at}`,
							]
						: []),
					`  Logical bytes (estimate): ${repo.metadata.size_bytes ?? "unknown"}; last commit: ${repo.metadata.last_commit_at ?? "unknown"}`,
					...(repo.metadata.metadata_errors ?? []).map((error) => `  ${error}`),
					...repo.reasons.map(
						(reason) => `  ${reason.code}: ${reason.message}; ${reason.action}`,
					),
				]),
				`SAFE logical bytes (estimate): ${summary.safe_size_bytes_estimate}; unknown sizes: ${summary.safe_size_unknown_count}`,
				`Scanned ${summary.scanned}; returned ${summary.returned}; SAFE ${summary.safe}; DIRTY ${summary.dirty}; PROTECTED ${summary.protected}; UNKNOWN ${summary.unknown}`,
			].join("\n");
	return {
		stdout,
		stderr: batch.errors
			.map((error) => `${error.code}: ${error.message}`)
			.join("\n"),
		exitCode: (summary.unknown || batch.errors.length ? 1 : 0) as 0 | 1,
	};
}
