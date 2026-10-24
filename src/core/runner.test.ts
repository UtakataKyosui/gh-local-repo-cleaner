import { expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { CommandRunner, makeCommandRunner } from "../executil/command.ts";
import { fixture } from "../testing/fixture.ts";

test("runner isolates Git selection/config injection and preserves literal argv", async () => {
	const f = await fixture();
	try {
		const a = await f.repository("a 日本語"),
			b = await f.repository("b");
		const runner = makeCommandRunner({
			...f.env,
			GIT_DIR: join(b.path, ".git"),
			GIT_WORK_TREE: b.path,
			GIT_INDEX_FILE: join(b.path, ".git", "index"),
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "alias.leak",
			GIT_CONFIG_VALUE_0: "secret-value",
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* CommandRunner;
				return yield* service.run({
					executable: "git",
					args: ["-C", a.path, "rev-parse", "--show-toplevel"],
				});
			}).pipe(Effect.provide(runner)),
		);
		expect(result.trim()).toBe(a.path);
		const binary = join(f.base, "bin");
		await mkdir(binary);
		const ghq = join(binary, "ghq");
		await writeFile(
			ghq,
			`#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
		);
		await chmod(ghq, 0o700);
		const argv = ["-leading", "空白 日本語", "$(must-not-run)", "line\nname"];
		const echoed = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* CommandRunner;
				return yield* service.run({ executable: "ghq", args: argv });
			}).pipe(Effect.provide(makeCommandRunner({ ...f.env, PATH: binary }))),
		);
		expect(JSON.parse(echoed)).toEqual(argv);
	} finally {
		await f.dispose();
	}
});

test("runner classifies output limits, invalid UTF-8, spawn failures and cancellation", async () => {
	const f = await fixture();
	try {
		const binary = join(f.base, "bin");
		await mkdir(binary);
		const ghq = join(binary, "ghq");
		const run = (maxOutputBytes?: number, signal?: AbortSignal) =>
			Effect.runPromiseExit(
				Effect.gen(function* () {
					const service = yield* CommandRunner;
					return yield* service.run({
						executable: "ghq",
						args: [],
						maxOutputBytes,
					});
				}).pipe(Effect.provide(makeCommandRunner({ ...f.env, PATH: binary }))),
				{ signal },
			);
		await writeFile(
			ghq,
			`#!${process.execPath}\nprocess.stdout.write("0123456789");\n`,
		);
		await chmod(ghq, 0o700);
		expect(JSON.stringify(await run(2))).toContain("output-limit");
		await writeFile(
			ghq,
			`#!${process.execPath}\nprocess.stdout.write(Buffer.from([255]));\n`,
		);
		expect(JSON.stringify(await run())).toContain("invalid-output");
		await writeFile(
			ghq,
			`#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
		);
		const controller = new AbortController();
		const pending = run(undefined, controller.signal);
		setTimeout(() => controller.abort(), 30);
		expect(JSON.stringify(await pending)).toContain("Interrupt");
		const unavailable = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const service = yield* CommandRunner;
				return yield* service.run({ executable: "ghq", args: [] });
			}).pipe(
				Effect.provide(
					makeCommandRunner({ ...f.env, PATH: "/nonexistent-binaries" }),
				),
			),
		);
		expect(JSON.stringify(unavailable)).toContain("spawn");
	} finally {
		await f.dispose();
	}
});
