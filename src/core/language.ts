import { lstat } from "node:fs/promises";
import { join } from "node:path";

// Earlier entries win, so a TypeScript project is not reported as JavaScript.
const markers = [
	["tsconfig.json", "TypeScript"],
	["package.json", "JavaScript"],
	["Cargo.toml", "Rust"],
	["go.mod", "Go"],
	["pyproject.toml", "Python"],
	["requirements.txt", "Python"],
	["setup.py", "Python"],
	["Gemfile", "Ruby"],
	["composer.json", "PHP"],
	["pom.xml", "Java"],
	["build.gradle", "Java"],
	["build.gradle.kts", "Kotlin"],
	["Package.swift", "Swift"],
	["mix.exs", "Elixir"],
	["CMakeLists.txt", "C/C++"],
] as const;

// Marker files are checked by existence only; symbolic links are not followed.
export async function detectLanguage(path: string): Promise<string | null> {
	for (const [file, language] of markers) {
		try {
			if ((await lstat(join(path, file))).isFile()) return language;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return null;
}
