#!/usr/bin/env bun
import { Crust } from "@crustjs/core";
import { handler } from "@crustjs/effect";
import { help, version } from "@crustjs/extensions";
import { Effect } from "effect";
import pkg from "../package.json" with { type: "json" };
import { coreContext } from "./runtime.ts";

const app = new Crust("gh-local-repo-cleaner", {
	description: "A CLI built with Crust",
	version: pkg.version,
})
	.provide(coreContext())
	.extend(version(), help())
	.args({
		name: "name",
		type: "string",
		description: "Your name",
		default: "world",
	})
	.flags({
		name: "greet",
		type: "string",
		description: "Greeting to use",
		default: "Hello",
		short: "g",
	})
	.action(
		handler(({ args, flags, stdout }) =>
			Effect.sync(() => {
				stdout(`${flags.greet}, ${args.name}!`);
			}),
		),
	);

await app.execute();
