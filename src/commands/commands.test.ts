import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { finding } from "../core/diagnosis.ts";
import type { Assessment, Batch } from "../model/assessment.ts";
import { runCli } from "./application.ts";
import {
	type Invocation,
	normalizeArguments,
	UsageError,
} from "./arguments.ts";
import { present } from "./output.ts";
import { gauge } from "./progress.ts";
import { Application, confirm, ServiceError } from "./services.ts";

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
	[
		["restore", "0123456789abcdef0123456789abcdef", "--yes"],
		"restore",
		"0123456789abcdef0123456789abcdef",
	],
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
		...["--status", "--yes", "--dry-run", "--state-dir"].map((flag) =>
			flag === "--yes" || flag === "--dry-run"
				? ["scan", flag]
				: ["scan", flag, "/abs"],
		),
		["scan", "dir", "--ghq"],
		["list", "dir", "--ghq"],
		["list", "--yes"],
		["list", "--delete"],
		["list", "--dry-run"],
		["list", "--state-dir", "/abs"],
		["list", "--status"],
		["list", "--status", ""],
		["list", "--status="],
		["list", "--status", "all"],
		["list", "--status", "safe,dirty"],
		["list", "--status", "safe", "--status", "safe"],
		["list", "--status=safe", "--status", "safe"],
		["inspect", "name", "--ghq"],
		["inspect", "name", "--status", "safe"],
		["inspect", "name", "--yes"],
		["inspect", "name", "--delete"],
		["inspect", "name", "--dry-run"],
		["inspect", "name", "--state-dir", "/abs"],
		["inspect", "a", "b"],
		["inspect", ""],
		["inspect", "--json"],
	].map((argv) => ({ argv })),
)("rejects invalid arguments %j", ({ argv }) => {
	expect(() => normalizeArguments(argv)).toThrow(UsageError);
});

test.each(["safe", "dirty", "protected", "unknown"] as const)(
	"list accepts --status %s as a single value",
	(status) => {
		expect(normalizeArguments(["list", "--status", status])).toMatchObject({
			status,
		});
		expect(normalizeArguments(["list", `--status=${status}`])).toMatchObject({
			status,
		});
	},
);

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
		safe_size_bytes_estimate: 0,
		safe_size_unknown_count: 1,
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

async function runFake(
	argv: string[],
	diagnose: (invocation: Invocation) => Effect.Effect<Batch, ServiceError>,
) {
	const stdout: string[] = [],
		stderr: string[] = [];
	const code = await runCli(
		argv,
		{
			stdout: (text) => stdout.push(text),
			stderr: (text) => stderr.push(text),
		},
		Layer.succeed(Application, { diagnose, operate: () => Effect.never }),
	);
	return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

test("target and configuration failures exit 2 with an explanation in JSON errors and stderr", async () => {
	const failing = () =>
		Effect.fail(
			new ServiceError({
				code: "CONFIG_OR_TARGET_ERROR",
				detail: "Repository name is ambiguous",
			}),
		);
	const json = await runFake(["inspect", "x", "--json"], failing);
	expect(json.code).toBe(2);
	expect(JSON.parse(json.stdout)).toMatchObject({
		schema_version: 1,
		repositories: [],
		errors: [
			{
				code: "CONFIG_OR_TARGET_ERROR",
				message: "Repository name is ambiguous",
			},
		],
	});
	const text = await runFake(["inspect", "x"], failing);
	expect(text.code).toBe(2);
	expect(text.stderr).toContain("Repository name is ambiguous");
});

test("enumeration failure exits 1 and an empty result exits 0", async () => {
	const failed = await runFake(["scan", "--json"], () =>
		Effect.fail(new ServiceError({ code: "GHQ_NOT_FOUND" })),
	);
	expect(failed.code).toBe(1);
	expect(JSON.parse(failed.stdout).errors[0].message).toContain("ghq");
	const empty = await runFake(["scan"], () =>
		Effect.succeed({ assessments: [], errors: [] }),
	);
	expect(empty.code).toBe(0);
	expect(empty.stdout).toContain("Scanned 0; returned 0");
});

test("exit code follows the full diagnosis for every status mix", async () => {
	for (const [statuses, expected] of [
		[["SAFE"], 0],
		[["DIRTY", "PROTECTED"], 0],
		[["SAFE", "UNKNOWN"], 1],
	] as const) {
		const result = await runFake(["list", "--status", "safe"], () =>
			Effect.succeed({
				assessments: statuses.map((status, index) =>
					assessment(`/test/${index}`, status),
				),
				errors: [],
			}),
		);
		expect(result.code).toBe(expected);
	}
});

test("text output is colored only when requested and JSON never is", () => {
	const batch: Batch = {
		assessments: [assessment("/test/a", "PROTECTED")],
		errors: [],
	};
	const plain = present(batch, normalizeArguments(["scan"]));
	const colored = present(batch, normalizeArguments(["scan"]), true);
	const json = present(batch, normalizeArguments(["scan", "--json"]), true);
	expect(plain.stdout).not.toContain("\x1b[");
	expect(colored.stdout).toContain("\x1b[1;31mPROTECTED\x1b[0m");
	expect(json.stdout).not.toContain("\x1b[");
});

test("text output separates diagnosed and returned counts and inspect shows its source", () => {
	const batch: Batch = {
		assessments: [
			assessment("/test/a", "SAFE"),
			assessment("/test/b", "UNKNOWN"),
		],
		errors: [],
	};
	const list = present(batch, normalizeArguments(["list", "--status", "safe"]));
	expect(list.stdout).toContain(
		"Scanned 2; returned 1; SAFE 1; DIRTY 0; PROTECTED 0; UNKNOWN 1",
	);
	const inspect = present(
		{ assessments: [batch.assessments[1] as Assessment], errors: [] },
		normalizeArguments(["inspect", "/test/b"]),
	);
	expect(inspect.stdout).toContain('Source: directory; root: "/test"');
	expect(inspect.stdout).toContain("Checked at: 2026-01-01T00:00:00Z");
	expect(inspect.stdout).toContain("LOCAL_INSPECTION_FAILED");
	expect(inspect.stdout).toContain("Resolve the inspection failure");
});

test("cancellation during inspect returns 130", async () => {
	const controller = new AbortController();
	const pending = runCli(
		["inspect", "name"],
		{ stdout: () => {}, stderr: () => {} },
		Layer.succeed(Application, {
			diagnose: () => Effect.never,
			operate: () => Effect.never,
		}),
		controller.signal,
	);
	setTimeout(() => controller.abort(), 10);
	expect(await pending).toBe(130);
});

test("progress gauge draws a bar and clears the line on finish", () => {
	const writes: string[] = [];
	const progress = gauge({ write: (text) => writes.push(text) });
	progress.finish();
	expect(writes).toEqual([]);
	progress.update(1, 2);
	expect(writes[0]).toContain("1/2 (50%)");
	progress.finish();
	expect(writes.at(-1)).toBe("\r\x1b[2K");
});
