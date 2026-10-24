import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { UsageError } from "../commands/arguments.ts";

export async function exclusions(path?: string): Promise<readonly string[]> {
	if (!path) return [];
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).some((key) => key !== "exclude")
		)
			throw new Error();
		const patterns = (value as { exclude?: unknown }).exclude;
		if (
			!Array.isArray(patterns) ||
			patterns.some((pattern) => typeof pattern !== "string" || pattern === "")
		)
			throw new Error();
		for (const pattern of patterns) new Bun.Glob(pattern);
		return Object.freeze([...patterns]);
	} catch {
		throw new UsageError("Invalid or unreadable configuration");
	}
}

export async function sizeBytes(
	path: string,
	signal?: AbortSignal,
): Promise<number> {
	signal?.throwIfAborted();
	const stat = await lstat(path);
	if (stat.isSymbolicLink() || stat.isFile()) return stat.size;
	if (!stat.isDirectory()) throw new Error("Unsupported file type");
	let size = 0;
	for (const name of await readdir(path))
		size += await sizeBytes(join(path, name), signal);
	if (!Number.isSafeInteger(size)) throw new Error("Size overflow");
	return size;
}
