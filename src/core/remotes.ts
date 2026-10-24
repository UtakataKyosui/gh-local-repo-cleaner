import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { CommandRunner } from "../executil/command.ts";

// Use Git's effective fetch URLs (including insteadOf), consistently for both
// remote verification and the dependency graph. Local paths are relative to -C.
export const effectiveRemotes = (path: string) =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const git = (...args: string[]) =>
			runner.run({ executable: "git", args: ["-C", path, ...args] });
		const names = (yield* git("remote")).trim().split("\n").filter(Boolean);
		const remotes: {
			readonly url: string;
			readonly localPath: string | null;
		}[] = [];
		for (const name of names) {
			const output = yield* git("remote", "get-url", "--all", "--", name);
			if (!output.endsWith("\n")) throw new Error("Invalid remote URL output");
			const urls = output.slice(0, -1).split("\n");
			if (urls.length !== 1 || !urls[0] || urls[0].includes("\0"))
				throw new Error("Ambiguous remote URL");
			const expanded = urls[0];
			const local = expanded.startsWith("file://")
				? fileURLToPath(expanded)
				: isAbsolute(expanded) || !/^[^/]+:/.test(expanded)
					? resolve(path, expanded)
					: null;
			const localPath =
				local === null
					? null
					: yield* Effect.tryPromise(async () => {
							try {
								return await realpath(local);
							} catch (error) {
								// Keep missing local paths identifiable as dependencies. Fetch will fail
								// verification separately; do not reinterpret them as network URLs.
								if (
									["ENOENT", "ENOTDIR"].includes(
										(error as NodeJS.ErrnoException).code ?? "",
									)
								)
									return local;
								throw error;
							}
						});
			remotes.push({ url: localPath ?? expanded, localPath });
		}
		return remotes;
	}).pipe(
		Effect.catchDefect(() =>
			Effect.fail(new Error("Remote URL resolution failed")),
		),
	);
