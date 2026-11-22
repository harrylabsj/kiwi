import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

// Exercise the same entry point and unprivileged MCP calls that a host sees.
export async function probeCompanyProcurementExpert(extracted, home) {
  const launcher = join(extracted, 'runtime/embedded-expert-launcher.mjs');
  const child = spawn(process.execPath, [launcher, 'kiwi-company-procurement-buyer'], {
    cwd: extracted,
    env: {
      HOME: home, TMPDIR: home, LANG: 'zh_CN.UTF-8', NODE_ENV: 'test',
      PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let processError;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.on('error', error => { processError = error; });
  child.stdin.on('error', error => { processError = error; });
  const exit = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const reader = lines[Symbol.asyncIterator]();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 35_000);

  const send = (method, params, id) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
  async function receive(id) {
    for (;;) {
      const line = await reader.next();
      assert(!line.done, `MCP request ${id} ended early: ${processError ?? stderr}`);
      const message = JSON.parse(line.value);
      if (message.id !== id) continue;
      assert(!message.error, JSON.stringify(message.error));
      return message.result;
    }
  }
  async function call(name, args, id) {
    send('tools/call', { name, arguments: args }, id);
    return receive(id);
  }
  function payload(result) {
    assert(!result.isError, result.content?.[0]?.text);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }

  try {
    const create = {
      operation: 'create', request_id: 'sandbox-prepare',
      basis: {
        buyer_item_key: 'fixture-1', description: 'USB-C 电源适配器',
        selection_mode: 'spec_based', quantity: 20, unit: '台', requirements: [], channels: ['ecommerce'],
      },
    };
    send('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'kiwi-expert-package-probe', version: '1.0.0' },
    }, 1);
    await receive(1);
    send('notifications/initialized');
    send('tools/list', {}, 2);
    // No read-only call to wait for startup before the first case write.
    send('tools/call', { name: 'kiwi_prepare_procurement', arguments: create }, 3);
    const { tools } = await receive(2);
    assert.equal(tools.length, 17);
    for (const [name, selector] of [
      ['kiwi_prepare_procurement', 'operation'], ['kiwi_get_procurement', 'operation'],
      ['kiwi_compare_quotes', 'operation'], ['kiwi_negotiate', 'action'],
    ]) {
      const input = tools.find(tool => tool.name === name)?.inputSchema;
      assert(input?.properties?.[selector]?.enum?.length > 1, `Missing selector: ${name}`);
      assert(input.required.includes(selector), `Missing required selector: ${name}`);
    }
    const created = payload(await receive(3));
    assert(created.case.id);
    assert.equal(payload(await call('kiwi_prepare_procurement', create, 4)).case.id, created.case.id);
    const invalid = await call('kiwi_prepare_procurement', { operation: 'create', request_id: 'invalid' }, 5);
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /INVALID_PROCUREMENT_INPUT/);

    const reference = '用户提供的样例报价单，第 1 行';
    const attached = payload(await call('kiwi_prepare_procurement', {
      operation: 'attach_sources', request_id: 'sandbox-attach',
      case_id: created.case.id, expected_revision: created.case.revision, ecommerce_status: 'completed',
      sources: [{
        id: 'fixture-quote', channel: 'ecommerce', variant: 'fixture-variant',
        name: '样例供应商', price_kind: 'IMPORTED_REFERENCE',
        evidence: { reference, captured_at: new Date().toISOString() },
        costs: { currency: 'CNY', mode: 'direct_total', complete: true, quantity: 20, unit: '台', total_minor: 2_000_000 },
      }],
    }, 6));
    assert.equal(attached.case.sources.length, 1);
    const { snapshot } = payload(await call('kiwi_compare_quotes', {
      operation: 'create', request_id: 'sandbox-compare',
      case_ref: { case_id: attached.case.id, revision: attached.case.revision },
    }, 7));
    assert.equal(snapshot.data.rows.length, 1);
    assert.equal(snapshot.data.rows[0].conditional_amount_minor, 2_000_000);
    assert.equal(snapshot.data.rows[0].cash_total_minor, null);
    assert.equal(snapshot.data.recommendation, null);
    assert(snapshot.markdown.includes(reference));

    child.stdin.end();
    assert.equal(await exit, 0, stderr);
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.kill('SIGKILL');
    await exit;
  }
}
