import { describe, expect, it } from "vitest";
import { HoverSession } from "../src/utils/hoverSession";
import { bridgeRectFor } from "../src/utils/envelope";

describe("long-to-short title hover session", () => {
	it.each(["left", "right"])("retains the learned width across shorter titles on the %s rail", side => {
		const session = new HoverSession();
		const rail = { left: 300, right: 328, top: 100, bottom: 500 };
		const long = { left: side === "right" ? 40 : 300, right: side === "right" ? 300 : 560, top: 200, bottom: 230 };
		session.include({ railRect: rail, items: [{ key: "long", markerRect: rail, cardRect: long, bridgeRect: bridgeRectFor(rail, long, 9, 5) }] });
		const x = side === "right" ? 80 : 500;
		expect(session.contains(x, 330, 100, 500)).toBe(true);
		const short = { left: 290, right: 350, top: 330, bottom: 350 };
		session.include({ railRect: rail, items: [{ key: "short", markerRect: rail, cardRect: short, bridgeRect: bridgeRectFor(rail, short, 9, 5) }] });
		expect(session.contains(x, 400, 100, 500)).toBe(true);
		expect(session.contains(x, 501, 100, 500)).toBe(false);
		expect(session.contains(900, 400, 100, 500)).toBe(false);
		session.clear();
		expect(session.contains(x, 400, 100, 500)).toBe(false);
	});
});
