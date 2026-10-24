import { createHash } from "node:crypto";
import { access, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import { CommandRunner } from "../executil/command.ts";
import { diagnose, type Finding, finding } from "./diagnosis.ts";
import { statusCodes } from "./porcelain.ts";
import { snapshot } from "./snapshot.ts";
import { verifyRemoteObjects } from "./verification.ts";

export interface InspectionRequest {
	readonly path: string;
	readonly excluded?: boolean;
}

// Provisional protections are removed only after fresh remote object verification.
export class RepositoryInspector extends Context.Service<
	RepositoryInspector,
	{
		readonly configuration?: (path: string) => Effect.Effect<string, unknown>;
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
			configuration: (path: string) =>
				runner
					.run({
						executable: "git",
						args: ["-C", path, "config", "--null", "--list", "--show-origin"],
					})
					.pipe(
						Effect.map((value) =>
							createHash("sha256").update(value).digest("hex"),
						),
					),
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
							Effect.catchDefect(() =>
								Effect.fail(new Error("Invalid inspection output")),
							),
							Effect.tap((present) =>
								Effect.sync(() => {
									if (present) findings.push(finding(code));
								}),
							),
							Effect.catch(() =>
								Effect.sync(() => {
									findings.push(finding("LOCAL_INSPECTION_FAILED"));
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
					const exists = (path: string) =>
						Effect.tryPromise(async () => {
							try {
								await access(path);
								return true;
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code === "ENOENT")
									return false;
								throw error;
							}
						});
					const configured = (key: string) =>
						git("config", "--get-regexp", key).pipe(
							Effect.map((s) => s.trim().length > 0),
							Effect.catchIf(
								(e) => e.kind === "exit" && e.exitCode === 1,
								() => Effect.succeed(false),
							),
						);
					yield* check(
						configured(
							"^(extensions\\.partialclone|remote\\..*\\.promisor|core\\.sparsecheckout)$",
						),
						"UNSUPPORTED_LAYOUT",
					);
					yield* check(
						exists(join(request.path, ".gitmodules")),
						"SUBMODULE_PRESENT",
					);
					yield* check(
						exists(join(request.path, ".git", "modules")),
						"SUBMODULE_PRESENT",
					);
					for (const name of [
						"MERGE_HEAD",
						"REBASE_HEAD",
						"rebase-apply",
						"rebase-merge",
						"CHERRY_PICK_HEAD",
						"REVERT_HEAD",
						"BISECT_LOG",
						"sequencer",
					]) {
						yield* check(
							exists(join(request.path, ".git", name)),
							"OPERATION_IN_PROGRESS",
						);
					}
					yield* check(
						exists(join(request.path, ".git", "info", "grafts")),
						"UNSUPPORTED_REFS",
					);
					yield* check(
						exists(join(request.path, ".git", "objects", "info", "alternates")),
						"EXTERNAL_GIT_STORAGE",
					);
					yield* check(
						exists(
							join(request.path, ".git", "objects", "info", "http-alternates"),
						),
						"EXTERNAL_GIT_STORAGE",
					);
					for (const name of [
						"objects",
						"refs",
						"logs",
						"index",
						"config",
						"packed-refs",
					]) {
						yield* check(
							Effect.tryPromise(async () => {
								try {
									return (
										await lstat(join(request.path, ".git", name))
									).isSymbolicLink();
								} catch (error) {
									if ((error as NodeJS.ErrnoException).code === "ENOENT")
										return false;
									throw error;
								}
							}),
							"EXTERNAL_GIT_STORAGE",
						);
					}
					yield* check(
						Effect.tryPromise(async () => {
							const local = await realpath(join(request.path, ".git"));
							return local !== join(await realpath(request.path), ".git");
						}),
						"EXTERNAL_GIT_STORAGE",
					);
					yield* check(
						git("rev-parse", "--git-common-dir").pipe(
							Effect.map(
								(s) =>
									resolve(request.path, s.trim()) !==
									join(resolve(request.path), ".git"),
							),
						),
						"EXTERNAL_GIT_STORAGE",
					);
					yield* check(
						git("ls-files", "-v", "-z").pipe(
							Effect.map((s) => s.split("\0").some((v) => /^[a-zS] /.test(v))),
						),
						"HIDDEN_INDEX_STATE",
					);
					yield* check(
						git("for-each-ref", "--format=%(refname)").pipe(
							Effect.map((s) =>
								s
									.trim()
									.split("\n")
									.some(
										(ref) =>
											ref !== "" &&
											!/^refs\/(heads|tags|remotes)\//.test(ref) &&
											ref !== "refs/stash",
									),
							),
						),
						"UNSUPPORTED_REFS",
					);
					yield* check(
						git("rev-parse", "--verify", "HEAD").pipe(
							Effect.as(false),
							Effect.catchIf(
								(e) => e.kind === "exit" && e.exitCode === 128,
								() => Effect.succeed(true),
							),
						),
						"UNBORN_HEAD",
					);
					yield* check(
						git("reflog", "show", "--all", "--format=%H").pipe(
							Effect.map((s) => s.trim().length > 0),
						),
						"REFLOG_ONLY_COMMITS",
					);
					yield* check(
						git(
							"fsck",
							"--full",
							"--unreachable",
							"--no-reflogs",
							"--no-progress",
						).pipe(
							Effect.map((s) => {
								if (s === "") return false;
								const lines = s.trim().split("\n");
								if (
									lines.some(
										(line) =>
											!/^(unreachable|dangling) (commit|tree|blob|tag) [0-9a-f]{40,64}$/.test(
												line,
											),
									)
								)
									throw new Error("Invalid fsck output");
								return true;
							}),
						),
						"UNREACHABLE_OBJECTS",
					);
					yield* check(
						git(
							"status",
							"--porcelain=v1",
							"-z",
							"--untracked-files=all",
							"--ignore-submodules=none",
						).pipe(
							Effect.map((output) => {
								for (const code of statusCodes(output))
									findings.push(finding(code));
								return false;
							}),
						),
						"LOCAL_INSPECTION_FAILED",
					);
					for (const [args, code, predicate] of [
						[
							["rev-parse", "--is-bare-repository"],
							"UNSUPPORTED_LAYOUT",
							(s: string) => {
								if (!["true", "false"].includes(s.trim()))
									throw new Error("Invalid Git boolean");
								return s.trim() === "true";
							},
						],
						[
							["rev-parse", "--is-shallow-repository"],
							"UNSUPPORTED_LAYOUT",
							(s: string) => {
								if (!["true", "false"].includes(s.trim()))
									throw new Error("Invalid Git boolean");
								return s.trim() === "true";
							},
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
							"STASH_PRESENT",
							(s: string) => s.trim().length > 0,
						],
						[
							["for-each-ref", "--format=%(refname)", "refs/tags/"],
							"LOCAL_TAG_ONLY",
							(s: string) => s.trim().length > 0,
						],
						[
							["worktree", "list", "--porcelain", "-z"],
							"WORKTREE_PRESENT",
							(s: string) =>
								s.split("\0").filter((v) => v.startsWith("worktree ")).length >
								1,
						],
						[
							["ls-files", "--stage", "-z"],
							"SUBMODULE_PRESENT",
							(s: string) => s.split("\0").some((v) => v.startsWith("160000 ")),
						],
						[
							["for-each-ref", "--format=%(upstream)", "refs/heads/"],
							"UPSTREAM_MISSING",
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
					const verified = yield* verifyRemoteObjects(request.path).pipe(
						Effect.provideService(CommandRunner, runner),
						Effect.catch(() => Effect.succeed(null)),
					);
					if (verified) {
						const provisional = new Set([
							"ONLINE_NOT_VERIFIED",
							"LOCAL_TAG_ONLY",
							"REFLOG_ONLY_COMMITS",
							"UNREACHABLE_OBJECTS",
							"DETACHED_HEAD",
						]);
						const confirmed = findings.filter(
							(item) => !provisional.has(item.code),
						);
						const objects = (s: string) => s.trim().split("\n").filter(Boolean);
						const validation = Effect.gen(function* () {
							const commits = objects(yield* git("rev-list", "--all", "HEAD"));
							if (commits.some((id) => !verified.objects.has(id)))
								confirmed.push(finding("UNPUSHED_COMMITS"));
							for (const line of objects(
								yield* git(
									"for-each-ref",
									"--format=%(objectname)%09%(refname)",
									"refs/tags/",
								),
							)) {
								const [id, name] = line.split("\t");
								if (!name || !id || !verified.tags.get(name)?.has(id))
									confirmed.push(finding("LOCAL_TAG_ONLY"));
							}
							if (
								objects(
									yield* git("reflog", "show", "--all", "--format=%H"),
								).some((id) => !verified.objects.has(id))
							)
								confirmed.push(finding("REFLOG_ONLY_COMMITS"));
							const unreachable = objects(
								yield* git(
									"fsck",
									"--full",
									"--unreachable",
									"--no-reflogs",
									"--no-progress",
								),
							);
							if (
								unreachable.some(
									(line) => !verified.objects.has(line.split(" ")[2] ?? ""),
								)
							)
								confirmed.push(finding("UNREACHABLE_OBJECTS"));
						});
						yield* validation.pipe(
							Effect.catch(() =>
								Effect.sync(() => {
									confirmed.push(finding("LOCAL_INSPECTION_FAILED"));
								}),
							),
						);
						return confirmed;
					}
					return findings;
				}),
		};
	}),
);

export const inspectRepositorySnapshot = (request: InspectionRequest) =>
	Effect.gen(function* () {
		const inspector = yield* RepositoryInspector;
		const configuration = () =>
			inspector.configuration
				? inspector
						.configuration(request.path)
						.pipe(Effect.catch(() => Effect.succeed(null)))
				: Effect.succeed(null);
		const before = yield* Effect.tryPromise((signal) =>
			snapshot(request.path, signal),
		).pipe(Effect.catch(() => Effect.succeed(null)));
		const configurationBefore = yield* configuration();
		const findings = [...(yield* inspector.inspect(request))];
		const configurationAfter = yield* configuration();
		const after = yield* Effect.tryPromise((signal) =>
			snapshot(request.path, signal),
		).pipe(Effect.catch(() => Effect.succeed(null)));
		if (!before || !after) findings.push(finding("LOCAL_INSPECTION_FAILED"));
		if (
			inspector.configuration &&
			(!configurationBefore || !configurationAfter)
		)
			findings.push(finding("LOCAL_INSPECTION_FAILED"));
		else if (configurationBefore !== configurationAfter)
			findings.push(finding("STATE_CHANGED"));
		else if (JSON.stringify(before) !== JSON.stringify(after))
			findings.push(finding("STATE_CHANGED"));
		return {
			diagnosis: diagnose(request.path, findings),
			complete: !findings.some((item) => item.status === "UNKNOWN"),
			snapshot: after
				? Object.freeze({
						...after,
						...(configurationAfter
							? { configuration: configurationAfter }
							: {}),
					})
				: null,
		};
	});

export const inspectRepository = (request: InspectionRequest) =>
	inspectRepositorySnapshot(request).pipe(
		Effect.map((result) => result.diagnosis),
	);

// Inspection failures are findings, so a missing repository does not stop the batch.
export const inspectRepositories = (requests: readonly InspectionRequest[]) =>
	Effect.forEach(requests, inspectRepository, { concurrency: 1 });
