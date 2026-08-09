import Ajv from "ajv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const schema = JSON.parse(await readFile(resolve(root, "contracts/candidate-agent-dto-1.0.schema.json"), "utf8"));
const valid = JSON.parse(await readFile(resolve(root, "contracts/vectors/candidate-agent.valid.json"), "utf8"));
const invalid = JSON.parse(await readFile(resolve(root, "contracts/vectors/candidate-agent.invalid-private-field.json"), "utf8"));
const validate = new Ajv({ strict: false }).compile(schema);
if (!validate(valid)) throw new Error(`valid vector rejected: ${JSON.stringify(validate.errors)}`);
if (validate(invalid)) throw new Error("invalid private-field vector was accepted");
console.log("contract vectors passed: candidate-agent valid/invalid");
