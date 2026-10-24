import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Crust } from "@crustjs/core";
import { handler } from "@crustjs/effect";
import { Effect, Exit, Layer } from "effect";
import {
	CommandError,
	CommandRunner,
	makeCommandRunner,
} from "../executil/command.ts";
import { coreContext } from "../runtime.ts";
import { diagnose, finding } from "./diagnosis.ts";
import {
	inspectRepositories,
	inspectRepository,
	inspectRepositorySnapshot,
	RepositoryInspectorLive,
} from "./inspection.ts";
import { statusCodes } from "./porcelain.ts";

async function publishedRepository() {
	const path = await repository();
	const remote = `${path}-remote`;
	temporary.push(remote);
	await git(path, "init", "--bare", remote);
	await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
	await git(path, "remote", "add", "origin", remote);
	await git(path, "push", "-u", "origin", "main");
	return { path, remote };
}

test("verified clone is SAFE and immutable snapshot is excluded from diagnosis JSON", async () => {
	const { path } = await publishedRepository();
	const result = await Effect.runPromise(
		inspectRepositorySnapshot({ path }).pipe(Effect.provide(CoreLive)),
	);
	expect(result.diagnosis.status).toBe("SAFE");
	expect(result.complete).toBe(true);
	expect(result.snapshot?.configuration).toHaveLength(64);
	expect(result.snapshot?.digest).toHaveLength(64);
	expect(Object.isFrozen(result.snapshot)).toBe(true);
	expect(JSON.stringify(result.diagnosis)).not.toContain("digest");
});

test("fresh remote refs override stale tracking refs after deletion and force push", async () => {
	const { path, remote } = await publishedRepository();
	await writeFile(join(path, "tracked"), "second");
	await git(path, "commit", "-am", "second");
	await git(path, "push");
	const head = (await git(path, "rev-parse", "HEAD")).trim();
	await git(
		remote,
		"update-ref",
		"refs/heads/main",
		(await git(path, "rev-parse", "HEAD~1")).trim(),
	);
	expect((await git(path, "rev-parse", "origin/main")).trim()).toBe(head);
	expect((await inspect(path)).reasons.map((r) => r.code)).toContain(
		"UNPUSHED_COMMITS",
	);
	await git(remote, "update-ref", "-d", "refs/heads/main");
	expect((await inspect(path)).status).not.toBe("SAFE");
});

test("annotated tags, reflog-only history and orphan blobs require object-level preservation", async () => {
	const { path } = await publishedRepository();
	await git(path, "tag", "-a", "private", "-m", "preserve message");
	expect((await inspect(path)).reasons.map((r) => r.code)).toContain(
		"LOCAL_TAG_ONLY",
	);
	await git(path, "push", "origin", "refs/tags/private");
	expect((await inspect(path)).status).toBe("SAFE");
	await writeFile(join(path, "tracked"), "unpublished");
	await git(path, "commit", "-am", "private commit");
	await git(path, "reset", "--hard", "HEAD~1");
	expect((await inspect(path)).reasons.map((r) => r.code)).toContain(
		"REFLOG_ONLY_COMMITS",
	);
	await writeFile(join(path, "blob-input"), "unique unreachable data");
	await git(path, "hash-object", "-w", "blob-input");
	await rm(join(path, "blob-input"));
	expect((await inspect(path)).reasons.map((r) => r.code)).toContain(
		"UNREACHABLE_OBJECTS",
	);
});

test.each([
	[
		"assume unchanged",
		async (path: string) =>
			git(path, "update-index", "--assume-unchanged", "tracked"),
		"HIDDEN_INDEX_STATE",
	],
	[
		"skip worktree",
		async (path: string) =>
			git(path, "update-index", "--skip-worktree", "tracked"),
		"HIDDEN_INDEX_STATE",
	],
	[
		"partial",
		async (path: string) =>
			git(path, "config", "remote.origin.promisor", "true"),
		"UNSUPPORTED_LAYOUT",
	],
	[
		"sparse",
		async (path: string) => git(path, "config", "core.sparseCheckout", "true"),
		"UNSUPPORTED_LAYOUT",
	],
	[
		"merge",
		async (path: string) =>
			writeFile(
				join(path, ".git", "MERGE_HEAD"),
				`${(await git(path, "rev-parse", "HEAD")).trim()}\n`,
			),
		"OPERATION_IN_PROGRESS",
	],
	[
		"submodule file",
		async (path: string) => writeFile(join(path, ".gitmodules"), ""),
		"SUBMODULE_PRESENT",
	],
	[
		"module metadata",
		async (path: string) => mkdir(join(path, ".git", "modules")),
		"SUBMODULE_PRESENT",
	],
	[
		"alternates",
		async (path: string) =>
			writeFile(
				join(path, ".git", "objects", "info", "alternates"),
				"/missing-objects\n",
			),
		"EXTERNAL_GIT_STORAGE",
	],
	[
		"replace refs",
		async (path: string) =>
			git(
				path,
				"update-ref",
				"refs/replace/test",
				(await git(path, "rev-parse", "HEAD")).trim(),
			),
		"UNSUPPORTED_REFS",
	],
] as const)("protects %s", async (_name, setup, code) => {
	const { path } = await publishedRepository();
	await setup(path);
	expect((await inspect(path)).reasons.map((r) => r.code)).toContain(code);
});

test("porcelain parses rename source separately and rejects incomplete records", () => {
	expect(
		statusCodes("R  new\nname\0old\tname\0?? -日本語\0 M tracked\0"),
	).toEqual(["STAGED_CHANGES", "UNTRACKED_FILES", "UNSTAGED_CHANGES"]);
	expect(() => statusCodes("R  name\0")).toThrow();
	expect(() => statusCodes("?? truncated")).toThrow();
});

const temporary: string[] = [];
const testHome = await realpath(await mkdtemp(join(tmpdir(), "core-home-")));
temporary.push(testHome);
const environment = {
	...process.env,
	HOME: testHome,
	XDG_CONFIG_HOME: testHome,
	XDG_DATA_HOME: testHome,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
};
const CommandRunnerLive = makeCommandRunner(environment);
const CoreLive = RepositoryInspectorLive.pipe(Layer.provide(CommandRunnerLive));
afterAll(async () => {
	await Promise.all(
		temporary.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function git(path: string, ...args: string[]) {
	const child = Bun.spawn(["git", "-C", path, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...environment,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(stderr);
	return stdout;
}

async function repository() {
	const path = await realpath(
		await mkdtemp(join(tmpdir(), "repo core 日本語 ")),
	);
	temporary.push(path);
	await git(path, "init", "-b", "main");
	await git(path, "config", "user.name", "Core Test");
	await git(path, "config", "user.email", "test@example.invalid");
	await git(path, "config", "commit.gpgsign", "false");
	await git(path, "config", "core.excludesFile", "/dev/null");
	await writeFile(join(path, "tracked"), "initial\n");
	await git(path, "add", ".");
	await git(path, "commit", "-m", "initial");
	return path;
}

const inspect = (path: string, excluded = false) =>
	Effect.runPromise(
		inspectRepository({ path, excluded }).pipe(Effect.provide(CoreLive)),
	);

test("classification keeps all reasons, deduplicates and applies safety priority", () => {
	expect(diagnose("/repo", []).status).toBe("SAFE");
	expect(diagnose("/repo", [finding("LOCAL_CHANGES")]).status).toBe("DIRTY");
	const findings = [
		finding("LOCAL_CHANGES"),
		finding("IGNORED_FILES"),
		finding("LOCAL_CHANGES"),
	];
	expect(diagnose("/repo", findings).status).toBe("PROTECTED");
	expect(diagnose("/repo", findings).reasons).toHaveLength(2);
	expect(
		diagnose("/repo", [...findings, finding("LOCAL_INSPECTION_FAILED")]).status,
	).toBe("UNKNOWN");
});

test("clean-looking repository remains UNKNOWN without online verification", async () => {
	const result = await inspect(await repository());
	expect(result.status).toBe("UNKNOWN");
	expect(result.reasons.map((r) => r.code)).toEqual([
		"ONLINE_NOT_VERIFIED",
		"REFLOG_ONLY_COMMITS",
		"NO_REMOTE",
		"REMOTE_MISSING",
	]);
});

test("NUL output detects ignored and untracked names with whitespace and newlines", async () => {
	const path = await repository();
	await writeFile(join(path, ".gitignore"), "*.secret\n");
	await writeFile(join(path, "日本語\nfile.secret"), "preserve");
	await writeFile(join(path, "untracked\nfile"), "preserve");
	const result = await inspect(path, true);
	expect(result.reasons.map((r) => r.code)).toEqual(
		expect.arrayContaining(["LOCAL_CHANGES", "IGNORED_FILES", "EXCLUDED"]),
	);
});

test("staged and unstaged changes are detected", async () => {
	const path = await repository();
	await writeFile(join(path, "tracked"), "staged\n");
	await git(path, "add", "tracked");
	expect((await inspect(path)).reasons.map((r) => r.code)).toContain(
		"LOCAL_CHANGES",
	);
	await writeFile(join(path, "tracked"), "unstaged\n");
	expect((await inspect(path)).reasons.map((r) => r.code)).toContain(
		"LOCAL_CHANGES",
	);
});

test("stash, tags, detached HEAD and extra worktrees are preserved", async () => {
	const path = await repository();
	await writeFile(join(path, "tracked"), "stash\n");
	await git(path, "stash", "push");
	await git(path, "tag", "local-tag");
	await git(path, "checkout", "--detach");
	const worktree = `${path}-worktree`;
	temporary.push(worktree);
	await git(path, "worktree", "add", "-b", "other", worktree);
	expect((await inspect(path)).reasons.map((r) => r.code)).toEqual(
		expect.arrayContaining([
			"STASH_PRESENT",
			"LOCAL_TAG_ONLY",
			"DETACHED_HEAD",
			"WORKTREE_PRESENT",
		]),
	);
	expect((await inspect(worktree)).reasons.map((r) => r.code)).toContain(
		"UNSUPPORTED_LAYOUT",
	);
});

test("missing repository does not abort remaining inspections", async () => {
	const path = await repository();
	const results = await Effect.runPromise(
		inspectRepositories([{ path: join(path, "missing") }, { path }]).pipe(
			Effect.provide(CoreLive),
		),
	);
	expect(results).toHaveLength(2);
	expect(results[0]?.reasons.map((r) => r.code)).toContain(
		"LOCAL_INSPECTION_FAILED",
	);
	expect(results[1]?.reasons.map((r) => r.code)).not.toContain(
		"LOCAL_INSPECTION_FAILED",
	);
});

test("gitlinks and bare repositories cannot be treated as ordinary repositories", async () => {
	const path = await repository();
	const head = (await git(path, "rev-parse", "HEAD")).trim();
	await git(
		path,
		"update-index",
		"--add",
		"--cacheinfo",
		`160000,${head},module`,
	);
	expect((await inspect(path)).reasons.map((r) => r.code)).toContain(
		"SUBMODULE_PRESENT",
	);
	const bare = await realpath(await mkdtemp(join(tmpdir(), "bare-core-")));
	temporary.push(bare);
	await git(bare, "init", "--bare");
	const result = await inspect(bare);
	expect(result.status).toBe("PROTECTED");
	expect(result.reasons.map((r) => r.code)).toContain("UNSUPPORTED_LAYOUT");
});

test("typed process failures become UNKNOWN without exposing command output", async () => {
	const fake = Layer.succeed(CommandRunner, {
		run: () => Effect.fail(new CommandError({ kind: "exit", exitCode: 128 })),
	});
	const layer = RepositoryInspectorLive.pipe(Layer.provide(fake));
	const result = await Effect.runPromise(
		inspectRepository({ path: "/missing" }).pipe(Effect.provide(layer)),
	);
	expect(result.status).toBe("UNKNOWN");
	expect(result.reasons.map((r) => r.code)).toContain(
		"LOCAL_INSPECTION_FAILED",
	);
	expect(JSON.stringify(result)).not.toContain("128");
});

test("runner reports command exit and enforces timeout", async () => {
	const path = await repository();
	const run = (args: string[], timeoutMs?: number) =>
		Effect.gen(function* () {
			const runner = yield* CommandRunner;
			return yield* runner.run({
				executable: "git",
				args,
				cwd: path,
				timeoutMs,
			});
		}).pipe(Effect.provide(CommandRunnerLive), Effect.flip);
	expect((await Effect.runPromise(run(["not-a-git-command"]))).kind).toBe(
		"exit",
	);
	// Only the fixture's Git alias invokes sleep; the runner always uses an argv array.
	const start = performance.now();
	expect(
		(await Effect.runPromise(run(["-c", "alias.wait=!sleep 1", "wait"], 20)))
			.kind,
	).toBe("timeout");
	expect(performance.now() - start).toBeLessThan(900);
});

test("official Crust handler provides the core services", async () => {
	const path = await repository();
	const app = new Crust("test")
		.provide(coreContext(CommandRunnerLive))
		.action(handler(() => inspectRepository({ path })));
	const outcome = await app.run([], undefined);
	expect(JSON.stringify(outcome)).toContain("ONLINE_NOT_VERIFIED");
});

test("Effect interruption is not converted to a successful diagnosis", async () => {
	const controller = new AbortController();
	controller.abort();
	const exit = await Effect.runPromiseExit(
		inspectRepository({ path: "/missing" }).pipe(Effect.provide(CoreLive)),
		{ signal: controller.signal },
	);
	expect(Exit.isFailure(exit)).toBe(true);
});

test("unborn, shallow and separate gitdir layouts never become SAFE", async () => {
	const empty = await realpath(await mkdtemp(join(tmpdir(), "unborn-core-")));
	temporary.push(empty);
	await git(empty, "init", "-b", "main");
	expect((await inspect(empty)).reasons.map((r) => r.code)).toContain(
		"UNBORN_HEAD",
	);
	const { path, remote } = await publishedRepository();
	const shallow = `${path}-shallow`;
	temporary.push(shallow);
	await git(path, "clone", "--depth=1", `file://${remote}`, shallow);
	expect((await inspect(shallow)).reasons.map((r) => r.code)).toContain(
		"UNSUPPORTED_LAYOUT",
	);
	const external = `${path}-gitdir`;
	temporary.push(external);
	await git(path, "init", `--separate-git-dir=${external}`);
	expect((await inspect(path)).status).not.toBe("SAFE");
});

test.each([
	"rebase-apply",
	"rebase-merge",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"BISECT_LOG",
	"sequencer",
])("protects operation marker %s", async (name) => {
	const path = await repository();
	await writeFile(join(path, ".git", name), "operation marker");
	expect((await inspect(path)).reasons.map((r) => r.code)).toContain(
		"OPERATION_IN_PROGRESS",
	);
});

test("dirty plus ignored and corrupt index retains all reasons with UNKNOWN priority", async () => {
	const path = await repository();
	await writeFile(join(path, ".git", "info", "exclude"), "*.secret\n");
	await writeFile(join(path, "keep.secret"), "preserved");
	await writeFile(join(path, "tracked"), "dirty");
	const before = await inspect(path);
	expect(before.reasons.map((r) => r.code)).toEqual(
		expect.arrayContaining(["UNSTAGED_CHANGES", "IGNORED_FILES"]),
	);
	await writeFile(join(path, ".git", "index"), "corrupt index");
	const result = await inspect(path);
	expect(result.status).toBe("UNKNOWN");
	expect(result.reasons.map((r) => r.code)).toContain(
		"LOCAL_INSPECTION_FAILED",
	);
});

test("a concurrent write invalidates the inspection snapshot", async () => {
	const path = await repository();
	const base = await Effect.runPromise(
		Effect.gen(function* () {
			return yield* CommandRunner;
		}).pipe(Effect.provide(CommandRunnerLive)),
	);
	let changed = false;
	const fake = Layer.succeed(CommandRunner, {
		run: (request) =>
			base.run(request).pipe(
				Effect.tap(() =>
					Effect.promise(async () => {
						if (!changed) {
							changed = true;
							await writeFile(
								join(path, "tracked"),
								"changed during inspection",
							);
						}
					}),
				),
			),
	});
	const result = await Effect.runPromise(
		inspectRepository({ path }).pipe(
			Effect.provide(RepositoryInspectorLive.pipe(Layer.provide(fake))),
		),
	);
	expect(result.reasons.map((r) => r.code)).toContain("STATE_CHANGED");
});

test("all branches report unique unpreserved commits independently of checked-out HEAD", async () => {
	const { path } = await publishedRepository();
	await git(path, "checkout", "-b", "private");
	await writeFile(join(path, "tracked"), "private");
	await git(path, "commit", "-am", "private");
	await git(path, "checkout", "main");
	const result = await inspect(path);
	expect(result.status).toBe("DIRTY");
	expect(
		result.reasons.find((r) => r.code === "UNPUSHED_COMMITS"),
	).toMatchObject({ branch: "refs/heads/private", commit_count: 1 });
});

test("current remote heads/tags union preserves detached HEAD; one failed remote prevents SAFE", async () => {
	const { path, remote } = await publishedRepository();
	await git(path, "checkout", "--detach");
	expect((await inspect(path)).status).toBe("SAFE");
	await writeFile(join(path, "tracked"), "detached private");
	await git(path, "commit", "-am", "detached private");
	expect((await inspect(path)).status).toBe("DIRTY");
	expect((await inspect(path)).reasons.map((r) => r.code)).toContain(
		"DETACHED_HEAD_ONLY_COMMITS",
	);
	await git(path, "remote", "add", "second", remote);
	await git(path, "push", "second", "HEAD:refs/heads/detached");
	expect((await inspect(path)).status).toBe("SAFE");
	await git(path, "remote", "set-url", "second", join(path, "absent"));
	expect((await inspect(path)).status).toBe("UNKNOWN");
});

test("custom remote refs are never evidence and deleted upstreams stay protected even with another backup", async () => {
	const { path, remote } = await publishedRepository();
	const head = (await git(path, "rev-parse", "HEAD")).trim();
	await git(remote, "update-ref", "refs/archive/main", head);
	await git(remote, "update-ref", "-d", "refs/heads/main");
	let result = await inspect(path);
	expect(result.reasons.map((r) => r.code)).toContain("UNPUSHED_COMMITS");
	await git(remote, "update-ref", "refs/heads/backup", head);
	result = await inspect(path);
	expect(result.reasons.map((r) => r.code)).toContain("UPSTREAM_MISSING");
	expect(result.status).toBe("PROTECTED");
});

test("unsupported helpers are rejected explicitly without exposing URL credentials", async () => {
	const { path } = await publishedRepository();
	await git(
		path,
		"remote",
		"set-url",
		"origin",
		"ext::secret-credential-command",
	);
	const result = await inspect(path);
	expect(result.reasons.map((r) => r.code)).toContain("UNSUPPORTED_TRANSPORT");
	expect(JSON.stringify(result)).not.toContain("secret-credential");
});

test("remote refs changing during fetch yield UNKNOWN and leave source snapshot unchanged", async () => {
	const { path, remote } = await publishedRepository();
	await writeFile(join(path, "tracked"), "second");
	await git(path, "commit", "-am", "second");
	await git(path, "push");
	const parent = (await git(path, "rev-parse", "HEAD~1")).trim();
	const before = await Effect.runPromise(
		inspectRepositorySnapshot({ path }).pipe(Effect.provide(CoreLive)),
	);
	let changed = false;
	const racingRunner = Layer.effect(
		CommandRunner,
		Effect.gen(function* () {
			const runner = yield* CommandRunner;
			return {
				run: (request: Parameters<typeof runner.run>[0]) =>
					runner.run(request).pipe(
						Effect.tap(() => {
							if (!changed && request.args.includes("fetch")) {
								changed = true;
								return Effect.tryPromise({
									try: () =>
										git(remote, "update-ref", "refs/heads/main", parent),
									catch: () => new CommandError({ kind: "exit", exitCode: 1 }),
								});
							}
							return Effect.succeed(undefined);
						}),
					),
			};
		}),
	).pipe(Layer.provide(CommandRunnerLive));
	const result = await Effect.runPromise(
		inspectRepositorySnapshot({ path }).pipe(
			Effect.provide(RepositoryInspectorLive.pipe(Layer.provide(racingRunner))),
		),
	);
	expect(result.diagnosis.status).toBe("UNKNOWN");
	expect(result.diagnosis.reasons.map((r) => r.code)).toContain(
		"REMOTE_CHANGED_DURING_SCAN",
	);
	expect(result.snapshot).toEqual(before.snapshot);
});

test("broken gitdir files and parent-owned subdirectories cannot become SAFE", async () => {
	const broken = await realpath(
		await mkdtemp(join(tmpdir(), "broken-gitdir-")),
	);
	temporary.push(broken);
	await writeFile(
		join(broken, ".git"),
		"gitdir: /missing/cleaner-test-gitdir\n",
	);
	expect((await inspect(broken)).status).toBe("UNKNOWN");
	const { path } = await publishedRepository();
	const child = join(path, "child");
	await mkdir(child);
	const result = await inspect(child);
	expect(result.status).not.toBe("SAFE");
	expect(result.reasons.map((r) => r.code)).toContain("UNSUPPORTED_LAYOUT");
});
