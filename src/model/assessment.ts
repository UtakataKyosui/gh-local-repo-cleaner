import type { Finding, Status } from "../core/diagnosis.ts";
import type { Snapshot } from "../core/snapshot.ts";

export interface Repository {
	readonly source: "ghq" | "directory";
	readonly root: string;
	readonly path: string;
	readonly name: string;
}
export interface Assessment {
	readonly repository: Repository;
	readonly status: Status;
	readonly reasons: readonly Finding[];
	readonly checked_at: string;
	readonly metadata: {
		readonly size_bytes: number | null;
		readonly last_commit_at: string | null;
	};
	readonly snapshot: Snapshot | null;
}
export interface Batch {
	readonly assessments: readonly Assessment[];
	readonly errors: readonly {
		readonly code: string;
		readonly message: string;
	}[];
}
