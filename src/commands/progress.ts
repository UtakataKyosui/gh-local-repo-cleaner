export interface Progress {
	readonly update: (done: number, total: number) => void;
	readonly finish: () => void;
}

const width = 24;

export function gauge(stream: { write: (text: string) => unknown }): Progress {
	let drawn = false;
	return {
		update: (done, total) => {
			const ratio = total === 0 ? 1 : done / total;
			const filled = Math.round(ratio * width);
			const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
			stream.write(
				`\r\x1b[2KScanning ${bar} ${done}/${total} (${Math.round(ratio * 100)}%)`,
			);
			drawn = true;
		},
		finish: () => {
			if (drawn) stream.write("\r\x1b[2K");
			drawn = false;
		},
	};
}
