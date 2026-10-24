import { Context, Data, Effect, Layer } from "effect";

export class CommandError extends Data.TaggedError("CommandError")<{
	readonly kind:
		| "spawn"
		| "timeout"
		| "exit"
		| "output-limit"
		| "invalid-output";
	readonly exitCode?: number;
}> {}

interface CommandRequest {
	readonly executable: "git" | "ghq";
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
}

export class CommandRunner extends Context.Service<
	CommandRunner,
	{
		readonly run: (
			request: CommandRequest,
		) => Effect.Effect<string, CommandError>;
	}
>()("CommandRunner") {}

export const makeCommandRunner = (environment: NodeJS.ProcessEnv) =>
	Layer.succeed(CommandRunner, {
		run: (request) =>
			Effect.tryPromise({
				try: async (signal) => {
					const timeoutMs =
						request.timeoutMs ??
						(request.executable === "git" ? 60_000 : 30_000);
					const maxOutputBytes = request.maxOutputBytes ?? 16 * 1024 * 1024;
					if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
						throw new CommandError({ kind: "timeout" });
					}
					let timedOut = false;
					let limited = false;
					// Git's repository selection and injected configuration must not escape -C.
					const env = Object.fromEntries(
						Object.entries(environment).filter(
							([key]) =>
								!key.startsWith("GIT_") ||
								[
									"GIT_CONFIG_GLOBAL",
									"GIT_CONFIG_SYSTEM",
									"GIT_CONFIG_NOSYSTEM",
									"GIT_SSH_COMMAND",
									"GIT_SSH",
									"GIT_ASKPASS",
								].includes(key),
						),
					);
					const child = Bun.spawn([request.executable, ...request.args], {
						detached: true,
						cwd: request.cwd,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "ignore",
						env: {
							...env,
							GIT_TERMINAL_PROMPT: "0",
							GIT_ASKPASS: "/usr/bin/false",
							SSH_ASKPASS: "/usr/bin/false",
							GIT_SSH_COMMAND: `${env.GIT_SSH_COMMAND ?? "ssh"} -oBatchMode=yes`,
							GIT_ALLOW_PROTOCOL: "file:https:http:ssh:git",
							GIT_OPTIONAL_LOCKS: "0",
							LC_ALL: "C",
						},
					});
					const reader = child.stdout.getReader();
					const kill = () => {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {}
						child.kill("SIGKILL");
						// Descendants may inherit stdout; stop reading even if they keep it open.
						void reader.cancel().catch(() => {});
					};
					const timer = setTimeout(() => {
						timedOut = true;
						kill();
					}, timeoutMs);
					signal.addEventListener("abort", kill, { once: true });
					if (signal.aborted) kill();
					try {
						const read = async () => {
							const decoder = new TextDecoder("utf-8", { fatal: true });
							let text = "";
							let bytes = 0;
							while (true) {
								const chunk = await reader.read();
								if (chunk.done) {
									try {
										return text + decoder.decode();
									} catch {
										throw new CommandError({ kind: "invalid-output" });
									}
								}
								bytes += chunk.value.byteLength;
								if (bytes > maxOutputBytes) {
									limited = true;
									kill();
									throw new CommandError({ kind: "output-limit" });
								}
								try {
									text += decoder.decode(chunk.value, { stream: true });
								} catch {
									throw new CommandError({ kind: "invalid-output" });
								}
							}
						};
						const [stdout, exitCode] = await Promise.all([
							read(),
							child.exited,
						]);
						if (timedOut) throw new CommandError({ kind: "timeout" });
						if (limited) throw new CommandError({ kind: "output-limit" });
						if (exitCode !== 0)
							throw new CommandError({ kind: "exit", exitCode });
						return stdout;
					} finally {
						kill();
						clearTimeout(timer);
						signal.removeEventListener("abort", kill);
						await reader.cancel().catch(() => {});
					}
				},
				catch: (error) =>
					error instanceof CommandError
						? error
						: new CommandError({ kind: "spawn" }),
			}),
	});

export const CommandRunnerLive = makeCommandRunner(process.env);
