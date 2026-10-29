// Run the production daemon with a live handle after cleanup. The supervisor
// must reap its process on the terminal acknowledgement, not event-loop idleness.
import "../src/runner-worker.js";
setInterval(() => undefined, 60_000);
