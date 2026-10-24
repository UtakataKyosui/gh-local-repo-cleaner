import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCommandRunner } from "../executil/command.ts";

export async function fixture() {
	const base = await realpath(
		await mkdtemp(join(tmpdir(), "cleaner-integration-")),
	);
	const root = join(base, "repositories");
	await mkdir(root);
	const env = {
		...process.env,
		HOME: base,
		XDG_CONFIG_HOME: join(base, "config"),
		XDG_DATA_HOME: join(base, "data"),
		XDG_CACHE_HOME: join(base, "cache"),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	async function git(path: string, ...args: string[]) {
		const child = Bun.spawn(["git", "-C", path, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(stderr);
		return stdout;
	}
	async function repository(name: string) {
		const path = join(root, name);
		const remote = join(base, `${name}-remote`);
		await mkdir(path);
		await git(path, "init", "-b", "main");
		await git(path, "config", "user.name", "Integration Test");
		await git(path, "config", "user.email", "test@example.invalid");
		await git(path, "config", "commit.gpgsign", "false");
		await writeFile(join(path, "tracked"), "preserved\n");
		await git(path, "add", ".");
		await git(path, "commit", "-m", "initial");
		await git(path, "init", "--bare", remote);
		await git(path, "remote", "add", "origin", remote);
		await git(path, "push", "-u", "origin", "main");
		return { path, remote };
	}
	return {
		base,
		root,
		env,
		git,
		repository,
		runner: makeCommandRunner(env),
		dispose: () => rm(base, { recursive: true, force: true }),
	};
}
