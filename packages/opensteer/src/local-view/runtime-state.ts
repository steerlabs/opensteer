export interface PageActivationIntent {
  readonly targetId: string;
  readonly ts: number;
}

export class LocalViewRuntimeState {
  private readonly activationIntentBySessionId = new Map<string, PageActivationIntent>();

  setPageActivationIntent(sessionId: string, targetId: string): void {
    this.activationIntentBySessionId.set(sessionId, {
      targetId,
      ts: Date.now(),
    });
  }

  getPageActivationIntent(sessionId: string): PageActivationIntent | undefined {
    return this.activationIntentBySessionId.get(sessionId);
  }

  clearPageActivationIntent(sessionId: string, targetId?: string): void {
    const current = this.activationIntentBySessionId.get(sessionId);
    if (!current) {
      return;
    }
    if (targetId !== undefined && current.targetId !== targetId) {
      return;
    }
    this.activationIntentBySessionId.delete(sessionId);
  }
}
