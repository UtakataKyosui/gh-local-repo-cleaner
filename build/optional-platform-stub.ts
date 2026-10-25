import type { BunPlugin } from "bun";

// @opentui/core imports its musl native package behind a runtime check.
// Bun installs only the host libc variant, so the bundler cannot resolve the
// other one; replace it with a module that fails if it is ever loaded.
const muslPackage = /^@opentui\/core-linux-[a-z0-9]+-musl$/;

const plugin: BunPlugin = {
	name: "optional-platform-stub",
	setup(build) {
		build.onResolve({ filter: muslPackage }, (args) => {
			try {
				return { path: Bun.resolveSync(args.path, args.resolveDir) };
			} catch {
				return { path: args.path, namespace: "optional-platform-stub" };
			}
		});
		build.onLoad(
			{ filter: /.*/, namespace: "optional-platform-stub" },
			(args) => ({
				contents: `throw new Error(${JSON.stringify(`${args.path} is not bundled in this binary`)});`,
				loader: "js",
			}),
		);
	},
};

export default plugin;
