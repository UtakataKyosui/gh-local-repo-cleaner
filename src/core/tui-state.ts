import { createStore } from "@crustjs/store";
import type { Locale } from "../commands/messages.ts";
import { locales } from "../commands/messages.ts";

export type TuiStatus = "safe" | "dirty" | "protected" | "unknown";
const statuses: readonly TuiStatus[] = [
	"safe",
	"dirty",
	"protected",
	"unknown",
];

// Every field is optional so a missing or hand-edited value means "no preference".
export type TuiState = {
	readonly target?: string;
	readonly status?: TuiStatus;
	readonly groupBy?: "language";
	readonly lang?: Locale;
};

export const tuiStateName = "tui-state";

const fields = {
	target: { type: "string" },
	status: { type: "string" },
	groupBy: { type: "string" },
	lang: { type: "string" },
} as const;

// Drops values the current version does not understand instead of failing on them.
export function sanitizeTuiState(raw: Record<string, unknown>): TuiState {
	const state: {
		target?: string;
		status?: TuiStatus;
		groupBy?: "language";
		lang?: Locale;
	} = {};
	if (typeof raw.target === "string" && raw.target) state.target = raw.target;
	if (statuses.includes(raw.status as TuiStatus))
		state.status = raw.status as TuiStatus;
	if (raw.groupBy === "language") state.groupBy = "language";
	if (locales.includes(raw.lang as Locale)) state.lang = raw.lang as Locale;
	return state;
}

// CLI flags win; a saved value only fills what the flags left unset.
export function mergeTuiState(saved: TuiState, flags: TuiState): TuiState {
	const defined = Object.fromEntries(
		Object.entries(flags).filter(([, value]) => value !== undefined),
	);
	return { ...saved, ...defined };
}

// dirPath must be absolute; tests pass a temporary directory.
export function tuiStateStore(dirPath: string) {
	const store = createStore({
		dirPath,
		name: tuiStateName,
		fields,
	});
	return {
		// A broken or unreadable file falls back to no saved preferences.
		load: async (): Promise<TuiState> => {
			try {
				return sanitizeTuiState(await store.read());
			} catch {
				return {};
			}
		},
		// Overwrites a broken file too, since patch repairs instead of rejecting.
		save: async (state: TuiState): Promise<void> => {
			await store.write({
				target: state.target,
				status: state.status,
				groupBy: state.groupBy,
				lang: state.lang,
			});
		},
		reset: () => store.reset(),
	};
}
