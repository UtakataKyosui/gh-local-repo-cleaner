import { lstat, readdir, realpath } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { Effect } from "effect";
import type { Invocation } from "../commands/arguments.ts";
import { UsageError } from "../commands/arguments.ts";
import { CommandRunner } from "../executil/command.ts";
import type { Repository } from "../model/assessment.ts";

export function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		rel !== "" &&
		rel !== ".." &&
		!rel.startsWith(`..${sep}`) &&
		!isAbsolute(rel)
	);
}

export const discover = (invocation: Invocation) =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		if (invocation.target && invocation.operation !== "inspect") {
			const root = yield* Effect.tryPromise(() =>
				realpath(resolve(invocation.target ?? ".")),
			);
			const names = yield* Effect.tryPromise(() => readdir(root));
			const repositories: Repository[] = [];
			for (const name of names.sort()) {
				const path = join(root, name);
				const candidate = yield* Effect.tryPromise(async () => {
					try {
						await lstat(join(path, ".git"));
						return true;
					} catch (error) {
						if (
							["ENOENT", "ENOTDIR"].includes(
								(error as NodeJS.ErrnoException).code ?? "",
							)
						)
							return false;
						throw error;
					}
				});
				if (candidate)
					repositories.push({ source: "directory", root, path, name });
			}
			return repositories;
		}
		if (
			invocation.operation === "inspect" &&
			invocation.target &&
			(isAbsolute(invocation.target) ||
				invocation.target.startsWith("./") ||
				invocation.target.startsWith("../"))
		) {
			const path = resolve(invocation.target);
			return [
				{
					source: "directory" as const,
					root: dirname(path),
					path,
					name: basename(path),
				},
			];
		}
		const rootsOutput = yield* runner.run({
			executable: "ghq",
			args: ["root", "--all"],
		});
		const pathsOutput = yield* runner.run({
			executable: "ghq",
			args: ["list", "--full-path"],
		});
		const lines = (value: string) => {
			if (value === "") return [];
			if (!value.endsWith("\n")) throw new Error("Invalid ghq output");
			const paths = value.slice(0, -1).split("\n");
			if (
				paths.some(
					(path) =>
						!isAbsolute(path) || path.includes("\r") || path.includes("\0"),
				)
			)
				throw new Error("Invalid ghq paths");
			return [...new Set(paths)];
		};
		const roots: string[] = [];
		for (const root of lines(rootsOutput))
			roots.push(yield* Effect.tryPromise(() => realpath(root)));
		if (!roots.length) throw new Error("No ghq roots");
		const repositories: Repository[] = [];
		for (const path of lines(pathsOutput)) {
			const root = [...roots]
				.sort((a, b) => b.length - a.length)
				.find((root) => within(root, resolve(path)));
			if (!root || resolve(path) !== path)
				throw new Error("Invalid ghq boundary");
			repositories.push({
				source: "ghq",
				root,
				path,
				name: relative(root, path),
			});
		}
		if (invocation.operation === "inspect") {
			const matches = repositories.filter(
				(repo) => repo.name === invocation.target,
			);
			if (matches.length !== 1)
				throw new UsageError("Repository name is missing or ambiguous");
			return matches;
		}
		return repositories;
	}).pipe(Effect.catchDefect((error) => Effect.fail(error)));
