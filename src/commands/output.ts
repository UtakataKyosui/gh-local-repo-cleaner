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
					...repo.reasons.map((reason) => `  ${reason.code}: ${reason.action}`),
				]),
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
