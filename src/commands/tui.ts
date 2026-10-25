import { runTui } from "@crustjs/tui";
import {
	BoxRenderable,
	bold,
	type CliRenderer,
	dim,
	fg,
	type KeyEvent,
	reverse,
	StyledText,
	type TextChunk,
	TextRenderable,
} from "@opentui/core";
import { formatSize, quote } from "./human-output.ts";
import { tuiText } from "./messages.ts";
import { statusColors } from "./palette.ts";
import {
	type Command,
	type Event,
	entryLine,
	initialModel,
	type Model,
	pane,
	preferences,
	type Row,
	reduce,
	rows,
	type Session,
	windowStart,
} from "./tui-model.ts";

// The renderer only draws the model and forwards keys; every decision is in tui-model.ts.

const plain = (text: string): TextChunk => ({ __isChunk: true, text });

function repositoryLine(row: Row, model: Model): TextChunk[] {
	if (row.kind === "group")
		return [
			bold(
				`== ${quote(row.name)} (${Object.entries(row.counts)
					.map(([status, count]) => `${status} ${count}`)
					.join("; ")}) ==`,
			),
		];
	const { item } = row;
	const mark = row.selected ? "[x]" : item.status === "SAFE" ? "[ ]" : "   ";
	const name = `${quote(item.repository.name)}  ${formatSize(item.metadata.size_bytes, model.lang === "ja")}`;
	return [
		plain(`${row.current ? ">" : " "} ${mark} `),
		bold(fg(statusColors[item.status])(item.status.padEnd(9))),
		row.current ? reverse(name) : plain(name),
	];
}

function joinLines(lines: readonly TextChunk[][]): StyledText {
	return new StyledText(
		lines.flatMap((line, index) => (index ? [plain("\n"), ...line] : line)),
	);
}

function mount(
	renderer: CliRenderer,
	session: Session,
	onExit: (aborted: boolean) => void,
) {
	const header = new TextRenderable(renderer, { height: 1, wrapMode: "none" });
	const body = new BoxRenderable(renderer, {
		flexGrow: 1,
		flexDirection: "row",
	});
	const list = new BoxRenderable(renderer, {
		border: true,
		flexGrow: 3,
		flexBasis: 0,
		overflow: "hidden",
	});
	const listText = new TextRenderable(renderer, { wrapMode: "none" });
	const details = new BoxRenderable(renderer, {
		border: true,
		flexGrow: 2,
		flexBasis: 0,
		overflow: "hidden",
	});
	const detailText = new TextRenderable(renderer, { wrapMode: "word" });
	const status = new TextRenderable(renderer, { height: 1, wrapMode: "none" });
	const keys = new TextRenderable(renderer, { height: 1, wrapMode: "none" });
	list.add(listText);
	details.add(detailText);
	body.add(list);
	body.add(details);
	for (const part of [header, body, status, keys]) renderer.root.add(part);

	const start = initialModel(session.initial);
	let model = start.model;

	const draw = () => {
		const words = tuiText(model.lang);
		// Header, status and key lines take one row each; the boxes add two border rows.
		const height = Math.max(1, renderer.height - 5);
		header.content = joinLines([
			[
				bold("gh-local-repo-cleaner"),
				plain(
					`  ${words.filter(model.status)}${model.groupBy ? `  ·  ${words.grouped}` : ""}  ·  ${words.selected(model.selected.length)}  ·  ${model.target ? quote(model.target) : "ghq"}`,
				),
			],
		]);
		if (model.view === "trash") {
			list.title = ` ${words.trash} (${model.entries.length}) `;
			const from = windowStart(model.entries.length, model.entryCursor, height);
			listText.content = joinLines(
				model.entries.slice(from, from + height).map((entry, offset) => {
					const current = from + offset === model.entryCursor;
					const line = entryLine(entry);
					return [
						plain(current ? "> " : "  "),
						current ? reverse(line) : plain(line),
					];
				}),
			);
		} else {
			const all = rows(model);
			list.title = ` ${words.repositories} (${model.assessments.length}) `;
			const at = Math.max(
				0,
				all.findIndex((row) => row.kind === "repository" && row.current),
			);
			const from = windowStart(all.length, at, height);
			listText.content = all.length
				? joinLines(
						all
							.slice(from, from + height)
							.map((row) => repositoryLine(row, model)),
					)
				: joinLines(model.busy ? [] : [[plain(words.noRepositories)]]);
		}
		const side = pane(model);
		details.title = ` ${side.title} `;
		const scroll = Math.min(model.scroll, Math.max(0, side.lines.length - 1));
		detailText.content = side.lines.slice(scroll).join("\n");
		const note = model.busy ? words.busy[model.busy] : model.message;
		status.content = joinLines([
			note ? [fg(model.busy ? "cyan" : "yellow")(note)] : [],
		]);
		keys.content = joinLines([
			[dim(words.keys[model.dialog ? "dialog" : model.view])],
		]);
	};

	const execute = (command: Command) => {
		if (command.type === "save") return session.save(preferences(model));
		if (command.type === "exit") {
			onExit(command.aborted);
			renderer.destroy();
			return;
		}
		session.perform(command, model).then(
			(event) => dispatch(event),
			(error: unknown) => dispatch({ type: "failed", message: String(error) }),
		);
	};

	const dispatch = (event: Event) => {
		if (renderer.isDestroyed) return;
		const step = reduce(model, event);
		model = step.model;
		draw();
		for (const command of step.commands) execute(command);
	};

	renderer.keyInput.on("keypress", (key: KeyEvent) =>
		dispatch({ type: "key", key: { name: key.name, ctrl: key.ctrl } }),
	);
	renderer.on("resize", draw);
	draw();
	for (const command of start.commands) execute(command);
}

export async function runInteractive(
	session: Session,
): Promise<{ aborted: boolean }> {
	let aborted = false;
	// Ctrl+C goes through the model so it cannot cut off a running move.
	await runTui(
		(renderer) =>
			mount(renderer, session, (value) => {
				aborted = value;
			}),
		{ exitOnCtrlC: false },
	);
	return { aborted };
}
