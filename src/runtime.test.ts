import { expect, test } from "bun:test";
import { Crust } from "@crustjs/core";
import { handler, layer } from "@crustjs/effect";
import { Effect, Exit, Layer } from "effect";
import { finding } from "./core/diagnosis.ts";
import { inspectRepository, RepositoryInspector } from "./core/inspection.ts";
import { CommandError } from "./executil/command.ts";

for (const mode of ["success", "failure", "cancel"] as const) {
	test(`official adapter releases the core layer on ${mode} with its Exit`, async () => {
		const events: string[] = [];
		const controller = new AbortController();
		const failure = new CommandError({ kind: "exit", exitCode: 128 });
		const core = layer(
			"core",
			Layer.effect(
				RepositoryInspector,
				Effect.acquireRelease(
					Effect.sync(() => {
						events.push("acquired");
						return {
							inspect: () => Effect.succeed([finding("ONLINE_NOT_VERIFIED")]),
						};
					}),
					(_, exit) =>
						Effect.sync(() => {
							events.push(
								Exit.isSuccess(exit) ? "released:success" : "released:failure",
							);
						}),
				),
			),
		);
		const app = new Crust("test").provide(core()).action(
			handler(function* () {
				const result = yield* inspectRepository({ path: "/fixture" });
				events.push("inspected");
				if (mode === "failure") return yield* Effect.fail(failure);
				if (mode === "cancel") {
					yield* Effect.sync(() => controller.abort());
					return yield* Effect.never;
				}
				return result;
			}),
		);
		const outcome = await app.run([], undefined, { signal: controller.signal });
		expect(events).toEqual([
			"acquired",
			"inspected",
			mode === "success" ? "released:success" : "released:failure",
		]);
		if (mode === "success") {
			expect(outcome.status).toBe("completed");
			if (outcome.status === "completed")
				expect(outcome.result.status).toBe("UNKNOWN");
		} else {
			expect(outcome.status).toBe("failed");
			if (outcome.status === "failed") {
				if (mode === "failure") expect(outcome.error).toBe(failure);
				else expect(outcome.error).toHaveProperty("name", "AbortError");
			}
		}
	});
}
