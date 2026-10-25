import { createStyle } from "@crustjs/style";
import type { Finding } from "../core/diagnosis.ts";

// Status colors live here so the text output and the TUI share one definition.
export const statusColors = {
	SAFE: "green",
	DIRTY: "yellow",
	PROTECTED: "red",
	UNKNOWN: "magenta",
} as const satisfies Record<Finding["status"], string>;

export function createPainter(color: boolean) {
	const style = createStyle({ mode: color ? "always" : "never" });
	return (status: Finding["status"], value: string = status) =>
		style.bold[statusColors[status]](value);
}
