import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeTuiState,
	sanitizeTuiState,
	tuiStateName,
	tuiStateStore,
} from "./tui-state.ts";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })));
});
async function temp() {
	const dir = await mkdtemp(join(tmpdir(), "cleaner-tui-state-"));
	dirs.push(dir);
	return dir;
}

test("a missing file loads as no preferences", async () => {
	expect(await tuiStateStore(join(await temp(), "none")).load()).toEqual({});
});

test("saved state round-trips and creates the directory", async () => {
	const dir = join(await temp(), "nested");
	const store = tuiStateStore(dir);
	const state = {
		target: "/work",
		status: "dirty",
		groupBy: "language",
		lang: "ja",
	} as const;
	await store.save(state);
	expect(await store.load()).toEqual(state);
	await store.save({ lang: "en" });
	expect(await store.load()).toEqual({ lang: "en" });
});

test("broken JSON loads as defaults and can be overwritten", async () => {
	const dir = await temp();
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${tuiStateName}.json`), "{not json");
	const store = tuiStateStore(dir);
	expect(await store.load()).toEqual({});
	await store.save({ status: "safe" });
	expect(await store.load()).toEqual({ status: "safe" });
	expect(
		JSON.parse(await readFile(join(dir, "tui-state.json"), "utf8")),
	).toMatchObject({
		status: "safe",
	});
});

test("unknown values are dropped and valid ones kept", async () => {
	const dir = await temp();
	await writeFile(
		join(dir, `${tuiStateName}.json`),
		JSON.stringify({
			target: "/t",
			status: "bogus",
			groupBy: "language",
			lang: "fr",
		}),
	);
	expect(await tuiStateStore(dir).load()).toEqual({
		target: "/t",
		groupBy: "language",
	});
	expect(sanitizeTuiState({ lang: "ja", target: "" })).toEqual({ lang: "ja" });
});

test("flags override saved values and unset flags keep them", () => {
	expect(
		mergeTuiState(
			{ target: "/a", status: "dirty", lang: "ja" },
			{ status: "safe", lang: undefined },
		),
	).toEqual({ target: "/a", status: "safe", lang: "ja" });
});
