import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const effortCore = require('../effort-core.js');
const perfAssets = require('../perf-assets.js');

test('resolveClaudeEffortSteps groups model variants in ascending strength and falls back cleanly', () => {
  const options = [
    { label: 'Gemini 4 Hydrogen XHigh' },
    { label: 'Gemini 4 Hydrogen Low' },
    { label: 'Gemini 4 Hydrogen High' },
    { label: 'Gemini 4 Hydrogen Medium' },
    { label: 'Gemini 4 Argon High' },
  ];
  const res = effortCore.resolveClaudeEffortSteps(options, 'Gemini 4 Hydrogen Medium', 'medium');
  assert.equal(res.baseName, 'Gemini 4 Hydrogen');
  assert.deepEqual(
    res.steps.map((s) => s.id),
    ['low', 'medium', 'high', 'xhigh']
  );
  assert.equal(res.selectedIdx, 1);

  const extraAlias = effortCore.resolveClaudeEffortSteps(
    [{ label: 'Gemini 4 Hydrogen Low' }, { label: 'Gemini 4 Hydrogen Medium' }, { label: 'Gemini 4 Hydrogen High' }, { label: 'Gemini 4 Hydrogen XHigh' }],
    'Gemini 4 Hydrogen Extra',
    'extra'
  );
  assert.equal(extraAlias.selectedIdx, 3);
  assert.equal(extraAlias.steps[3].id, 'xhigh');
  assert.equal(extraAlias.steps[3].display, 'Extra');

  const hostXHigh = effortCore.resolveClaudeEffortSteps(
    [{ label: 'Gemini 4 Hydrogen Low' }, { label: 'Gemini 4 Hydrogen Medium' }, { label: 'Gemini 4 Hydrogen High' }, { label: 'Gemini 4 Hydrogen XHigh' }],
    'Gemini 4 Hydrogen (XHigh)',
    'Extra'
  );
  assert.equal(hostXHigh.selectedIdx, 3);
  assert.equal(hostXHigh.steps[3].id, 'xhigh');
  assert.equal(hostXHigh.steps[3].display, 'Extra');

  const noExtraBadge = effortCore.resolveClaudeEffortSteps(
    [{ label: 'Gemini 4 Hydrogen Low' }, { label: 'Gemini 4 Hydrogen High' }, { label: 'Gemini 4 Hydrogen XHigh' }],
    'Gemini 4 Hydrogen (XHigh)',
    'xhigh'
  );
  assert.equal(noExtraBadge.steps[2].id, 'xhigh');
  assert.equal(noExtraBadge.steps[2].display, 'XHigh');

  const fallback = effortCore.resolveClaudeEffortSteps([], 'Custom Model Max', 'max');
  assert.deepEqual(
    fallback.steps.map((s) => s.id),
    ['low', 'medium', 'high', 'max']
  );
  assert.equal(fallback.selectedIdx, 3);

  const fallbackExtra = effortCore.resolveClaudeEffortSteps([], 'Gemini 4 Hydrogen Extra', 'Extra');
  assert.equal(fallbackExtra.steps[3].id, 'xhigh');
  assert.equal(fallbackExtra.steps[3].display, 'Extra');

  const labelOnlyExtra = effortCore.resolveClaudeEffortSteps(
    [{ label: 'Gemini 4 Hydrogen Low' }, { label: 'Gemini 4 Hydrogen High' }, { label: 'Gemini 4 Hydrogen XHigh' }],
    'Gemini 4 Hydrogen (Extra)',
    ''
  );
  assert.equal(labelOnlyExtra.selectedIdx, 2);
  assert.equal(labelOnlyExtra.steps[2].id, 'xhigh');
  assert.equal(labelOnlyExtra.steps[2].display, 'Extra');
});

test('dampTravel (DETENT = 0.8) is strictly monotonic, pins endpoints, and slows mid-detents', () => {
  assert.equal(effortCore.DETENT, 0.8);
  const span = 210;
  const steps = 4;
  assert.equal(effortCore.dampTravel(0, span, steps), 0);
  assert.equal(effortCore.dampTravel(span, span, steps), span);

  let prev = -1;
  for (let x = 0; x <= span; x += 3) {
    const d = effortCore.dampTravel(x, span, steps);
    assert.ok(d >= prev, `dampTravel should be monotonic at x=${x}`);
    assert.ok(d >= 0 && d <= span);
    prev = d;
  }

  // Stops at exact detents remain unshifted
  const seg = span / (steps - 1);
  for (let i = 0; i < steps; i++) {
    assert.ok(Math.abs(effortCore.dampTravel(i * seg, span, steps) - i * seg) < 1e-9);
  }
});

test('nearestStepIndex and computeEffortTintPercent resolve edge boundaries accurately', () => {
  assert.equal(effortCore.nearestStepIndex(0, 200, 4), 0);
  assert.equal(effortCore.nearestStepIndex(200, 200, 4), 3);
  assert.equal(effortCore.nearestStepIndex(67, 200, 4), 1);
  assert.equal(effortCore.nearestStepIndex(133, 200, 4), 2);
  assert.equal(effortCore.computeEffortTintPercent(4, 0), 0);
  assert.equal(effortCore.computeEffortTintPercent(4, 3), 100);
  assert.equal(effortCore.computeEffortTintPercent(1, 0), null);
});

test('5-row matrix-field solver and plume fade envelope stay within expected bounds', () => {
  assert.equal(effortCore.cellFade(0.05), 0);
  assert.equal(effortCore.cellFade(0.75), 1);
  assert.ok(effortCore.cellFade(0.4) > 0 && effortCore.cellFade(0.4) < 1);

  const field = effortCore.solveField(432, 2);
  assert.equal(field.heightDev, effortCore.BAND_H * 2);
  assert.ok(field.blocks.length >= 50);

  const first = field.blocks[0];
  assert.equal(first.fade, 0);
  const last = field.blocks[field.blocks.length - 1];
  assert.equal(last.fade, 1);

  const out = effortCore.composeBlockColour([163, 89, 255], [242, 232, 255], 0.5, 0.25, 0.5);
  assert.equal(out.length, 3);
  for (const ch of out) {
    assert.ok(ch >= 89 && ch <= 255);
  }
});

test('resolvePerformancePresets pairs Flash+Argon, Flash+Hydrogen, Claude Sonnet+Opus, and fallback', () => {
  const realAntigravityOpts = [
    { label: 'Gemini 3.8 Flash Low' },
    { label: 'Gemini 3.8 Flash Medium' },
    { label: 'Gemini 3.8 Flash High' },
    { label: 'Gemini 4 Argon Low' },
    { label: 'Gemini 4 Argon Medium' },
    { label: 'Gemini 4 Argon High' },
    { label: 'Gemini 4 Hydrogen Low' },
    { label: 'Gemini 4 Hydrogen Medium' },
    { label: 'Gemini 4 Hydrogen High' },
    { label: 'Gemini 4 Hydrogen XHigh' },
    { label: 'Claude Sonnet 5.5 Low' },
    { label: 'Claude Sonnet 5.5 Medium' },
    { label: 'Claude Sonnet 5.5 High' },
    { label: 'Claude Opus 5.5 Low' },
    { label: 'Claude Opus 5.5 Medium' },
    { label: 'Claude Opus 5.5 High' },
  ];

  // Argon selected -> 6 tiers spanning Flash Low/Med/High -> Argon Low/Med/High
  const argon = effortCore.resolvePerformancePresets(realAntigravityOpts, 'Gemini 4 Argon High', 'high', true);
  assert.equal(argon.presets.length, 6);
  assert.equal(argon.presets[0].modelShort, 'Flash');
  assert.equal(argon.presets[5].modelShort, 'Argon');
  assert.equal(argon.activeIdx, 5);

  // Hydrogen selected -> 6 tiers spanning Flash Low/Med/High -> Hydrogen Low/High/XHigh (or Med/High/XHigh when Med active)
  const hydro = effortCore.resolvePerformancePresets(realAntigravityOpts, 'Gemini 4 Hydrogen XHigh', 'xhigh', true);
  assert.equal(hydro.presets.length, 6);
  assert.equal(hydro.presets[5].fullLabel, 'Gemini 4 Hydrogen XHigh');
  assert.equal(hydro.presets[5].effort, 'xhigh');
  assert.equal(hydro.presets[5].effortDisplay, 'XHigh');
  assert.equal(hydro.activeIdx, 5);

  const hydroExtra = effortCore.resolvePerformancePresets(realAntigravityOpts, 'Gemini 4 Hydrogen (XHigh)', 'Extra', true);
  assert.equal(hydroExtra.presets[5].effort, 'xhigh');
  assert.equal(hydroExtra.presets[5].effortDisplay, 'Extra');
  assert.equal(hydroExtra.activeIdx, 5);

  const hydroLabelOnlyExtra = effortCore.resolvePerformancePresets(realAntigravityOpts, 'Gemini 4 Hydrogen Extra', '', true);
  assert.equal(hydroLabelOnlyExtra.presets[5].effort, 'xhigh');
  assert.equal(hydroLabelOnlyExtra.presets[5].effortDisplay, 'Extra');
  assert.equal(hydroLabelOnlyExtra.activeIdx, 5);

  // Claude selected -> 6 tiers spanning Sonnet Low/Med/High -> Opus Low/Med/High
  const claude = effortCore.resolvePerformancePresets(realAntigravityOpts, 'Claude Opus 5.5 Medium', 'medium', false);
  assert.equal(claude.presets.length, 6);
  assert.equal(claude.presets[0].modelShort, 'Sonnet');
  assert.equal(claude.presets[4].fullLabel, 'Claude Opus 5.5 Medium');
  assert.equal(claude.activeIdx, 4);

  // Fallback with empty options
  const fb = effortCore.resolvePerformancePresets([], '', '', true);
  assert.equal(fb.presets.length, 6);

  // AGY 2.33.0 Gemini 4 Neon / Carbon / Helix / Orchestrator model badge & presets
  const agy233Opts = [
    { label: 'Gemini 3.8 Flash Low' },
    { label: 'Gemini 3.8 Flash Medium' },
    { label: 'Gemini 3.8 Flash High' },
    { label: 'Gemini 4 Carbon Low' },
    { label: 'Gemini 4 Carbon Medium' },
    { label: 'Gemini 4 Carbon High' },
    { label: 'Gemini 4 Neon Low' },
    { label: 'Gemini 4 Neon Medium' },
    { label: 'Gemini 4 Neon High' },
    { label: 'Gemini 4 Neon XHigh' },
  ];
  const carbon = effortCore.resolvePerformancePresets(agy233Opts, 'Gemini 4 Carbon (High)', 'high', true);
  assert.equal(carbon.presets.length, 6);
  assert.equal(carbon.presets[0].modelShort, 'Flash');
  assert.equal(carbon.presets[5].modelShort, 'Carbon');
  assert.equal(carbon.presets[5].fullLabel, 'Gemini 4 Carbon High');
  assert.equal(carbon.activeIdx, 5);

  const neon = effortCore.resolvePerformancePresets(agy233Opts, 'Gemini 4 Neon (XHigh)', 'xhigh', true);
  assert.equal(neon.presets.length, 6);
  assert.equal(neon.presets[0].modelShort, 'Flash');
  assert.equal(neon.presets[5].modelShort, 'Neon');
  assert.equal(neon.presets[5].fullLabel, 'Gemini 4 Neon XHigh');
  assert.equal(neon.activeIdx, 5);

  const helixFb = effortCore.resolvePerformancePresets(
    [{ label: 'Gemini 4 Helix Low' }, { label: 'Gemini 4 Helix High' }],
    'Gemini 4 Helix High',
    'high',
    false
  );
  assert.equal(helixFb.presets[0].modelShort, 'Helix');

  const orchFb = effortCore.resolvePerformancePresets(
    [{ label: 'Orchestrator (Neon)' }],
    'Orchestrator (Neon)',
    '',
    false
  );
  assert.equal(orchFb.presets.length, 6);
  assert.equal(effortCore.parseModelLabelEffort('Orchestrator (Neon)').effort, '');
});

test('frameForLevel, levelForFrame, interpolatePerfColor, and perf-assets 31 WebP frames stay consistent', () => {
  assert.equal(effortCore.PERF_FRAME_COUNT, 31);
  assert.equal(effortCore.frameForLevel(0, 6), 0);
  assert.equal(effortCore.frameForLevel(5, 6), 30);
  assert.equal(effortCore.frameForLevel(4, 6), 24);
  assert.equal(effortCore.levelForFrame(24, 6), 4);
  assert.equal(effortCore.levelForFrame(0, 6), 0);
  assert.equal(effortCore.levelForFrame(30, 6), 5);

  const colStart = effortCore.interpolatePerfColor(0);
  const colEnd = effortCore.interpolatePerfColor(30);
  assert.match(colStart, /^rgb\(\d+, \d+, \d+\)$/);
  assert.notEqual(colStart, colEnd);

  assert.equal(perfAssets.FRAME_COUNT, 31);
  assert.equal(perfAssets.frames.length, 31);
  for (const frame of perfAssets.frames) {
    assert.ok(frame.startsWith('data:image/webp;base64,'));
  }
});

test('normalizeEffortStyle and Codex effort math stay consistent with dsh-codex-effort-slider', () => {
  assert.equal(effortCore.normalizeEffortStyle('claude'), 'claude');
  assert.equal(effortCore.normalizeEffortStyle('chatgpt'), 'chatgpt');
  assert.equal(effortCore.normalizeEffortStyle('codex'), 'chatgpt');
  assert.equal(effortCore.normalizeEffortStyle('liangwufeng'), 'liangwufeng');
  assert.equal(effortCore.normalizeEffortStyle('performance'), 'liangwufeng');
  assert.equal(effortCore.normalizeEffortStyle('unknown'), 'claude');

  assert.equal(effortCore.CODEX_PARTICLES.length, 22);
  assert.equal(effortCore.codexEnergyFor(0), 0);
  assert.equal(effortCore.codexEnergyFor(1 / 3), 0);
  assert.ok(Math.abs(effortCore.codexEnergyFor(2 / 3) - 0.5) < 1e-6);
  assert.equal(effortCore.codexEnergyFor(1), 1);

  assert.equal(effortCore.codexFillColorFor(0), 'rgb(77,147,248)');
  assert.equal(effortCore.codexFillColorFor(2 / 3), 'rgb(147,51,234)');
  assert.equal(effortCore.codexFillColorFor(1), 'rgb(76,29,149)');
  assert.equal(effortCore.codexValueColorFor(0, 'Off'), '');
  assert.equal(effortCore.codexValueColorFor(1, 'Extra'), 'rgb(139,92,246)');

  const m = { x: 0, v: 0, a: 0, target: 1 };
  for (let i = 0; i < 60; i += 1) {
    effortCore.codexMotionStep(m, 1 / 60);
  }
  assert.equal(effortCore.codexMotionSettled(m), true);
  assert.equal(m.x, 1);
  assert.equal(m.v, 0);
});

test('stripContextWindowSuffix and parseModelLabelEffort handle AGY 2.33.1 thinking & context window suffixes', () => {
  assert.equal(effortCore.stripContextWindowSuffix('Gemini 4 Neon (High) · 1M'), 'Gemini 4 Neon (High)');
  assert.equal(effortCore.stripContextWindowSuffix('High · 200K'), 'High');
  assert.equal(effortCore.stripContextWindowSuffix('Gemini 4 Argon (Low) · 1M context'), 'Gemini 4 Argon (Low)');
  assert.equal(effortCore.stripContextWindowSuffix('Gemini 4 Argon (High)'), 'Gemini 4 Argon (High)');

  assert.deepEqual(effortCore.parseModelLabelEffort('Gemini 4 Neon (High Thinking)'), {
    base: 'Gemini 4 Neon',
    effort: 'high',
  });
  assert.deepEqual(effortCore.parseModelLabelEffort('Gemini 4 Neon (XHigh Thinking) · 1M'), {
    base: 'Gemini 4 Neon',
    effort: 'xhigh',
  });
  assert.deepEqual(effortCore.parseModelLabelEffort('Gemini 4 Neon Extra · 200K'), {
    base: 'Gemini 4 Neon',
    effort: 'xhigh',
  });
  assert.deepEqual(effortCore.parseModelLabelEffort('Claude Sonnet 4.5 (Medium) · 1M'), {
    base: 'Claude Sonnet 4.5',
    effort: 'medium',
  });

  const options = [
    { label: 'Gemini 4 Neon (Low Thinking)' },
    { label: 'Gemini 4 Neon (Medium Thinking)' },
    { label: 'Gemini 4 Neon (High Thinking)' },
    { label: 'Gemini 4 Neon (XHigh Thinking)' },
  ];
  const resolved = effortCore.resolveClaudeEffortSteps(options, 'Gemini 4 Neon (High Thinking) · 1M', '');
  assert.equal(resolved.baseName, 'Gemini 4 Neon');
  assert.deepEqual(
    resolved.steps.map((s) => s.id),
    ['low', 'medium', 'high', 'xhigh']
  );
  assert.equal(resolved.selectedIdx, 2);
});
