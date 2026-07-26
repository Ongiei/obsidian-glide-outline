export type Cleanup = () => void;

/** Collects cleanup callbacks and runs them (in reverse order) on dispose. */
export class DisposableStore {
	private cleanups: Cleanup[] = [];
	private disposed = false;

	add(cleanup: Cleanup): void {
		if (this.disposed) {
			cleanup();
			return;
		}
		this.cleanups.push(cleanup);
	}

	/** Convenience: addEventListener + auto-removal on dispose. */
	listen<K extends keyof HTMLElementEventMap>(
		target: HTMLElement,
		type: K,
		handler: (event: HTMLElementEventMap[K]) => void,
		options?: AddEventListenerOptions,
	): void {
		target.addEventListener(type, handler as EventListener, options);
		this.add(() =>
			target.removeEventListener(type, handler as EventListener, options),
		);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (let i = this.cleanups.length - 1; i >= 0; i--) {
			try {
				this.cleanups[i]();
			} catch (error) {
				console.error("[glide-outline] cleanup failed", error);
			}
		}
		this.cleanups = [];
	}
}
