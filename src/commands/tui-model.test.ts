import { expect, test } from "bun:test";
import type { Entry } from "../core/trash.ts";
import type { Assessment } from "../model/assessment.ts";
import {
	type Event,
	initialModel,
	type Model,
	preferences,
	reduce,
	rows,
} from "./tui-model.ts";

function assessment(
	path: string,
	status: Assessment["status"],
	language: string | null = null,
): Assessment {
	return {
		repository: { source: "directory", root: "/test", path, name: path },
		status,
		reasons: [],
		checked_at: "2026-01-01T00:00:00Z",
		metadata: { size_bytes: null, last_commit_at: null, language },
		snapshot: null,
	};
}

const key = (name: string, ctrl = false): Event => ({
	type: "key",
	key: { name, ctrl },
});

function play(model: Model, ...events: Event[]) {
	let commands: ReturnType<typeof reduce>["commands"] = [];
	for (const event of events) ({ model, commands } = reduce(model, event));
	return { model, commands };
}

function scanned(...assessments: Assessment[]): Model {
	const start = initialModel({});
	return play(start.model, {
		type: "scanned",
		batch: { assessments, errors: [] },
	}).model;
}

test("starts with a scan and restores saved preferences", () => {
	const start = initialModel({ target: "/work", status: "safe", lang: "ja" });
	expect(start.commands).toEqual([{ type: "scan" }]);
	expect(start.model.busy).toBe("scan");
	expect(preferences(start.model)).toEqual({
		target: "/work",
		status: "safe",
		groupBy: undefined,
		lang: "ja",
	});
});

test("only SAFE repositories can be selected", () => {
	const model = scanned(assessment("/a", "DIRTY"), assessment("/b", "SAFE"));
	const refused = play(model, key("space")).model;
	expect(refused.selected).toEqual([]);
	expect(refused.message).toBeDefined();
	const picked = play(model, key("down"), key("space")).model;
	expect(picked.selected).toEqual(["/b"]);
	expect(play(picked, key("space")).model.selected).toEqual([]);
});

test("select all picks only SAFE and toggles off", () => {
	const model = scanned(
		assessment("/a", "SAFE"),
		assessment("/b", "PROTECTED"),
		assessment("/c", "SAFE"),
	);
	const all = play(model, key("a")).model;
	expect(all.selected).toEqual(["/a", "/c"]);
	expect(play(all, key("a")).model.selected).toEqual([]);
});

test("clean previews first and moves only after confirmation", () => {
	const model = play(scanned(assessment("/a", "SAFE")), key("space")).model;
	const preview = play(model, key("c"));
	expect(preview.commands).toEqual([{ type: "preview", paths: ["/a"] }]);
	const dialog = play(preview.model, {
		type: "previewed",
		report: "would move /a",
	}).model;
	expect(dialog.dialog?.kind).toBe("clean");
	expect(play(dialog, key("n")).commands).toEqual([]);
	expect(play(dialog, key("y")).commands).toEqual([
		{ type: "clean", paths: ["/a"] },
	]);
});

test("clean without a selection does nothing", () => {
	const step = play(scanned(assessment("/a", "SAFE")), key("c"));
	expect(step.commands).toEqual([]);
	expect(step.model.message).toBeDefined();
});

test("a rescan drops selections that are no longer SAFE", () => {
	const model = play(scanned(assessment("/a", "SAFE")), key("space")).model;
	const next = play(model, key("s"), {
		type: "scanned",
		batch: { assessments: [assessment("/a", "DIRTY")], errors: [] },
	}).model;
	expect(next.selected).toEqual([]);
});

test("filter and grouping are saved", () => {
	const model = scanned(
		assessment("/a", "SAFE", "rust"),
		assessment("/b", "DIRTY", "go"),
	);
	const filtered = play(model, key("f"));
	expect(filtered.model.status).toBe("safe");
	expect(filtered.commands).toEqual([{ type: "save" }]);
	expect(
		rows(filtered.model).filter((row) => row.kind === "repository"),
	).toHaveLength(1);
	const grouped = play(model, key("g")).model;
	expect(grouped.groupBy).toBe("language");
	expect(rows(grouped).some((row) => row.kind === "group")).toBe(true);
});

test("restore from the trash view asks before running", () => {
	const entry = {
		id: "e1",
		original: "/a",
		destination: "/trash/e1",
	} as unknown as Entry;
	const model = scanned();
	const trash = play(model, key("t"));
	expect(trash.commands).toEqual([{ type: "trash" }]);
	const listed = play(trash.model, { type: "listed", entries: [entry] }).model;
	const asking = play(listed, key("r")).model;
	expect(asking.dialog?.kind).toBe("restore");
	expect(play(asking, key("y")).commands).toEqual([
		{ type: "restore", id: "e1" },
	]);
});

test("quit waits for a running move", () => {
	const model = play(
		scanned(assessment("/a", "SAFE")),
		key("space"),
		key("c"),
		{
			type: "previewed",
			report: "",
		},
	).model;
	const moving = play(model, key("y")).model;
	const waiting = play(moving, key("c", true));
	expect(waiting.commands).toEqual([]);
	expect(waiting.model.quitting).toBe("abort");
	const done = play(waiting.model, { type: "cleaned", report: "moved" });
	expect(done.commands).toContainEqual({ type: "exit", aborted: true });
});

test("q exits when idle", () => {
	expect(play(scanned(), key("q")).commands).toEqual([
		{ type: "exit", aborted: false },
	]);
});
