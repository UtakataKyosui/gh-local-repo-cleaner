import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { UsageError } from "../commands/arguments.ts";

type Rule = { kind: "name"; pattern: string } | { kind: "path"; value: string };

// Small slash-aware glob language; consecutive stars do not enable recursion.
export function namePattern(pattern: string): RegExp {
	if (!pattern || pattern.includes("\0")) throw new Error("Invalid pattern");
	const literal = (value: string) =>
		value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "\\") {
			const next = pattern[++i];
			if (next === undefined) throw new Error("Trailing escape");
			source += literal(next);
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (char === "[") {
			let content = "";
			if (pattern[i + 1] === "^") {
				content = "^";
				i++;
			}
			let count = 0;
			while (++i < pattern.length && pattern[i] !== "]") {
				let item = pattern[i];
				if (item === "\\") {
					item = pattern[++i];
					if (item === undefined) throw new Error("Trailing escape");
					content += literal(item).replaceAll("-", "\\-");
				} else content += item === "[" || item === "^" ? `\\${item}` : item;
				count++;
			}
			if (pattern[i] !== "]" || !count) throw new Error("Invalid class");
			source += `(?!/)[${content}]`;
		} else source += literal(char ?? "");
	}
	return new RegExp(`${source}(?![\\s\\S])`, "u");
}

export async function exclusions(path?: string) {
	try {
		const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
		if (!path && !isAbsolute(base)) throw new Error("Invalid config root");
		const file = path ?? join(base, "gh-local-repo-cleaner", "config.json");
		let text: string;
		let missing = false;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			if (!path && (error as NodeJS.ErrnoException).code === "ENOENT") {
				// A dangling config symlink is a read failure, not an absent config.
				try {
					await lstat(file);
					throw error;
				} catch (statError) {
					if (
						statError === error ||
						(statError as NodeJS.ErrnoException).code !== "ENOENT"
					)
						throw statError;
				}
				missing = true;
				text = '{"version":1,"exclude":[]}';
			} else throw error;
		}
		const value = JSON.parse(text);
		if (
			!value ||
			Array.isArray(value) ||
			typeof value !== "object" ||
			value.version !== 1 ||
			Object.keys(value).some((key) => !["version", "exclude"].includes(key)) ||
			!Array.isArray(value.exclude)
		)
			throw new Error("Invalid config");
		const rules: Rule[] = value.exclude.map((rule: Record<string, unknown>) => {
			if (!rule || typeof rule !== "object" || Array.isArray(rule))
				throw new Error("Invalid rule");
			if (
				rule.kind === "name" &&
				typeof rule.pattern === "string" &&
				Object.keys(rule).length === 2
			) {
				namePattern(rule.pattern);
				return { kind: "name", pattern: rule.pattern };
			}
			if (
				rule.kind === "path" &&
				typeof rule.value === "string" &&
				isAbsolute(rule.value) &&
				!rule.value.includes("\0") &&
				Object.keys(rule).length === 2
			)
				return { kind: "path", value: resolve(rule.value) };
			throw new Error("Invalid rule");
		});
		return {
			fingerprint: JSON.stringify([file, missing, text]),
			match: (repo: { name: string; path: string }) =>
				rules.findIndex((rule) =>
					rule.kind === "name"
						? namePattern(rule.pattern).test(repo.name)
						: rule.value === resolve(repo.path),
				),
		};
	} catch {
		throw new UsageError("Invalid or unreadable configuration");
	}
}

const SIZE_CONCURRENCY = 32;

export async function sizeBytes(
	path: string,
	signal?: AbortSignal,
): Promise<number> {
	let active = 0;
	const waiting: (() => void)[] = [];
	const limited = async <T>(task: () => Promise<T>): Promise<T> => {
		if (active >= SIZE_CONCURRENCY)
			await new Promise<void>((resolve) => waiting.push(resolve));
		else active++;
		try {
			return await task();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
	const walk = async (current: string): Promise<number> => {
		signal?.throwIfAborted();
		const stat = await limited(() => lstat(current));
		if (stat.isSymbolicLink()) return 0;
		if (stat.isFile()) return stat.size;
		if (!stat.isDirectory()) throw new Error("Unsupported file type");
		const names = await limited(() => readdir(current));
		const sizes = await Promise.all(
			names.map((name) => walk(join(current, name))),
		);
		const size = sizes.reduce((sum, value) => sum + value, 0);
		if (!Number.isSafeInteger(size)) throw new Error("Size overflow");
		return size;
	};
	return walk(path);
}
