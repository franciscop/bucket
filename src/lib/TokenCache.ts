// Resolves a credential once and holds it until it expires. Lives in the
// provider context, so every folder shares one instead of re-resolving.
export class TokenCache<T> {
  #resolve: () => Promise<[T, number]>;
  #value: T | null = null;
  #expiry = 0;

  /** `resolve` returns the credential and the epoch millis it expires at. */
  constructor(resolve: () => Promise<[T, number]>) {
    this.#resolve = resolve;
  }

  async get(): Promise<T> {
    if (this.#value !== null && Date.now() < this.#expiry) return this.#value;
    [this.#value, this.#expiry] = await this.#resolve();
    return this.#value;
  }
}
