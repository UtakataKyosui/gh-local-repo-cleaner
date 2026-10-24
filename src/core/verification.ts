import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { CommandRunner } from "../executil/command.ts";

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
		const names = (yield* git("-C", path, "remote"))
			.trim()
			.split("\n")
			.filter(Boolean);
		if (names.length === 0) throw new Error("No remote");
		const tags = new Map<string, Set<string>>();
		for (const [index, name] of names.entries()) {
			const urls = (yield* git("-C", path, "remote", "get-url", "--all", name))
				.trimEnd()
				.split("\n");
			if (urls.length !== 1 || !urls[0])
				throw new Error("Ambiguous remote URL");
			const url = urls[0];
			const before = remoteRefs(yield* git("ls-remote", "--refs", "--", url));
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
				`+refs/*:refs/verified/${index}/*`,
			);
			const after = remoteRefs(yield* git("ls-remote", "--refs", "--", url));
			if (
				JSON.stringify([...before].sort()) !== JSON.stringify([...after].sort())
			)
				throw new Error("Remote changed");
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
				throw new Error("Fetched refs mismatch");
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
		return { objects, tags };
	}).pipe(
		Effect.scoped,
		Effect.catchDefect(() => Effect.fail(new Error("Verification failed"))),
	);
