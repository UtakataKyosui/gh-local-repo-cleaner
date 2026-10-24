import { expect, test } from "bun:test";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot } from "./snapshot.ts";
import { type TrashError, TrashStore } from "./trash.ts";

async function setup() {
	const base = await realpath(await mkdtemp(join(tmpdir(), "cleaner-trash-")));
	const root = join(base, "repositories");
	const original = join(root, "repo");
	await mkdir(join(original, ".git"), { recursive: true });
	await writeFile(join(original, ".git", "config"), "[core]\n");
	await writeFile(join(original, "script.sh"), "#!/bin/sh\n", { mode: 0o755 });
	await writeFile(join(original, "ignored.log"), "local only\n");
	await symlink("script.sh", join(original, "link"));
	return {
		base,
		root,
		original,
		state: join(base, "state"),
		dispose: () => rm(base, { recursive: true, force: true }),
	};
}

async function move(
	store: TrashStore,
	f: { root: string; original: string },
	revalidate = async () => true,
	original = f.original,
) {
	const session = await store.open();
	try {
		return await session.moveRepository(
			original,
			f.root,
			await snapshot(original),
			revalidate,
		);
	} finally {
		await session.close();
	}
}

async function restore(store: TrashStore, id: string) {
	const session = await store.open();
	try {
		await session.restore(id);
	} finally {
		await session.close();
	}
}

async function tree(path: string, prefix = ""): Promise<string[]> {
	const lines: string[] = [];
	for (const name of (await readdir(path)).sort()) {
		const file = join(path, name);
		const stat = await lstat(file);
		const mode = (stat.mode & 0o777).toString(8);
		if (stat.isSymbolicLink())
			lines.push(`${prefix}${name} link ${await readlink(file)}`);
		else if (stat.isDirectory()) {
			lines.push(`${prefix}${name}/ ${mode}`);
			lines.push(...(await tree(file, `${prefix}${name}/`)));
		} else
			lines.push(`${prefix}${name} ${mode} ${await readFile(file, "utf8")}`);
	}
	return lines;
}

const code = (error: unknown) => (error as TrashError).code;
const rejection = (action: Promise<unknown>) =>
	action.then(
		() => null,
		(error) => error as TrashError,
	);
const exdev = async () => {
	throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
};

test("move and restore round trip keeps .git, settings, modes and symlinks in private storage", async () => {
	const f = await setup();
	try {
		const store = new TrashStore(f.state);
		const before = await tree(f.original);
		const id = await move(store, f);
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(await lstat(f.original).catch(() => null)).toBeNull();
		for (const [path, mode] of [
			[f.state, 0o700],
			[join(f.state, "entries", id), 0o700],
			[join(f.state, "entries", id, "record.json"), 0o600],
		] as const)
			expect((await lstat(path)).mode & 0o777).toBe(mode);
		const record = JSON.parse(
			JSON.parse(
				await readFile(join(f.state, "entries", id, "record.json"), "utf8"),
			).data,
		);
		expect(record).toMatchObject({
			schema_version: 1,
			id,
			original: f.original,
			destination: join(f.state, "entries", id, "repo"),
			root: f.root,
			source: "clean",
			status: "moved",
			assessment: { status: "SAFE", reasons: [] },
		});
		expect((await store.list()).entries[0]?.status).toBe("moved");

		await restore(store, id);
		expect(await readFile(join(f.original, ".git", "config"), "utf8")).toBe(
			"[core]\n",
		);
		expect((await lstat(join(f.original, "script.sh"))).mode & 0o777).toBe(
			0o755,
		);
		expect(await readlink(join(f.original, "link"))).toBe("script.sh");
		expect(await tree(f.original)).toEqual(before);
		expect((await store.list()).entries[0]?.status).toBe("restored");
		expect(code(await rejection(restore(store, id)))).toBe("UNRESTORABLE");
	} finally {
		await f.dispose();
	}
});

test("a failed revalidation or a changed snapshot keeps the repository and creates no entry", async () => {
	const f = await setup();
	try {
		const store = new TrashStore(f.state);
		expect(code(await rejection(move(store, f, async () => false)))).toBe(
			"STATE_CHANGED",
		);
		await mkdir(join(f.original, ".git", "info"), { recursive: true });
		const mutations = [
			() => writeFile(join(f.original, "late.txt"), "added after approval"),
			() => writeFile(join(f.original, ".git", "info", "exclude"), "*.log\n"),
			() => writeFile(join(f.original, "ignored.log"), "changed ignored file"),
			() =>
				writeFile(join(f.original, ".git", "HEAD"), "ref: refs/heads/other\n"),
		];
		for (const mutate of mutations) {
			const session = await store.open();
			const expected = await snapshot(f.original);
			await mutate();
			expect(
				code(
					await rejection(
						session.moveRepository(
							f.original,
							f.root,
							expected,
							async () => true,
						),
					),
				),
			).toBe("STATE_CHANGED");
			await session.close();
		}
		expect(await readFile(join(f.original, "late.txt"), "utf8")).toContain(
			"added",
		);
		expect((await store.list()).entries).toEqual([]);
	} finally {
		await f.dispose();
	}
});

test("the working directory, its parents, the management root and the store are never moved", async () => {
	const f = await setup();
	try {
		const store = new TrashStore(f.state);
		for (const target of [f.root, f.base, f.state]) {
			await mkdir(f.state, { recursive: true, mode: 0o700 });
			expect(
				code(await rejection(move(store, f, async () => true, target))),
			).toBe("STATE_CHANGED");
		}
		const inside = new TrashStore(join(f.original, "state"));
		expect(code(await rejection(move(inside, f)))).toBe("STATE_CHANGED");
		expect(await lstat(f.original)).toBeDefined();
	} finally {
		await f.dispose();
	}
});

test("record write failure before the move keeps the source and leaves no entry", async () => {
	const f = await setup();
	try {
		const store = new TrashStore(f.state, undefined, undefined, async () => {
			throw new Error("Injected write failure");
		});
		expect(code(await rejection(move(store, f)))).toBe("RECORD_FAILED");
		expect(await lstat(join(f.original, ".git", "config"))).toBeDefined();
		expect(await readdir(join(f.state, "entries"))).toEqual([]);
	} finally {
		await f.dispose();
	}
});

test("rename failures (EXDEV, EACCES, collision) keep the source and never fall back to copying", async () => {
	const f = await setup();
	try {
		for (const failure of ["EXDEV", "EACCES", "EEXIST"]) {
			const store = new TrashStore(f.state, async () => {
				throw Object.assign(new Error(failure), { code: failure });
			});
			const error = await rejection(move(store, f));
			expect(code(error)).toBe("MOVE_FAILED");
			expect(error?.id).toMatch(/^[0-9a-f]{32}$/);
			expect(await lstat(join(f.original, ".git", "config"))).toBeDefined();
		}
		const listed = await new TrashStore(f.state).list();
		expect(listed.entries.map((entry) => entry.status)).toEqual([
			"failed",
			"failed",
			"failed",
		]);
		expect(listed.failed).toBe(false);
		for (const entry of listed.entries)
			expect(await readdir(join(f.state, "entries", entry.id))).toEqual([
				"record.json",
			]);
	} finally {
		await f.dispose();
	}
});

test("a failed move record update reports the id and the moved data is a restorable candidate", async () => {
	const f = await setup();
	try {
		const store = new TrashStore(
			f.state,
			undefined,
			undefined,
			async (status) => {
				if (status === "moved") throw new Error("Injected record failure");
			},
		);
		const error = await rejection(move(store, f));
		expect(code(error)).toBe("RECORD_FAILED_AFTER_MOVE");
		const id = error?.id ?? "";
		expect(await lstat(f.original).catch(() => null)).toBeNull();
		const recovered = new TrashStore(f.state);
		const listed = await recovered.list();
		expect(listed.entries[0]).toMatchObject({ id, status: "recoverable" });
		expect(listed.failed).toBe(true);
		await restore(recovered, id);
		expect(await readFile(join(f.original, ".git", "config"), "utf8")).toBe(
			"[core]\n",
		);
	} finally {
		await f.dispose();
	}
});

test("prepared records reconcile to not moved, recoverable or recovery required without touching data", async () => {
	const f = await setup();
	try {
		const stop = async () => {
			throw new Error("Injected stop");
		};
		const interrupted = new TrashStore(
			f.state,
			exdev,
			undefined,
			async (status) => {
				if (status === "failed") await stop();
			},
		);
		await rejection(move(interrupted, f));
		const store = new TrashStore(f.state);
		const [entry] = (await store.list()).entries;
		expect(entry?.status).toBe("not_moved");
		const id = entry?.id ?? "";
		await mkdir(join(f.state, "entries", id, "repo"));
		expect((await store.list()).entries[0]?.status).toBe("recovery_required");
		expect(code(await rejection(restore(store, id)))).toBe("UNRESTORABLE");
		expect(await lstat(f.original)).toBeDefined();
	} finally {
		await f.dispose();
	}
});

test("restore refuses any existing destination and a missing parent, and never overwrites", async () => {
	const f = await setup();
	try {
		const store = new TrashStore(f.state);
		const id = await move(store, f);
		await mkdir(f.original);
		expect(code(await rejection(restore(store, id)))).toBe("UNRESTORABLE");
		await rm(f.original, { recursive: true });
		await symlink(join(f.base, "nowhere"), f.original);
		expect(code(await rejection(restore(store, id)))).toBe("UNRESTORABLE");
		await rm(f.original);
		await rm(f.root, { recursive: true });
		expect(code(await rejection(restore(store, id)))).toBe("UNRESTORABLE");
		expect(await lstat(f.root).catch(() => null)).toBeNull();
		await mkdir(f.root);
		await restore(store, id);
		expect(await readFile(join(f.original, "ignored.log"), "utf8")).toBe(
			"local only\n",
		);
	} finally {
		await f.dispose();
	}
});

test("an interrupted restore is recorded as restoring and can be resumed", async () => {
	const f = await setup();
	try {
		const id = await move(new TrashStore(f.state), f);
		const failing = new TrashStore(f.state, exdev);
		expect(code(await rejection(restore(failing, id)))).toBe("MOVE_FAILED");
		const store = new TrashStore(f.state);
		expect((await store.list()).entries[0]?.status).toBe("recoverable");
		await restore(store, id);
		expect((await store.list()).entries[0]?.status).toBe("restored");
	} finally {
		await f.dispose();
	}
});

test("tampered records, changed payloads and traversal IDs are rejected", async () => {
	const f = await setup();
	try {
		const store = new TrashStore(f.state);
		const id = await move(store, f);
		for (const bad of [
			"../../etc",
			"..",
			"",
			`${id}/../${id}`,
			id.toUpperCase(),
		])
			expect(code(await rejection(restore(store, bad)))).toBe("UNKNOWN_ID");

		await writeFile(join(f.state, "entries", id, "repo", "intruder"), "x");
		expect((await store.list()).entries[0]?.status).toBe("recovery_required");
		expect(code(await rejection(restore(store, id)))).toBe("UNRESTORABLE");

		const path = join(f.state, "entries", id, "record.json");
		const wrapper = JSON.parse(await readFile(path, "utf8"));
		wrapper.data = wrapper.data.replace(f.original, join(f.base, "elsewhere"));
		await writeFile(path, JSON.stringify(wrapper), { mode: 0o600 });
		expect((await store.list()).entries[0]?.status).toBe("invalid_record");
		await rejection(restore(store, id));
		expect(await lstat(join(f.base, "elsewhere")).catch(() => null)).toBeNull();
	} finally {
		await f.dispose();
	}
});

test("one corrupt entry does not hide the others and orphan entries are reported", async () => {
	const f = await setup();
	try {
		const store = new TrashStore(f.state);
		const id = await move(store, f);
		await mkdir(join(f.state, "entries", "0".repeat(32)), { mode: 0o700 });
		await writeFile(join(f.state, "entries", "garbage"), "x");
		const listed = await store.list();
		expect(listed.failed).toBe(true);
		expect(
			Object.fromEntries(listed.entries.map((e) => [e.id, e.status])),
		).toEqual({
			[id]: "moved",
			["0".repeat(32)]: "orphan_entry",
			garbage: "invalid_record",
		});
	} finally {
		await f.dispose();
	}
});

test("unsafe storage permissions and a second concurrent session fail without being used", async () => {
	const f = await setup();
	try {
		const store = new TrashStore(f.state);
		const id = await move(store, f);
		const session = await store.open();
		expect(code(await rejection(store.open()))).toBe("LOCK_HELD");
		await session.close();

		await chmod(join(f.state, "entries", id, "record.json"), 0o644);
		expect((await store.list()).entries[0]?.status).toBe("invalid_record");
		await chmod(join(f.state, "entries", id, "record.json"), 0o600);
		await chmod(f.state, 0o755);
		expect(code(await rejection(store.open()))).toBe("STORE_UNSAFE");
		expect(code(await rejection(store.list()))).toBe("STORE_UNSAFE");
		await chmod(f.state, 0o700);

		const link = join(f.base, "state-link");
		await symlink(f.state, link);
		expect(code(await rejection(new TrashStore(link).open()))).toBe(
			"STORE_UNSAFE",
		);
	} finally {
		await f.dispose();
	}
});

test("a symlink swapped in for the repository after inspection is never followed or moved", async () => {
	const f = await setup();
	try {
		const store = new TrashStore(f.state);
		const session = await store.open();
		const expected = await snapshot(f.original);
		const aside = join(f.base, "aside");
		await rename(f.original, aside);
		await symlink(aside, f.original);
		expect(
			code(
				await rejection(
					session.moveRepository(
						f.original,
						f.root,
						expected,
						async () => true,
					),
				),
			),
		).toBe("STATE_CHANGED");
		await session.close();
		expect((await lstat(f.original)).isSymbolicLink()).toBe(true);
		expect(await readFile(join(aside, ".git", "config"), "utf8")).toBe(
			"[core]\n",
		);
	} finally {
		await f.dispose();
	}
});

test("a repository containing the working directory is never moved", async () => {
	const f = await setup();
	const previous = process.cwd();
	try {
		process.chdir(join(f.original, ".git"));
		expect(code(await rejection(move(new TrashStore(f.state), f)))).toBe(
			"STATE_CHANGED",
		);
		process.chdir(previous);
		expect(await lstat(join(f.original, ".git", "config"))).toBeDefined();
	} finally {
		process.chdir(previous);
		await f.dispose();
	}
});

test("a process killed before the rename, after it, or after the move returns leaves an identifiable state", async () => {
	const killAt = {
		"before-rename": "not_moved",
		"after-rename": "recoverable",
		"after-return": "moved",
	} as const;
	for (const [point, expected] of Object.entries(killAt)) {
		const f = await setup();
		try {
			const kill = 'process.kill(process.pid, "SIGKILL");';
			const script = `import { rename } from "node:fs/promises";
import { TrashStore } from ${JSON.stringify(join(process.cwd(), "src/core/trash.ts"))};
import { snapshot } from ${JSON.stringify(join(process.cwd(), "src/core/snapshot.ts"))};
const store = new TrashStore(${JSON.stringify(f.state)}, async (from, to) => {
	${point === "before-rename" ? kill : ""}
	await rename(from, to);
	${point === "after-rename" ? kill : ""}
});
const session = await store.open();
await session.moveRepository(${JSON.stringify(f.original)}, ${JSON.stringify(f.root)}, await snapshot(${JSON.stringify(f.original)}), async () => true);
${point === "after-return" ? kill : ""}
`;
			const file = join(f.base, "crash.ts");
			await writeFile(file, script);
			const child = Bun.spawn([process.execPath, file], {
				stdout: "ignore",
				stderr: "ignore",
			});
			expect(await child.exited).not.toBe(0);
			const store = new TrashStore(f.state);
			const listed = await store.list();
			expect(listed.entries.map((entry) => entry.status)).toEqual([expected]);
			expect(
				await Promise.all([
					lstat(f.original).then(
						() => "original",
						() => null,
					),
					lstat(
						join(f.state, "entries", listed.entries[0]?.id ?? "", "repo"),
					).then(
						() => "payload",
						() => null,
					),
				]),
			).toEqual(
				expected === "not_moved" ? ["original", null] : [null, "payload"],
			);
			await (await store.open()).close();
		} finally {
			await f.dispose();
		}
	}
});

test("an interrupted restore of a recovered prepared entry stays retryable", async () => {
	const f = await setup();
	try {
		const failing = new TrashStore(
			f.state,
			undefined,
			undefined,
			async (status) => {
				if (status === "moved") throw new Error("Injected record failure");
			},
		);
		const id = (await rejection(move(failing, f)))?.id ?? "";
		expect((await new TrashStore(f.state).list()).entries[0]?.status).toBe(
			"recoverable",
		);
		expect(
			code(await rejection(restore(new TrashStore(f.state, exdev), id))),
		).toBe("MOVE_FAILED");
		const store = new TrashStore(f.state);
		expect((await store.list()).entries[0]?.status).toBe("recoverable");
		await restore(store, id);
		expect(await readFile(join(f.original, ".git", "config"), "utf8")).toBe(
			"[core]\n",
		);
	} finally {
		await f.dispose();
	}
});
