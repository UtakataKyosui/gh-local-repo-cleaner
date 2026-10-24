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
import {
	type Entry,
	TrashError,
	type TrashSession,
	TrashStore,
} from "../core/trash.ts";
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
	createStore: (path: string) => TrashStore = (path) => new TrashStore(path),
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
					const assessments: Assessment[] = yield* Effect.forEach(
						repositories,
						(repository) =>
							Effect.gen(function* () {
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
								return {
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
								};
							}),
						{ concurrency: 4 },
					);
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
								detail: error instanceof UsageError ? error.message : undefined,
							}),
					),
				);

			const moveNotice =
				"Moving within one filesystem frees no disk space; the lock does not stop editors, Git or other external writers, so do not run this on repositories in use.";
			const manual =
				"Nothing was changed. See the README (退避・復元と復旧) for manual recovery.";
			const moveHints: Record<string, string> = {
				STATE_CHANGED: ": changed since inspection; kept in place.",
				MOVE_FAILED: ": move failed; kept in place (no copy fallback).",
				RECORD_FAILED:
					": the record could not be written; kept in place and nothing was moved.",
				RECORD_FAILED_AFTER_MOVE:
					": moved, but the record was not finalized; run trash list, then restore <ID> if needed.",
			};
			const restoreHints: Record<string, string> = {
				LOCK_HELD:
					": another clean or restore is running; nothing was changed. Retry later.",
				STORE_UNSAFE: `: the state store has unsafe ownership, permissions or symlinks. ${manual}`,
				UNRESTORABLE: `: the destination exists, its parent is missing, or the entry needs manual recovery. ${manual}`,
				RECORD_FAILED:
					": the record could not be written before the move; nothing was moved. Run trash list.",
				MOVE_FAILED:
					": the move failed after the record was updated; the data stays in the trash. Run trash list; the entry can be restored again.",
				RECORD_FAILED_AFTER_MOVE:
					": restored, but the record was not finalized. Run trash list.",
			};
			const entryGuidance: Partial<Record<string, string>> = {
				not_moved: "Not moved: the original is still in place.",
				recoverable: "Moved but not finalized: restore <ID> can put it back.",
				recovery_required: `Ambiguous state: do not restore automatically. ${manual}`,
				invalid_record: `The record is unreadable or fails verification. ${manual}`,
				orphan_entry: `The entry has no record. ${manual}`,
			};
			const describeEntry = (entry: Entry) => {
				const presence = (value?: boolean) => (value ? "present" : "absent");
				const guidance = entryGuidance[entry.status]?.replace("<ID>", entry.id);
				return [
					`${entry.id} ${entry.status}`,
					...(entry.recorded
						? [
								`  Original: ${JSON.stringify(entry.original)}`,
								`  Destination: ${JSON.stringify(entry.destination)}`,
								`  Created: ${entry.created_at}; updated: ${entry.updated_at}`,
								`  Record: ${entry.recorded}; check: ${entry.status}; original path ${presence(entry.original_present)}; destination ${presence(entry.destination_present)}`,
							]
						: [`  Record: unreadable or missing; check: ${entry.status}`]),
					...(guidance ? [`  ${guidance}`] : []),
				].join("\n");
			};
			const statePath = (invocation: Invocation) => {
				const configured = process.env.XDG_STATE_HOME;
				const home =
					configured && isAbsolute(configured)
						? configured
						: join(homedir(), ".local", "state");
				return invocation.stateDir ?? join(home, "gh-local-repo-cleaner");
			};
			return {
				diagnose: diagnoseBatch,
				operate: (invocation: Invocation) =>
					Effect.gen(function* () {
						const store = createStore(statePath(invocation));
						if (invocation.operation === "trash") {
							const result = yield* Effect.tryPromise({
								try: () => store.list(),
								catch: (error) => {
									const code =
										error instanceof TrashError
											? error.code
											: "STORE_UNREADABLE";
									return new ServiceError({
										code,
										detail: `${code}: the state store could not be read safely, so the history is unknown. ${manual}`,
									});
								},
							});
							const attention = result.entries.filter((entry) =>
								[
									"recoverable",
									"recovery_required",
									"invalid_record",
									"orphan_entry",
								].includes(entry.status),
							).length;
							const text = [
								...(result.entries.length
									? result.entries.map(describeEntry)
									: ["Trash is empty."]),
								`${result.entries.length} entries; ${attention} need attention.`,
								...(result.unstable
									? [
											"The store changed while it was being listed, so the result is not reliable. Run trash list again.",
										]
									: []),
							].join("\n");
							if (result.failed)
								return yield* Effect.fail(
									new ServiceError({
										code: "RECOVERY_REQUIRED",
										detail:
											"RECOVERY_REQUIRED: some entries are unresolved or unverifiable; see the guidance above.",
										output: text,
									}),
								);
							return text;
						}
						if (invocation.operation === "restore") {
							const id = invocation.target ?? "";
							if (!invocation.yes && !input.tty)
								throw new UsageError("Non-interactive restore requires --yes");
							const entries = yield* Effect.tryPromise({
								try: () => store.list(),
								catch: (error) => {
									const code =
										error instanceof TrashError
											? error.code
											: "STORE_UNREADABLE";
									return new ServiceError({
										code,
										detail: `${code}${restoreHints[code] ?? `: the state store could not be read safely. ${manual}`}`,
									});
								},
							});
							const entry = entries.entries.find(
								(candidate) => candidate.id === id,
							);
							if (!entry)
								return yield* Effect.fail(
									new ServiceError({
										code: "UNKNOWN_ID",
										detail: `UNKNOWN_ID ${id}: no such entry; run trash list. Nothing was changed.`,
									}),
								);
							if (entry.status === "restored")
								return yield* Effect.fail(
									new ServiceError({
										code: "ALREADY_RESTORED",
										detail: `ALREADY_RESTORED ${id}: restored to ${JSON.stringify(entry.original)} (last updated ${entry.updated_at}); nothing was changed.`,
									}),
								);
							if (entry.status !== "moved" && entry.status !== "recoverable")
								return yield* Effect.fail(
									new ServiceError({
										code: "NOT_RESTORABLE",
										detail: `NOT_RESTORABLE ${id} ${entry.status}: ${manual}`,
									}),
								);
							const accepted = yield* Effect.tryPromise((signal) =>
								confirm(
									invocation,
									input,
									`Restore ${id} from ${JSON.stringify(entry.destination)} to ${JSON.stringify(entry.original)}?`,
									signal,
								),
							);
							if (!accepted) return "Skipped.";
							yield* Effect.uninterruptible(
								Effect.tryPromise({
									try: async () => {
										const session = await store.open();
										try {
											await session.restore(id);
										} finally {
											await session.close();
										}
									},
									catch: (error) => {
										const code =
											error instanceof TrashError
												? error.code
												: "RESTORE_FAILED";
										return new ServiceError({
											code,
											detail: `${code} ${id}${restoreHints[code] ?? ": restore did not complete; run trash list to see the current state."}`,
										});
									},
								}),
							);
							return `Restored ${id} from ${JSON.stringify(entry.destination)} to ${JSON.stringify(entry.original)}.`;
						}
						if (!invocation.dryRun && !invocation.yes && !input.tty)
							throw new UsageError("Non-interactive clean requires --yes");
						const configBefore = yield* Effect.tryPromise({
							try: () => exclusions(invocation.config),
							catch: (error) => error,
						});
						const batch = yield* diagnoseBatch(invocation);
						const messages: string[] = [];
						const count = {
							moved: 0,
							skipped: 0,
							kept: 0,
							failed: 0,
							would: 0,
						};
						let failed = false;
						let session: TrashSession | null = null;
						yield* Effect.addFinalizer(() =>
							Effect.promise(async () => session?.close()),
						);
						const destination = join(store.path, "entries", "<ID>", "repo");
						for (const item of batch.assessments) {
							const path = item.repository.path;
							if (item.status === "UNKNOWN") failed = true;
							if (item.status !== "SAFE" || !item.snapshot) {
								count.kept++;
								messages.push(
									`Kept ${JSON.stringify(path)}: ${item.status} ${item.reasons.map((reason) => reason.code).join(", ")}`,
								);
								continue;
							}
							if (invocation.dryRun) {
								count.would++;
								messages.push(
									`Would move ${JSON.stringify(path)} to ${JSON.stringify(destination)} (logical bytes, estimate: ${item.metadata.size_bytes ?? "unknown"}).`,
								);
								continue;
							}
							session ??= yield* Effect.tryPromise({
								try: () => store.open(),
								catch: (error) =>
									new ServiceError({
										code:
											error instanceof TrashError
												? error.code
												: "STORE_UNAVAILABLE",
									}),
							});
							const held = session;
							const accepted = yield* Effect.tryPromise((signal) =>
								confirm(
									invocation,
									input,
									`Move ${JSON.stringify(path)} to ${JSON.stringify(destination)}? ${moveNotice}`,
									signal,
								),
							);
							if (!accepted) {
								count.skipped++;
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
							const outcome = yield* Effect.uninterruptible(
								Effect.tryPromise({
									try: () =>
										held.moveRepository(
											path,
											item.repository.root,
											expected,
											revalidate,
										),
									catch: (error) => error,
								}),
							).pipe(
								Effect.map((id) => ({ id, error: null as unknown })),
								Effect.catch((error) =>
									Effect.succeed({ id: null, error: error as unknown }),
								),
							);
							if (outcome.id) {
								count.moved++;
								messages.push(
									`Moved ${JSON.stringify(path)}: ${outcome.id} -> ${JSON.stringify(join(store.path, "entries", outcome.id, "repo"))}`,
								);
								continue;
							}
							failed = true;
							count.failed++;
							const error = outcome.error;
							const code =
								error instanceof TrashError ? error.code : "MOVE_FAILED";
							messages.push(
								`${code}${error instanceof TrashError && error.id ? ` ${error.id}` : ""} ${JSON.stringify(path)}${moveHints[code] ?? ""}`,
							);
							if (code !== "STATE_CHANGED" && code !== "MOVE_FAILED") {
								messages.push(
									"Stopped: the state store is not reliable, so remaining repositories were not moved. Run trash list.",
								);
								break;
							}
						}
						const report = messages.length
							? [
									...(count.would + count.moved + count.skipped + count.failed
										? [`State store: ${JSON.stringify(store.path)}`, moveNotice]
										: []),
									...messages,
									invocation.dryRun
										? `Dry run: nothing was moved. Would move ${count.would}; kept ${count.kept}.`
										: `Moved ${count.moved}; skipped ${count.skipped}; kept ${count.kept}; failed ${count.failed}.`,
									...(count.moved || count.failed
										? [
												"Review with: trash list. Put a repository back with: restore <ID>.",
											]
										: []),
								].join("\n")
							: "No repositories.";
						if (failed)
							return yield* Effect.fail(
								new ServiceError({
									code: "CLEAN_INCOMPLETE",
									detail:
										"CLEAN_INCOMPLETE: some repositories could not be diagnosed or moved; see the output.",
									output: report,
								}),
							);
						return report;
					}).pipe(
						Effect.scoped,
						Effect.catchDefect((error) => Effect.fail(error)),
						Effect.mapError((error) =>
							error instanceof ServiceError
								? error
								: new ServiceError({
										code:
											error instanceof UsageError
												? "CONFIG_OR_TARGET_ERROR"
												: "OPERATION_FAILED",
										detail:
											error instanceof UsageError ? error.message : undefined,
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
