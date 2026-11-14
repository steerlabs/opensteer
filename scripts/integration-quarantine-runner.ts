import LockOrderTestRunner from "../packages/database/src/lock-order-runner.test-support.js";
import { quarantineRunner } from "./quarantine-runner.js";

export default quarantineRunner(LockOrderTestRunner);
