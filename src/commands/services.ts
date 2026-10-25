import { Context, Data, Effect, Layer } from "effect";
import type { Batch } from "../model/assessment.ts";
import type { Invocation } from "./arguments.ts";
import { UsageError } from "./arguments.ts";

export class ServiceError extends Data.TaggedError("ServiceError")<{
	readonly code: string;
	readonly detail?: string;
	readonly output?: string;
}> {}

// Command-specific use cases connect through this boundary. Missing services fail closed.
export class Application extends Context.Service<
	Application,
	{
		readonly diagnose: (
			invocation: Invocation,
		) => Effect.Effect<Batch, ServiceError>;
		readonly operate: (
			invocation: Invocation,
		) => Effect.Effect<string, ServiceError>;
		// Runs the TUI and returns what its operations reported, for the scrollback.
		readonly interact: (
			invocation: Invocation,
		) => Effect.Effect<string, ServiceError>;
	}
>()("Application") {}

export const ApplicationUnavailable = Layer.succeed(Application, {
	diagnose: () =>
		Effect.fail(new ServiceError({ code: "SERVICE_NOT_CONNECTED" })),
	operate: () =>
		Effect.fail(new ServiceError({ code: "SERVICE_NOT_CONNECTED" })),
	interact: () =>
		Effect.fail(new ServiceError({ code: "SERVICE_NOT_CONNECTED" })),
});

export interface Confirmation {
	readonly tty: boolean;
	readonly read: (
		prompt: string,
		signal?: AbortSignal,
	) => Promise<string | null>;
}
export async function confirm(
	invocation: Invocation,
	input: Confirmation,
	prompt: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (invocation.dryRun) return false;
	if (invocation.yes) return true;
	if (!input.tty)
		throw new UsageError("Non-interactive operation requires --yes");
	return /^(y|yes)$/i.test((await input.read(prompt, signal))?.trim() ?? "");
}
