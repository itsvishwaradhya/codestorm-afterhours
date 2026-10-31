# NightShift demo: narration script

Spoken over `nightshift-demo.mp4` (2:10). Times match the video.

**0:00** Meet NightShift, an autonomous on-call engineer. It catches production failures, tests a fix on a shadow copy, and applies it only when it is proven, with no human paged.

**0:12** The overview shows live health, time to heal, and an action budget, so the agent can never start a restart storm.

**0:20** The service map blames the deepest failing service, the root cause, instead of restarting every symptom. And this panel counts what a blind auto-restart would have done wrong.

**0:31** Now the Workspace. Here you bring your own app. This is a small Express bookstore API, in a real editor with a terminal and a request runner.

**0:41** We start it from the terminal. Traffic flows through NightShift's proxy, so the app needs no code changes.

**0:50** Every endpoint is discovered from the code. One click sends a request through the proxy.

**0:56** Now let's break it. AI inject bug picks a random route and a random kind of bug. An AI writes the bug, and it is checked on a throwaway copy first.

**1:07** The AI, groq, broke orders.js. Within seconds NightShift sees /authors and /books and /books/featured and /orders and /orders/summary and / and /health failing and opens an incident.

**1:22** It tests fixes on shadow copies with replayed production traffic. A restart won't help, because the bug is in the code. So it asks the AI to write a fix, using the error logs and the exact change.

**1:36** The AI fix passed the shadow test, so NightShift applied it. Here is the bug on the left, and the fix groq wrote on the right.

**1:45** It watches production for twenty seconds to confirm the fix holds, then writes a Heal Receipt: what broke, what was tried, and what was applied.

**1:55** Every detection, verdict and action lands in the audit log, so you can see exactly what the agent did, and why.

**2:03** That's NightShift. Detect, test on a shadow copy, fix, and prove it.
