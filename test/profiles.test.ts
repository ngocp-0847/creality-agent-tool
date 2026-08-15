import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CrealityError } from '../src/errors.js';
import {
  PRINTER_PROFILES,
  SUPPORTED_MODELS,
  getProfile,
  normalizeModel,
} from '../src/profiles.js';
import { MUTATING_ACTIONS, isMutatingAction } from '../src/types.js';

describe('normalizeModel', () => {
  it('accepts the canonical spellings', () => {
    for (const model of SUPPORTED_MODELS) {
      assert.equal(normalizeModel(model), model);
    }
  });

  it('accepts loose operator spellings', () => {
    assert.equal(normalizeModel('K1'), 'k1');
    assert.equal(normalizeModel(' k1c '), 'k1c');
    assert.equal(normalizeModel('K1-C'), 'k1c');
    assert.equal(normalizeModel('K1 Max'), 'k1-max');
    assert.equal(normalizeModel('k1_max'), 'k1-max');
    assert.equal(normalizeModel('K1MAX'), 'k1-max');
    assert.equal(normalizeModel('K2 Plus'), 'k2');
    assert.equal(normalizeModel('k2plus'), 'k2');
    assert.equal(normalizeModel('Creality Hi Combo'), 'hi-combo');
    assert.equal(normalizeModel('Hi'), 'hi-combo');
  });

  it('rejects an unknown model with a listing of what is supported', () => {
    assert.throws(
      () => normalizeModel('ender3'),
      (error: unknown) => {
        assert.ok(CrealityError.is(error));
        assert.equal(error.code, 'CONFIG_INVALID');
        assert.match(error.message, /Supported: k1, k1c, k1-max, k2, hi-combo/);
        return true;
      },
    );
  });
});

describe('printer profiles', () => {
  it('describes every supported model', () => {
    assert.deepEqual([...SUPPORTED_MODELS].sort(), ['hi-combo', 'k1', 'k1-max', 'k1c', 'k2']);
  });

  it('keeps each profile internally consistent', () => {
    for (const model of SUPPORTED_MODELS) {
      const profile = getProfile(model);
      assert.equal(profile.model, model);
      assert.ok(profile.displayName.length > 0);
      assert.ok(profile.maxExtruderTempC > 0);
      assert.ok(profile.maxBedTempC > 0);
      assert.ok(profile.maxGcodeBytes > 0);
      for (const axis of ['x', 'y', 'z'] as const) {
        assert.ok(profile.buildVolumeMm[axis] > 0, `${model} ${axis} volume`);
      }
      // A chamber limit only makes sense on a machine that heats one.
      if (!profile.heatedChamber) {
        assert.equal(profile.maxChamberTempC, undefined);
      } else {
        assert.ok((profile.maxChamberTempC ?? 0) > 0);
      }
      assert.deepEqual([...profile.supportedActions], [...MUTATING_ACTIONS]);
      assert.ok(Array.isArray(profile.compatibilityNotes));
    }
  });

  it('models the K2 as the only heated-chamber machine', () => {
    assert.equal(PRINTER_PROFILES.k2.heatedChamber, true);
    assert.equal(PRINTER_PROFILES.k2.maxChamberTempC, 60);
    assert.equal(PRINTER_PROFILES.k1.heatedChamber, false);
    assert.equal(PRINTER_PROFILES.k1c.heatedChamber, false);
    assert.equal(PRINTER_PROFILES['k1-max'].heatedChamber, false);
    assert.equal(PRINTER_PROFILES['hi-combo'].heatedChamber, false);
  });

  it('uses the official Creality Hi Combo safety envelope', () => {
    const profile = PRINTER_PROFILES['hi-combo'];
    assert.deepEqual(profile.buildVolumeMm, { x: 260, y: 260, z: 300 });
    assert.equal(profile.maxExtruderTempC, 300);
    assert.equal(profile.maxBedTempC, 100);
    assert.equal(profile.maxChamberTempC, undefined);
    assert.match(profile.compatibilityNotes.join(' '), /CFS multicolor/i);
    assert.match(profile.compatibilityNotes.join(' '), /Moonraker/i);
  });

  it('gives the K1 Max a larger build volume than the K1', () => {
    assert.ok(PRINTER_PROFILES['k1-max'].buildVolumeMm.x > PRINTER_PROFILES.k1.buildVolumeMm.x);
  });
});

describe('isMutatingAction', () => {
  it('recognises every mutating action', () => {
    for (const action of MUTATING_ACTIONS) {
      assert.equal(isMutatingAction(action), true);
    }
  });

  it('rejects read-only and unknown names', () => {
    assert.equal(isMutatingAction('printer_status'), false);
    assert.equal(isMutatingAction('run_gcode_script'), false);
    assert.equal(isMutatingAction(''), false);
  });
});
