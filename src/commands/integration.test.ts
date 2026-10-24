import { afterEach, expect, test } from "bun:test";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Layer } from "effect";
import { snapshot } from "../core/snapshot.ts";
import { TrashStore } from "../core/trash.ts";
import {
	CommandError,
	CommandRunner,
	makeCommandRunner,
} from "../executil/command.ts";
import { fixture } from "../testing/fixture.ts";
import { runCli } from "./application.ts";
import { applicationLive } from "./live.ts";
import type { Confirmation } from "./services.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((item) => item.dispose()));
});
async function setup(
	input: Confirmation = { tty: false, read: async () => null },
) {
	const f = await fixture();
	fixtures.push(f);
	const store = join(f.base, "state");
	const app = applicationLive(input, () => "2026-01-01T00:00:00Z", f.runner);
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
		return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
	};
	return { ...f, store, run };
}

test("E2E-01 clean clone scan is SAFE, read-only and creates no state", async () => {
	const f = await setup();
	const repo = await f.repository("日本語 repo");
	const before = await snapshot(repo.path);
	const result = await f.run("scan", f.root, "--json");
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).repositories[0].status).toBe("SAFE");
	expect(await snapshot(repo.path)).toEqual(before);
	expect(await lstat(f.store).catch(() => null)).toBeNull();
});

test("E2E-02/03 mixed batch continues, clean --yes moves SAFE only", async () => {
	const f = await setup();
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
	const before = await Promise.all(
		[dirty, ignored, unknown].map((repo) => snapshot(repo.path)),
	);
	const scan = await f.run("scan", f.root, "--json");
	expect(
		JSON.parse(scan.stdout).repositories.map(
			(repo: { status: string }) => repo.status,
		),
	).toEqual(["SAFE", "DIRTY", "PROTECTED", "UNKNOWN"]);
	expect(scan.code).toBe(1);
	const clean = await f.run("clean", f.root, "--yes", "--state-dir", f.store);
	expect(clean.code).toBe(1);
	expect(await lstat(safe.path).catch(() => null)).toBeNull();
	expect(
		await Promise.all(
			[dirty, ignored, unknown].map((repo) => snapshot(repo.path)),
		),
	).toEqual(before);
	// Four real repositories plus scan, clean and revalidation exceed Bun's 5s default
	// on hosted macOS runners. Process timeouts are tested separately.
}, 15_000);

test("E2E-04 state changed during approval is kept", async () => {
	let mutate = async () => {};
	const f = await setup({
		tty: true,
		read: async () => {
			await mutate();
			return "yes";
		},
	});
	const repo = await f.repository("race");
	mutate = () =>
		writeFile(join(repo.path, "tracked"), "changed during approval");
	const result = await f.run("clean", f.root, "--state-dir", f.store);
	expect(result.code).toBe(1);
	expect(await readFile(join(repo.path, "tracked"), "utf8")).toBe(
		"changed during approval",
	);
});

test("E2E-07 dry-run skips confirmation and state; non-TTY mutation requires --yes", async () => {
	const f = await setup();
	const repo = await f.repository("safe");
	expect(
		(await f.run("clean", f.root, "--dry-run", "--state-dir", f.store)).code,
	).toBe(0);
	expect(await lstat(f.store).catch(() => null)).toBeNull();
	expect((await f.run("clean", f.root, "--state-dir", f.store)).code).toBe(2);
	expect(await lstat(repo.path)).toBeDefined();
});

test("E2E-08/10 clean -> trash list -> restore retains data and rejects collisions/tampering", async () => {
	const f = await setup();
	const repo = await f.repository("safe");
	expect(
		(await f.run("clean", f.root, "--yes", "--state-dir", f.store)).code,
	).toBe(0);
	const entries = await new TrashStore(f.store).list();
	const id = entries.entries[0]?.id ?? "";
	expect(
		(await f.run("trash", "list", "--state-dir", f.store)).stdout,
	).toContain(id);
	await mkdir(repo.path);
	expect(
		(await f.run("restore", id, "--yes", "--state-dir", f.store)).code,
	).toBe(1);
	await rename(repo.path, `${repo.path}-collision`);
	expect(
		(await f.run("restore", id, "--yes", "--state-dir", f.store)).code,
	).toBe(0);
	expect(await readFile(join(repo.path, "tracked"), "utf8")).toBe(
		"preserved\n",
	);
	expect(
		(await f.run("restore", id, "--yes", "--state-dir", f.store)).code,
	).toBe(1);
	const recordPath = join(f.store, `${id}.json`);
	const record = JSON.parse(await readFile(recordPath, "utf8"));
	record.data = record.data.replace('"status":"restored"', '"status":"moved"');
	await writeFile(recordPath, JSON.stringify(record));
	expect((await f.run("trash", "list", "--state-dir", f.store)).code).toBe(1);
});

test("E2E-09 record failure after rename exposes recovery candidate without losing data", async () => {
	const f = await setup();
	const repo = await f.repository("safe");
	const store = new TrashStore(f.store, rename, undefined, async (status) => {
		if (status === "moved") throw new Error("Injected record failure");
	});
	await expect(
		store.moveRepository(
			repo.path,
			f.root,
			await snapshot(repo.path),
			async () => true,
		),
	).rejects.toThrow();
	const result = await new TrashStore(f.store).list();
	expect(result.failed).toBe(true);
	expect(result.entries[0]?.status).toBe("recovery-required");
	expect(
		await readFile(
			join(f.store, result.entries[0]?.id ?? "", "tracked"),
			"utf8",
		),
	).toBe("preserved\n");
});

test("E2E-11 filtered JSON retains UNKNOWN in summary and exit status", async () => {
	const f = await setup();
	await f.repository("safe");
	const unknown = await f.repository("unknown");
	await f.git(
		unknown.path,
		"remote",
		"set-url",
		"origin",
		join(f.base, "missing"),
	);
	const result = await f.run("list", f.root, "--status", "safe", "--json");
	const json = JSON.parse(result.stdout);
	expect(json.repositories).toHaveLength(1);
	expect(json.summary.unknown).toBe(1);
	expect(result.code).toBe(1);
});

test("E2E-12 local remote inside target set protects dependent repositories", async () => {
	const f = await setup();
	const a = await f.repository("a"),
		b = await f.repository("b");
	await f.git(a.path, "remote", "set-url", "origin", b.path);
	const result = await f.run("clean", f.root, "--yes", "--state-dir", f.store);
	expect(result.stdout).toContain("LOCAL_REMOTE_DEPENDENCY");
	expect(await lstat(a.path)).toBeDefined();
	expect(await lstat(b.path)).toBeDefined();
});

test("exclusion configuration, symlink escapes and injected EXDEV never move source", async () => {
	const f = await setup();
	const repo = await f.repository("excluded");
	const config = join(f.base, "exclude.json");
	await writeFile(
		config,
		JSON.stringify({
			version: 1,
			exclude: [{ kind: "name", pattern: "excluded" }],
		}),
	);
	expect(
		(
			await f.run(
				"clean",
				f.root,
				"--yes",
				"--config",
				config,
				"--state-dir",
				f.store,
			)
		).stdout,
	).toContain("PROTECTED");
	await writeFile(config, "invalid JSON");
	expect(
		(
			await f.run(
				"clean",
				f.root,
				"--yes",
				"--config",
				config,
				"--state-dir",
				f.store,
			)
		).code,
	).toBe(2);
	await symlink(repo.path, join(f.root, "link"));
	const scan = JSON.parse((await f.run("scan", f.root, "--json")).stdout);
	expect(
		scan.repositories.find((item: { path: string }) =>
			item.path.endsWith("/link"),
		).status,
	).not.toBe("SAFE");
	const store = new TrashStore(f.store, async () => {
		throw Object.assign(new Error("Injected EXDEV"), { code: "EXDEV" });
	});
	await expect(
		store.moveRepository(
			repo.path,
			f.root,
			await snapshot(repo.path),
			async () => true,
		),
	).rejects.toThrow();
	expect(await readFile(join(repo.path, "tracked"), "utf8")).toBe(
		"preserved\n",
	);
});

test("missing trash store is read-only and empty", async () => {
	const f = await setup();
	expect((await f.run("trash", "list", "--state-dir", f.store)).code).toBe(0);
	expect((await readdir(f.base)).includes("state")).toBe(false);
});

test("ghq executable supports multiple roots, Japanese paths, duplicates and per-item failures", async () => {
	const f = await setup();
	const a = await f.repository("日本語 space");
	const second = join(f.base, "root2");
	await mkdir(second);
	const b = await f.repository("second");
	const moved = join(second, "second");
	await rename(b.path, moved);
	const binaryDirectory = join(f.base, "bin");
	await mkdir(binaryDirectory);
	const executable = join(binaryDirectory, "ghq");
	const roots = `${f.root}\n${second}\n`;
	const paths = `${a.path}\n${moved}\n${a.path}\n${join(f.root, "missing")}\n`;
	await writeFile(
		executable,
		`#!${process.execPath}\nconsole.log(process.argv[2] === "root" ? ${JSON.stringify(roots.slice(0, -1))} : ${JSON.stringify(paths.slice(0, -1))});\n`,
	);
	await chmod(executable, 0o700);
	const env = { ...f.env, PATH: `${binaryDirectory}:${process.env.PATH}` };
	const app = applicationLive(
		{ tty: false, read: async () => null },
		undefined,
		makeCommandRunner(env),
	);
	const stdout: string[] = [];
	expect(
		await runCli(
			["--json"],
			{ stdout: (text) => stdout.push(text), stderr: () => {} },
			app,
		),
	).toBe(1);
	const json = JSON.parse(stdout[0] ?? "");
	expect(json.summary.scanned).toBe(3);
	expect(json.summary.safe).toBe(2);
	expect(json.summary.unknown).toBe(1);
	await writeFile(
		executable,
		`#!${process.execPath}\nprocess.stdout.write("relative\\n");\n`,
	);
	expect(
		await runCli(
			["clean", "--yes", "--state-dir", f.store],
			{ stdout: () => {}, stderr: () => {} },
			app,
		),
	).toBe(1);
	expect(await lstat(a.path)).toBeDefined();
});

test("separate clean processes serialize under the store lock", async () => {
	const f = await setup();
	const repo = await f.repository("concurrent");
	const args = [
		process.execPath,
		"src/cli.ts",
		"clean",
		f.root,
		"--yes",
		"--state-dir",
		f.store,
	];
	const children = [
		Bun.spawn(args, { env: f.env, stdout: "pipe", stderr: "pipe" }),
		Bun.spawn(args, { env: f.env, stdout: "pipe", stderr: "pipe" }),
	];
	const exits = await Promise.all(
		children.map(async (child) => {
			await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			return child.exited;
		}),
	);
	expect(exits).toContain(0);
	const listed = await new TrashStore(f.store).list();
	expect(
		listed.entries.filter((entry) => entry.status === "moved"),
	).toHaveLength(1);
	expect(
		await readFile(
			join(f.store, listed.entries[0]?.id ?? "", "tracked"),
			"utf8",
		),
	).toBe("preserved\n");
	expect(await lstat(repo.path).catch(() => null)).toBeNull();
});

test("separate process death immediately after rename leaves a recoverable pending record", async () => {
	const f = await setup();
	const repo = await f.repository("interrupted");
	const script = join(f.base, "crash.ts");
	await writeFile(
		script,
		`import { rename } from "node:fs/promises";\nimport { TrashStore } from ${JSON.stringify(join(process.cwd(), "src/core/trash.ts"))};\nimport { snapshot } from ${JSON.stringify(join(process.cwd(), "src/core/snapshot.ts"))};\nconst store = new TrashStore(${JSON.stringify(f.store)}, async (a,b) => { await rename(a,b); process.kill(process.pid, "SIGKILL"); });\nawait store.moveRepository(${JSON.stringify(repo.path)}, ${JSON.stringify(f.root)}, await snapshot(${JSON.stringify(repo.path)}), async () => true);\n`,
	);
	const child = Bun.spawn([process.execPath, script], {
		env: f.env,
		stdout: "ignore",
		stderr: "ignore",
	});
	expect(await child.exited).not.toBe(0);
	const listed = await new TrashStore(f.store).list();
	expect(listed.failed).toBe(true);
	expect(listed.entries[0]?.status).toBe("recovery-required");
	expect(
		await readFile(
			join(f.store, listed.entries[0]?.id ?? "", "tracked"),
			"utf8",
		),
	).toBe("preserved\n");
});

test("concurrent restore processes never overwrite an existing destination", async () => {
	const f = await setup();
	const repo = await f.repository("restore-race");
	await f.run("clean", f.root, "--yes", "--state-dir", f.store);
	const listed = await new TrashStore(f.store).list();
	const id = listed.entries[0]?.id ?? "";
	const children = [1, 2].map(() =>
		Bun.spawn(
			[
				process.execPath,
				"src/cli.ts",
				"restore",
				id,
				"--yes",
				"--state-dir",
				f.store,
			],
			{ env: f.env, stdout: "ignore", stderr: "ignore" },
		),
	);
	const exits = await Promise.all(children.map((child) => child.exited));
	expect(exits.filter((code) => code === 0)).toHaveLength(1);
	expect(await readFile(join(repo.path, "tracked"), "utf8")).toBe(
		"preserved\n",
	);
});

test("injected permission and pending-record failures preserve the source", async () => {
	const f = await setup();
	const repo = await f.repository("permission-failure");
	const before = await snapshot(repo.path);
	const denied = new TrashStore(f.store, async () => {
		throw Object.assign(new Error("Injected permission failure"), {
			code: "EACCES",
		});
	});
	await expect(
		denied.moveRepository(repo.path, f.root, before, async () => true),
	).rejects.toThrow();
	expect(await snapshot(repo.path)).toEqual(before);
	const store2 = join(f.base, "record-failure");
	const failed = new TrashStore(store2, rename, undefined, async () => {
		throw new Error("Injected write failure");
	});
	await expect(
		failed.moveRepository(repo.path, f.root, before, async () => true),
	).rejects.toThrow();
	expect(await snapshot(repo.path)).toEqual(before);
});

test("global Git configuration changes after approval invalidate the snapshot", async () => {
	let mutate = async () => {};
	const f = await setup({
		tty: true,
		read: async () => {
			await mutate();
			return "yes";
		},
	});
	const repo = await f.repository("config-race");
	const configuration = join(f.base, "gitconfig");
	await writeFile(configuration, "[user]\nname = before\n");
	f.env.GIT_CONFIG_GLOBAL = configuration;
	mutate = () => writeFile(configuration, "[user]\nname = after\n");
	const result = await f.run("clean", f.root, "--state-dir", f.store);
	expect(result.code).toBe(1);
	expect(await readFile(join(repo.path, "tracked"), "utf8")).toBe(
		"preserved\n",
	);
});

test.each(["path", "symlink", "file-url"] as const)(
	"rewritten %s remote protects both dependency endpoints from clean --yes",
	async (kind) => {
		const f = await setup();
		const a = await f.repository("a");
		const b = await f.repository("b");
		// Preserve both histories even if the fixtures were committed in different seconds.
		await f.git(a.path, "push", b.path, "HEAD:refs/heads/backup-a");
		await f.git(b.path, "push", "--all", "origin");
		const alias = join(f.base, "remote alias 日本語");
		await symlink(f.root, alias);
		const base =
			kind === "path"
				? `${f.root}/`
				: kind === "symlink"
					? `${alias}/`
					: pathToFileURL(`${alias}/`).href;
		const config = join(f.base, "gitconfig");
		await writeFile(config, `[url "${base}"]\n\tinsteadOf = backup:\n`);
		f.env.GIT_CONFIG_GLOBAL = config;
		await f.git(a.path, "remote", "set-url", "origin", "backup:b");
		const before = await Promise.all([a, b].map((repo) => snapshot(repo.path)));
		const scan = await f.run("scan", f.root, "--json");
		expect(scan.code).toBe(0);
		const json = JSON.parse(scan.stdout);
		expect(json.repositories).toHaveLength(2);
		for (const repository of json.repositories) {
			expect(repository.status).toBe("PROTECTED");
			expect(
				repository.reasons.map((reason: { code: string }) => reason.code),
			).toContain("LOCAL_REMOTE_DEPENDENCY");
		}
		expect(
			(await f.run("clean", f.root, "--yes", "--state-dir", f.store)).code,
		).toBe(0);
		expect(
			await Promise.all([a, b].map((repo) => snapshot(repo.path))),
		).toEqual(before);
		expect(await lstat(f.store).catch(() => null)).toBeNull();
	},
);

test("relative local remote is verified from the repository rather than cleaner cwd", async () => {
	const f = await setup();
	const repo = await f.repository("relative remote 日本語");
	await f.git(
		repo.path,
		"remote",
		"set-url",
		"origin",
		relative(repo.path, repo.remote),
	);
	expect(process.cwd()).not.toBe(repo.path);
	expect(await f.git(repo.path, "ls-remote", "--heads", "origin")).toContain(
		"refs/heads/main",
	);
	const before = await snapshot(repo.path);
	const result = await f.run("inspect", repo.path, "--json");
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).repositories[0].status).toBe("SAFE");
	expect(await snapshot(repo.path)).toEqual(before);
	expect(
		(await f.run("clean", f.root, "--yes", "--state-dir", f.store)).code,
	).toBe(0);
	const id = (await new TrashStore(f.store).list()).entries[0]?.id ?? "";
	expect(
		(await f.run("restore", id, "--yes", "--state-dir", f.store)).code,
	).toBe(0);
	expect(await f.git(repo.path, "ls-remote", "--heads", "origin")).toContain(
		"refs/heads/main",
	);
});

test("unresolved remote dependency graph prevents moving otherwise SAFE targets", async () => {
	const f = await setup();
	const a = await f.repository("a"),
		b = await f.repository("b");
	await f.git(a.path, "config", "--add", "remote.origin.url", b.path);
	const before = await Promise.all([a, b].map((repo) => snapshot(repo.path)));
	expect(
		(await f.run("clean", f.root, "--yes", "--state-dir", f.store)).code,
	).toBe(1);
	expect(await Promise.all([a, b].map((repo) => snapshot(repo.path)))).toEqual(
		before,
	);
	expect(await lstat(f.store).catch(() => null)).toBeNull();
});

test("config changes after confirmation stop clean even when the repository remains unexcluded", async () => {
	let mutate = async () => {};
	const f = await setup({
		tty: true,
		read: async () => {
			await mutate();
			return "yes";
		},
	});
	const repo = await f.repository("config-change");
	const config = join(f.base, "config.json");
	await writeFile(config, JSON.stringify({ version: 1, exclude: [] }));
	mutate = () =>
		writeFile(
			config,
			JSON.stringify({
				version: 1,
				exclude: [{ kind: "name", pattern: "unrelated" }],
			}),
		);
	expect(
		(await f.run("clean", f.root, "--config", config, "--state-dir", f.store))
			.code,
	).toBe(1);
	expect(await lstat(repo.path)).toBeDefined();
});

test("nested ignored repositories are protected; directory scans never enumerate grandchildren", async () => {
	const f = await setup();
	const repo = await f.repository("parent");
	await writeFile(join(repo.path, ".git", "info", "exclude"), "nested/\n");
	const nested = join(repo.path, "nested");
	await mkdir(nested);
	await f.git(nested, "init");
	const result = JSON.parse((await f.run("scan", f.root, "--json")).stdout);
	expect(result.repositories).toHaveLength(1);
	expect(
		result.repositories[0].reasons.map((r: { code: string }) => r.code),
	).toContain("NESTED_REPOSITORY");
	expect(
		(await f.run("clean", f.root, "--yes", "--state-dir", f.store)).stdout,
	).toContain("PROTECTED");
});

test("metadata uses maximum branch/HEAD committer date, reports nulls, and text displays estimates", async () => {
	const f = await setup();
	const repo = await f.repository("metadata");
	// A commit-tree fixture sets committer time without changing the checked-out branch.
	const tree = (await f.git(repo.path, "rev-parse", "HEAD^{tree}")).trim();
	const parent = (await f.git(repo.path, "rev-parse", "HEAD")).trim();
	const child = Bun.spawn(
		[
			"git",
			"-C",
			repo.path,
			"commit-tree",
			tree,
			"-p",
			parent,
			"-m",
			"future branch",
		],
		{
			env: {
				...f.env,
				GIT_AUTHOR_DATE: "2030-01-02T03:04:05Z",
				GIT_COMMITTER_DATE: "2030-01-02T03:04:05Z",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const commit = (await new Response(child.stdout).text()).trim();
	expect(await child.exited).toBe(0);
	await f.git(repo.path, "update-ref", "refs/heads/future", commit);
	const json = JSON.parse((await f.run("scan", f.root, "--json")).stdout);
	expect(json.repositories[0].metadata.last_commit_at).toBe(
		"2030-01-02T03:04:05.000Z",
	);
	expect(json.repositories[0].metadata.size_bytes).toBeGreaterThan(0);
	expect(json.repositories[0].metadata.metadata_errors).toEqual([]);
	expect((await f.run("scan", f.root)).stdout).toContain(
		"Logical bytes (estimate)",
	);
	const empty = join(f.root, "empty");
	await mkdir(empty);
	await f.git(empty, "init");
	const emptyJson = JSON.parse((await f.run("inspect", empty, "--json")).stdout)
		.repositories[0];
	expect(emptyJson.metadata.last_commit_at).toBeNull();
	expect(emptyJson.metadata.metadata_errors).toContain(
		"LAST_COMMIT_UNAVAILABLE",
	);
});

test("metadata date failure leaves a verified repository SAFE and JSON reports null/error", async () => {
	const f = await setup();
	await f.repository("date-failure");
	const runner = Layer.effect(
		CommandRunner,
		Effect.gen(function* () {
			const delegate = yield* CommandRunner;
			return {
				run: (request: Parameters<typeof delegate.run>[0]) =>
					request.args.includes("log")
						? Effect.fail(new CommandError({ kind: "exit", exitCode: 128 }))
						: delegate.run(request),
			};
		}),
	).pipe(Layer.provide(f.runner));
	const output: string[] = [];
	const code = await runCli(
		["scan", f.root, "--json"],
		{ stdout: (text) => output.push(text), stderr: () => {} },
		applicationLive(undefined, undefined, runner),
	);
	const json = JSON.parse(output.join(""));
	expect(code).toBe(0);
	expect(json.repositories[0].status).toBe("SAFE");
	expect(json.repositories[0].metadata.last_commit_at).toBeNull();
	expect(json.repositories[0].metadata.metadata_errors).toEqual([
		"LAST_COMMIT_UNAVAILABLE",
	]);
	expect(json.summary.safe_size_bytes_estimate).toBeGreaterThan(0);
	expect(json.summary.safe_size_unknown_count).toBe(0);
});
