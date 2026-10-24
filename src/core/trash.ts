import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rmdir,
	unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { within } from "./discovery.ts";
import {
	acquireExclusiveLock,
	type ExclusiveLock,
	renameNoReplace,
} from "./platform.ts";
import { type Snapshot, snapshot } from "./snapshot.ts";

const recordStatuses = [
	"prepared",
	"moved",
	"restoring",
	"restored",
	"failed",
] as const;
type RecordStatus = (typeof recordStatuses)[number];

export type EntryStatus =
	| "moved"
	| "restored"
	| "failed"
	| "not_moved"
	| "recoverable"
	| "recovery_required"
	| "invalid_record"
	| "orphan_entry";

export interface Entry {
	readonly id: string;
	readonly original?: string;
	readonly created_at?: string;
	readonly updated_at?: string;
	readonly status: EntryStatus;
}

export type TrashErrorCode =
	| "LOCK_HELD"
	| "STORE_UNSAFE"
	| "STATE_CHANGED"
	| "MOVE_FAILED"
	| "RECORD_FAILED"
	| "RECORD_FAILED_AFTER_MOVE"
	| "UNKNOWN_ID"
	| "UNRESTORABLE";

export class TrashError extends Error {
	constructor(
		readonly code: TrashErrorCode,
		readonly id?: string,
	) {
		super(code);
	}
}

interface RecordData {
	readonly schema_version: 1;
	readonly id: string;
	readonly original: string;
	readonly destination: string;
	readonly root: string;
	readonly source: "clean";
	readonly created_at: string;
	readonly updated_at: string;
	readonly status: RecordStatus;
	readonly assessment: {
		readonly status: "SAFE";
		readonly reasons: readonly [];
	};
	readonly snapshot: Snapshot;
}

export interface TrashSession {
	moveRepository(
		original: string,
		root: string,
		expected: Snapshot,
		revalidate: () => Promise<boolean>,
	): Promise<string>;
	restore(id: string): Promise<void>;
	close(): Promise<void>;
}

const idPattern = /^[0-9a-f]{32}$/;
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
const sameJson = (left: unknown, right: unknown) =>
	JSON.stringify(left) === JSON.stringify(right);

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
	private get entries(): string {
		return join(this.path, "entries");
	}
	private entry(id: string): string {
		return join(this.entries, id);
	}
	private payload(id: string): string {
		return join(this.entry(id), "repo");
	}
	private async directory(path: string, create: boolean): Promise<boolean> {
		if (create) {
			await mkdir(dirname(path), { recursive: true });
			await mkdir(path, { mode: 0o700 }).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			});
		} else if (await absent(path)) return false;
		const stat = await lstat(path);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== process.getuid?.() ||
			(await realpath(path)) !== path
		)
			throw new TrashError("STORE_UNSAFE");
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
			throw new TrashError("STORE_UNSAFE");
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
		if (key.length !== 32) throw new TrashError("STORE_UNSAFE");
		return key;
	}
	private async save(record: RecordData): Promise<void> {
		await this.beforeSave(record.status);
		const data = JSON.stringify(record);
		const mac = createHmac("sha256", await this.key(true))
			.update(data)
			.digest("hex");
		const entry = this.entry(record.id);
		const temporary = join(entry, `.record-${randomBytes(8).toString("hex")}`);
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify({ data, mac }));
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, join(entry, "record.json"));
		} catch (error) {
			await unlink(temporary).catch(() => {});
			throw error;
		}
		const directory = await open(entry, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
	private async read(id: string): Promise<RecordData> {
		if (!idPattern.test(id)) throw new TrashError("UNKNOWN_ID");
		await this.directory(this.entry(id), false);
		const wrapper = JSON.parse(
			(await this.privateFile(join(this.entry(id), "record.json"))).toString(
				"utf8",
			),
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
			record.schema_version !== 1 ||
			record.id !== id ||
			record.destination !== this.payload(id) ||
			record.source !== "clean" ||
			!recordStatuses.includes(record.status) ||
			typeof record.created_at !== "string" ||
			typeof record.updated_at !== "string" ||
			!isAbsolute(record.original) ||
			!isAbsolute(record.root) ||
			resolve(record.original) !== record.original ||
			resolve(record.root) !== record.root ||
			!within(record.root, record.original) ||
			within(this.path, record.original) ||
			within(record.original, this.path) ||
			record.original === this.path ||
			!record.snapshot ||
			typeof record.snapshot.digest !== "string"
		)
			throw new Error("Invalid record fields");
		return Object.freeze(record);
	}
	private async identityMatches(record: RecordData): Promise<boolean> {
		const stat = await lstat(this.payload(record.id), { bigint: true });
		return (
			String(stat.dev) === record.snapshot.device &&
			String(stat.ino) === record.snapshot.inode
		);
	}
	private async contentMatches(record: RecordData): Promise<boolean> {
		return snapshot(this.payload(record.id)).then(
			(current) => sameJson(current, record.snapshot),
			() => false,
		);
	}
	// Reconciles a record with the real paths. Nothing is ever deleted or overwritten here.
	private async reconcile(record: RecordData): Promise<EntryStatus> {
		const payload = this.payload(record.id);
		const present = !(await absent(payload));
		if (present && !(await lstat(payload)).isDirectory())
			return "recovery_required";
		const original = !(await absent(record.original));
		switch (record.status) {
			case "restored":
			case "failed":
				return present ? "recovery_required" : record.status;
			case "moved":
				return present && (await this.contentMatches(record))
					? "moved"
					: "recovery_required";
			case "prepared":
				if (original && !present) return "not_moved";
				return !original && present && (await this.identityMatches(record))
					? "recoverable"
					: "recovery_required";
			case "restoring":
				return !original && present && (await this.contentMatches(record))
					? "recoverable"
					: "recovery_required";
		}
	}
	// Non-waiting and held until close(); the OS releases it if the process dies.
	async open(): Promise<TrashSession> {
		await this.directory(this.path, true);
		let lock: ExclusiveLock;
		try {
			lock = await acquireExclusiveLock(join(this.path, "lock"));
		} catch {
			throw new TrashError("LOCK_HELD");
		}
		let closed = false;
		const active = () => {
			if (closed) throw new Error("Trash session is closed");
		};
		return {
			moveRepository: (...parameters) => {
				active();
				return this.moveRepository(...parameters);
			},
			restore: (id) => {
				active();
				return this.restore(id);
			},
			close: async () => {
				closed = true;
				await lock.release();
			},
		};
	}
	async list(): Promise<{
		readonly entries: readonly Entry[];
		readonly failed: boolean;
	}> {
		if (
			!(await this.directory(this.path, false)) ||
			!(await this.directory(this.entries, false))
		)
			return { entries: [], failed: false };
		const entries: Entry[] = [];
		let failed = false;
		for (const id of (await readdir(this.entries)).sort()) {
			let entry: Entry;
			try {
				if (!idPattern.test(id)) entry = { id, status: "invalid_record" };
				else if (await absent(join(this.entry(id), "record.json")))
					entry = { id, status: "orphan_entry" };
				else {
					const record = await this.read(id);
					entry = {
						id,
						original: record.original,
						created_at: record.created_at,
						updated_at: record.updated_at,
						status: await this.reconcile(record),
					};
				}
			} catch {
				entry = { id, status: "invalid_record" };
			}
			if (
				["recoverable", "recovery_required", "invalid_record"].includes(
					entry.status,
				) ||
				entry.status === "orphan_entry"
			)
				failed = true;
			entries.push(entry);
		}
		return { entries, failed };
	}
	private async holdsWorkingDirectory(path: string): Promise<boolean> {
		const cwd = await realpath(process.cwd()).catch(() => null);
		return cwd === null || cwd === path || within(path, cwd);
	}
	private async moveRepository(
		original: string,
		root: string,
		expected: Snapshot,
		revalidate: () => Promise<boolean>,
	): Promise<string> {
		if (
			!within(root, original) ||
			original === this.path ||
			within(original, this.path) ||
			within(this.path, original) ||
			(await realpath(root)) !== root ||
			(await realpath(original)) !== original ||
			!(await lstat(original)).isDirectory() ||
			(await this.holdsWorkingDirectory(original))
		)
			throw new TrashError("STATE_CHANGED");
		const expectedFiles = {
			path: expected.path,
			device: expected.device,
			inode: expected.inode,
			digest: expected.digest,
		};
		if (
			!(await revalidate()) ||
			!sameJson(await snapshot(original), expectedFiles)
		)
			throw new TrashError("STATE_CHANGED");
		const id = randomBytes(16).toString("hex");
		const timestamp = this.now();
		const record: RecordData = {
			schema_version: 1,
			id,
			original,
			destination: this.payload(id),
			root,
			source: "clean",
			created_at: timestamp,
			updated_at: timestamp,
			status: "prepared",
			assessment: { status: "SAFE", reasons: [] },
			snapshot: expected,
		};
		try {
			await this.directory(this.entries, true);
			await mkdir(this.entry(id), { mode: 0o700 });
			await this.save(record);
		} catch {
			await rmdir(this.entry(id)).catch(() => {});
			throw new TrashError("RECORD_FAILED");
		}
		try {
			await this.move(original, this.payload(id));
		} catch {
			// The original is untouched, so the failure is recorded best-effort and the data stays.
			if (!(await absent(original)))
				await this.save({
					...record,
					status: "failed",
					updated_at: this.now(),
				}).catch(() => {});
			throw new TrashError("MOVE_FAILED", id);
		}
		try {
			await this.save({
				...record,
				status: "moved",
				updated_at: this.now(),
				snapshot: await snapshot(this.payload(id)),
			});
		} catch {
			throw new TrashError("RECORD_FAILED_AFTER_MOVE", id);
		}
		return id;
	}
	private async restore(id: string): Promise<void> {
		if (!idPattern.test(id) || !(await this.directory(this.entries, false)))
			throw new TrashError("UNKNOWN_ID");
		if (await absent(this.entry(id))) throw new TrashError("UNKNOWN_ID");
		const record = await this.read(id);
		const status = await this.reconcile(record);
		if (status !== "moved" && status !== "recoverable")
			throw new TrashError("UNRESTORABLE", id);
		const parent = dirname(record.original);
		if (
			(await realpath(parent).catch(() => null)) !== parent ||
			!(await absent(record.original))
		)
			throw new TrashError("UNRESTORABLE", id);
		try {
			await this.save({
				...record,
				status: "restoring",
				updated_at: this.now(),
				snapshot: await snapshot(this.payload(id)),
			});
		} catch {
			throw new TrashError("RECORD_FAILED", id);
		}
		try {
			await this.move(this.payload(id), record.original);
		} catch {
			throw new TrashError("MOVE_FAILED", id);
		}
		try {
			await this.save({
				...record,
				status: "restored",
				updated_at: this.now(),
			});
		} catch {
			throw new TrashError("RECORD_FAILED_AFTER_MOVE", id);
		}
	}
}
