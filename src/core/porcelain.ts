export function statusCodes(
	output: string,
): readonly ("STAGED_CHANGES" | "UNSTAGED_CHANGES" | "UNTRACKED_FILES")[] {
	if (output === "") return [];
	if (!output.endsWith("\0")) throw new Error("Incomplete status output");
	const records = output.slice(0, -1).split("\0");
	const codes = new Set<
		"STAGED_CHANGES" | "UNSTAGED_CHANGES" | "UNTRACKED_FILES"
	>();
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record || record.length < 4 || record[2] !== " ")
			throw new Error("Invalid status record");
		const x = record[0] ?? "";
		const y = record[1] ?? "";
		if (x === "?" && y === "?") codes.add("UNTRACKED_FILES");
		else {
			if (!" MADRCUT".includes(x) || !" MADRCUT".includes(y))
				throw new Error("Invalid status code");
			if (x !== " ") codes.add("STAGED_CHANGES");
			if (y !== " ") codes.add("UNSTAGED_CHANGES");
			if ("RC".includes(x) || "RC".includes(y)) {
				if (!records[++index]) throw new Error("Missing rename source");
			}
		}
	}
	return [...codes];
}
