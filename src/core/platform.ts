import { dlopen, FFIType } from "bun:ffi";
import { type FileHandle, open } from "node:fs/promises";

const darwin = process.platform === "darwin";
interface Libc {
	flock(fd: number, operation: number): number;
	renamex_np?(from: Uint8Array, to: Uint8Array, flags: number): number;
	renameat2?(
		fromDirectory: number,
		from: Uint8Array,
		toDirectory: number,
		to: Uint8Array,
		flags: number,
	): number;
}

// Loaded on first use so that read-only commands work even where a symbol is unavailable.
let cached: Libc | undefined;
const libc = (): Libc =>
	(cached ??= dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		...(darwin
			? {
					renamex_np: {
						args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
						returns: FFIType.i32,
					},
				}
			: {
					renameat2: {
						args: [
							FFIType.i32,
							FFIType.ptr,
							FFIType.i32,
							FFIType.ptr,
							FFIType.u32,
						],
						returns: FFIType.i32,
					},
				}),
	}).symbols as unknown as Libc);

const LOCK_EX = 2;
const LOCK_NB = 4;
const RENAME_EXCL = 0x4;
const RENAME_NOREPLACE = 1;
const AT_FDCWD = -100;
const cstring = (path: string) => Buffer.from(`${path}\0`);

export interface ExclusiveLock {
	release(): Promise<void>;
}

// The lock lives as long as its file descriptor, so handles stay referenced until released:
// a garbage-collected handle would close the descriptor and silently drop the lock.
const held = new Set<FileHandle>();

// The kernel drops the lock when the process exits, so a killed process never leaves a stale lock.
// Acquisition never waits: a held lock fails immediately.
export async function acquireExclusiveLock(
	path: string,
): Promise<ExclusiveLock> {
	const file: FileHandle = await open(path, "a+", 0o600);
	if (libc().flock(file.fd, LOCK_EX | LOCK_NB) !== 0) {
		await file.close();
		throw new Error("LOCK_HELD");
	}
	held.add(file);
	return {
		release: async () => {
			held.delete(file);
			await file.close();
		},
	};
}

// Fails without replacing an existing destination. The caller keeps the source on any failure.
export async function renameNoReplace(from: string, to: string): Promise<void> {
	const source = cstring(from);
	const target = cstring(to);
	const native = libc();
	const result = darwin
		? native.renamex_np?.(source, target, RENAME_EXCL)
		: native.renameat2?.(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE);
	if (result !== 0) throw new Error("RENAME_FAILED");
}
