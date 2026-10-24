import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	rename,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { snapshot } from "../core/snapshot.ts";
import { makeCommandRunner } from "../executil/command.ts";
import { fixture } from "../testing/fixture.ts";
import { runCli } from "./application.ts";
import { applicationLive } from "./live.ts";

// Each case diagnoses several real repositories, which exceeds the 5s default on slow runners.
setDefaultTimeout(30_000);

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((item) => item.dispose()));
});

async function setup() {
	const f = await fixture();
	fixtures.push(f);
	const bin = join(f.base, "bin");
	await mkdir(bin);
	const executable = join(bin, "ghq");
	const app = applicationLive(
		{ tty: false, read: async () => null },
		() => "2026-01-01T00:00:00Z",
		makeCommandRunner({ ...f.env, PATH: `${bin}:${process.env.PATH}` }),
	);
	const ghq = async (roots: string[], paths: string[]) => {
		await writeFile(
			executable,
			`#!${process.execPath}\nprocess.stdout.write(process.argv[2] === "root" ? ${JSON.stringify(roots.length ? `${roots.join("\n")}\n` : "")} : ${JSON.stringify(paths.length ? `${paths.join("\n")}\n` : "")});\n`,
		);
		await chmod(executable, 0o700);
	};
	const run = async (...args: string[]) => {
		const stdout: string[] = [],
			stderr: string[] = [];
		const code = await runCli(
			args,
			{
				stdout: (text) => stdout.push(text),
				stderr: (text) => stderr.push(text),
			},
			app,
		);
		return {
			code,
			stdout: stdout.join("\n"),
			stderr: stderr.join("\n"),
			json: () => JSON.parse(stdout[0] ?? ""),
		};
	};
	return { ...f, ghq, run, executable };
}

async function mixed(f: Awaited<ReturnType<typeof setup>>) {
	const safe = await f.repository("a-safe"),
		dirty = await f.repository("b-dirty"),
		ignored = await f.repository("c-ignored"),
		unknown = await f.repository("d-unknown");
	await writeFile(join(dirty.path, "tracked"), "changed");
	await writeFile(join(ignored.path, ".git", "info", "exclude"), "*.secret\n");
	await writeFile(join(ignored.path, "file.secret"), "preserve secret");
	await f.git(
		unknown.path,
		"remote",
		"set-url",
		"origin",
		join(f.base, "missing-remote"),
	);
	await f.ghq(
		[f.root],
		[safe, dirty, ignored, unknown].map((repo) => repo.path),
	);
	return { safe, dirty, ignored, unknown };
}

test("no arguments, scan and --ghq run the same ghq diagnosis across roots", async () => {
	const f = await setup();
	const a = await f.repository("日本語 repo");
	const second = join(f.base, "root2");
	await mkdir(second);
	const b = await f.repository("second");
	const moved = join(second, "second");
	await rename(b.path, moved);
	await f.ghq([f.root, second], [a.path, moved]);
	const results = [
		await f.run("--json"),
		await f.run("scan", "--json"),
		await f.run("scan", "--ghq", "--json"),
	];
	for (const result of results) {
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(results[0]?.stdout ?? "");
	}
	const json = results[0]?.json();
	expect(json.summary).toMatchObject({ scanned: 2, returned: 2, safe: 2 });
	expect(
		json.repositories.map((repo: { root: string }) => repo.root).sort(),
	).toEqual([f.root, second].sort());
	expect(json.errors).toEqual([]);
	const text = await f.run();
	expect(text.stdout).toBe((await f.run("scan")).stdout);
	expect(text.stdout).toContain("Scanned 2; returned 2");
});

test("scan DIR reads direct children only and rejects DIR with --ghq", async () => {
	const f = await setup();
	const safe = await f.repository("direct");
	await mkdir(join(f.root, "group"));
	await rename(
		(await f.repository("grandchild")).path,
		join(f.root, "group", "grandchild"),
	);
	await f.ghq([f.root], []);
	const dir = await f.run("scan", f.root, "--json");
	expect(
		dir.json().repositories.map((repo: { path: string }) => repo.path),
	).toEqual([safe.path]);
	expect((await f.run("scan", f.root, "--ghq")).code).toBe(2);
	expect((await f.run("list", f.root, "--ghq")).code).toBe(2);
	const legacy = await f.run(f.root, "--json");
	expect(legacy.stdout).toBe(dir.stdout);
});

test("mixed four states and an individual failure never stop the remaining diagnosis", async () => {
	const f = await setup();
	const repos = await mixed(f);
	await f.ghq(
		[f.root],
		[...Object.values(repos).map((repo) => repo.path), join(f.root, "gone")],
	);
	const before = await Promise.all(
		Object.values(repos).map((repo) => snapshot(repo.path)),
	);
	const result = await f.run("scan", "--json");
	const json = result.json();
	expect(
		json.repositories.map((repo: { status: string }) => repo.status),
	).toEqual(["SAFE", "DIRTY", "PROTECTED", "UNKNOWN", "UNKNOWN"]);
	expect(json.summary).toMatchObject({
		scanned: 5,
		returned: 5,
		safe: 1,
		dirty: 1,
		protected: 1,
		unknown: 2,
	});
	expect(result.code).toBe(1);
	for (const repo of json.repositories) {
		expect(repo.metadata).toHaveProperty("size_bytes");
		expect(repo.metadata).toHaveProperty("last_commit_at");
		expect(repo.checked_at).toBe("2026-01-01T00:00:00Z");
	}
	expect(
		await Promise.all(Object.values(repos).map((repo) => snapshot(repo.path))),
	).toEqual(before);
	expect(await readdir(f.base)).not.toContain("state");
});

test("DIRTY and PROTECTED alone and an empty listing exit 0, enumeration failure exits 1", async () => {
	const f = await setup();
	const dirty = await f.repository("dirty");
	await writeFile(join(dirty.path, "tracked"), "changed");
	const ignored = await f.repository("ignored");
	await writeFile(join(ignored.path, ".git", "info", "exclude"), "*.secret\n");
	await writeFile(join(ignored.path, "x.secret"), "x");
	await f.ghq([f.root], [dirty.path, ignored.path]);
	expect((await f.run("scan")).code).toBe(0);
	await f.ghq([f.root], []);
	const empty = await f.run("scan", "--json");
	expect(empty.code).toBe(0);
	expect(empty.json().summary.scanned).toBe(0);
	expect(empty.json().errors).toEqual([]);
	expect((await f.run("scan")).stdout).toContain("Scanned 0; returned 0");
	await writeFile(f.executable, `#!${process.execPath}\nprocess.exit(7);`);
	const failed = await f.run("scan", "--json");
	expect(failed.code).toBe(1);
	expect(failed.json().repositories).toEqual([]);
	expect(failed.json().errors[0]).toMatchObject({
		code: "GHQ_COMMAND_FAILED",
	});
	expect(failed.stderr).toContain("GHQ_COMMAND_FAILED");
});

test("configuration errors exit 2 before discovery and are reported in errors", async () => {
	const f = await setup();
	await f.repository("safe");
	await f.ghq([f.root], []);
	const config = join(f.base, "bad.json");
	await writeFile(config, "{");
	for (const command of ["scan", "list", "inspect"]) {
		const target = command === "inspect" ? [f.root] : [];
		const json = await f.run(command, ...target, "--config", config, "--json");
		expect(json.code).toBe(2);
		expect(json.json().repositories).toEqual([]);
		expect(json.json().errors[0].code).toBe("CONFIG_OR_TARGET_ERROR");
		expect(json.json().errors[0].message).toContain("configuration");
		const text = await f.run(command, ...target, "--config", config);
		expect(text.code).toBe(2);
		expect(text.stderr).toContain("configuration");
	}
});

test("list filters after diagnosing everything for each status and reports hidden UNKNOWN", async () => {
	const f = await setup();
	await mixed(f);
	for (const [status, expected, code] of [
		["safe", "SAFE", 1],
		["dirty", "DIRTY", 1],
		["protected", "PROTECTED", 1],
		["unknown", "UNKNOWN", 1],
	] as const) {
		const result = await f.run("list", "--status", status, "--json");
		const json = result.json();
		expect(
			json.repositories.map((repo: { status: string }) => repo.status),
		).toEqual([expected]);
		expect(json.summary).toMatchObject({
			scanned: 4,
			returned: 1,
			safe: 1,
			dirty: 1,
			protected: 1,
			unknown: 1,
		});
		expect(result.code).toBe(code);
	}
	const all = await f.run("list", "--json");
	expect(all.json().summary.returned).toBe(4);
	const text = await f.run("list", "--status", "safe");
	expect(text.stdout).toContain(
		"Scanned 4; returned 1; SAFE 1; DIRTY 1; PROTECTED 1; UNKNOWN 1",
	);
	expect(text.stdout).not.toContain('DIRTY "');
});

test("list with no match is a normal result", async () => {
	const f = await setup();
	const safe = await f.repository("safe");
	await f.ghq([f.root], [safe.path]);
	const none = await f.run("list", "--status", "dirty", "--json");
	expect(none.code).toBe(0);
	expect(none.json().repositories).toEqual([]);
	expect(none.json().summary).toMatchObject({ scanned: 1, returned: 0 });
	expect((await f.run("list", "--status", "dirty")).stdout).toContain(
		"Scanned 1; returned 0",
	);
});

test("every run diagnoses afresh and list never filters before inspecting", async () => {
	const f = await setup();
	const repo = await f.repository("fresh");
	await f.ghq([f.root], [repo.path]);
	expect((await f.run("scan", "--json")).json().repositories[0].status).toBe(
		"SAFE",
	);
	await writeFile(join(repo.path, "tracked"), "changed");
	expect((await f.run("scan", "--json")).json().repositories[0].status).toBe(
		"DIRTY",
	);
	const hidden = await f.run("list", "--status", "safe", "--json");
	expect(hidden.json().repositories).toEqual([]);
	expect(hidden.json().summary.dirty).toBe(1);
	await f.git(repo.path, "checkout", "--", "tracked");
	expect((await f.run("list", "--status", "safe", "--json")).code).toBe(0);
	expect(
		(await f.run("list", "--status", "safe", "--json")).json().repositories,
	).toHaveLength(1);
});

test("inspect resolves ghq names exactly and diagnoses only that repository", async () => {
	const f = await setup();
	const space = await f.repository("日本語 space");
	const other = await f.repository("日本語");
	await f.ghq([f.root], [space.path, other.path]);
	const result = await f.run("inspect", "日本語 space", "--json");
	expect(result.code).toBe(0);
	const json = result.json();
	expect(json.repositories).toHaveLength(1);
	expect(json.repositories[0]).toMatchObject({
		source: "ghq",
		root: f.root,
		name: "日本語 space",
		path: space.path,
		status: "SAFE",
		checked_at: "2026-01-01T00:00:00Z",
	});
	expect(json.summary).toMatchObject({ scanned: 1, returned: 1, safe: 1 });
	const text = await f.run("inspect", "日本語 space");
	expect(text.stdout).toContain("Source: ghq");
	expect(text.stdout).toContain(`root: ${JSON.stringify(f.root)}`);
	expect(text.stdout).toContain('name: "日本語 space"');
	expect(text.stdout).toContain("Checked at: 2026-01-01T00:00:00Z");
	expect(text.stdout).toContain("Logical bytes (estimate)");
	expect(text.stdout).toContain("Scanned 1; returned 1");
	for (const missing of ["日本", "日本語 spac", "SPACE", "space"]) {
		const miss = await f.run("inspect", missing, "--json");
		expect(miss.code).toBe(2);
		expect(miss.json().repositories).toEqual([]);
		expect(miss.json().errors[0].code).toBe("CONFIG_OR_TARGET_ERROR");
		expect(miss.json().errors[0].message).toContain("absolute path");
	}
});

test("inspect refuses a name shared by two roots and points to an absolute path", async () => {
	const f = await setup();
	const first = await f.repository("same");
	const second = join(f.base, "root2");
	await mkdir(second);
	const moved = join(second, "same");
	await rename((await f.repository("same-2")).path, moved);
	await f.ghq([f.root, second], [first.path, moved]);
	const result = await f.run("inspect", "same", "--json");
	expect(result.code).toBe(2);
	const message = result.json().errors[0].message;
	expect(message).toContain("ambiguous");
	expect(message).toContain(first.path);
	expect(message).toContain(moved);
	expect(message).toContain("absolute path");
	expect((await f.run("inspect", moved, "--json")).code).toBe(0);
});

test("inspect accepts absolute, ./ and ../ paths and diagnoses the repository itself", async () => {
	const f = await setup();
	const repo = await f.repository("空白 repo ");
	await f.ghq([f.root], []);
	const before = await snapshot(repo.path);
	const work = join(f.base, "work");
	await mkdir(work);
	const original = process.cwd();
	try {
		for (const [cwd, target] of [
			[original, repo.path],
			[f.base, "./repositories/空白 repo "],
			[work, "../repositories/空白 repo "],
		] as const) {
			process.chdir(cwd);
			const result = await f.run("inspect", target, "--json");
			expect(result.code).toBe(0);
			const json = result.json();
			expect(json.repositories[0]).toMatchObject({
				source: "directory",
				path: repo.path,
				status: "SAFE",
			});
			expect(json.repositories).toHaveLength(1);
		}
	} finally {
		process.chdir(original);
	}
	expect(await snapshot(repo.path)).toEqual(before);
	expect(await readdir(f.base)).not.toContain("state");
});

test("inspect rejects child folders, plain directories and files; ghq is not consulted for paths", async () => {
	const f = await setup();
	const repo = await f.repository("parent");
	const child = join(repo.path, "child");
	await mkdir(child);
	await writeFile(join(repo.path, "file"), "x");
	await writeFile(f.executable, `#!${process.execPath}\nprocess.exit(7);`);
	for (const target of [child, f.root, join(repo.path, "file")]) {
		const result = await f.run("inspect", target, "--json");
		expect(result.code).toBe(2);
		expect(result.json().repositories).toEqual([]);
		expect(result.json().errors[0].message).toContain("worktree root");
	}
	expect((await f.run("inspect", repo.path)).code).toBe(0);
});

test("inspect never turns missing, broken or symlinked paths into SAFE", async () => {
	const f = await setup();
	const repo = await f.repository("real");
	const broken = join(f.root, "broken");
	await mkdir(broken);
	await writeFile(join(broken, ".git"), "gitdir: /nonexistent/gitdir\n");
	const linked = join(f.root, "linked");
	await symlink(repo.path, linked);
	const missing = join(f.root, "missing");
	await f.ghq([f.root], []);
	for (const [target, reason] of [
		[missing, "LOCAL_INSPECTION_FAILED"],
		[broken, "LOCAL_INSPECTION_FAILED"],
		[linked, "PATH_SYMLINK"],
	] as const) {
		const result = await f.run("inspect", target, "--json");
		const item = result.json().repositories[0];
		expect(item.status).not.toBe("SAFE");
		if (target !== linked) expect(item.status).toBe("UNKNOWN");
		if (reason)
			expect(item.reasons.map((r: { code: string }) => r.code)).toContain(
				reason,
			);
	}
	const unknown = await f.run("inspect", missing, "--json");
	expect(unknown.code).toBe(1);
	expect(unknown.json().repositories[0].status).toBe("UNKNOWN");
	expect(await lstat(repo.path)).toBeDefined();
});

test("inspect text and JSON keep every reason with its manual action", async () => {
	const f = await setup();
	const repo = await f.repository("multi");
	await writeFile(join(repo.path, "tracked"), "changed");
	await writeFile(join(repo.path, ".git", "info", "exclude"), "*.secret\n");
	await writeFile(join(repo.path, "a.secret"), "x");
	await f.ghq([f.root], [repo.path]);
	const json = (await f.run("inspect", "multi", "--json")).json();
	const reasons = json.repositories[0].reasons as {
		code: string;
		action: string;
	}[];
	expect(reasons.length).toBeGreaterThan(1);
	const text = (await f.run("inspect", "multi")).stdout;
	for (const reason of reasons) {
		expect(text).toContain(reason.code);
		expect(text).toContain(reason.action);
	}
});

test("a missing or non-directory DIR is an argument error, an unreadable one an enumeration failure", async () => {
	const f = await setup();
	await f.ghq([f.root], []);
	const file = join(f.base, "plain-file");
	await writeFile(file, "x");
	for (const target of [join(f.base, "absent"), file]) {
		for (const command of ["scan", "list"]) {
			const result = await f.run(command, target, "--json");
			expect(result.code).toBe(2);
			expect(result.json().errors[0].code).toBe("CONFIG_OR_TARGET_ERROR");
			expect(result.json().repositories).toEqual([]);
		}
		const clean = await f.run("clean", target, "--dry-run");
		expect(clean.code).toBe(2);
		expect(clean.stderr).toContain("Directory does not exist");
	}
	if (process.getuid?.() === 0) return;
	const locked = join(f.base, "locked");
	await mkdir(locked);
	await chmod(locked, 0o000);
	try {
		const result = await f.run("scan", locked, "--json");
		expect(result.code).toBe(1);
		expect(result.json().errors[0].code).toBe("DISCOVERY_FAILED");
	} finally {
		await chmod(locked, 0o700);
	}
});
