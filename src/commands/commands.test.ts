import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { finding } from "../core/diagnosis.ts";
import type { Assessment, Batch } from "../model/assessment.ts";
import { runCli } from "./application.ts";
import { normalizeArguments, UsageError } from "./arguments.ts";
import { present } from "./output.ts";
import { Application, confirm } from "./services.ts";

test.each([
	[[], "scan", undefined],
	[["scan"], "scan", undefined],
	[["--ghq"], "scan", undefined],
	[["./scan"], "scan", "./scan"],
	[["日本語 dir", "--delete", "--yes"], "clean", "日本語 dir"],
	[["list", "--status", "safe"], "list", undefined],
	[["inspect", "./-repo"], "inspect", "./-repo"],
	[["clean", "--dry-run"], "clean", undefined],
	[["trash", "list"], "trash", undefined],
	[["restore", "id", "--yes"], "restore", "id"],
] as const)("normalizes %j", (argv, operation, target) => {
	expect(normalizeArguments(argv)).toMatchObject({ operation, target });
});

test.each(
	[
		["--yes"],
		["scan", "--yes"],
		["scan", "--delete"],
		["--delete"],
		["dir", "--ghq"],
		["scan", "a", "b"],
		["--unknown"],
		["list", "--status", "SAFE"],
		["list", "--status", "safe", "--status", "dirty"],
		["clean", "--json"],
		["restore", "id", "--json"],
		["trash"],
		["trash", "unknown"],
		["inspect"],
		["clean", "--state-dir", "relative"],
		["--config"],
		["--json=true"],
		["trash", "list", "--config", "x"],
	].map((argv) => ({ argv })),
)("rejects invalid arguments %j", ({ argv }) => {
	expect(() => normalizeArguments(argv)).toThrow(UsageError);
});

function assessment(path: string, status: Assessment["status"]): Assessment {
	return {
		repository: { source: "directory", root: "/test", path, name: path },
		status,
		reasons: status === "UNKNOWN" ? [finding("LOCAL_INSPECTION_FAILED")] : [],
		checked_at: "2026-01-01T00:00:00Z",
		metadata: { size_bytes: null, last_commit_at: null },
		snapshot: { path, device: "1", inode: "1", digest: "secret-internal" },
	};
}

test("JSON contract excludes snapshots and filters display without hiding UNKNOWN exit and totals", () => {
	const batch: Batch = {
		assessments: [
			assessment("/test/z", "UNKNOWN"),
			assessment("/test/a", "SAFE"),
		],
		errors: [],
	};
	const result = present(
		batch,
		normalizeArguments(["list", "--json", "--status", "safe"]),
	);
	const json = JSON.parse(result.stdout);
	expect(json.schema_version).toBe(1);
	expect(json.summary).toEqual({
		scanned: 2,
		returned: 1,
		safe: 1,
		dirty: 0,
		protected: 0,
		unknown: 1,
	});
	expect(json.repositories[0]).toMatchObject({
		path: "/test/a",
		source: "directory",
		root: "/test",
		metadata: { size_bytes: null, last_commit_at: null },
	});
	expect(json.errors).toEqual([]);
	expect(result.stdout).not.toContain("secret-internal");
	expect(result.exitCode).toBe(1);
});

test("Crust dispatches normalized argv via official Effect service and separates output", async () => {
	const stdout: string[] = [],
		stderr: string[] = [];
	const fake = Layer.succeed(Application, {
		diagnose: (invocation) => {
			expect(invocation.operation).toBe("list");
			return Effect.succeed({
				assessments: [
					assessment("/test/b", "UNKNOWN"),
					assessment("/test/a", "SAFE"),
				],
				errors: [],
			});
		},
		operate: () => Effect.die("Unexpected operation"),
	});
	const code = await runCli(
		["list", "--json", "--status", "safe"],
		{
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
		},
		fake,
	);
	expect(code).toBe(1);
	expect(stdout).toHaveLength(1);
	expect(JSON.parse(stdout[0] ?? "").repositories).toHaveLength(1);
	expect(stderr).toHaveLength(0);
});

test("unconnected services fail explicitly and help/version never acquire a service", async () => {
	for (const argv of [
		["--help"],
		["--version"],
		["-v"],
		["scan", "--help"],
		["trash", "list", "--help"],
	]) {
		const fake = Layer.effect(Application, Effect.die("Must not build"));
		expect(
			await runCli(argv, { stdout: () => {}, stderr: () => {} }, fake),
		).toBe(0);
	}
	const stdout: string[] = [],
		stderr: string[] = [];
	expect(
		await runCli(["scan", "--json"], {
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
		}),
	).toBe(1);
	expect(JSON.parse(stdout[0] ?? "").errors[0].code).toBe(
		"SERVICE_NOT_CONNECTED",
	);
	expect(stderr.join("")).toContain("SERVICE_NOT_CONNECTED");
});

test("unknown command is a usage error", async () => {
	expect(
		await runCli(["definitely-not-an-existing-command-734c2601"], {
			stdout: () => {},
			stderr: () => {},
		}),
	).toBe(2);
});

test("confirmation accepts only explicit y/yes, refuses EOF and enforces TTY", async () => {
	const clean = normalizeArguments(["clean"]);
	for (const answer of ["y", "Y", "yes", "YES"])
		expect(
			await confirm(clean, { tty: true, read: async () => answer }, "?"),
		).toBe(true);
	for (const answer of [null, "", "no", "sure", "yes please"])
		expect(
			await confirm(clean, { tty: true, read: async () => answer }, "?"),
		).toBe(false);
	expect(
		confirm(clean, { tty: false, read: async () => "yes" }, "?"),
	).rejects.toThrow(UsageError);
	expect(
		await confirm(
			normalizeArguments(["clean", "--yes"]),
			{
				tty: false,
				read: async () => {
					throw new Error("Unexpected prompt");
				},
			},
			"?",
		),
	).toBe(true);
	expect(
		await confirm(
			normalizeArguments(["clean", "--dry-run"]),
			{
				tty: false,
				read: async () => {
					throw new Error("Unexpected prompt");
				},
			},
			"?",
		),
	).toBe(false);
});

test("cancellation propagates through Crust and returns 130", async () => {
	const controller = new AbortController();
	const fake = Layer.succeed(Application, {
		diagnose: () => Effect.never,
		operate: () => Effect.never,
	});
	const pending = runCli(
		["scan"],
		{ stdout: () => {}, stderr: () => {} },
		fake,
		controller.signal,
	);
	setTimeout(() => controller.abort(), 10);
	expect(await pending).toBe(130);
});
