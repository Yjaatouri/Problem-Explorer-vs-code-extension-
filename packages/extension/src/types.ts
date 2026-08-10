/** Minimal dispose contract shared by the extension's own wiring. */
export interface DisposableLike {
  dispose(): void;
}