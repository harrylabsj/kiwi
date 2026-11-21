import test from 'node:test';
import assert from 'node:assert/strict';
import {PREPARE_CODE_CATEGORIES,PREPARE_ERROR_MESSAGES,holdCode} from '../runtime/prepare-error-codes.mjs';

test('every prepare category has user guidance',()=>{
  for(const category of new Set(PREPARE_CODE_CATEGORIES.values())){
    assert.ok(PREPARE_ERROR_MESSAGES.has(`PREPARE_FAILED:${category}`),`missing message for ${category}`);
  }
  assert.ok(PREPARE_ERROR_MESSAGES.has('NPM_12_UNAVAILABLE'));
});

test('probe timeouts and process failures are retryable, contract mismatches are terminal',()=>{
  assert.equal(PREPARE_CODE_CATEGORIES.get('MCP_PROBE_TIMEOUT'),'TOOL_CHECK_RETRYABLE');
  assert.equal(PREPARE_CODE_CATEGORIES.get('MCP_PROBE_FAILED'),'TOOL_CHECK_RETRYABLE');
  assert.equal(PREPARE_CODE_CATEGORIES.get('MCP_SPAWN_FAILED'),'TOOL_CHECK_RETRYABLE');
  assert.equal(PREPARE_CODE_CATEGORIES.get('TOOL_SCHEMA_MISMATCH'),'TOOL_CHECK_FAILED');
  assert.equal(PREPARE_CODE_CATEGORIES.get('TOOL_SET_MISMATCH'),'TOOL_CHECK_FAILED');
  assert.notEqual(
    PREPARE_ERROR_MESSAGES.get('PREPARE_FAILED:TOOL_CHECK_RETRYABLE'),
    PREPARE_ERROR_MESSAGES.get('PREPARE_FAILED:TOOL_CHECK_FAILED'),
  );
});

test('hold codes keep tool-name details out without losing the terminal classification',()=>{
  assert.equal(holdCode('TOOL_SCHEMA_MISMATCH:kiwi_request_quotes'),'TOOL_SCHEMA_MISMATCH');
  assert.equal(holdCode('TOOL_SCHEMA_MISMATCH:kiwi_get_task2'),'TOOL_SCHEMA_MISMATCH');
  assert.equal(holdCode('TOOL_SCHEMA_MISMATCH:unexpected suffix'),'TOOL_SCHEMA_MISMATCH');
  assert.equal(holdCode('MCP_PROBE_TIMEOUT'),'MCP_PROBE_TIMEOUT');
  assert.equal(holdCode('lowercase-message'),'BUYER_INSPECTION_FAILED');
});
