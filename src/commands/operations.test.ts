import { afterEach, expect, test } from "bun:test";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { snapshot } from "../core/snapshot.ts";
import { type TrashError, TrashStore } from "../core/trash.ts";
import { CommandRunner } from "../executil/command.ts";
import { fixture } from "../testing/fixture.ts";
import { runCli } from "./application.ts";
import { applicationLive } from "./live.ts";
import type { Confirmation } from "./services.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((item) => item.dispose()));
});

const nonInteractive: Confirmation = {
	tty: false,
	read: async () => {
		throw new Error("Unexpected prompt");
	},
};
const exdev = async () => {
	throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
};

async function setup(
	input: Confirmation = nonInteractive,
	createStore?: (path: string) => TrashStore,
	runner?: Layer.Layer<CommandRunner>,
) {
	const f = await fixture();
	fixtures.push(f);
	const store = join(f.base, "state");
	const app = applicationLive(
		input,
		() => "2026-01-01T00:00:00Z",
		runner ?? f.runner,
		createStore,
	);
	const runWith = async (
		signal: AbortSignal | undefined,
		...args: string[]
	) => {
		const stdout: string[] = [],
			stderr: string[] = [];
		const code = await runCli(
			args,
			{
				stdout: (text) => stdout.push(text),
				stderr: (text) => stderr.push(text),
			},
			app,
			signal,
		);
		return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
	};
	const run = (...args: string[]) => runWith(undefined, ...args);
	const moveRepo = async (
		path: string,
		storeToUse = new TrashStore(store),
	): Promise<string> => {
		const session = await storeToUse.open();
		try {
			return await session.moveRepository(
				path,
				f.root,
				await snapshot(path),
				async () => true,
			);
		} finally {
			await session.close();
		}
	};
	return { ...f, store, run, runWith, moveRepo };
}

async function tree(path: string, prefix = ""): Promise<string[]> {
	const lines: string[] = [];
	for (const name of (await readdir(path)).sort()) {
		const file = join(path, name);
		const info = await lstat(file);
		const mode = (info.mode & 0o777).toString(8);
		if (info.isSymbolicLink())
			lines.push(`${prefix}${name} link ${await readlink(file)}`);
		else if (info.isDirectory()) {
			lines.push(`${prefix}${name}/ ${mode}`);
			lines.push(...(await tree(file, `${prefix}${name}/`)));
		} else
			lines.push(`${prefix}${name} ${mode} ${await readFile(file, "base64")}`);
	}
	return lines;
}

const idOf = async (store: string, index = 0) =>
	(await new TrashStore(store).list()).entries[index]?.id ?? "";

async function stopped(
	f: Awaited<ReturnType<typeof setup>>,
	path: string,
	mover: (from: string, to: string) => Promise<void>,
	failedStop = false,
) {
	const store = new TrashStore(f.store, mover, undefined, async (status) => {
		if (failedStop && status === "failed") throw new Error("Injected stop");
	});
	try {
		await f.moveRepo(path, store);
	} catch (error) {
		return (error as TrashError).id ?? "";
	}
	throw new Error("Expected the move to fail");
}
const interruptedAfterRename = (
	f: Awaited<ReturnType<typeof setup>>,
	path: string,
) =>
	stopped(f, path, async (from, to) => {
		await rename(from, to);
		throw new Error("Injected stop after rename");
	});
const notMoved = (f: Awaited<ReturnType<typeof setup>>, path: string) =>
	stopped(f, path, exdev, true);

test("clean shows the destination, limits, moved IDs and next steps", async () => {
	const f = await setup();
	const repo = await f.repository("shown");
	const result = await f.run("clean", f.root, "--yes", "--state-dir", f.store);
	const id = await idOf(f.store);
	expect(result.code).toBe(0);
	expect(result.stdout).toContain(`State store: ${JSON.stringify(f.store)}`);
	expect(result.stdout).toContain("frees no disk space");
	expect(result.stdout).toContain("external writers");
	expect(result.stdout).toContain(
		`Moved ${JSON.stringify(repo.path)}: ${id} -> ${JSON.stringify(join(f.store, "entries", id, "repo"))}`,
	);
	expect(result.stdout).toContain("Moved 1; skipped 0; kept 0; failed 0.");
	expect(result.stdout).toContain("trash list");
	expect(result.stdout).toContain("restore <ID>");
});

test("clean --dry-run lists candidates and limits without a prompt, store or lock", async () => {
	const f = await setup();
	const safe = await f.repository("a-safe");
	const dirty = await f.repository("b-dirty");
	await writeFile(join(dirty.path, "tracked"), "changed");
	const before = await snapshot(safe.path);
	const result = await f.run(
		"clean",
		f.root,
		"--dry-run",
		"--state-dir",
		f.store,
	);
	expect(result.code).toBe(0);
	expect(result.stdout).toContain(`Would move ${JSON.stringify(safe.path)}`);
	expect(result.stdout).toContain(join(f.store, "entries", "<ID>", "repo"));
	expect(result.stdout).toContain("frees no disk space");
	expect(result.stdout).toContain(`Kept ${JSON.stringify(dirty.path)}: DIRTY`);
	expect(result.stdout).toContain(
		"Dry run: nothing was moved. Would move 1; kept 1.",
	);
	expect(await snapshot(safe.path)).toEqual(before);
	expect(await lstat(f.store).catch(() => null)).toBeNull();
});

test("clean confirmation approves only y/yes; refusal, empty input and EOF skip with exit 0", async () => {
	const answers: (string | null)[] = ["no", "", null, "y"];
	const prompts: string[] = [];
	const f = await setup({
		tty: true,
		read: async (prompt) => {
			prompts.push(prompt);
			return answers.shift() ?? null;
		},
	});
	const repos = [];
	for (const name of ["a", "b", "c", "d"]) repos.push(await f.repository(name));
	const result = await f.run("clean", f.root, "--state-dir", f.store);
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("Moved 1; skipped 3; kept 0; failed 0.");
	expect(prompts).toHaveLength(4);
	expect(prompts[0]).toContain(JSON.stringify(repos[0]?.path));
	expect(prompts[0]).toContain(join(f.store, "entries", "<ID>", "repo"));
	expect(prompts[0]).toContain("frees no disk space");
	for (const repo of repos.slice(0, 3))
		expect(await lstat(repo.path)).toBeDefined();
	expect(await lstat(repos[3]?.path ?? "").catch(() => null)).toBeNull();
	// All refused: nothing moves and the exit value stays 0.
	const refused = await setup({ tty: true, read: async () => "n" });
	const kept = await refused.repository("kept");
	expect((await refused.run("clean", refused.root)).code).toBe(0);
	expect(await lstat(kept.path)).toBeDefined();
});

test("clean DIR --delete --yes runs the same service as clean", async () => {
	const f = await setup();
	const repo = await f.repository("legacy");
	const result = await f.run(
		f.root,
		"--delete",
		"--yes",
		"--state-dir",
		f.store,
	);
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("Moved 1; skipped 0; kept 0; failed 0.");
	expect(await lstat(repo.path).catch(() => null)).toBeNull();
	expect((await new TrashStore(f.store).list()).entries[0]?.status).toBe(
		"moved",
	);
});

test("clean rejects --json, --status and DIR with --ghq with exit 2 and moves nothing", async () => {
	const f = await setup();
	const repo = await f.repository("untouched");
	for (const args of [
		["clean", f.root, "--yes", "--json"],
		["clean", f.root, "--yes", "--status", "safe"],
		["clean", f.root, "--ghq", "--yes"],
		["clean", f.root, "extra", "--yes"],
	])
		expect((await f.run(...args, "--state-dir", f.store)).code).toBe(2);
	expect(await lstat(repo.path)).toBeDefined();
	expect(await lstat(f.store).catch(() => null)).toBeNull();
});

test("clean with an unconnected service fails explicitly and moves nothing", async () => {
	const f = await setup();
	const repo = await f.repository("unconnected");
	const stderr: string[] = [];
	const code = await runCli(
		["clean", f.root, "--yes", "--state-dir", f.store],
		{ stdout: () => {}, stderr: (text) => stderr.push(text) },
	);
	expect(code).toBe(1);
	expect(stderr.join("")).toContain("SERVICE_NOT_CONNECTED");
	expect(await lstat(repo.path)).toBeDefined();
	expect(await lstat(f.store).catch(() => null)).toBeNull();
});

test("clean keeps DIRTY and PROTECTED even with --yes and exits 0", async () => {
	const f = await setup();
	const dirty = await f.repository("a-dirty");
	const ignored = await f.repository("b-ignored");
	await writeFile(join(dirty.path, "tracked"), "changed");
	await writeFile(join(ignored.path, ".git", "info", "exclude"), "*.secret\n");
	await writeFile(join(ignored.path, "file.secret"), "secret");
	const result = await f.run("clean", f.root, "--yes", "--state-dir", f.store);
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("Kept");
	expect(result.stdout).toContain("Moved 0; skipped 0; kept 2; failed 0.");
	expect(await lstat(f.store).catch(() => null)).toBeNull();
});

test("clean reports injected EXDEV and record failures with exit 1 and keeps the data", async () => {
	const crossDevice = await setup(
		nonInteractive,
		(path) => new TrashStore(path, exdev),
	);
	const kept = await crossDevice.repository("exdev");
	const before = await snapshot(kept.path);
	const first = await crossDevice.run(
		"clean",
		crossDevice.root,
		"--yes",
		"--state-dir",
		crossDevice.store,
	);
	expect(first.code).toBe(1);
	expect(first.stdout).toContain("MOVE_FAILED");
	expect(first.stdout).toContain("no copy fallback");
	expect(first.stdout).toContain("Moved 0; skipped 0; kept 0; failed 1.");
	expect(await snapshot(kept.path)).toEqual(before);

	const record = await setup(
		nonInteractive,
		(path) =>
			new TrashStore(path, undefined, undefined, async (status) => {
				if (status === "moved") throw new Error("Injected record failure");
			}),
	);
	await record.repository("a-record");
	await record.repository("b-record");
	const second = await record.run(
		"clean",
		record.root,
		"--yes",
		"--state-dir",
		record.store,
	);
	expect(second.code).toBe(1);
	expect(second.stdout).toContain("RECORD_FAILED_AFTER_MOVE");
	expect(second.stdout).toContain("run trash list");
	expect(second.stdout).toContain("Stopped");
	expect(second.stdout).not.toContain("Moved 1;");
	expect(second.stdout).toContain("Moved 0; skipped 0; kept 0; failed 1.");
	expect(await lstat(join(record.root, "b-record"))).toBeDefined();
	const listed = await new TrashStore(record.store).list();
	expect(listed.entries.map((entry) => entry.status)).toEqual(["recoverable"]);
});

test("clean returns 130 on Ctrl-C at the prompt and moves nothing", async () => {
	const controller = new AbortController();
	const f = await setup({
		tty: true,
		read: (_prompt, signal) =>
			new Promise((resolve) => {
				signal?.addEventListener("abort", () => resolve(null));
				controller.abort();
			}),
	});
	const repo = await f.repository("interrupted");
	const result = await f.runWith(
		controller.signal,
		"clean",
		f.root,
		"--state-dir",
		f.store,
	);
	expect(result.code).toBe(130);
	expect(await lstat(repo.path)).toBeDefined();
});

test("trash list shows record, check, paths and times in ID order, including restored entries", async () => {
	const f = await setup();
	const first = await f.repository("first");
	const second = await f.repository("second");
	const idA = await f.moveRepo(first.path);
	const idB = await f.moveRepo(second.path);
	await f.run("restore", idB, "--yes", "--state-dir", f.store);
	const result = await f.run("trash", "list", "--state-dir", f.store);
	expect(result.code).toBe(0);
	expect(result.stderr).toBe("");
	const [low, high] = [idA, idB].sort();
	expect(result.stdout.indexOf(low ?? "")).toBeLessThan(
		result.stdout.indexOf(high ?? ""),
	);
	const text = result.stdout;
	expect(text).toContain(`${idA} moved`);
	expect(text).toContain(`${idB} restored`);
	expect(text).toContain(`Original: ${JSON.stringify(first.path)}`);
	expect(text).toContain(
		`Destination: ${JSON.stringify(join(f.store, "entries", idA, "repo"))}`,
	);
	expect(text).toMatch(/Created: \d{4}-\d\d-\d\dT[^;]+; updated: \d{4}-/);
	expect(text).toContain(
		"Record: moved; check: moved; original path absent; destination present",
	);
	expect(text).toContain(
		"Record: restored; check: restored; original path present; destination absent",
	);
	expect(text).toContain("2 entries; 0 need attention.");
	expect(text).toBe(
		(await f.run("trash", "list", "--state-dir", f.store)).stdout,
	);
});

test("trash list reports the four prepared combinations and exits 1 only for unresolved ones", async () => {
	const f = await setup();
	const idle = await f.repository("a-idle");
	const idNotMoved = await notMoved(f, idle.path);
	const alone = await f.run("trash", "list", "--state-dir", f.store);
	expect(alone.code).toBe(0);
	expect(alone.stdout).toContain(
		"Record: prepared; check: not_moved; original path present; destination absent",
	);

	const candidate = await f.repository("b-candidate");
	const idCandidate = await interruptedAfterRename(f, candidate.path);
	const both1 = await f.repository("c-both");
	const idBoth = await notMoved(f, both1.path);
	await mkdir(join(f.store, "entries", idBoth, "repo"));
	const neither = await f.repository("d-neither");
	const idNeither = await interruptedAfterRename(f, neither.path);
	await rm(join(f.store, "entries", idNeither, "repo"), { recursive: true });

	const before = await snapshot(f.store);
	const result = await f.run("trash", "list", "--state-dir", f.store);
	expect(result.code).toBe(1);
	const lines = Object.fromEntries(
		result.stdout
			.split("\n")
			.filter((line) => /^[0-9a-f]{32} /.test(line))
			.map((line) => line.split(" ") as [string, string]),
	);
	expect(lines).toEqual({
		[idNotMoved]: "not_moved",
		[idCandidate]: "recoverable",
		[idBoth]: "recovery_required",
		[idNeither]: "recovery_required",
	});
	expect(result.stdout).toContain(`restore ${idCandidate}`);
	expect(result.stdout).toContain("Nothing was changed. See the README");
	expect(result.stderr).toContain("RECOVERY_REQUIRED");
	expect(await snapshot(f.store)).toEqual(before);
});

test("trash list shows the rest when one record is broken and leaves the store unchanged", async () => {
	const f = await setup();
	const good = await f.repository("good");
	const bad = await f.repository("bad");
	const goodId = await f.moveRepo(good.path);
	const badId = await f.moveRepo(bad.path);
	const recordPath = join(f.store, "entries", badId, "record.json");
	await writeFile(recordPath, "{not json", { mode: 0o600 });
	await mkdir(join(f.store, "entries", "0".repeat(32)), { mode: 0o700 });
	const before = await snapshot(f.store);
	const result = await f.run("trash", "list", "--state-dir", f.store);
	expect(result.code).toBe(1);
	expect(result.stdout).toContain(`${goodId} moved`);
	expect(result.stdout).toContain(`${badId} invalid_record`);
	expect(result.stdout).toContain(`${"0".repeat(32)} orphan_entry`);
	expect(result.stdout).toContain("3 entries; 2 need attention.");
	expect(await snapshot(f.store)).toEqual(before);
	expect(await readFile(recordPath, "utf8")).toBe("{not json");
});

test("trash list distinguishes an absent store from an unsafe one and never creates it", async () => {
	const f = await setup();
	const missing = await f.run("trash", "list", "--state-dir", f.store);
	expect(missing.code).toBe(0);
	expect(missing.stdout).toContain("Trash is empty.");
	expect(await lstat(f.store).catch(() => null)).toBeNull();

	await mkdir(f.store, { mode: 0o755 });
	await chmod(f.store, 0o755);
	const unsafe = await f.run("trash", "list", "--state-dir", f.store);
	expect(unsafe.code).toBe(1);
	expect(unsafe.stderr).toContain("STORE_UNSAFE");
	expect(unsafe.stderr).toContain("history is unknown");
	expect((await stat(f.store)).mode & 0o777).toBe(0o755);

	const real = join(f.base, "real-state");
	await mkdir(real, { mode: 0o700 });
	const linked = join(f.base, "linked-state");
	await symlink(real, linked);
	const viaLink = await f.run("trash", "list", "--state-dir", linked);
	expect(viaLink.code).toBe(1);
	expect(viaLink.stderr).toContain("STORE_UNSAFE");
	expect(await readdir(real)).toEqual([]);
});

test("trash list rejects unsupported flags and extra arguments with exit 2", async () => {
	const f = await setup();
	for (const args of [
		["--json"],
		["--yes"],
		["--config", "/abs/config.json"],
		["--ghq"],
		["--status", "safe"],
		["--dry-run"],
		["extra"],
		["--state-dir", "relative"],
	])
		expect((await f.run("trash", "list", ...args)).code).toBe(2);
	expect((await f.run("trash")).code).toBe(2);
	expect(await lstat(f.store).catch(() => null)).toBeNull();
});

test("restore rejects missing or malformed IDs and unsupported flags with exit 2 and no operation", async () => {
	const f = await setup();
	const valid = "a".repeat(32);
	for (const args of [
		[],
		["../../etc"],
		["a".repeat(31)],
		["A".repeat(32)],
		[`${valid}/../${valid}`],
		[valid, "--json"],
		[valid, "--dry-run"],
		[valid, "--config", "/abs/config.json"],
		[valid, "--ghq"],
		[valid, "--status", "safe"],
		[valid, "extra"],
	])
		expect(
			(await f.run("restore", ...args, "--yes", "--state-dir", f.store)).code,
		).toBe(2);
	expect(await lstat(f.store).catch(() => null)).toBeNull();
});

test("restore of an unknown but well-formed ID exits 1 and creates no store", async () => {
	const f = await setup();
	const result = await f.run(
		"restore",
		"b".repeat(32),
		"--yes",
		"--state-dir",
		f.store,
	);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("UNKNOWN_ID");
	expect(await lstat(f.store).catch(() => null)).toBeNull();
});

test("restore confirms with ID, destination and original; only y/yes proceeds; non-TTY needs --yes", async () => {
	const answers: (string | null)[] = ["no", "", null, "yes"];
	const prompts: string[] = [];
	const f = await setup({
		tty: true,
		read: async (prompt) => {
			prompts.push(prompt);
			return answers.shift() ?? null;
		},
	});
	const repo = await f.repository("confirmed");
	const id = await f.moveRepo(repo.path);
	for (let attempt = 0; attempt < 3; attempt++) {
		const refused = await f.run("restore", id, "--state-dir", f.store);
		expect(refused.code).toBe(0);
		expect(refused.stdout).toBe("Skipped.");
		expect(await lstat(repo.path).catch(() => null)).toBeNull();
	}
	expect(prompts[0]).toContain(id);
	expect(prompts[0]).toContain(
		JSON.stringify(join(f.store, "entries", id, "repo")),
	);
	expect(prompts[0]).toContain(JSON.stringify(repo.path));
	const accepted = await f.run("restore", id, "--state-dir", f.store);
	expect(accepted.code).toBe(0);
	expect(accepted.stdout).toContain(`Restored ${id}`);
	expect(accepted.stdout).toContain(JSON.stringify(repo.path));
	expect(await readFile(join(repo.path, "tracked"), "utf8")).toBe(
		"preserved\n",
	);

	const batch = await setup();
	const other = await batch.repository("non-tty");
	const otherId = await batch.moveRepo(other.path);
	const denied = await batch.run(
		"restore",
		otherId,
		"--state-dir",
		batch.store,
	);
	expect(denied.code).toBe(2);
	expect(denied.stderr).toContain("requires --yes");
	expect(await lstat(other.path).catch(() => null)).toBeNull();
	expect(
		(await batch.run("restore", otherId, "--yes", "--state-dir", batch.store))
			.code,
	).toBe(0);
});

test("a second restore does not move again and shows the history with exit 1", async () => {
	const f = await setup();
	const repo = await f.repository("twice");
	const id = await f.moveRepo(repo.path);
	expect(
		(await f.run("restore", id, "--yes", "--state-dir", f.store)).code,
	).toBe(0);
	await writeFile(join(repo.path, "later"), "new work");
	const again = await f.run("restore", id, "--yes", "--state-dir", f.store);
	expect(again.code).toBe(1);
	expect(again.stderr).toContain(`ALREADY_RESTORED ${id}`);
	expect(again.stderr).toContain(JSON.stringify(repo.path));
	expect(await readFile(join(repo.path, "later"), "utf8")).toBe("new work");
});

test("restore never overwrites an existing path or creates a missing parent", async () => {
	const f = await setup();
	const repo = await f.repository("collide");
	const id = await f.moveRepo(repo.path);
	const restore = () => f.run("restore", id, "--yes", "--state-dir", f.store);
	await mkdir(repo.path);
	await writeFile(join(repo.path, "mine"), "keep");
	expect((await restore()).code).toBe(1);
	expect(await readFile(join(repo.path, "mine"), "utf8")).toBe("keep");
	await rm(repo.path, { recursive: true });
	await symlink(join(f.base, "nowhere"), repo.path);
	expect((await restore()).code).toBe(1);
	expect((await lstat(repo.path)).isSymbolicLink()).toBe(true);
	await rm(repo.path);
	const parked = `${f.root}-parked`;
	await rename(f.root, parked);
	const orphaned = await restore();
	expect(orphaned.code).toBe(1);
	expect(orphaned.stderr).toContain("UNRESTORABLE");
	expect(await lstat(f.root).catch(() => null)).toBeNull();
	await rename(parked, f.root);
	expect((await restore()).code).toBe(0);
});

test("restore refuses tampered records and ambiguous states but restores a confirmed candidate", async () => {
	const f = await setup();
	const tampered = await f.repository("a-tampered");
	const ambiguous = await f.repository("b-ambiguous");
	const candidate = await f.repository("c-candidate");
	const tamperedId = await f.moveRepo(tampered.path);
	const ambiguousId = await notMoved(f, ambiguous.path);
	await mkdir(join(f.store, "entries", ambiguousId, "repo"));
	const candidateId = await interruptedAfterRename(f, candidate.path);
	const recordPath = join(f.store, "entries", tamperedId, "record.json");
	const wrapper = JSON.parse(await readFile(recordPath, "utf8"));
	wrapper.data = wrapper.data.replace(tampered.path, join(f.base, "elsewhere"));
	await writeFile(recordPath, JSON.stringify(wrapper));
	const restore = (id: string) =>
		f.run("restore", id, "--yes", "--state-dir", f.store);

	const bad = await restore(tamperedId);
	expect(bad.code).toBe(1);
	expect(bad.stderr).toContain(`NOT_RESTORABLE ${tamperedId} invalid_record`);
	expect(await lstat(join(f.base, "elsewhere")).catch(() => null)).toBeNull();
	const unclear = await restore(ambiguousId);
	expect(unclear.code).toBe(1);
	expect(unclear.stderr).toContain(
		`NOT_RESTORABLE ${ambiguousId} recovery_required`,
	);
	expect(unclear.stderr).toContain("manual recovery");
	expect(await lstat(ambiguous.path)).toBeDefined();
	expect((await restore(candidateId)).code).toBe(0);
	expect(await readFile(join(candidate.path, "tracked"), "utf8")).toBe(
		"preserved\n",
	);
});

test("restore failures show the ID and recovery guidance and are never reported as success", async () => {
	const base = await setup();
	const repo = await base.repository("failing");
	const id = await base.moveRepo(repo.path);
	const args = ["restore", id, "--yes", "--state-dir", base.store] as const;
	const failing = async (createStore: (path: string) => TrashStore) => {
		const f = await setup(nonInteractive, createStore);
		return f.run(...args);
	};

	const crossDevice = await failing((path) => new TrashStore(path, exdev));
	expect(crossDevice.code).toBe(1);
	expect(crossDevice.stderr).toContain(`MOVE_FAILED ${id}`);
	expect(crossDevice.stderr).toContain("Run trash list");
	expect(crossDevice.stdout).not.toContain("Restored");
	expect(await lstat(repo.path).catch(() => null)).toBeNull();
	expect((await new TrashStore(base.store).list()).entries[0]?.status).toBe(
		"recoverable",
	);

	const record = await failing(
		(path) =>
			new TrashStore(path, undefined, undefined, async (status) => {
				if (status === "restored") throw new Error("Injected record failure");
			}),
	);
	expect(record.code).toBe(1);
	expect(record.stderr).toContain(`RECORD_FAILED_AFTER_MOVE ${id}`);
	expect(record.stdout).not.toContain("Restored");
	expect(await lstat(join(repo.path, "tracked"))).toBeDefined();

	const other = await setup();
	const locked = await other.repository("locked");
	const lockedId = await other.moveRepo(locked.path);
	const held = await new TrashStore(other.store).open();
	const contended = await other.run(
		"restore",
		lockedId,
		"--yes",
		"--state-dir",
		other.store,
	);
	await held.close();
	expect(contended.code).toBe(1);
	expect(contended.stderr).toContain(`LOCK_HELD ${lockedId}`);
	expect(await lstat(locked.path).catch(() => null)).toBeNull();
});

test("restore returns 130 on Ctrl-C at the prompt and moves nothing", async () => {
	const controller = new AbortController();
	const f = await setup({
		tty: true,
		read: (_prompt, signal) =>
			new Promise((resolve) => {
				signal?.addEventListener("abort", () => resolve(null));
				controller.abort();
			}),
	});
	const repo = await f.repository("cancelled");
	const id = await f.moveRepo(repo.path);
	const result = await f.runWith(
		controller.signal,
		"restore",
		id,
		"--state-dir",
		f.store,
	);
	expect(result.code).toBe(130);
	expect(await lstat(repo.path).catch(() => null)).toBeNull();
});

test("restore needs neither Git, ghq nor the network, so a repository that would be DIRTY or offline still returns", async () => {
	const offline = Layer.succeed(CommandRunner, {
		run: () => Effect.die("restore must not run external commands"),
	});
	const f = await setup(nonInteractive, undefined, offline);
	const repo = await f.repository("offline");
	const id = await f.moveRepo(repo.path);
	await rm(repo.remote, { recursive: true });
	const result = await f.run("restore", id, "--yes", "--state-dir", f.store);
	expect(result.code).toBe(0);
	await writeFile(join(repo.path, "tracked"), "edited after restore");
	expect(await f.git(repo.path, "status", "--porcelain")).toContain("tracked");
});

test("clean -> trash list -> restore round trip keeps .git, contents, config and permissions", async () => {
	const f = await setup();
	const repo = await f.repository("round-trip");
	const hook = join(repo.path, ".git", "hooks", "pre-push");
	await writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	await chmod(hook, 0o755);
	await f.git(repo.path, "config", "local.marker", "kept");
	const config = await readFile(join(repo.path, ".git", "config"), "utf8");
	const before = await tree(repo.path);
	const head = await f.git(repo.path, "rev-parse", "HEAD");

	const cleaned = await f.run("clean", f.root, "--yes", "--state-dir", f.store);
	expect(cleaned.code).toBe(0);
	expect(await lstat(repo.path).catch(() => null)).toBeNull();
	const id = await idOf(f.store);
	const listed = await f.run("trash", "list", "--state-dir", f.store);
	expect(listed.stdout).toContain(`${id} moved`);
	const restored = await f.run("restore", id, "--yes", "--state-dir", f.store);
	expect(restored.code).toBe(0);

	expect(await tree(repo.path)).toEqual(before);
	expect(await readFile(join(repo.path, ".git", "config"), "utf8")).toBe(
		config,
	);
	expect((await stat(hook)).mode & 0o777).toBe(0o755);
	expect(await f.git(repo.path, "config", "--get", "local.marker")).toBe(
		"kept\n",
	);
	expect(await f.git(repo.path, "rev-parse", "HEAD")).toBe(head);
	expect(await f.git(repo.path, "status", "--porcelain")).toBe("");
	expect(await readFile(join(repo.path, "tracked"), "utf8")).toBe(
		"preserved\n",
	);
});
