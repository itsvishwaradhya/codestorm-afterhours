const HEALER = process.env.HEALER_URL ?? "http://localhost:4000";

async function main(): Promise<void> {
  const response = await fetch(`${HEALER}/api/reset`, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`[reset] failed (${response.status}): ${body}`);
    process.exit(1);
  }
  console.log("[reset] incidents, receipts, attempts and captures cleared; services restarted healthy");
}

main().catch((error) => {
  console.error(`[reset] error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
