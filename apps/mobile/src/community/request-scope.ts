/** Invalidate requests on route/identity changes, even when transport cancellation fails. */
export class CommunityRequestScope {
  #epoch = 0;
  begin(): () => boolean {
    const epoch = ++this.#epoch;
    return () => epoch === this.#epoch;
  }
  invalidate(): void { this.#epoch += 1; }
}
