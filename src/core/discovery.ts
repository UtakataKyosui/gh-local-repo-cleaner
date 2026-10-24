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
			const root = resolve(invocation.target);
			const listing = yield* Effect.tryPromise(() =>
				readdir(root).catch((error: NodeJS.ErrnoException) =>
					["ENOENT", "ENOTDIR"].includes(error.code ?? "")
						? null
						: Promise.reject(error),
				),
			);
			if (!listing)
				throw new UsageError("Directory does not exist or is not a directory");
			const names = listing;
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
						return true; // Diagnose this inaccessible candidate individually.
					}
				});
				const bare =
					!candidate &&
					(yield* Effect.tryPromise(async () => {
						try {
							return (
								(await lstat(join(path, "HEAD"))).isFile() &&
								(await lstat(join(path, "objects"))).isDirectory()
							);
						} catch {
							return false;
						}
					}));
				if (candidate || bare)
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
			const worktreeRoot = yield* Effect.tryPromise(async () => {
				let stat: Awaited<ReturnType<typeof lstat>>;
				try {
					stat = await lstat(path);
				} catch {
					return true; // Missing or inaccessible: diagnosed as UNKNOWN.
				}
				if (stat.isSymbolicLink()) return true;
				if (!stat.isDirectory()) return false;
				try {
					await lstat(join(path, ".git"));
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
				}
				try {
					return (
						(await lstat(join(path, "HEAD"))).isFile() &&
						(await lstat(join(path, "objects"))).isDirectory()
					);
				} catch {
					return false;
				}
			});
			if (!worktreeRoot)
				throw new UsageError(
					"Path is not a Git worktree root; specify the repository root itself",
				);
			return [
				{
					source: "directory" as const,
					root: dirname(path),
					path,
					name: basename(path),
				},
			];
		}
		const rootsOutput = yield* runner
			.run({
				executable: "ghq",
				args: ["root", "--all"],
			})
			.pipe(
				Effect.mapError(
					(error) =>
						new Error(
							error.kind === "spawn"
								? "GHQ_NOT_FOUND"
								: error.kind === "timeout"
									? "GHQ_TIMEOUT"
									: "GHQ_COMMAND_FAILED",
						),
				),
			);
		const pathsOutput = yield* runner
			.run({
				executable: "ghq",
				args: ["list", "--full-path"],
			})
			.pipe(
				Effect.mapError(
					(error) =>
						new Error(
							error.kind === "spawn"
								? "GHQ_NOT_FOUND"
								: error.kind === "timeout"
									? "GHQ_TIMEOUT"
									: "GHQ_COMMAND_FAILED",
						),
				),
			);
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
		for (const root of lines(rootsOutput)) {
			yield* Effect.tryPromise(async () => {
				const actual = await realpath(root);
				if (!(await lstat(actual)).isDirectory())
					throw new Error("Invalid ghq root");
			});
			roots.push(resolve(root));
		}
		const fallbackRoot = roots[0];
		if (!fallbackRoot) throw new Error("No ghq roots");
		const repositories: Repository[] = [];
		const seen = new Set<string>();
		for (const raw of lines(pathsOutput)) {
			const path = resolve(raw);
			const root = [...roots]
				.sort((a, b) => b.length - a.length)
				.find((root) => within(root, resolve(path)));
			const identity = yield* Effect.tryPromise(() => realpath(path)).pipe(
				Effect.catch(() => Effect.succeed(path)),
			);
			if (seen.has(identity)) continue;
			seen.add(identity);
			repositories.push({
				source: "ghq",
				root: root ?? fallbackRoot,
				path,
				name: relative(root ?? fallbackRoot, path)
					.split(sep)
					.join("/"),
			});
		}
		if (invocation.operation === "inspect") {
			const matches = repositories.filter(
				(repo) => repo.name === invocation.target,
			);
			if (matches.length === 0)
				throw new UsageError(
					`No ghq repository is named ${JSON.stringify(invocation.target)}; use an absolute path, ./ or ../ for other repositories`,
				);
			if (matches.length > 1)
				throw new UsageError(
					`Repository name ${JSON.stringify(invocation.target)} is ambiguous across ghq roots (${matches.map((repo) => JSON.stringify(repo.path)).join(", ")}); specify an absolute path`,
				);
			return matches;
		}
		return repositories;
	}).pipe(Effect.catchDefect((error) => Effect.fail(error)));
