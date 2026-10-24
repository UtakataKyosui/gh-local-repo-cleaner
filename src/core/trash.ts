import {
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { within } from "./discovery.ts";
import { acquireExclusiveLock, renameNoReplace } from "./platform.ts";
import { type Snapshot, snapshot } from "./snapshot.ts";

interface RecordData {
	readonly version: 1;
	readonly id: string;
	readonly original: string;
	readonly root: string;
	readonly created_at: string;
	readonly assessment: {
		readonly status: "SAFE";
		readonly reasons: readonly [];
	};
	readonly status: "pending" | "moved" | "restored";
	readonly snapshot: Snapshot;
}
const idPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const missing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";
async function absent(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return false;
	} catch (error) {
		if (missing(error)) return true;
		throw error;
	}
}

export class TrashStore {
	constructor(
		readonly path: string,
		private readonly move = renameNoReplace,
		private readonly now = () => new Date().toISOString(),
		private readonly beforeSave: (
			status: string,
		) => Promise<void> = async () => {},
	) {
		if (!isAbsolute(path) || resolve(path) !== path)
			throw new Error("Invalid state path");
	}
	private async directory(create: boolean): Promise<boolean> {
		if (create) await mkdir(this.path, { recursive: true, mode: 0o700 });
		else if (await absent(this.path)) return false;
		const stat = await lstat(this.path);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== process.getuid?.() ||
			(await realpath(this.path)) !== this.path
		)
			throw new Error("Unsafe state directory");
		return true;
	}
	private async privateFile(path: string): Promise<Buffer> {
		const stat = await lstat(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== process.getuid?.()
		)
			throw new Error("Unsafe state file");
		return readFile(path);
	}
	private async key(create: boolean): Promise<Buffer> {
		const path = join(this.path, "key");
		if (create && (await absent(path))) {
			const file = await open(path, "wx", 0o600);
			try {
				await file.writeFile(randomBytes(32));
				await file.sync();
			} finally {
				await file.close();
			}
		}
		const key = await this.privateFile(path);
		if (key.length !== 32) throw new Error("Invalid state key");
		return key;
	}
	private async save(record: RecordData): Promise<void> {
		await this.beforeSave(record.status);
		const data = JSON.stringify(record);
		const mac = createHmac("sha256", await this.key(true))
			.update(data)
			.digest("hex");
		const temporary = join(this.path, `.${record.id}-${randomUUID()}`);
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify({ data, mac }));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, join(this.path, `${record.id}.json`));
		const directory = await open(this.path, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
	private async read(id: string): Promise<RecordData> {
		if (!idPattern.test(id)) throw new Error("Invalid trash ID");
		const wrapper = JSON.parse(
			(await this.privateFile(join(this.path, `${id}.json`))).toString("utf8"),
		);
		if (
			typeof wrapper.data !== "string" ||
			typeof wrapper.mac !== "string" ||
			!/^[0-9a-f]{64}$/.test(wrapper.mac)
		)
			throw new Error("Invalid record");
		const expected = createHmac("sha256", await this.key(false))
			.update(wrapper.data)
			.digest();
		if (!timingSafeEqual(Buffer.from(wrapper.mac, "hex"), expected))
			throw new Error("Record integrity failure");
		const record = JSON.parse(wrapper.data) as RecordData;
		if (
			record.version !== 1 ||
			record.id !== id ||
			!["pending", "moved", "restored"].includes(record.status) ||
			!isAbsolute(record.original) ||
			!isAbsolute(record.root) ||
			resolve(record.original) !== record.original ||
			!within(record.root, record.original) ||
			within(this.path, record.original) ||
			record.original === this.path ||
			!record.snapshot ||
			typeof record.snapshot.digest !== "string"
		)
			throw new Error("Invalid record fields");
		return Object.freeze(record);
	}
	private async locked<A>(action: () => Promise<A>): Promise<A> {
		await this.directory(true);
		const lock = await acquireExclusiveLock(join(this.path, "lock"));
		try {
			return await action();
		} finally {
			await lock.release();
		}
	}
	async list(): Promise<{
		readonly entries: readonly {
			id: string;
			original?: string;
			status: string;
		}[];
		readonly failed: boolean;
	}> {
		if (!(await this.directory(false))) return { entries: [], failed: false };
		const entries: { id: string; original?: string; status: string }[] = [];
		let failed = false;
		for (const name of (await readdir(this.path)).sort()) {
			if (
				idPattern.test(name) &&
				(await absent(join(this.path, `${name}.json`)))
			) {
				failed = true;
				entries.push({ id: name, status: "orphan-payload" });
				continue;
			}
			if (!name.endsWith(".json")) continue;
			const id = name.slice(0, -5);
			try {
				const record = await this.read(id);
				let status: string = record.status;
				const payload = join(this.path, id);
				if (record.status === "pending") status = "recovery-required";
				else if (record.status === "moved") {
					const current = await snapshot(payload);
					if (JSON.stringify(current) !== JSON.stringify(record.snapshot))
						status = "recovery-required";
				} else if (!(await absent(payload))) status = "recovery-required";
				if (status === "recovery-required") failed = true;
				entries.push({ id, original: record.original, status });
			} catch {
				failed = true;
				entries.push({ id, status: "invalid-record" });
			}
		}
		return { entries, failed };
	}
	async moveRepository(
		original: string,
		root: string,
		expected: Snapshot,
		revalidate: () => Promise<boolean>,
	): Promise<string> {
		return this.locked(async () => {
			if (
				!within(root, original) ||
				original === this.path ||
				within(original, this.path) ||
				within(this.path, original) ||
				(await realpath(root)) !== root ||
				(await realpath(original)) !== original ||
				!(await lstat(original)).isDirectory()
			)
				throw new Error("Unsafe source boundary");
			const expectedFiles = {
				path: expected.path,
				device: expected.device,
				inode: expected.inode,
				digest: expected.digest,
			};
			if (
				!(await revalidate()) ||
				JSON.stringify(await snapshot(original)) !==
					JSON.stringify(expectedFiles)
			)
				throw new Error("STATE_CHANGED");
			const id = randomUUID();
			const payload = join(this.path, id);
			const record: RecordData = {
				version: 1,
				id,
				original,
				root,
				created_at: this.now(),
				assessment: { status: "SAFE", reasons: [] },
				status: "pending",
				snapshot: expected,
			};
			await this.save(record);
			if (!(await absent(payload))) throw new Error("Destination collision");
			await this.move(original, payload);
			// If this write fails, the pending record remains discoverable; never delete data.
			await this.save({
				...record,
				status: "moved",
				snapshot: await snapshot(payload),
			});
			return id;
		});
	}
	async restore(id: string): Promise<void> {
		if (!(await this.directory(false))) throw new Error("Unknown trash ID");
		await this.locked(async () => {
			const record = await this.read(id);
			if (record.status !== "moved")
				throw new Error("Record is not restorable");
			const payload = join(this.path, id);
			if (
				JSON.stringify(await snapshot(payload)) !==
				JSON.stringify(record.snapshot)
			)
				throw new Error("Payload changed");
			if (
				(await realpath(dirname(record.original))) !==
					dirname(record.original) ||
				!(await absent(record.original))
			)
				throw new Error("Restore collision or unsafe parent");
			await this.move(payload, record.original);
			await this.save({ ...record, status: "restored" });
		});
	}
}
