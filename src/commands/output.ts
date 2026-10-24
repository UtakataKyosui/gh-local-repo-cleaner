import type { Batch } from "../model/assessment.ts";
import type { Invocation } from "./arguments.ts";
import { formatSize, humanOutput } from "./human-output.ts";
import { text } from "./messages.ts";

const otherGroup = "Other";
const statuses = ["safe", "dirty", "protected", "unknown"] as const;

const palette = {
	SAFE: "32",
	DIRTY: "33",
	PROTECTED: "31",
	UNKNOWN: "35",
	dim: "2",
	bold: "1",
} as const;

export function present(batch: Batch, invocation: Invocation, color = false) {
	const labels = text(invocation.lang);
	const paint = (code: string, text: string) =>
		color ? `\x1b[${code}m${text}\x1b[0m` : text;
	const paintStatus = (status: keyof typeof palette) =>
		paint(`${palette.bold};${palette[status]}`, status);
	const all = [...batch.assessments].sort((a, b) =>
		a.repository.path < b.repository.path
			? -1
			: a.repository.path > b.repository.path
				? 1
				: 0,
	);
	const shown = all
		.filter(
			(item) =>
				!invocation.status || item.status.toLowerCase() === invocation.status,
		)
		.sort((a, b) =>
			invocation.groupBy
				? Number(a.metadata.language === null) -
						Number(b.metadata.language === null) ||
					(a.metadata.language ?? "").localeCompare(b.metadata.language ?? "")
				: 0,
		);
	const groupName = (item?: { metadata: { language: string | null } }) =>
		item && (item.metadata.language ?? otherGroup);
	const groups = new Map<
		string,
		Record<(typeof statuses)[number] | "total", number>
	>();
	if (invocation.groupBy)
		for (const item of shown) {
			const counts = groups.get(groupName(item) as string) ?? {
				total: 0,
				safe: 0,
				dirty: 0,
				protected: 0,
				unknown: 0,
			};
			counts.total++;
			counts[item.status.toLowerCase() as (typeof statuses)[number]]++;
			groups.set(groupName(item) as string, counts);
		}
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
				summary: invocation.groupBy
					? { ...summary, by_language: Object.fromEntries(groups) }
					: summary,
				errors: batch.errors,
			})
		: humanOutput(
				shown,
				invocation,
				[
					labels.totals(
						summary.scanned,
						summary.returned,
						statuses.map(
							(status) =>
								`${paintStatus(status.toUpperCase() as keyof typeof palette)} ${summary[status]}`,
						),
					),
					invocation.lang === "ja"
						? `退避候補: ${summary.safe}件 / 論理サイズ概算: ${formatSize(summary.safe_size_bytes_estimate, true)}; サイズ不明: ${summary.safe_size_unknown_count}件`
						: `Candidates: ${summary.safe}; Logical bytes (estimate): ${formatSize(summary.safe_size_bytes_estimate, false)}; unknown sizes: ${summary.safe_size_unknown_count}`,
				],
				color,
			);

	return {
		stdout,
		stderr: batch.errors
			.map((error) => `${error.code}: ${error.message}`)
			.join("\n"),
		exitCode: (summary.unknown || batch.errors.length ? 1 : 0) as 0 | 1,
	};
}
