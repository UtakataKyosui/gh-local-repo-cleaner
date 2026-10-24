import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Effect, Layer } from "effect";
import { exclusions, sizeBytes } from "../core/configuration.ts";
import { diagnose, finding } from "../core/diagnosis.ts";
import { discover, within } from "../core/discovery.ts";
import {
	inspectRepositorySnapshot,
	RepositoryInspector,
	RepositoryInspectorLive,
} from "../core/inspection.ts";
import { effectiveRemotes } from "../core/remotes.ts";
import { TrashStore } from "../core/trash.ts";
import { CommandRunner, CommandRunnerLive } from "../executil/command.ts";
import type { Assessment, Batch } from "../model/assessment.ts";
import { type Invocation, UsageError } from "./arguments.ts";
import {
	Application,
	type Confirmation,
	confirm,
	ServiceError,
} from "./services.ts";

const terminal: Confirmation = {
	tty: Boolean(process.stdin.isTTY && process.stderr.isTTY),
	read: async (prompt, signal) => {
		const input = createInterface({
			input: process.stdin,
			output: process.stderr,
		});
		try {
			return await input.question(`${prompt} [y/yes] `, { signal });
		} catch {
			return null;
		} finally {
			input.close();
		}
	},
};

export const applicationLive = (
	input: Confirmation = terminal,
	now = () => new Date().toISOString(),
	runnerLayer: Layer.Layer<CommandRunner> = CommandRunnerLive,
) =>
	Layer.effect(
		Application,
		Effect.gen(function* () {
			const runner = yield* CommandRunner;
			const inspector = yield* RepositoryInspector;
			const diagnoseBatch = (invocation: Invocation) =>
				Effect.gen(function* () {
					const patterns = yield* Effect.tryPromise({
						try: () => exclusions(invocation.config),
						catch: (error) => error,
					});
					const repositories = yield* discover(invocation);
					const assessments: Assessment[] = [];
					for (const repository of repositories) {
						const ruleIndex = patterns.match(repository);
						const excluded = ruleIndex >= 0;
						const inspected = yield* inspectRepositorySnapshot({
							path: repository.path,
						});
						const boundary = yield* Effect.tryPromise(
							async () =>
								(await realpath(repository.path)) === repository.path &&
								within(repository.root, repository.path),
						).pipe(Effect.catch(() => Effect.succeed(false)));
						const reasons = [...inspected.diagnosis.reasons];
						if (excluded)
							reasons.push({
								...finding("EXCLUDED_BY_CONFIG"),
								rule_index: ruleIndex,
							});
						if (
							!boundary ||
							repository.path === homedir() ||
							repository.path === process.cwd() ||
							within(repository.path, process.cwd())
						)
							reasons.push(finding("UNSUPPORTED_LAYOUT"));
						const size = yield* Effect.tryPromise((signal) =>
							sizeBytes(repository.path, signal),
						).pipe(Effect.catch(() => Effect.succeed(null)));
						const date = yield* runner
							.run({
								executable: "git",
								args: [
									"-C",
									repository.path,
									"log",
									"--no-walk",
									"--format=%ct",
									"--branches",
									"HEAD",
								],
							})
							.pipe(
								Effect.map((value) => {
									const times = value
										.trim()
										.split("\n")
										.filter(Boolean)
										.map(Number);
									if (!times.length) return null;
									if (times.some((time) => !Number.isFinite(time)))
										throw new Error("Invalid timestamp");
									return new Date(Math.max(...times) * 1000).toISOString();
								}),
								Effect.catchDefect(() => Effect.succeed(null)),
								Effect.catch(() => Effect.succeed(null)),
							);
						const result = diagnose(repository.path, reasons);
						assessments.push({
							repository,
							status: result.status,
							reasons: result.reasons,
							checked_at: now(),
							metadata: {
								size_bytes: size,
								last_commit_at: date,
								metadata_errors: [
									...(size === null ? ["SIZE_UNAVAILABLE"] : []),
									...(date === null ? ["LAST_COMMIT_UNAVAILABLE"] : []),
								],
							},
							snapshot: inspected.snapshot,
						});
					}
					// Local remotes must not be evacuated along with repositories relying on them.
					for (let index = 0; index < assessments.length; index++) {
						const item = assessments[index];
						if (!item) continue;
						const remotes = yield* effectiveRemotes(item.repository.path).pipe(
							Effect.catch(() => Effect.succeed(null)),
						);
						if (remotes === null) {
							// A missing entry has no repository to depend on another target.
							// Otherwise an incomplete dependency graph must prevent evacuation.
							const missing = yield* Effect.tryPromise(async () => {
								try {
									await lstat(item.repository.path);
									return false;
								} catch (error) {
									if ((error as NodeJS.ErrnoException).code === "ENOENT")
										return true;
									throw error;
								}
							}).pipe(Effect.catch(() => Effect.succeed(false)));
							if (!missing)
								for (let other = 0; other < assessments.length; other++) {
									const candidate = assessments[other];
									if (!candidate) continue;
									const result = diagnose(candidate.repository.path, [
										...candidate.reasons,
										finding("LOCAL_INSPECTION_FAILED"),
									]);
									assessments[other] = {
										...candidate,
										status: result.status,
										reasons: result.reasons,
									};
								}
							continue;
						}
						for (const { localPath: local } of remotes) {
							if (
								local &&
								assessments.some(
									(candidate) =>
										candidate.repository.path === local ||
										within(candidate.repository.path, local),
								)
							) {
								for (let other = 0; other < assessments.length; other++) {
									const candidate = assessments[other];
									if (!candidate) continue;
									if (
										other === index ||
										candidate.repository.path === local ||
										within(candidate.repository.path, local)
									) {
										const result = diagnose(candidate.repository.path, [
											...candidate.reasons,
											finding("LOCAL_REMOTE_DEPENDENCY"),
										]);
										assessments[other] = {
											...candidate,
											status: result.status,
											reasons: result.reasons,
										};
									}
								}
							}
						}
					}
					return { assessments, errors: [] } satisfies Batch;
				}).pipe(
					Effect.provideService(CommandRunner, runner),
					Effect.provideService(RepositoryInspector, inspector),
					Effect.catchDefect((error) => Effect.fail(error)),
					Effect.mapError(
						(error) =>
							new ServiceError({
								code:
									error instanceof UsageError
										? "CONFIG_OR_TARGET_ERROR"
										: error instanceof Error &&
												[
													"GHQ_NOT_FOUND",
													"GHQ_TIMEOUT",
													"GHQ_COMMAND_FAILED",
												].includes(error.message)
											? error.message
											: "DISCOVERY_FAILED",
							}),
					),
				);

			const statePath = (invocation: Invocation) => {
				const home =
					process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
				if (!isAbsolute(home))
					throw new UsageError("XDG_DATA_HOME must be absolute");
				return invocation.stateDir ?? join(home, "gh-local-repo-cleaner");
			};
			return {
				diagnose: diagnoseBatch,
				operate: (invocation: Invocation) =>
					Effect.gen(function* () {
						const store = new TrashStore(statePath(invocation));
						if (invocation.operation === "trash") {
							const result = yield* Effect.tryPromise(() => store.list());
							const text =
								result.entries
									.map(
										(entry) =>
											`${entry.id} ${entry.status} ${JSON.stringify(entry.original ?? "")}`,
									)
									.join("\n") || "Trash is empty.";
							if (result.failed)
								return yield* Effect.fail(
									new ServiceError({ code: `RECOVERY_REQUIRED\n${text}` }),
								);
							return text;
						}
						if (invocation.operation === "restore") {
							if (!invocation.yes && !input.tty)
								throw new UsageError("Non-interactive restore requires --yes");
							const entries = yield* Effect.tryPromise(() => store.list());
							const entry = entries.entries.find(
								(entry) => entry.id === invocation.target,
							);
							if (entry?.status !== "moved")
								return yield* Effect.fail(
									new ServiceError({ code: "UNKNOWN_OR_UNRESTORABLE_ID" }),
								);
							const accepted = yield* Effect.tryPromise((signal) =>
								confirm(
									invocation,
									input,
									`Restore ${invocation.target} to ${JSON.stringify(entry.original)}?`,
									signal,
								),
							);
							if (!accepted) return "Skipped.";
							yield* Effect.uninterruptible(
								Effect.tryPromise(() => store.restore(invocation.target ?? "")),
							);
							return `Restored ${invocation.target}.`;
						}
						if (!invocation.dryRun && !invocation.yes && !input.tty)
							throw new UsageError("Non-interactive clean requires --yes");
						const configBefore = yield* Effect.tryPromise({
							try: () => exclusions(invocation.config),
							catch: (error) => error,
						});
						const batch = yield* diagnoseBatch(invocation);
						const messages: string[] = [];
						let failed = false;
						for (const item of batch.assessments) {
							const path = item.repository.path;
							if (item.status === "UNKNOWN") failed = true;
							if (item.status !== "SAFE" || !item.snapshot) {
								messages.push(
									`Kept ${JSON.stringify(path)}: ${item.status} ${item.reasons.map((reason) => reason.code).join(", ")}`,
								);
								continue;
							}
							if (invocation.dryRun) {
								messages.push(
									`Would move ${JSON.stringify(path)} to ${JSON.stringify(store.path)} (logical bytes, estimate: ${item.metadata.size_bytes ?? "unknown"}).`,
								);
								continue;
							}
							const accepted = yield* Effect.tryPromise((signal) =>
								confirm(
									invocation,
									input,
									`Move ${JSON.stringify(path)} to ${JSON.stringify(store.path)}?`,
									signal,
								),
							);
							if (!accepted) {
								messages.push(`Skipped ${JSON.stringify(path)}.`);
								continue;
							}
							const expected = item.snapshot;
							const revalidate = async () => {
								if (
									(await exclusions(invocation.config)).fingerprint !==
									configBefore.fingerprint
								)
									return false;
								const valid = await Effect.runPromise(
									diagnoseBatch(invocation).pipe(
										Effect.map((fresh) => {
											const current = fresh.assessments.find(
												(candidate) => candidate.repository.path === path,
											);
											return (
												current?.status === "SAFE" &&
												JSON.stringify(current.snapshot) ===
													JSON.stringify(expected)
											);
										}),
									),
								);
								return (
									valid &&
									(await exclusions(invocation.config)).fingerprint ===
										configBefore.fingerprint
								);
							};
							const moved = yield* Effect.uninterruptible(
								Effect.tryPromise(() =>
									store.moveRepository(
										path,
										item.repository.root,
										expected,
										revalidate,
									),
								),
							).pipe(
								Effect.map((id) => ({ id })),
								Effect.catch(() => Effect.succeed({ id: null })),
							);
							if (moved.id)
								messages.push(`Moved ${JSON.stringify(path)}: ${moved.id}`);
							else {
								failed = true;
								messages.push(
									`MOVE_FAILED_OR_STATE_CHANGED ${JSON.stringify(path)}; inspect trash records before retrying.`,
								);
							}
						}
						const message = messages.join("\n") || "No repositories.";
						if (failed)
							return yield* Effect.fail(new ServiceError({ code: message }));
						return message;
					}).pipe(
						Effect.catchDefect((error) => Effect.fail(error)),
						Effect.mapError((error) =>
							error instanceof ServiceError
								? error
								: new ServiceError({
										code:
											error instanceof UsageError
												? "CONFIG_OR_TARGET_ERROR"
												: "OPERATION_FAILED",
									}),
						),
					),
			};
		}),
	).pipe(
		Layer.provide(
			RepositoryInspectorLive.pipe(Layer.provideMerge(runnerLayer)),
		),
	);
