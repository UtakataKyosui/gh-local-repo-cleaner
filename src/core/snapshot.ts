import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface Snapshot {
	readonly path: string;
	readonly device: string;
	readonly inode: string;
	readonly digest: string;
	readonly configuration?: string;
}

// Internal only. Include ignored files, Git configuration, refs, index and logs.
// Never follow symlinks or read special devices. A failed read invalidates inspection.
export async function snapshot(
	path: string,
	signal?: AbortSignal,
): Promise<Snapshot> {
	signal?.throwIfAborted();
	const canonical = await realpath(path);
	const root = await lstat(canonical, { bigint: true });
	const hash = createHash("sha256");
	async function visit(file: string, relative: string): Promise<void> {
		signal?.throwIfAborted();
		const stat = await lstat(file, { bigint: true });
		hash.update(
			JSON.stringify([
				relative,
				String(stat.dev),
				String(stat.ino),
				String(stat.mode),
				String(stat.size),
				String(stat.mtimeNs),
				String(stat.ctimeNs),
			]),
		);
		if (stat.isSymbolicLink())
			hash.update(JSON.stringify(await readlink(file)));
		else if (stat.isDirectory()) {
			for (const name of (await readdir(file)).sort())
				await visit(join(file, name), `${relative}/${name}`);
		} else if (stat.isFile()) {
			for await (const chunk of createReadStream(file, { signal }))
				hash.update(chunk);
		} else throw new Error("Unsupported file type");
	}
	await visit(canonical, "");
	return Object.freeze({
		path: canonical,
		device: String(root.dev),
		inode: String(root.ino),
		digest: hash.digest("hex"),
	});
}
