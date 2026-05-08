import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

function blockFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match?.[1] || '';
}

test('narrow composer keeps permission control to its visible button area', async () => {
  const css = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const narrowComposer = css.match(/@media\s*\(max-width:\s*380px\)\s*\{(?<body>[\s\S]*)\n\}/)?.groups?.body || '';
  const compactComposer = css.match(/@media\s*\(max-width:\s*480px\)\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body || '';
  const controlsRule = blockFor(narrowComposer, '.composer-controls');
  const controlLeftRule = blockFor(narrowComposer, '.control-left');
  const controlRightRule = blockFor(narrowComposer, '.control-right');
  const permissionRule = blockFor(narrowComposer, '.permission-pill');
  const permissionFullRule = blockFor(narrowComposer, '.permission-label-full');
  const permissionShortRule = blockFor(narrowComposer, '.permission-label-short');
  const skillMenuRule = blockFor(compactComposer, '.skill-menu');

  assert.doesNotMatch(controlsRule, /flex-wrap:\s*wrap/);
  assert.doesNotMatch(controlLeftRule, /display:\s*grid/);
  assert.doesNotMatch(controlRightRule, /width:\s*100%/);
  assert.match(permissionRule, /justify-self:\s*start/);
  assert.doesNotMatch(permissionRule, /max-width:\s*none/);
  assert.match(permissionFullRule, /display:\s*none/);
  assert.match(permissionShortRule, /display:\s*inline/);
  assert.match(skillMenuRule, /left:\s*12px/);
  assert.match(skillMenuRule, /right:\s*12px/);
  assert.match(skillMenuRule, /max-width:\s*none/);
  assert.match(skillMenuRule, /min-width:\s*0/);
});

test('mobile composer moves mode and skill controls into the add menu while keeping context visible', async () => {
  const app = await fs.readFile(new URL('./App.jsx', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const compactComposer = css.match(/@media\s*\(max-width:\s*480px\)\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body || '';
  const modeSelectRule = blockFor(compactComposer, '.mode-select');
  const skillSelectRule = blockFor(compactComposer, '.skill-select');
  const modeMenuRule = blockFor(compactComposer, '.mode-menu');
  const contextRule = blockFor(compactComposer, '.context-status-button');
  const contextTextRule = blockFor(compactComposer, '.context-status-button > span:not(.context-status-dot)');

  assert.match(app, /className="mobile-attach-option"[\s\S]*setOpenMenu\('composer-mode'\)/);
  assert.match(app, /className="mobile-attach-option"[\s\S]*setOpenMenu\('skill'\)/);
  assert.match(modeSelectRule, /display:\s*none/);
  assert.match(skillSelectRule, /display:\s*none/);
  assert.match(modeMenuRule, /left:\s*12px/);
  assert.match(modeMenuRule, /right:\s*12px/);
  assert.doesNotMatch(contextRule, /display:\s*none/);
  assert.match(contextTextRule, /display:\s*none/);
});

test('mobile add menu labels the folded plan mode action clearly', async () => {
  const app = await fs.readFile(new URL('./App.jsx', import.meta.url), 'utf8');

  assert.match(app, /className="mobile-attach-option"[\s\S]*<span className="menu-item-main">计划<\/span>/);
  assert.doesNotMatch(app, /<span className="menu-item-main">\{composerModeLabel\(composerMode\)\}<\/span>/);
});

test('mobile model selector uses compact text and content-sized width', async () => {
  const app = await fs.readFile(new URL('./App.jsx', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const compactComposer = css.match(/@media\s*\(max-width:\s*480px\)\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body || '';
  const narrowComposer = css.match(/@media\s*\(max-width:\s*380px\)\s*\{(?<body>[\s\S]*)\n\}/)?.groups?.body || '';
  const compactModelRule = blockFor(compactComposer, '.model-select');
  const narrowModelRule = blockFor(narrowComposer, '.model-select');

  assert.match(app, /<span>\{shortModelName\(selectedModelLabel\)\} \{reasoningLabel\(selectedReasoningEffort\)\}<\/span>/);
  assert.doesNotMatch(app, /<span>\{selectedModelLabel\} \{reasoningLabel\(selectedReasoningEffort\)\}<\/span>/);
  assert.match(compactModelRule, /width:\s*max-content/);
  assert.match(compactModelRule, /max-width:\s*min\(44vw,\s*136px\)/);
  assert.match(narrowModelRule, /max-width:\s*min\(44vw,\s*136px\)/);
});

test('desktop composer keeps anchored menus inside the desktop composer width', async () => {
  const css = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const desktopComposer = css.match(/@media\s*\(min-width:\s*1024px\)\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body || '';
  const skillMenuRule = blockFor(desktopComposer, '.skill-menu');
  const modelMenuRule = blockFor(desktopComposer, '.model-menu,\\s*\\n\\s*\\.send-mode-menu') || desktopComposer;

  assert.match(skillMenuRule, /left:\s*calc\(var\(--desktop-composer-gutter\) \+ 154px\)/);
  assert.match(modelMenuRule, /right:\s*var\(--desktop-composer-gutter\)/);
});
