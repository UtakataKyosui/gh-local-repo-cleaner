import { afterEach, expect, test } from "bun:test";
import { chmod, link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "../testing/fixture.ts";
import { exclusions, namePattern, sizeBytes } from "./configuration.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((f) => f.dispose()));
});
async function setup() {
	const f = await fixture();
	fixtures.push(f);
	return f;
}

test.each([
	["a/*", "a/b", true],
	["a/*", "a/b/c", false],
	["a/**", "a/b/c", false],
	["a/?", "a/日", true],
	["a/?", "a/", false],
	["[a-c]", "b", true],
	["[^a]", "b", true],
	["[^a]", "/", false],
	["[/a]", "/", false],
	["a\\*", "a*", true],
	["a", "a\n", false],
	["a\\?", "a?", true],
	["[\\a]", "a", true],
	["[a\\-z]", "-", true],
] as const)("name glob %s against %s is %s", (pattern, name, matches) => {
	expect(namePattern(pattern).test(name)).toBe(matches);
});
test.each(["", "[", "[]", "[^]", "[z-a]", "a\\", "[a\\]"])(
	"rejects malformed glob %s",
	(pattern) => {
		expect(() => namePattern(pattern)).toThrow();
	},
);

test("strict versioned rules preserve paths and report their zero-based index", async () => {
	const f = await setup();
	const config = join(f.base, "config.json");
	await writeFile(
		config,
		JSON.stringify({
			version: 1,
			exclude: [
				{ kind: "name", pattern: "github.com/company/*" },
				{ kind: "path", value: join(f.root, "important") },
			],
		}),
	);
	const rules = await exclusions(config);
	expect(rules.match({ name: "github.com/company/repo", path: "/other" })).toBe(
		0,
	);
	expect(rules.match({ name: "other", path: join(f.root, "important") })).toBe(
		1,
	);
	expect(
		rules.match({ name: "other", path: join(f.root, "important-sibling") }),
	).toBe(-1);
	expect(
		rules.match({ name: "github.com/company/repo/nested", path: "/other" }),
	).toBe(-1);
});

test.each([
	{},
	{ version: 2, exclude: [] },
	{ version: 1, exclude: [], extra: true },
	{ version: 1, exclude: ["legacy"] },
	{ version: 1, exclude: [{ kind: "name", pattern: "[" }] },
	{ version: 1, exclude: [{ kind: "path", value: "~/repo" }] },
	{ version: 1, exclude: [{ kind: "path", value: "relative" }] },
	{ version: 1, exclude: [{ kind: "name", pattern: "*", extra: true }] },
])("rejects invalid configuration %j", async (value) => {
	const f = await setup();
	const config = join(f.base, "config.json");
	await writeFile(config, JSON.stringify(value));
	await expect(exclusions(config)).rejects.toThrow();
});

test("explicit missing and invalid JSON fail, default missing is empty", async () => {
	const f = await setup();
	const config = join(f.base, "missing.json");
	await expect(exclusions(config)).rejects.toThrow();
	await writeFile(config, "{");
	await expect(exclusions(config)).rejects.toThrow();
	const previous = process.env.XDG_CONFIG_HOME;
	try {
		process.env.XDG_CONFIG_HOME = f.base;
		expect((await exclusions()).match({ name: "any", path: "/any" })).toBe(-1);
		await mkdir(join(f.base, "gh-local-repo-cleaner"));
		await writeFile(
			join(f.base, "gh-local-repo-cleaner", "config.json"),
			"invalid",
		);
		await expect(exclusions()).rejects.toThrow();
	} finally {
		if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previous;
	}
});

test("logical size includes Git/ignored, counts hardlinks per path, skips symlink cycles, never masks failures", async () => {
	const f = await setup();
	const path = join(f.root, "size");
	await mkdir(path);
	await mkdir(join(path, ".git"));
	await writeFile(join(path, ".git", "config"), "123");
	await writeFile(join(path, "ignored"), "12345");
	await link(join(path, "ignored"), join(path, "hardlink"));
	await symlink(path, join(path, "cycle"));
	expect(await sizeBytes(path)).toBe(13);
	await expect(sizeBytes(join(path, "absent"))).rejects.toThrow();
});

test.skipIf(process.getuid?.() === 0)(
	"unreadable size and configuration never become zero or an empty config",
	async () => {
		const f = await setup();
		const directory = join(f.root, "unreadable");
		await mkdir(directory);
		const config = join(f.base, "config.json");
		await writeFile(config, '{"version":1,"exclude":[]}');
		await chmod(directory, 0);
		await chmod(config, 0);
		try {
			await expect(sizeBytes(directory)).rejects.toThrow();
			await expect(exclusions(config)).rejects.toThrow();
		} finally {
			await chmod(directory, 0o700);
			await chmod(config, 0o600);
		}
	},
);
