import { afterAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Crust } from "@crustjs/core";
import { handler } from "@crustjs/effect";
import { Effect, Exit, Layer } from "effect";
import { CoreLive, coreContext } from "../runtime.ts";
import { CommandError, CommandRunner, CommandRunnerLive } from "./command.ts";
import { diagnose, finding } from "./diagnosis.ts";
import {
	inspectRepositories,
	inspectRepository,
	RepositoryInspectorLive,
} from "./inspection.ts";

const temporary: string[] = [];
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
			...process.env,
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
		diagnose("/repo", [...findings, finding("INSPECTION_FAILED")]).status,
	).toBe("UNKNOWN");
});

test("clean-looking repository remains UNKNOWN without online verification", async () => {
	const result = await inspect(await repository());
	expect(result.status).toBe("UNKNOWN");
	expect(result.reasons.map((r) => r.code)).toEqual([
		"ONLINE_NOT_VERIFIED",
		"MISSING_UPSTREAM",
		"NO_REMOTE",
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
			"STASH",
			"LOCAL_TAGS",
			"DETACHED_HEAD",
			"EXTRA_WORKTREES",
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
	expect(results[0]?.reasons.map((r) => r.code)).toContain("INSPECTION_FAILED");
	expect(results[1]?.reasons.map((r) => r.code)).not.toContain(
		"INSPECTION_FAILED",
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
		"SUBMODULES",
	);
	const bare = await realpath(await mkdtemp(join(tmpdir(), "bare-core-")));
	temporary.push(bare);
	await git(bare, "init", "--bare");
	const result = await inspect(bare);
	expect(result.status).toBe("UNKNOWN");
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
	expect(result.reasons.map((r) => r.code)).toContain("INSPECTION_FAILED");
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
		.provide(coreContext())
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
