/**
 * Diagnostic capture for the "Copy Glide Outline diagnostics" command.
 *
 * Two recent interactions are recorded so a mis-jump can be reported with
 * enough context to tell a *wrong heading* apart from a *wrong release
 * point*:
 *   - LastPointerActivationDiagnostic — what a pointer press/release did.
 *   - LastJumpDiagnostic — what an editor/preview jump landed on.
 */

export interface LastPointerActivationDiagnostic {
	headingKey: string;
	headingText: string;
	headingLine: number;
	targetType: "marker" | "card";
	downX: number;
	downY: number;
	upX: number;
	upY: number;
	accepted: boolean;
	rejectionReason?: string;
}

export interface LastJumpDiagnostic {
	headingKey: string;
	headingText: string;
	expectedLine: number;
	mode: "editor" | "preview";
	behavior: "smooth" | "auto";
	finalErrorPx?: number;
	correctionCount: number;
}

/** Mutable collector shared by the magnification controller (activation)
 * and the outline controller (jump). */
export class Diagnostics {
	lastPointerActivation: LastPointerActivationDiagnostic | null = null;
	lastJump: LastJumpDiagnostic | null = null;

	recordPointerActivation(d: LastPointerActivationDiagnostic): void {
		this.lastPointerActivation = d;
	}

	recordJump(d: LastJumpDiagnostic): void {
		this.lastJump = d;
	}
}
