import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
import { detectLanguage } from "../core/language.ts";
import { effectiveRemotes } from "../core/remotes.ts";
import { TrashError, type TrashSession, TrashStore } from "../core/trash.ts";
import {
	mergeTuiState,
	type TuiState,
	tuiStateStore,
} from "../core/tui-state.ts";
import { CommandRunner, CommandRunnerLive } from "../executil/command.ts";
import type { Assessment, Batch } from "../model/assessment.ts";
import { type Invocation, nonInteractiveTui, UsageError } from "./arguments.ts";
import {
	cleanText,
	failureMessage,
	type Locale,
	localizeUsage,
	restoreText,
} from "./messages.ts";
import type { Progress } from "./progress.ts";
import {
	Application,
	type Confirmation,
	confirm,
	ServiceError,
} from "./services.ts";
import type { Event, Model, Session, TaskCommand } from "./tui-model.ts";

// How long a finished scan may back a clean preview.
const recentScanMs = 60_000;

// Resolves once the TUI exits; aborted means Ctrl+C.
type TuiLauncher = (session: Session) => Promise<{ aborted: boolean }>;

// Loaded on demand so other commands never load the native renderer.
const launchTui: TuiLauncher = async (session) =>
	(await import("./tui.ts")).runInteractive(session);

const describe = (error: ServiceError, lang: Locale) =>
	error.code === "CONFIG_OR_TARGET_ERROR" && error.detail
		? localizeUsage(lang, error.detail)
		: (error.detail ?? error.code);

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
	progress?: Progress,
	launch: TuiLauncher = launchTui,
) =>
	Layer.effect(
		Application,
		Effect.gen(function* () {
			const runner = yield* CommandRunner;
			const inspector = yield* RepositoryInspector;
			// The TUI owns the screen while it runs, so the scan gauge stays silent.
			let screenOwned = false;
			const scanRepositories = (invocation: Invocation) =>
				Effect.gen(function* () {
					const gauge = screenOwned ? undefined : progress;
					const patterns = yield* Effect.tryPromise({
						try: () => exclusions(invocation.config),
						catch: (error) => error,
					});
					const repositories = yield* discover(invocation);
					let completed = 0;
					gauge?.update(0, repositories.length);
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
								const language = yield* Effect.tryPromise(() =>
									detectLanguage(repository.path),
								).pipe(Effect.catch(() => Effect.succeed(undefined)));
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
											...(!reasons.some(
												(reason) => reason.code === "UNBORN_HEAD",
											)
												? ["HEAD"]
												: []),
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
										Effect.catchDefect(() => Effect.succeed(undefined)),
										Effect.catch(() => Effect.succeed(undefined)),
									);
								const commitStatus: NonNullable<
									Assessment["metadata"]["last_commit_status"]
								> =
									date === undefined
										? "unavailable"
										: date === null
											? "none"
											: "available";
								const result = diagnose(repository.path, reasons);
								return {
									repository,
									status: result.status,
									reasons: result.reasons,
									checked_at: now(),
									metadata: {
										size_bytes: size,
										last_commit_at: date ?? null,
										last_commit_status: commitStatus,
										language: language ?? null,
										metadata_errors: [
											...(size === null ? ["SIZE_UNAVAILABLE"] : []),
											...(language === undefined
												? ["LANGUAGE_UNAVAILABLE"]
												: []),
											...(commitStatus === "unavailable"
												? ["LAST_COMMIT_UNAVAILABLE"]
												: []),
										],
									},
									snapshot: inspected.snapshot,
								};
							}).pipe(
								Effect.ensuring(
									Effect.sync(() =>
										gauge?.update(++completed, repositories.length),
									),
								),
							),
						{ concurrency: 4 },
					).pipe(Effect.ensuring(Effect.sync(() => gauge?.finish())));
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

			// The last completed scan, kept for this process only. Only the clean preview
			// reads it; every scan that can lead to a move runs fresh.
			let recent: { key: string; at: number; batch: Batch } | undefined;
			const scanKey = (invocation: Invocation) =>
				Effect.tryPromise(async () =>
					JSON.stringify([
						invocation.target,
						invocation.ghq,
						invocation.config,
						(await exclusions(invocation.config)).fingerprint,
					]),
				).pipe(Effect.catch(() => Effect.succeed(undefined)));
			const diagnoseBatch = (invocation: Invocation) =>
				Effect.gen(function* () {
					const key = yield* scanKey(invocation);
					const batch = yield* scanRepositories(invocation);
					recent = key ? { key, at: Date.parse(now()), batch } : undefined;
					return batch;
				});
			const diagnoseRecent = (invocation: Invocation) =>
				Effect.gen(function* () {
					const key = yield* scanKey(invocation);
					if (
						key &&
						recent?.key === key &&
						Date.parse(now()) - recent.at < recentScanMs
					)
						return recent.batch;
					return yield* diagnoseBatch(invocation);
				});

			const statePath = (invocation: Invocation) => {
				const configured = process.env.XDG_STATE_HOME;
				const home =
					configured && isAbsolute(configured)
						? configured
						: join(homedir(), ".local", "state");
				return invocation.stateDir ?? join(home, "gh-local-repo-cleaner");
			};
			const operate = (invocation: Invocation) =>
				Effect.gen(function* () {
					const store = createStore(statePath(invocation));
					const restoreWords = restoreText(invocation.lang);
					if (invocation.operation === "trash") {
						const result = yield* Effect.tryPromise({
							try: () => store.list(),
							catch: (error) => {
								const code =
									error instanceof TrashError ? error.code : "STORE_UNREADABLE";
								return new ServiceError({
									code,
									detail: restoreWords.storeUnreadable(code, false),
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
								? result.entries.map((entry) =>
										restoreWords.entry(entry, JSON.stringify),
									)
								: [restoreWords.trashEmpty]),
							restoreWords.entryCount(result.entries.length, attention),
							...(result.unstable ? [restoreWords.unstable] : []),
						].join("\n");
						if (result.failed)
							return yield* Effect.fail(
								new ServiceError({
									code: "RECOVERY_REQUIRED",
									detail: restoreWords.recoveryRequired,
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
									error instanceof TrashError ? error.code : "STORE_UNREADABLE";
								return new ServiceError({
									code,
									detail:
										restoreWords.restoreHint(code) === undefined
											? restoreWords.storeUnreadable(code, true)
											: `${code}${restoreWords.restoreHint(code)}`,
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
									detail: restoreWords.unknownId(id),
								}),
							);
						if (entry.status === "restored")
							return yield* Effect.fail(
								new ServiceError({
									code: "ALREADY_RESTORED",
									detail: restoreWords.alreadyRestored(
										id,
										JSON.stringify(entry.original),
										String(entry.updated_at),
									),
								}),
							);
						if (entry.status !== "moved" && entry.status !== "recoverable")
							return yield* Effect.fail(
								new ServiceError({
									code: "NOT_RESTORABLE",
									detail: restoreWords.notRestorable(id, entry.status),
								}),
							);
						const accepted = yield* Effect.tryPromise((signal) =>
							confirm(
								invocation,
								input,
								restoreWords.prompt(
									id,
									JSON.stringify(entry.destination),
									JSON.stringify(entry.original),
								),
								signal,
							),
						);
						if (!accepted) return restoreWords.skipped;
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
										error instanceof TrashError ? error.code : "RESTORE_FAILED";
									return new ServiceError({
										code,
										detail:
											restoreWords.restoreHint(code) === undefined
												? restoreWords.restoreFailed(code, id)
												: `${code} ${id}${restoreWords.restoreHint(code)}`,
									});
								},
							}),
						);
						return restoreWords.restored(
							id,
							JSON.stringify(entry.destination),
							JSON.stringify(entry.original),
						);
					}
					const words = cleanText(invocation.lang);
					if (!invocation.dryRun && !invocation.yes && !input.tty)
						throw new UsageError("Non-interactive clean requires --yes");
					const configBefore = yield* Effect.tryPromise({
						try: () => exclusions(invocation.config),
						catch: (error) => error,
					});
					const batch = yield* (
						invocation.dryRun ? diagnoseRecent : diagnoseBatch
					)(invocation);
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
						// The whole batch is still diagnosed so dependencies on unselected ones count.
						if (invocation.only && !invocation.only.includes(path)) continue;
						if (item.status === "UNKNOWN") failed = true;
						if (item.status !== "SAFE" || !item.snapshot) {
							count.kept++;
							messages.push(
								words.kept(
									JSON.stringify(path),
									item.status,
									item.reasons.map((reason) => reason.code).join(", "),
								),
							);
							continue;
						}
						if (invocation.dryRun) {
							count.would++;
							messages.push(
								words.wouldMove(
									JSON.stringify(path),
									JSON.stringify(destination),
									item.metadata.size_bytes,
								),
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
								`${words.prompt(JSON.stringify(path), JSON.stringify(destination))} ${words.moveNotice}`,
								signal,
							),
						);
						if (!accepted) {
							count.skipped++;
							messages.push(words.skipped(JSON.stringify(path)));
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
								words.moved(
									JSON.stringify(path),
									outcome.id,
									JSON.stringify(
										join(store.path, "entries", outcome.id, "repo"),
									),
								),
							);
							continue;
						}
						failed = true;
						count.failed++;
						const error = outcome.error;
						const code =
							error instanceof TrashError ? error.code : "MOVE_FAILED";
						messages.push(
							`${code}${error instanceof TrashError && error.id ? ` ${error.id}` : ""} ${JSON.stringify(path)}${words.moveHint(code)}`,
						);
						if (code !== "STATE_CHANGED" && code !== "MOVE_FAILED") {
							messages.push(words.stopped);
							break;
						}
					}
					const report = messages.length
						? [
								...(count.would + count.moved + count.skipped + count.failed
									? [
											words.stateStore(JSON.stringify(store.path)),
											words.moveNotice,
										]
									: []),
								...messages,
								invocation.dryRun
									? words.dryRunSummary(count.would, count.kept)
									: words.summary(
											count.moved,
											count.skipped,
											count.kept,
											count.failed,
										),
								...(count.moved || count.failed ? [words.review] : []),
							].join("\n")
						: words.empty;
					if (failed)
						return yield* Effect.fail(
							new ServiceError({
								code: "CLEAN_INCOMPLETE",
								detail: words.incomplete,
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
				);
			const interact = (invocation: Invocation) =>
				Effect.gen(function* () {
					const directory = statePath(invocation);
					const states = tuiStateStore(directory);
					const saved = yield* Effect.promise(() => states.load());
					// --ghq asks for ghq explicitly, so a remembered directory must not win.
					const initial = mergeTuiState(
						invocation.ghq ? { ...saved, target: undefined } : saved,
						{
							target: invocation.target && resolve(invocation.target),
							status: invocation.status,
							groupBy: invocation.groupBy,
							lang: invocation.langGiven ? invocation.lang : undefined,
						},
					);
					// Saves run one after another; a failed save only loses a preference.
					let saving = Promise.resolve();
					const save = (state: TuiState) => {
						saving = saving.then(() => states.save(state)).catch(() => {});
					};
					save(initial);
					const reports: string[] = [];
					const scoped = (model: Model): Invocation => ({
						...invocation,
						target: model.target,
						lang: model.lang,
						status: undefined,
						groupBy: undefined,
					});
					const settle = (
						effect: Effect.Effect<string, ServiceError>,
						lang: Locale,
					) =>
						Effect.runPromise(
							effect.pipe(
								Effect.catch((error) =>
									Effect.succeed(
										[error.output, describe(error, lang)]
											.filter(Boolean)
											.join("\n"),
									),
								),
							),
						);
					const perform = async (
						command: TaskCommand,
						model: Model,
					): Promise<Event> => {
						const base = scoped(model);
						switch (command.type) {
							case "scan":
								return Effect.runPromise(
									diagnoseBatch({ ...base, operation: "scan" }).pipe(
										Effect.map((batch) => ({
											type: "scanned" as const,
											batch,
										})),
										Effect.catch((error) =>
											Effect.succeed({
												type: "failed" as const,
												message: `${error.code}: ${
													error.code === "CONFIG_OR_TARGET_ERROR" &&
													error.detail
														? localizeUsage(model.lang, error.detail)
														: failureMessage(model.lang, error.code)
												}`,
											}),
										),
									),
								);
							case "preview":
								return {
									type: "previewed",
									report: await settle(
										operate({
											...base,
											operation: "clean",
											dryRun: true,
											yes: false,
											only: command.paths,
										}),
										model.lang,
									),
								};
							case "clean": {
								const report = await settle(
									operate({
										...base,
										operation: "clean",
										dryRun: false,
										yes: true,
										only: command.paths,
									}),
									model.lang,
								);
								reports.push(report);
								return { type: "cleaned", report };
							}
							case "restore": {
								const report = await settle(
									operate({
										...base,
										operation: "restore",
										target: command.id,
										yes: true,
									}),
									model.lang,
								);
								reports.push(report);
								return { type: "restored", report };
							}
							case "trash": {
								const words = restoreText(model.lang);
								try {
									const result = await createStore(directory).list();
									return {
										type: "listed",
										entries: result.entries,
										note: result.unstable
											? words.unstable
											: result.failed
												? words.recoveryRequired
												: undefined,
									};
								} catch (error) {
									return {
										type: "failed",
										message: words.storeUnreadable(
											error instanceof TrashError
												? error.code
												: "STORE_UNREADABLE",
											false,
										),
									};
								}
							}
						}
					};
					screenOwned = true;
					const outcome = yield* Effect.tryPromise({
						try: () => launch({ initial, perform, save }),
						catch: (error) =>
							error instanceof Error && error.name === "NonInteractiveError"
								? new UsageError(nonInteractiveTui)
								: error,
					}).pipe(
						Effect.ensuring(
							Effect.promise(async () => {
								screenOwned = false;
								await saving;
							}),
						),
					);
					if (outcome.aborted) return yield* Effect.interrupt;
					return reports.join("\n\n");
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
									detail:
										error instanceof UsageError ? error.message : undefined,
								}),
					),
				);
			return { diagnose: diagnoseBatch, operate, interact };
		}),
	).pipe(
		Layer.provide(
			RepositoryInspectorLive.pipe(Layer.provideMerge(runnerLayer)),
		),
	);
