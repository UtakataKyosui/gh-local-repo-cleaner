import { layer } from "@crustjs/effect";
import { Layer } from "effect";
import { CommandRunnerLive } from "./core/command.ts";
import { RepositoryInspectorLive } from "./core/inspection.ts";

export const CoreLive = RepositoryInspectorLive.pipe(
	Layer.provide(CommandRunnerLive),
);

// The official adapter provides services to handler() and scopes them to the invocation.
export const coreContext = layer("core", CoreLive);
