import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireExclusiveLock, renameNoReplace } from "./platform.ts";

async function temporary() {
	return realpath(await mkdtemp(join(tmpdir(), "cleaner-platform-")));
}

test("exclusive lock fails immediately while held and is reusable after release", async () => {
	const base = await temporary();
	try {
		const path = join(base, "lock");
		const first = await acquireExclusiveLock(path);
		await expect(acquireExclusiveLock(path)).rejects.toThrow("LOCK_HELD");
		await first.release();
		await (await acquireExclusiveLock(path)).release();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("exclusive lock is released by the OS when the holder is killed", async () => {
	const base = await temporary();
	try {
		const path = join(base, "lock");
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { acquireExclusiveLock } from ${JSON.stringify(join(process.cwd(), "src/core/platform.ts"))};await acquireExclusiveLock(${JSON.stringify(path)});console.log("held");setInterval(() => {}, 1000);`,
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const reader = child.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(
			"held",
		);
		await expect(acquireExclusiveLock(path)).rejects.toThrow("LOCK_HELD");
		child.kill("SIGKILL");
		await child.exited;
		await (await acquireExclusiveLock(path)).release();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("rename without replacement moves into a free name and refuses every existing destination", async () => {
	const base = await temporary();
	try {
		await mkdir(join(base, "source"));
		await writeFile(join(base, "source", "data"), "kept");
		await renameNoReplace(join(base, "source"), join(base, "moved"));
		expect(await Bun.file(join(base, "moved", "data")).text()).toBe("kept");

		await mkdir(join(base, "next"));
		await mkdir(join(base, "empty-destination"));
		await expect(
			renameNoReplace(join(base, "next"), join(base, "empty-destination")),
		).rejects.toThrow("RENAME_FAILED");
		await writeFile(join(base, "file-destination"), "other");
		await expect(
			renameNoReplace(join(base, "next"), join(base, "file-destination")),
		).rejects.toThrow("RENAME_FAILED");
		expect(await Bun.file(join(base, "file-destination")).text()).toBe("other");
		await expect(
			renameNoReplace(join(base, "missing"), join(base, "anywhere")),
		).rejects.toThrow("RENAME_FAILED");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
