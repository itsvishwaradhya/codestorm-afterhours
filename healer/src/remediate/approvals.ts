export type ApprovalDecision = "approve" | "reject" | "timeout";

interface Waiting {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalGate {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly timeoutMs: number) {}

  request(id: string): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, "timeout"), this.timeoutMs);
      this.waiting.set(id, { resolve, timer });
    });
  }

  decide(id: string, decision: "approve" | "reject"): boolean {
    return this.settle(id, decision);
  }

  pending(): string[] {
    return [...this.waiting.keys()];
  }

  private settle(id: string, decision: ApprovalDecision): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.waiting.delete(id);
    entry.resolve(decision);
    return true;
  }
}
