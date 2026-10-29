import { parse } from "yaml";

process.stdout.write(parse("answer: 42").answer.toString());
