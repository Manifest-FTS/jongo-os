import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabs } from '../dist/index.js';
import { BillingView, billingSections, createFixtureAdapter } from '../dist/golf-lab/index.js';

test('billing section labels and capabilities reflect role content, not provider automation', () => {
  assert.deepEqual(billingSections('member').map(row => row.id), ['membership', 'payment', 'agreements']);
  assert.deepEqual(billingSections('admin').map(row => row.id), ['membership', 'payment', 'agreements']);
  assert.deepEqual(billingSections('instructor'), [{ id: 'agreements', label: 'Instructor agreement' }]);
  for (const role of ['member', 'admin', 'instructor']) {
    const html = renderToStaticMarkup(createElement(BillingView, { role, membershipSelector: () => createElement('p', { 'data-selector': true }, 'Shared selector') }));
    assert.equal((html.match(/data-selector/g) ?? []).length, role === 'instructor' ? 0 : 1);
    assert.ok(!html.includes('Required review reason'));
    assert.ok(!html.includes('Record review request'));
    assert.ok(!html.includes('Manage card &amp; invoices'));
    assert.ok(html.includes('role="tablist"'));
    assert.ok(!html.includes('type="password"'));
  }
});
test('unpaid and pending membership entry never grants booking or cancellation', () => {
  for (const member of createFixtureAdapter().members.filter(row => ['unpaid', 'pending'].includes(row.billingStatus))) {
    const html = renderToStaticMarkup(createElement(BillingView, { role: 'member', member }));
    assert.ok(html.includes(member.billingStatus === 'pending' ? 'No active subscription or booking access is claimed.' : 'No paid membership is active.'));
    assert.ok(!html.includes('Request plan change / cancellation'));
    assert.ok(!html.includes('Manage card &amp; invoices'));
  }
});
test('shared tabs have unique linked IDs, roving tabindex and empty hidden panels', () => {
  const items = billingSections('member');
  const render = () => createElement(Tabs, { label: 'Billing sections', items, value: 'payment', onChange() {} }, createElement('p', null, 'Active payment content'));
  const html = renderToStaticMarkup(createElement('div', null, render(), render()));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(row => row[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-selected="false"/g) ?? []).length, 4);
  assert.equal((html.match(/Active payment content/g) ?? []).length, 2);
  for (const row of html.matchAll(/aria-controls="([^"]+)"/g)) assert.ok(ids.includes(row[1]));
  assert.equal((html.match(/hidden=""[^>]*><\/div>/g) ?? []).length, 4);
});