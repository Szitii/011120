export class ViewerSensitiveCache {
  #epoch = 0;
  #values = new Map<string, unknown>();

  get epoch(): number { return this.#epoch; }

  get<T>(key: string): T | undefined {
    return this.#values.get(`${this.#epoch}:${key}`) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.#values.set(`${this.#epoch}:${key}`, value);
  }

  purgeViewerSensitive(): number {
    this.#epoch += 1;
    this.#values.clear();
    return this.#epoch;
  }

  size(): number { return this.#values.size; }
}
