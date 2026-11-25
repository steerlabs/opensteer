// A REPL worker entry four times slower than this machine: its CPU counts four
// times (see `slowThisThread`). For services that start their own worker and
// take only its entry, as the browser REPL does (its workerData says "browser").
import { slowThisThread } from "./computer-repl-worker.test-support.js";

slowThisThread({ cpuScale: 4 });
await import("./computer-repl-worker.js");
