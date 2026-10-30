import type { Attempt, Incident, Receipt } from "@nightshift/shared";
import { rewordReceipt, type ChainOptions, type LlmProvider } from "./chain.js";
import { buildFacts } from "./facts.js";
import { draftReceipt } from "./template.js";

export interface ReceiptWriterDeps {
  loadAttempts: (incidentId: string) => Promise<Attempt[]>;
  saveReceipt: (receipt: Receipt) => Promise<void>;
  providers: LlmProvider[];
  chain: ChainOptions;
  now: () => Date;
}

export class ReceiptWriter {
  constructor(private readonly deps: ReceiptWriterDeps) {}

  async write(incident: Incident): Promise<Receipt> {
    const attempts = await this.deps.loadAttempts(incident.id);
    const facts = buildFacts(incident, attempts);
    const draft = draftReceipt(facts);

    const receipt: Receipt = {
      incidentId: incident.id,
      text: draft,
      draftText: draft,
      wordedBy: "template",
      facts: facts as unknown as Record<string, unknown>,
      createdAt: this.deps.now().toISOString(),
    };
    await this.deps.saveReceipt(receipt);

    if (this.deps.providers.length > 0) {
      const reworded = await rewordReceipt(facts, draft, this.deps.providers, this.deps.chain);
      if (reworded.wordedBy !== "template") {
        receipt.text = reworded.text;
        receipt.wordedBy = reworded.wordedBy;
        await this.deps.saveReceipt(receipt);
      }
    }
    return receipt;
  }
}
