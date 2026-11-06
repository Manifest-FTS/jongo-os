import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CraftLoginCard } from '../dist/index.js';

const render = props => renderToStaticMarkup(createElement(CraftLoginCard, props));
const css = readFileSync(new URL('../src/studio.css', import.meta.url), 'utf8');

test('login card: Jongo sign-in with emergency access collapsed behind a disclosure', () => {
  const html = render({ siteName: 'The Golf Lab', jongo: true, password: true, passwordAction: '/x' });
  assert.match(html, /<h1[^>]*>Sign in to Jongo Craft<\/h1>/);
  assert.ok(html.includes('Edit The Golf Lab'));
  assert.match(html, /<button[^>]*data-sso-button="true"[^>]*>[\s\S]*<span>Sign in with Jongo<\/span><\/button>/);
  assert.ok(/data-sso-button="true"[^>]*autofocus=""|autofocus=""[^>]*data-sso-button="true"/.test(html), 'the primary button takes focus');
  assert.ok(html.includes('You will confirm on jongo.app. Your Jongo password is never shared with this site.'));
  assert.match(html, /<details class="jongo-login-emergency"><summary class="jongo-login-summary">Use emergency access<\/summary>/);
  assert.ok(html.indexOf('<details') < html.indexOf('name="password"') && html.indexOf('name="password"') < html.indexOf('</details>'), 'the password field is inside the disclosure');
  assert.ok(!/<details[^>]*\sopen/.test(html), 'collapsed by default');
  assert.match(html, /<label for="craft-password">Jongo Craft password<\/label><input id="craft-password" type="password" autoComplete="current-password" required="" maxLength="256" name="password"\/>/i);
  assert.match(html, /<button class="jongo-login-secondary" type="submit">Use emergency access<\/button>/);
  assert.ok(html.includes('data-login-method="jongo"') && html.includes('data-login-method="password"'));
  assert.ok(html.includes('action="/craft/auth/start"') && html.includes('method="post"'));
  assert.ok(!html.includes('role="alert"'));
});

test('login card: without a site name the context line stays neutral', () => {
  assert.ok(render({ jongo: true }).includes('Edit your site\u2019s content'));
  assert.ok(render({ jongo: true, siteName: '   ' }).includes('Edit your site\u2019s content'));
});

test('login card: the password alone is a plain form, not a disclosure, and takes focus', () => {
  const html = render({ password: true, passwordAction: '/x', eyebrow: 'Temporary sign-in', passwordHelp: 'A shared password gates saving.' });
  assert.ok(!html.includes('<details') && !html.includes('data-sso-button'));
  assert.match(html, /<button class="jongo-login-primary" type="submit">Sign in<\/button>/);
  assert.match(html, /id="craft-password"[^>]*autofocus=""/);
  assert.ok(html.includes('Temporary sign-in') && html.includes('A shared password gates saving.'));
});

test('login card: a rejected password opens the disclosure and moves focus to the field', () => {
  const html = render({ jongo: true, password: true, emergencyOpen: true, notice: { code: 'invalid', message: 'The password was not accepted.' } });
  assert.match(html, /<details class="jongo-login-emergency" open="">/);
  assert.match(html, /id="craft-password"[^>]*autofocus=""/);
  assert.ok(!/data-sso-button="true"[^>]*autofocus/.test(html));
});

test('login card: errors are alerts with an icon and the code in data-login-error', () => {
  const html = render({ jongo: true, notice: { code: 'sso', message: 'Sign-in with Jongo did not complete.' } });
  assert.match(html, /<div class="jongo-login-alert jongo-login-alert--error" role="alert" data-login-error="sso"><svg [^>]*aria-hidden="true"/);
  assert.ok(html.includes('Sign-in with Jongo did not complete.'));
});

test('login card: the lockout state names itself and uses its own treatment', () => {
  const html = render({ jongo: true, notice: { code: 'limited', kind: 'locked', message: 'Too many failed attempts. Try again in about 60 seconds.' } });
  assert.ok(html.includes('jongo-login-alert--locked') && html.includes('Too many attempts') && html.includes('Try again in about 60 seconds.'));
  assert.ok(html.includes('data-login-error="limited"') && html.includes('role="alert"'));
});

test('login card: the unavailable state replaces every sign-in method', () => {
  const html = render({ jongo: true, password: true, unavailable: { title: 'Sign-in is not available right now', children: createElement('p', null, 'Changes cannot be saved until this site is set up.') } });
  assert.ok(html.includes('data-login-disabled="true"') && html.includes('role="alert"'));
  assert.ok(html.includes('<h2 class="jongo-login-alert-title">Sign-in is not available right now</h2>'));
  assert.ok(!html.includes('data-sso-button') && !html.includes('name="password"') && !html.includes('<form'));
});

test('login card: text is rendered as text and nothing is read from the environment', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = render({ jongo: true, siteName: evil, notice: { code: 'x"><b>', message: evil } });
  assert.ok(!html.includes('<img src=x') && !html.includes('<b>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('login card styles live under the .jongo-login namespace and respect touch targets', () => {
  const rules = css.split('\n').filter(line => /jongo-login/.test(line));
  assert.ok(rules.length > 20);
  assert.ok(/pointer:coarse/.test(css) && /min-height:52px/.test(css));
  for (const line of rules.filter(l => l.startsWith('.jongo-'))) assert.ok(/\.jongo-studio/.test(line), `scoped: ${line.slice(0, 60)}`);
});
