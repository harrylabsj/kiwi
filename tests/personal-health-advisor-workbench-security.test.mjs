import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

const templatePath =
  'integrations/hosts/workbuddy/account-assets/personal-health-advisor/0.2.8/source/src/healthcare/advisor/workbench_template.html';
const template = readFileSync(templatePath, 'utf8');

const helperSource = template.slice(
  template.indexOf('const esc='),
  template.indexOf('const md='),
);
const { esc, enumValue, finiteNumber, cssPercent } = runInNewContext(
  `(() => { ${helperSource}; return { esc, enumValue, finiteNumber, cssPercent }; })()`,
);

test('archived health workbench rendering boundary', async (t) => {
  await t.test('encodes hostile free text before HTML and quoted-attribute insertion', () => {
    const hostile = `"><img src=x onerror=alert(1)> & 'sleep'`;
    assert.equal(esc(hostile), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &#39;sleep&#39;');
  });

  await t.test('keeps ordinary health text readable after encoding', () => {
    assert.equal(esc('血红蛋白 132 g/L · 晨间'), '血红蛋白 132 g/L · 晨间');
    assert.equal(esc('7.5'), '7.5');
  });

  await t.test('rejects model-controlled CSS classes and clamps style percentages', () => {
    assert.equal(enumValue('warn', ['good', 'warn', 'none'], 'none'), 'warn');
    assert.equal(enumValue('x" onclick="alert(1)', ['good', 'warn', 'none'], 'none'), 'none');
    assert.equal(cssPercent('42'), 42);
    assert.equal(cssPercent('12%;background:url(javascript:alert(1))'), 0);
    assert.equal(cssPercent(150), 100);
    assert.equal(finiteNumber('"><img src=x onerror=alert(1)>'), 0);
    assert.equal(finiteNumber('132'), 132);
  });

  await t.test('keeps the reported model fields behind the encoding or validation boundary', () => {
    assert.ok(template.includes("${enumValue(D.mode,['demo','live'],'live')}"));
    assert.ok(template.includes("enumValue(t.status.cls,['good','warn','none'],'none')"));
    assert.ok(template.includes("enumValue(c.state,['taken','skipped','missing','pending'],'missing')"));
    assert.ok(template.includes("enumValue(a.last_class,['good','warn','none'],'none')"));
    assert.ok(template.includes('${cssPercent(g.percent)}%'));
    assert.ok(template.includes('esc(vals[i].bedtime)'));
    assert.ok(template.includes('esc(vals[i].wake_time)'));
    assert.ok(template.includes('data-tip="<b>${esc(d)}</b><br>${esc(a.name)}'));
    assert.ok(template.includes('esc(j.candidates)'));
    assert.ok(template.includes('${esc(l.count)} 条记录'));
    assert.ok(template.includes('${esc(p.jobs.length)} 份报告待核对'));
  });
});
