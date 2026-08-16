import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ajv is CommonJS; 2020-12 元 schema 需要 Ajv2020（与 src/contracts/negotiation-schema.ts 一致）。
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020.js");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const read = (rel) => readFile(resolve(root, rel), "utf8").then((t) => JSON.parse(t));

const cases = [
  {
    name: "candidate-agent",
    schema: "contracts/candidate-agent-dto-1.0.schema.json",
    valid: ["contracts/vectors/candidate-agent.valid.json"],
    invalid: ["contracts/vectors/candidate-agent.invalid-private-field.json"],
  },
  {
    name: "commerce-intent",
    schema: "contracts/commerce-intent/1.0/schema.json",
    valid: ["contracts/vectors/commerce-intent.valid.json"],
    invalid: ["contracts/vectors/commerce-intent.invalid-no-items.json"],
  },
  {
    name: "delegation-policy",
    schema: "contracts/delegation-policy/1.0/schema.json",
    valid: ["contracts/vectors/delegation-policy.valid.json"],
    invalid: ["contracts/vectors/delegation-policy.invalid-payment-auto.json"],
  },
  {
    name: "effective-authorization",
    schema: "contracts/effective-authorization/1.0/schema.json",
    valid: ["contracts/vectors/effective-authorization.valid.json"],
    invalid: ["contracts/vectors/effective-authorization.invalid-deny-wins.json"],
  },
  {
    name: "persistent-task",
    schema: "contracts/persistent-task/1.0/schema.json",
    valid: ["contracts/vectors/persistent-task.valid.json"],
    invalid: ["contracts/vectors/persistent-task.invalid-no-idempotency.json"],
  },
];

const validate = new Ajv({ strict: true });
const addFormats = (await import("ajv-formats")).default;
addFormats(validate);
// candidate-agent 是 draft-07 schema；注册 draft-07 元 schema 使同一实例可编译混合草稿。
validate.addMetaSchema(require("ajv/dist/refs/json-schema-draft-07.json"));

let failures = 0;
for (const c of cases) {
  const schema = await read(c.schema);
  const compile = validate.compile(schema);
  for (const rel of c.valid) {
    const instance = await read(rel);
    if (!compile(instance)) {
      failures += 1;
      console.error(`${c.name}: valid vector rejected ${rel}: ${JSON.stringify(compile.errors)}`);
    }
  }
  for (const rel of c.invalid) {
    const instance = await read(rel);
    if (compile(instance)) {
      failures += 1;
      console.error(`${c.name}: invalid vector accepted ${rel}`);
    }
  }
  console.log(`contract vectors passed: ${c.name}`);
}

if (failures > 0) {
  console.error(`${failures} vector check(s) failed`);
  process.exit(1);
}
