import "./env.js";
import { SERVICE_PORTS } from "@nightshift/shared";

const RPS = Number(process.env.TRAFFIC_RPS ?? 2);
const MAX_IN_FLIGHT = 20;
const ORDERS_URL = `http://localhost:${SERVICE_PORTS.orders}/checkout`;
const ITEMS = ["keyboard", "monitor", "usb-cable", "headphones"];

let sent = 0;
let succeeded = 0;
let failed = 0;
let inFlight = 0;

async function sendOrder(): Promise<void> {
  sent += 1;
  inFlight += 1;
  try {
    const response = await fetch(ORDERS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        item: ITEMS[Math.floor(Math.random() * ITEMS.length)],
        quantity: 1 + Math.floor(Math.random() * 3),
        cardNumber: "4242 4242 4242 4242",
        email: `shopper${sent}@example.test`,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      succeeded += 1;
    } else {
      failed += 1;
    }
  } catch {
    failed += 1;
  } finally {
    inFlight -= 1;
  }
}

setInterval(() => {
  if (inFlight < MAX_IN_FLIGHT) {
    void sendOrder();
  }
}, 1000 / RPS);

setInterval(() => {
  console.log(`[traffic] sent=${sent} ok=${succeeded} failed=${failed} in-flight=${inFlight}`);
}, 10_000);
