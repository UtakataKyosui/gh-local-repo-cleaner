import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import { CommandRunner } from "./command.ts";
import { diagnose, type Finding, finding } from "./diagnosis.ts";

export interface InspectionRequest {
	readonly path: string;
	readonly excluded?: boolean;
}

// Online reachability, reflogs and unreachable objects still need a verifier.
// Every live inspection carries ONLINE_NOT_VERIFIED until that exists.
export class RepositoryInspector extends Context.Service<
	RepositoryInspector,
	{
		readonly inspect: (
			request: InspectionRequest,
		) => Effect.Effect<readonly Finding[]>;
	}
>()("RepositoryInspector") {}

export const RepositoryInspectorLive = Layer.effect(
	RepositoryInspector,
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		return {
			inspect: (request: InspectionRequest) =>
				Effect.gen(function* () {
					const findings: Finding[] = [finding("ONLINE_NOT_VERIFIED")];
					if (request.excluded) findings.push(finding("EXCLUDED"));
					const git = (...args: string[]) =>
						runner.run({
							executable: "git",
							args: ["--no-optional-locks", "-C", request.path, ...args],
						});
					const check = <E>(
						effect: Effect.Effect<boolean, E>,
						code: Parameters<typeof finding>[0],
					) =>
						effect.pipe(
							Effect.tap((present) =>
								Effect.sync(() => {
									if (present) findings.push(finding(code));
								}),
							),
							Effect.catch(() =>
								Effect.sync(() => {
									findings.push(finding("INSPECTION_FAILED"));
								}),
							),
						);
					const layout = Effect.tryPromise(async () => {
						const path = await realpath(request.path);
						const stat = await lstat(join(path, ".git"));
						return (
							!stat.isDirectory() ||
							stat.isSymbolicLink() ||
							path !== resolve(request.path)
						);
					});
					yield* check(layout, "UNSUPPORTED_LAYOUT");
					for (const [args, code, predicate] of [
						[
							["rev-parse", "--is-bare-repository"],
							"UNSUPPORTED_LAYOUT",
							(s: string) => s.trim() !== "false",
						],
						[
							["rev-parse", "--is-shallow-repository"],
							"UNSUPPORTED_LAYOUT",
							(s: string) => s.trim() !== "false",
						],
						[
							[
								"status",
								"--porcelain=v1",
								"-z",
								"--untracked-files=all",
								"--ignore-submodules=none",
							],
							"LOCAL_CHANGES",
							(s: string) => s.length > 0,
						],
						[
							["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
							"IGNORED_FILES",
							(s: string) => s.length > 0,
						],
						[
							["stash", "list", "--format=%H"],
							"STASH",
							(s: string) => s.trim().length > 0,
						],
						[
							["for-each-ref", "--format=%(refname)", "refs/tags/"],
							"LOCAL_TAGS",
							(s: string) => s.trim().length > 0,
						],
						[
							["worktree", "list", "--porcelain", "-z"],
							"EXTRA_WORKTREES",
							(s: string) =>
								s.split("\0").filter((v) => v.startsWith("worktree ")).length >
								1,
						],
						[
							["ls-files", "--stage", "-z"],
							"SUBMODULES",
							(s: string) => s.split("\0").some((v) => v.startsWith("160000 ")),
						],
						[
							["for-each-ref", "--format=%(upstream)", "refs/heads/"],
							"MISSING_UPSTREAM",
							(s: string) =>
								s === "" ||
								s
									.slice(0, -1)
									.split("\n")
									.some((v) => v === ""),
						],
						[["remote"], "NO_REMOTE", (s: string) => s.trim() === ""],
					] as const) {
						yield* check(git(...args).pipe(Effect.map(predicate)), code);
					}
					yield* check(
						git("symbolic-ref", "-q", "HEAD").pipe(
							Effect.as(false),
							Effect.catchIf(
								(e) => e.kind === "exit" && e.exitCode === 1,
								() => Effect.succeed(true),
							),
						),
						"DETACHED_HEAD",
					);
					return findings;
				}),
		};
	}),
);

export const inspectRepository = (request: InspectionRequest) =>
	Effect.gen(function* () {
		const inspector = yield* RepositoryInspector;
		return diagnose(request.path, yield* inspector.inspect(request));
	});

// Inspection failures are findings, so a missing repository does not stop the batch.
export const inspectRepositories = (requests: readonly InspectionRequest[]) =>
	Effect.forEach(requests, inspectRepository, { concurrency: 1 });
