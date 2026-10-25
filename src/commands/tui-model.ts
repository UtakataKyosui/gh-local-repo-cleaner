import type { Status } from "../core/diagnosis.ts";
import type { Entry } from "../core/trash.ts";
import type { TuiState, TuiStatus } from "../core/tui-state.ts";
import type { Assessment, Batch } from "../model/assessment.ts";
import { humanOutput, quote } from "./human-output.ts";
import { type Locale, restoreText, tuiText } from "./messages.ts";

// Screen transitions live here, apart from the renderer, so they can be tested as plain data.
// Safety is never decided here: only the diagnosis status gates selection, and services decide the rest.

type Task = "scan" | "preview" | "clean" | "trash" | "restore";

export interface Key {
	readonly name: string;
	readonly ctrl?: boolean;
}

type Dialog =
	| {
			readonly kind: "clean";
			readonly paths: readonly string[];
			readonly report: string;
	  }
	| { readonly kind: "restore"; readonly id: string; readonly prompt: string };

export interface Model {
	readonly view: "repositories" | "trash";
	readonly target?: string;
	readonly status?: TuiStatus;
	readonly groupBy?: "language";
	readonly lang: Locale;
	readonly assessments: readonly Assessment[];
	readonly errors: Batch["errors"];
	readonly cursor: number;
	readonly selected: readonly string[];
	readonly entries: readonly Entry[];
	readonly entryCursor: number;
	readonly busy?: Task;
	readonly dialog?: Dialog;
	// A one-line hint, and the full text of the last operation shown in place of the details.
	readonly message?: string;
	readonly report?: string;
	readonly scroll: number;
	// Repositories changed behind the list (after a restore) and need a rescan.
	readonly stale: boolean;
	readonly quitting?: "quit" | "abort";
}

export type Command =
	| { readonly type: "scan" }
	| { readonly type: "preview"; readonly paths: readonly string[] }
	| { readonly type: "clean"; readonly paths: readonly string[] }
	| { readonly type: "trash" }
	| { readonly type: "restore"; readonly id: string }
	| { readonly type: "save" }
	| { readonly type: "exit"; readonly aborted: boolean };

export type Event =
	| { readonly type: "key"; readonly key: Key }
	| { readonly type: "scanned"; readonly batch: Batch }
	| { readonly type: "previewed"; readonly report: string }
	| { readonly type: "cleaned"; readonly report: string }
	| {
			readonly type: "listed";
			readonly entries: readonly Entry[];
			readonly note?: string;
	  }
	| { readonly type: "restored"; readonly report: string }
	| { readonly type: "failed"; readonly message: string };

export type TaskCommand = Exclude<Command, { type: "save" | "exit" }>;

// What the renderer drives: services carry out each task and answer with an event.
export interface Session {
	readonly initial: TuiState;
	readonly perform: (command: TaskCommand, model: Model) => Promise<Event>;
	// Queued in order by the caller; the TUI does not wait for it.
	readonly save: (state: TuiState) => void;
}

interface Step {
	readonly model: Model;
	readonly commands: readonly Command[];
}

const statusCycle: readonly (TuiStatus | undefined)[] = [
	undefined,
	"safe",
	"dirty",
	"protected",
	"unknown",
];
const mutating: readonly (Task | undefined)[] = ["clean", "restore"];
const page = 10;

export function initialModel(state: TuiState): Step {
	return {
		model: {
			view: "repositories",
			target: state.target,
			status: state.status,
			groupBy: state.groupBy,
			lang: state.lang ?? "en",
			assessments: [],
			errors: [],
			cursor: 0,
			selected: [],
			entries: [],
			entryCursor: 0,
			busy: "scan",
			scroll: 0,
			stale: false,
		},
		commands: [{ type: "scan" }],
	};
}

export function preferences(model: Model): TuiState {
	return {
		target: model.target,
		status: model.status,
		groupBy: model.groupBy,
		lang: model.lang,
	};
}

const groupOf = (item: Assessment) => item.metadata.language;

// Same order as the text output: by path, then languages with unknown last when grouped.
function visibleRepositories(model: Model): readonly Assessment[] {
	return [...model.assessments]
		.filter(
			(item) => !model.status || item.status.toLowerCase() === model.status,
		)
		.sort((a, b) =>
			a.repository.path < b.repository.path
				? -1
				: a.repository.path > b.repository.path
					? 1
					: 0,
		)
		.sort((a, b) =>
			model.groupBy
				? Number(groupOf(a) === null) - Number(groupOf(b) === null) ||
					(groupOf(a) ?? "").localeCompare(groupOf(b) ?? "")
				: 0,
		);
}

export type Row =
	| {
			readonly kind: "group";
			readonly name: string;
			readonly counts: Readonly<Record<Status, number>>;
	  }
	| {
			readonly kind: "repository";
			readonly item: Assessment;
			readonly index: number;
			readonly selected: boolean;
			readonly current: boolean;
	  };

export function rows(model: Model): readonly Row[] {
	const items = visibleRepositories(model);
	const result: Row[] = [];
	let group: string | null | undefined;
	items.forEach((item, index) => {
		if (model.groupBy && (index === 0 || groupOf(item) !== group)) {
			group = groupOf(item);
			const members = items.filter((other) => groupOf(other) === group);
			result.push({
				kind: "group",
				name: group ?? tuiText(model.lang).other,
				counts: {
					SAFE: members.filter((m) => m.status === "SAFE").length,
					DIRTY: members.filter((m) => m.status === "DIRTY").length,
					PROTECTED: members.filter((m) => m.status === "PROTECTED").length,
					UNKNOWN: members.filter((m) => m.status === "UNKNOWN").length,
				},
			});
		}
		result.push({
			kind: "repository",
			item,
			index,
			selected: model.selected.includes(item.repository.path),
			current: index === model.cursor,
		});
	});
	return result;
}

// The first row to draw so the cursor stays roughly centered in a window of `height` rows.
export function windowStart(total: number, cursorRow: number, height: number) {
	if (height <= 0) return 0;
	return Math.max(
		0,
		Math.min(cursorRow - Math.floor(height / 2), total - height),
	);
}

const clamp = (value: number, length: number) =>
	Math.max(0, Math.min(value, length - 1));

function currentRepository(model: Model): Assessment | undefined {
	return visibleRepositories(model)[model.cursor];
}

function currentEntry(model: Model): Entry | undefined {
	return model.entries[model.entryCursor];
}

// The right pane: a pending confirmation, else the last result, else the cursor's details.
export function pane(model: Model): { title: string; lines: string[] } {
	const words = tuiText(model.lang);
	if (model.dialog)
		return {
			title: words.confirm,
			lines: [
				...(model.dialog.kind === "clean"
					? model.dialog.report
					: model.dialog.prompt
				).split("\n"),
				"",
				model.dialog.kind === "clean"
					? words.confirmClean(model.dialog.paths.length)
					: words.confirmRestore,
			],
		};
	if (model.report !== undefined)
		return { title: words.result, lines: model.report.split("\n") };
	if (model.view === "trash") {
		const entry = currentEntry(model);
		return {
			title: words.details,
			lines: entry
				? restoreText(model.lang).entry(entry, JSON.stringify).split("\n")
				: [restoreText(model.lang).trashEmpty],
		};
	}
	const item = currentRepository(model);
	return {
		title: words.details,
		lines: item
			? humanOutput(
					[item],
					{ operation: "inspect", groupBy: undefined, lang: model.lang },
					[],
					false,
				)
					.split("\n")
					.slice(1)
			: [...model.errors.map((e) => `${e.code}: ${e.message}`)],
	};
}

export function entryLine(entry: Entry) {
	return `${entry.id} ${entry.status}${entry.original === undefined ? "" : ` ${quote(entry.original)}`}`;
}

const stay = (model: Model): Step => ({ model, commands: [] });
const run = (model: Model, task: Task, command: Command): Step => ({
	model: { ...model, busy: task, message: undefined },
	commands: [command],
});

function finish(model: Model, next: Step): Step {
	if (!model.quitting) return next;
	return {
		model: next.model,
		commands: [{ type: "exit", aborted: model.quitting === "abort" }],
	};
}

function quit(model: Model, key: Key): Step | undefined {
	const abort = key.ctrl === true && key.name === "c";
	if (!abort && key.name !== "q") return undefined;
	// A move or restore must not be cut off; leave once it reports back.
	if (mutating.includes(model.busy))
		return stay({
			...model,
			quitting: abort ? "abort" : "quit",
			message: tuiText(model.lang).finishing,
		});
	return { model, commands: [{ type: "exit", aborted: abort }] };
}

function onKey(model: Model, key: Key): Step {
	const leaving = quit(model, key);
	if (leaving) return leaving;
	if (model.busy) return stay(model);
	const words = tuiText(model.lang);
	if (model.dialog) {
		const dialog = model.dialog;
		const closed = { ...model, dialog: undefined };
		if (key.name !== "y")
			return stay({ ...closed, message: words.cancelled, report: undefined });
		return dialog.kind === "clean"
			? run({ ...closed, report: undefined }, "clean", {
					type: "clean",
					paths: dialog.paths,
				})
			: run({ ...closed, report: undefined }, "restore", {
					type: "restore",
					id: dialog.id,
				});
	}
	const moved = (patch: Partial<Model>): Step =>
		stay({ ...model, ...patch, report: undefined, scroll: 0 });
	const saved = (patch: Partial<Model>): Step => ({
		model: { ...model, ...patch, message: undefined },
		commands: [{ type: "save" }],
	});
	switch (key.name) {
		case "pagedown":
			return stay({ ...model, scroll: model.scroll + page });
		case "pageup":
			return stay({ ...model, scroll: Math.max(0, model.scroll - page) });
		case "l":
			return saved({ lang: model.lang === "en" ? "ja" : "en" });
	}
	if (model.view === "trash") {
		const length = model.entries.length;
		switch (key.name) {
			case "up":
			case "k":
				return moved({ entryCursor: clamp(model.entryCursor - 1, length) });
			case "down":
			case "j":
				return moved({ entryCursor: clamp(model.entryCursor + 1, length) });
			case "home":
				return moved({ entryCursor: 0 });
			case "end":
				return moved({ entryCursor: clamp(length - 1, length) });
			case "s":
				return run({ ...model, report: undefined }, "trash", { type: "trash" });
			case "r":
			case "return": {
				const entry = currentEntry(model);
				if (!entry) return stay(model);
				return stay({
					...model,
					message: undefined,
					report: undefined,
					dialog: {
						kind: "restore",
						id: entry.id,
						prompt: restoreText(model.lang).prompt(
							entry.id,
							JSON.stringify(entry.destination),
							JSON.stringify(entry.original),
						),
					},
				});
			}
			case "t":
			case "tab":
			case "escape": {
				const back = {
					...model,
					view: "repositories" as const,
					report: undefined,
					message: undefined,
					scroll: 0,
				};
				return back.stale
					? run({ ...back, stale: false }, "scan", { type: "scan" })
					: stay(back);
			}
		}
		return stay(model);
	}
	const visible = visibleRepositories(model);
	const length = visible.length;
	switch (key.name) {
		case "up":
		case "k":
			return moved({ cursor: clamp(model.cursor - 1, length) });
		case "down":
		case "j":
			return moved({ cursor: clamp(model.cursor + 1, length) });
		case "home":
			return moved({ cursor: 0 });
		case "end":
			return moved({ cursor: clamp(length - 1, length) });
		case "space": {
			const item = visible[model.cursor];
			if (!item) return stay(model);
			const path = item.repository.path;
			if (model.selected.includes(path))
				return stay({
					...model,
					message: undefined,
					selected: model.selected.filter((other) => other !== path),
				});
			if (item.status !== "SAFE")
				return stay({ ...model, message: words.onlySafe });
			return stay({
				...model,
				message: undefined,
				selected: [...model.selected, path],
			});
		}
		case "a": {
			const safe = visible
				.filter((item) => item.status === "SAFE")
				.map((item) => item.repository.path);
			const all = safe.every((path) => model.selected.includes(path));
			return stay({
				...model,
				message: undefined,
				selected: all
					? model.selected.filter((path) => !safe.includes(path))
					: [...new Set([...model.selected, ...safe])],
			});
		}
		case "f": {
			const status =
				statusCycle[
					(statusCycle.indexOf(model.status) + 1) % statusCycle.length
				];
			return saved({ status, cursor: 0, report: undefined, scroll: 0 });
		}
		case "g":
			return saved({
				groupBy: model.groupBy ? undefined : "language",
				cursor: 0,
				report: undefined,
				scroll: 0,
			});
		case "c":
			if (!model.selected.length)
				return stay({ ...model, message: words.nothingSelected });
			return run({ ...model, report: undefined }, "preview", {
				type: "preview",
				paths: model.selected,
			});
		case "s":
			return run({ ...model, report: undefined }, "scan", { type: "scan" });
		case "t":
		case "tab":
			return run(
				{ ...model, view: "trash", report: undefined, scroll: 0 },
				"trash",
				{ type: "trash" },
			);
	}
	return stay(model);
}

export function reduce(model: Model, event: Event): Step {
	const idle = { ...model, busy: undefined };
	switch (event.type) {
		case "key":
			return onKey(model, event.key);
		case "scanned": {
			const assessments = event.batch.assessments;
			// A selection survives a rescan only while its repository is still SAFE.
			const selected = model.selected.filter((path) =>
				assessments.some(
					(item) => item.repository.path === path && item.status === "SAFE",
				),
			);
			const next = { ...idle, assessments, errors: event.batch.errors };
			return finish(
				model,
				stay({
					...next,
					selected,
					cursor: clamp(model.cursor, visibleRepositories(next).length),
				}),
			);
		}
		case "previewed":
			return finish(
				model,
				stay({
					...idle,
					scroll: 0,
					dialog: {
						kind: "clean",
						paths: model.selected,
						report: event.report,
					},
				}),
			);
		case "cleaned":
			return finish(
				model,
				run(
					{ ...idle, report: event.report, scroll: 0, selected: [] },
					"scan",
					{
						type: "scan",
					},
				),
			);
		case "listed":
			return finish(
				model,
				stay({
					...idle,
					entries: event.entries,
					entryCursor: clamp(model.entryCursor, event.entries.length),
					message: event.note,
				}),
			);
		case "restored":
			return finish(
				model,
				run(
					{ ...idle, report: event.report, scroll: 0, stale: true },
					"trash",
					{
						type: "trash",
					},
				),
			);
		case "failed":
			return finish(model, stay({ ...idle, report: event.message, scroll: 0 }));
	}
}
