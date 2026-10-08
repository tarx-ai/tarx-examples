/** Fires `onAlert` once when a connector hits N consecutive failures; re-arms after a success. */
export class FailureAlerter {
  private consecutive = new Map<string, number>();
  private alerted = new Set<string>();
  constructor(private threshold: number, private onAlert: (connector: string, failures: number, lastError: unknown) => void | Promise<void>) {}
  async failure(connector: string, err: unknown): Promise<void> {
    const n = (this.consecutive.get(connector) ?? 0) + 1;
    this.consecutive.set(connector, n);
    if (n >= this.threshold && !this.alerted.has(connector)) {
      this.alerted.add(connector);
      try {
        await this.onAlert(connector, n, err);
      } catch (alertErr) {
        console.error(`[connector-kit] alert hook failed for ${connector}:`, alertErr); // never break the caller
      }
    }
  }
  success(connector: string): void {
    this.consecutive.set(connector, 0);
    this.alerted.delete(connector);
  }
}
