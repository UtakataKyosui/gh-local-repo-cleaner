import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { CommandRunner } from "../executil/command.ts";
import { effectiveRemotes } from "./remotes.ts";

const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
function remoteRefs(output: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const line of output.trimEnd().split("\n")) {
		if (!line) continue;
		const [id, ref, extra] = line.split("\t");
		if (
			!id ||
			!oid.test(id) ||
			!ref ||
			extra ||
			!ref.startsWith("refs/") ||
			[...ref].some((char) => char.charCodeAt(0) <= 32)
		)
			throw new Error("Invalid remote refs");
		if (!ref.endsWith("^{}")) result.set(ref, id);
	}
	return result;
}

// Fetch only into an isolated bare object store. Never update the inspected repo.
export const verifyRemoteObjects = (path: string) =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const git = (...args: string[]) => runner.run({ executable: "git", args });
		const directory = yield* Effect.acquireRelease(
			Effect.tryPromise(() => mkdtemp(join(tmpdir(), "repo-verification-"))),
			(directory) =>
				Effect.promise(() => rm(directory, { recursive: true, force: true })),
		);
		yield* git("init", "--bare", directory);
		const remotes = yield* effectiveRemotes(path);
		if (remotes.length === 0) throw new Error("REMOTE_MISSING");
		const tags = new Map<string, Set<string>>();
		const heads = new Map<string, Set<string>>();
		const advertised = (output: string) =>
			new Map(
				[...remoteRefs(output)].filter(([ref]) =>
					/^refs\/(heads|tags)\//.test(ref),
				),
			);
		for (const [index, { url }] of remotes.entries()) {
			const before = advertised(yield* git("ls-remote", "--refs", "--", url));
			yield* git(
				"--git-dir",
				directory,
				"-c",
				"fetch.fsckObjects=true",
				"fetch",
				"--no-tags",
				"--no-write-fetch-head",
				"--force",
				"--",
				url,
				`+refs/heads/*:refs/verified/${index}/heads/*`,
				`+refs/tags/*:refs/verified/${index}/tags/*`,
			);
			const after = advertised(yield* git("ls-remote", "--refs", "--", url));
			if (
				JSON.stringify([...before].sort()) !== JSON.stringify([...after].sort())
			)
				throw new Error("REMOTE_CHANGED_DURING_SCAN");
			const fetched = (yield* git(
				"--git-dir",
				directory,
				"for-each-ref",
				"--format=%(objectname)%09%(refname)",
				`refs/verified/${index}/`,
			)).trimEnd();
			const actual = remoteRefs(
				fetched.replaceAll(`refs/verified/${index}/`, "refs/"),
			);
			if (
				JSON.stringify([...actual].sort()) !== JSON.stringify([...after].sort())
			)
				throw new Error("REMOTE_CHANGED_DURING_SCAN");
			heads.set(
				remotes[index]?.name ?? "",
				new Set(
					[...after.keys()].filter((ref) => ref.startsWith("refs/heads/")),
				),
			);
			for (const [ref, id] of after)
				if (ref.startsWith("refs/tags/")) {
					const values = tags.get(ref) ?? new Set<string>();
					values.add(id);
					tags.set(ref, values);
				}
		}
		const output = yield* git(
			"--git-dir",
			directory,
			"rev-list",
			"--objects",
			"--all",
			"--no-object-names",
		);
		const objects = new Set(output.trim().split("\n").filter(Boolean));
		if ([...objects].some((id) => !oid.test(id)))
			throw new Error("Invalid object IDs");
		return { objects, tags, heads };
	}).pipe(
		Effect.scoped,
		Effect.catchDefect((error) =>
			Effect.fail(
				error instanceof Error ? error : new Error("Verification failed"),
			),
		),
	);
