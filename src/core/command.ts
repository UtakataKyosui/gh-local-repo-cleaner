import { Context, Data, Effect, Layer } from "effect";

export class CommandError extends Data.TaggedError("CommandError")<{
	readonly kind: "spawn" | "timeout" | "exit";
	readonly exitCode?: number;
}> {}

interface CommandRequest {
	readonly executable: "git" | "ghq";
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly timeoutMs?: number;
}

export class CommandRunner extends Context.Service<
	CommandRunner,
	{
		readonly run: (
			request: CommandRequest,
		) => Effect.Effect<string, CommandError>;
	}
>()("CommandRunner") {}

export const CommandRunnerLive = Layer.succeed(CommandRunner, {
	run: (request) =>
		Effect.tryPromise({
			try: async (signal) => {
				const timeoutMs = request.timeoutMs ?? 30_000;
				if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
					throw new CommandError({ kind: "timeout" });
				}
				let timedOut = false;
				const child = Bun.spawn([request.executable, ...request.args], {
					cwd: request.cwd,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "ignore",
					env: {
						...process.env,
						GIT_TERMINAL_PROMPT: "0",
						GIT_OPTIONAL_LOCKS: "0",
						LC_ALL: "C",
					},
				});
				const reader = child.stdout.getReader();
				const kill = () => {
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
						const decoder = new TextDecoder();
						let text = "";
						while (true) {
							const chunk = await reader.read();
							if (chunk.done) return text + decoder.decode();
							text += decoder.decode(chunk.value, { stream: true });
						}
					};
					const [stdout, exitCode] = await Promise.all([read(), child.exited]);
					if (timedOut) throw new CommandError({ kind: "timeout" });
					if (exitCode !== 0)
						throw new CommandError({ kind: "exit", exitCode });
					return stdout;
				} finally {
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
