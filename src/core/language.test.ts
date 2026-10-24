import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLanguage } from "./language.ts";

const temporary: string[] = [];
afterAll(() =>
	Promise.all(temporary.map((path) => rm(path, { recursive: true }))),
);

async function directory(...files: string[]) {
	const path = await mkdtemp(join(tmpdir(), "cleaner-language-"));
	temporary.push(path);
	await Promise.all(files.map((file) => writeFile(join(path, file), "")));
	return path;
}

test.each([
	[["Cargo.toml"], "Rust"],
	[["go.mod"], "Go"],
	[["pyproject.toml"], "Python"],
	[["package.json"], "JavaScript"],
	[["package.json", "tsconfig.json"], "TypeScript"],
	[["Cargo.toml", "package.json"], "JavaScript"],
	[[], null],
] as const)("detects %j as %p", async (files, expected) => {
	expect(await detectLanguage(await directory(...files))).toBe(expected);
});

test("a symbolic-link marker is ignored", async () => {
	const path = await directory("real");
	await symlink(join(path, "real"), join(path, "Cargo.toml"));
	expect(await detectLanguage(path)).toBeNull();
});
