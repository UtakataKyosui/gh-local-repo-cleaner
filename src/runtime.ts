import { layer } from "@crustjs/effect";
import { Layer } from "effect";
import { RepositoryInspectorLive } from "./core/inspection.ts";
import { type CommandRunner, CommandRunnerLive } from "./executil/command.ts";

const CoreLive = RepositoryInspectorLive.pipe(Layer.provide(CommandRunnerLive));

// The official adapter provides services to handler() and scopes them to the invocation.
export const coreContext = (runner?: Layer.Layer<CommandRunner>) =>
	layer(
		"core",
		runner ? RepositoryInspectorLive.pipe(Layer.provide(runner)) : CoreLive,
	)();
