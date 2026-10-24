import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { normalizeArguments } from "../commands/arguments.ts";
import {
	CommandError,
	CommandRunner,
	makeCommandRunner,
} from "../executil/command.ts";
import { fixture } from "../testing/fixture.ts";
import { discover, within } from "./discovery.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((f) => f.dispose()));
});
async function setup() {
	const f = await fixture();
	fixtures.push(f);
	const bin = join(f.base, "bin");
	await mkdir(bin);
	const executable = join(bin, "ghq");
	const runner = makeCommandRunner({
		...f.env,
		PATH: `${bin}:${process.env.PATH}`,
	});
	const output = async (roots: string[], paths: string[]) => {
		await writeFile(
			executable,
			`#!${process.execPath}\nprocess.stdout.write(process.argv[2] === "root" ? ${JSON.stringify(roots.length ? `${roots.join("\n")}\n` : "")} : ${JSON.stringify(paths.length ? `${paths.join("\n")}\n` : "")});\n`,
		);
		await chmod(executable, 0o700);
	};
	const run = (args: string[] = ["scan"]) =>
		Effect.runPromise(
			discover(normalizeArguments(args)).pipe(Effect.provide(runner)),
		);
	return { ...f, output, run, executable };
}

test("ghq handles empty lists, longest nested root, normalized paths, duplicate real paths and trailing spaces", async () => {
	const f = await setup();
	await f.output([f.root], []);
	expect(await f.run()).toEqual([]);
	const nested = join(f.root, "nested");
	await mkdir(nested);
	const path = join(nested, "日本語 repo ");
	await mkdir(path);
	const alias = join(nested, "alias");
	await symlink(path, alias);
	await f.output([f.root, nested], [`${nested}/./日本語 repo `, path, alias]);
	expect(await f.run()).toEqual([
		{ source: "ghq", root: nested, path, name: "日本語 repo " },
	]);
});

test("same managed name across roots is an inspect usage error", async () => {
	const f = await setup();
	const other = join(f.base, "other");
	await mkdir(other);
	await mkdir(join(f.root, "same"));
	await mkdir(join(other, "same"));
	await f.output([f.root, other], [join(f.root, "same"), join(other, "same")]);
	await expect(f.run(["inspect", "same"])).rejects.toThrow("ambiguous");
});

test("ghq failure is distinct from successful empty discovery", async () => {
	const f = await setup();
	await writeFile(f.executable, `#!${process.execPath}\nprocess.exit(7);`);
	await chmod(f.executable, 0o700);
	await expect(f.run()).rejects.toThrow("GHQ_COMMAND_FAILED");
	for (const [kind, code] of [
		["spawn", "GHQ_NOT_FOUND"],
		["timeout", "GHQ_TIMEOUT"],
	] as const) {
		const runner = Layer.succeed(CommandRunner, {
			run: () => Effect.fail(new CommandError({ kind })),
		});
		await expect(
			Effect.runPromise(
				discover(normalizeArguments(["scan"])).pipe(Effect.provide(runner)),
			),
		).rejects.toThrow(code);
	}
});

test.each([
	["/repos", "/repos-other/repo", false],
	["/repos", "/repos", false],
	["/repos", "/repos/repo", true],
	["/repos", "/repos/../elsewhere", false],
])("path boundary %s to %s", (root, path, expected) => {
	expect(within(root, path)).toBe(expected);
});
