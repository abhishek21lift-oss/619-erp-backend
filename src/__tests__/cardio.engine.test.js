process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
const cardio = require('../modules/pt-os/cardio');

describe('Case A: K11 intensity bands use %MHR', () => {
  test('age 40 -> MHR 180 -> 90-108 / 108-126 / 126-153 / 153-180', () => {
    const resolved = cardio.resolveHeartRateInputs({ age: 40, restingHeartRate: 60 });
    expect(resolved.errors).toEqual([]);
    expect(resolved.value.maxHeartRate).toBe(180);
    expect(resolved.value.maxHeartRateSource).toBe('estimated');

    const ranges = cardio.K11_INTENSITY_BANDS.map((band) => (
      cardio.calcTargetRangeForBand({
        maxHeartRate: 180,
        restingHeartRate: 60,
        method: 'mhr',
        intensity: band.key,
      })
    ));
    expect(ranges.map((r) => [r.minBpm, r.maxBpm])).toEqual([
      [90, 108],
      [108, 126],
      [126, 153],
      [153, 180],
    ]);
    expect(ranges.every((r) => r.basisLabel === '% MHR')).toBe(true);
  });

  test('MHR method does not include resting heart rate', () => {
    expect(cardio.calcMhrTargetHeartRate(180, 0.7)).toBe(126);
    expect(cardio.calcMhrTargetHeartRate(180, 0.7)).not.toBe(
      cardio.calcTargetHeartRate(180, 60, 0.7),
    );
  });
});

describe('Case B: Karvonen uses %HRR', () => {
  test('MHR 180, RHR 60 -> 108/120/132/144/156/162/168', () => {
    const fractions = [0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9];
    expect(fractions.map((f) => cardio.calcTargetHeartRate(180, 60, f))).toEqual([
      108, 120, 132, 144, 156, 162, 168,
    ]);
    expect(cardio.calcHrr(180, 60)).toBe(120);
  });
});

describe('Case C: canonical five-phase template', () => {
  test('5@40 + 3@50 + 20@70 + 5@40 + 5@30 = 38 min and targets 108/120/144/108/96', () => {
    expect(cardio.FIVE_PHASE_DEFAULTS.map((p) => [p.durationMinutes, p.intensityFraction])).toEqual([
      [5, 0.4],
      [3, 0.5],
      [20, 0.7],
      [5, 0.4],
      [5, 0.3],
    ]);
    expect(cardio.FIVE_PHASE_CARDIO_TOTAL_MINUTES).toBe(38);

    const session = cardio.buildFivePhaseCardio(180, 60);
    expect(session.totalMinutes).toBe(38);
    expect(session.phases.map((p) => p.targetHeartRate)).toEqual([108, 120, 144, 108, 96]);
  });

  test('editing one phase changes the total and keeps targets coherent', () => {
    const session = cardio.buildFivePhaseCardio(180, 60, {
      work: { durationMinutes: 30, intensityFraction: 0.8 },
    });
    expect(session.totalMinutes).toBe(48);
    expect(session.phases[2].targetHeartRate).toBe(156);
  });

  test('legacy name-keyed overrides still work', () => {
    const session = cardio.buildFivePhaseCardio(180, 60, {
      'Main work': { durationMinutes: 25 },
    });
    expect(session.totalMinutes).toBe(43);
  });
});

describe('Case D: valid boundaries accepted', () => {
  test('age 1 and 120 accepted; 0, 121, decimals, NaN and infinity rejected', () => {
    expect(cardio.validateAge(1)).toBeNull();
    expect(cardio.validateAge(120)).toBeNull();
    expect(cardio.validateAge(0)).toBeTruthy();
    expect(cardio.validateAge(121)).toBeTruthy();
    expect(cardio.validateAge(40.5)).toBeTruthy();
    expect(cardio.validateAge(Number.NaN)).toBeTruthy();
    expect(cardio.validateAge(Number.POSITIVE_INFINITY)).toBeTruthy();
  });

  test('heart-rate pair and reserve validation', () => {
    expect(cardio.validateRestingHeartRate(1)).toBeNull();
    expect(cardio.validateRestingHeartRate(0)).toBeTruthy();
    expect(cardio.validateRestingHeartRate(-1)).toBeTruthy();
    expect(cardio.validateRestingHeartRate(Number.NaN)).toBeTruthy();
    expect(cardio.validateMeasuredMaxHeartRate(181, 60)).toBeNull();
    expect(cardio.validateMeasuredMaxHeartRate(60, 60)).toBeTruthy();
    expect(cardio.validateMeasuredMaxHeartRate(59, 60)).toBeTruthy();
    expect(cardio.calcHrr(180, 60)).toBe(120);
    expect(cardio.calcHrr(60, 60)).toBeNull();
    expect(cardio.calcHrr(59, 60)).toBeNull();
  });

  test('intensity 0 and 1 accepted, outside rejected', () => {
    expect(cardio.validateIntensityFraction(0)).toBeNull();
    expect(cardio.validateIntensityFraction(1)).toBeNull();
    expect(cardio.validateIntensityFraction(-0.01)).toBeTruthy();
    expect(cardio.validateIntensityFraction(1.01)).toBeTruthy();
    expect(cardio.validateIntensityFraction(Number.NaN)).toBeTruthy();
    expect(cardio.validateIntensityFraction(Number.POSITIVE_INFINITY)).toBeTruthy();
  });

  test('frequency and main-work boundaries accepted, invalid values rejected', () => {
    expect(cardio.validateFrequencyPerWeek(1)).toBeNull();
    expect(cardio.validateFrequencyPerWeek(14)).toBeNull();
    expect(cardio.validateFrequencyPerWeek(0)).toBeTruthy();
    expect(cardio.validateFrequencyPerWeek(15)).toBeTruthy();
    expect(cardio.validateFrequencyPerWeek(3.5)).toBeTruthy();
    expect(cardio.validateMainWorkMinutes(5)).toBeNull();
    expect(cardio.validateMainWorkMinutes(180)).toBeNull();
    expect(cardio.validateMainWorkMinutes(4)).toBeTruthy();
    expect(cardio.validateMainWorkMinutes(181)).toBeTruthy();
    expect(cardio.validateMainWorkMinutes(30.5)).toBeTruthy();
  });

  test('progression phase boundaries are inclusive and outside values are rejected', () => {
    const base = { frequencyPerWeek: 3, minutesPerSession: 30, maxHeartRate: 180, restingHeartRate: 60 };
    expect(cardio.buildProgressionPrescription({ ...base, phase: 'initial', intensityFraction: 0.4 }).errors).toEqual([]);
    expect(cardio.buildProgressionPrescription({ ...base, phase: 'initial', intensityFraction: 0.6 }).errors).toEqual([]);
    expect(cardio.buildProgressionPrescription({ ...base, phase: 'improvement', intensityFraction: 0.6 }).errors).toEqual([]);
    expect(cardio.buildProgressionPrescription({ ...base, phase: 'improvement', intensityFraction: 0.8 }).errors).toEqual([]);
    expect(cardio.buildProgressionPrescription({ ...base, phase: 'maintenance', intensityFraction: 0.8 }).errors).toEqual([]);
    expect(cardio.buildProgressionPrescription({ ...base, phase: 'maintenance', intensityFraction: 0.9 }).errors).toEqual([]);

    expect(cardio.buildProgressionPrescription({ ...base, phase: 'initial', intensityFraction: 0.39 }).value).toBeNull();
    expect(cardio.buildProgressionPrescription({ ...base, phase: 'initial', intensityFraction: 0.61 }).value).toBeNull();
    expect(cardio.buildProgressionPrescription({ ...base, phase: 'improvement', intensityFraction: 0.59 }).value).toBeNull();
    expect(cardio.buildProgressionPrescription({ ...base, phase: 'maintenance', intensityFraction: 0.91 }).value).toBeNull();
  });

  test('phase reference table matches the supplied K11 values and maintenance has no invented defaults', () => {
    expect(cardio.K11_PROGRESSION_PHASES.map((p) => ({
      key: p.key,
      weeks: [p.durationWeeks.min, p.durationWeeks.max],
      hrr: [p.intensityHrr.min, p.intensityHrr.max],
      days: p.frequencyDays ? [p.frequencyDays.min, p.frequencyDays.max] : null,
      minutes: p.minutes ? [p.minutes.min, p.minutes.max] : null,
    }))).toEqual([
      { key: 'initial', weeks: [4, 8], hrr: [0.4, 0.6], days: [3, 5], minutes: [20, 40] },
      { key: 'improvement', weeks: [8, 20], hrr: [0.6, 0.8], days: [3, 6], minutes: [45, 60] },
      { key: 'maintenance', weeks: [24, 50], hrr: [0.8, 0.9], days: null, minutes: null },
    ]);
  });
});

describe('MHR estimation and source selection', () => {
  test('220 - age only when measured MHR is absent', () => {
    expect(cardio.estimateMaxHeartRate(40)).toBe(180);
    const estimated = cardio.resolveHeartRateInputs({ age: 40, restingHeartRate: 60 });
    expect(estimated.value.maxHeartRateSource).toBe('estimated');
    expect(estimated.value.estimatedMaxHeartRate).toBe(180);
  });

  test('measured MHR wins and is never overwritten by the estimate', () => {
    const resolved = cardio.resolveHeartRateInputs({
      age: 40,
      measuredMaxHeartRate: 200,
      restingHeartRate: 60,
    });
    expect(resolved.value.maxHeartRate).toBe(200);
    expect(resolved.value.maxHeartRateSource).toBe('measured');
    expect(resolved.value.estimatedMaxHeartRate).toBe(180);
  });

  test('missing age and measured MHR is an error', () => {
    const resolved = cardio.resolveHeartRateInputs({ restingHeartRate: 60 });
    expect(resolved.value).toBeNull();
    expect(resolved.errors.join(' ')).toMatch(/age|measured/i);
  });
});

describe('FITT prescription', () => {
  const base = {
    maxHeartRate: 180,
    restingHeartRate: 60,
    method: 'karvonen',
    intensity: 'high',
    frequencyPerWeek: 4,
    mainWorkMinutes: 45,
    modality: 'Rowing',
    programType: 'hiit',
  };

  test('produces frequency, intensity, time, category and programme', () => {
    const result = cardio.buildFittPrescription(base);
    expect(result.errors).toEqual([]);
    expect(result.value.frequencyPerWeek).toBe(4);
    expect(result.value.intensity.key).toBe('high');
    expect(result.value.targetHeartRate).toEqual({
      minBpm: 144,
      maxBpm: 162,
      minFraction: 0.7,
      maxFraction: 0.85,
      method: 'karvonen',
      basisLabel: '% HRR',
    });
    expect(result.value.mainWorkMinutes).toBe(45);
    expect(result.value.modalityCategory).toBe('non-weight-bearing');
    expect(result.value.programType).toBe('hiit');
  });

  test('outside the FITT reference warns but is still valid', () => {
    const result = cardio.buildFittPrescription({
      ...base,
      frequencyPerWeek: 6,
      mainWorkMinutes: 80,
    });
    expect(result.value).not.toBeNull();
    expect(result.value.warnings.join(' ')).toMatch(/6 sessions\/week/);
    expect(result.value.warnings.join(' ')).toMatch(/80 min/);
  });

  test('unknown modality stays unclassified instead of being forced', () => {
    const result = cardio.buildFittPrescription({ ...base, modality: 'Mystery machine' });
    expect(result.value.modalityCategory).toBeNull();
    expect(result.value.warnings.join(' ')).toMatch(/unclassified/i);
    expect(cardio.classifyCardioModality('Running')).toBe('weight-bearing-high-impact');
    expect(cardio.classifyCardioModality('Elliptical')).toBe('weight-bearing-low-impact');
    expect(cardio.classifyCardioModality('Cycling')).toBe('non-weight-bearing');
    expect(cardio.classifyCardioModality('Mystery machine')).toBeNull();
  });

  test('invalid frequency, time, programme and blank modality are rejected', () => {
    expect(cardio.buildFittPrescription({ ...base, frequencyPerWeek: 0 }).value).toBeNull();
    expect(cardio.buildFittPrescription({ ...base, mainWorkMinutes: 4 }).value).toBeNull();
    expect(cardio.buildFittPrescription({ ...base, programType: 'sprint' }).value).toBeNull();
    expect(cardio.buildFittPrescription({ ...base, modality: '   ' }).value).toBeNull();
  });

  test('modality is limited to the frontend boundary of 80 characters', () => {
    expect(cardio.buildFittPrescription({ ...base, modality: 'x'.repeat(80) }).value).not.toBeNull();
    const tooLong = cardio.buildFittPrescription({ ...base, modality: 'x'.repeat(81) });
    expect(tooLong.value).toBeNull();
    expect(tooLong.errors.join(' ')).toMatch(/80 characters or fewer/);
  });
});

describe('plan config persistence and validation', () => {
  function validConfig() {
    const fitt = cardio.buildFittPrescription({
      maxHeartRate: 180,
      restingHeartRate: 60,
      method: 'mhr',
      intensity: 'high',
      frequencyPerWeek: 4,
      mainWorkMinutes: 30,
      modality: 'Running',
      programType: 'fartlek',
    });
    return cardio.toCardioPlanConfig({
      method: 'mhr',
      intensity: 'high',
      targetHeartRate: fitt.value.targetHeartRate,
      frequencyPerWeek: fitt.value.frequencyPerWeek,
      mainWorkMinutes: fitt.value.mainWorkMinutes,
      modality: fitt.value.modality,
      modalityCategory: fitt.value.modalityCategory,
      programType: fitt.value.programType,
      goal: 'endurance',
      progression: {
        phase: 'initial',
        intensityPercent: 50,
        frequencyPerWeek: 3,
        minutesPerSession: 30,
      },
    });
  }

  test('flat config keeps min/max authoritative and target as midpoint', () => {
    expect(validConfig()).toMatchObject({
      cardio_source: 'k11',
      target_heart_rate_min: 126,
      target_heart_rate_max: 153,
      target_heart_rate: 140,
      target_heart_rate_basis: '% MHR',
      cardio_method: 'mhr',
      cardio_intensity: 'high',
      cardio_frequency_per_week: 4,
      cardio_main_work_minutes: 30,
      cardio_modality: 'Running',
      cardio_modality_category: 'weight-bearing-high-impact',
      cardio_program_type: 'fartlek',
      cardio_goal: 'endurance',
      cardio_progression_phase: 'initial',
      cardio_progression_intensity_percent: 50,
    });
  });

  test('a config with no cardio_source is legacy and passes untouched', () => {
    expect(cardio.validateCardioPlanConfig({ duration_seconds: 60 })).toEqual({ ok: true, errors: [] });
    expect(cardio.validateCardioPlanConfig(null)).toEqual({ ok: true, errors: [] });
  });

  test('rejects decimals, NaN, infinity, negatives and out-of-band values', () => {
    const bads = [
      { target_heart_rate: 140.5 },
      { target_heart_rate: Number.NaN },
      { target_heart_rate: Number.POSITIVE_INFINITY },
      { target_heart_rate: -1 },
      { target_heart_rate_min: 0 },
      { target_heart_rate_max: 0 },
      { target_heart_rate_min: 160, target_heart_rate_max: 150 },
      { target_heart_rate: 200 },
      { target_heart_rate_basis: '% VO2' },
      { target_heart_rate_basis: '% HRR' },
      { cardio_method: 'estimated' },
      { cardio_intensity: 'max' },
      { cardio_frequency_per_week: 0 },
      { cardio_frequency_per_week: 15 },
      { cardio_frequency_per_week: 3.5 },
      { cardio_main_work_minutes: 4 },
      { cardio_main_work_minutes: 181 },
      { cardio_main_work_minutes: 30.5 },
      { cardio_modality: '' },
      { cardio_modality: 'x'.repeat(81) },
      { cardio_modality_category: 'aquatic' },
      { cardio_modality_category: 'non-weight-bearing' },
      { cardio_modality: 'Rowing', cardio_modality_category: 'weight-bearing-high-impact' },
      { cardio_modality: 'Rowing', cardio_modality_category: null },
      { cardio_program_type: 'sprint' },
      { cardio_progression_phase: 'peak' },
      { cardio_progression_intensity_percent: -1 },
      { cardio_progression_intensity_percent: 101 },
      { cardio_progression_phase: 'initial', cardio_progression_intensity_percent: 70 },
      { cardio_progression_phase: 'maintenance', cardio_progression_intensity_percent: 60 },
      { cardio_progression_phase: 'initial', cardio_progression_intensity_percent: null },
      { cardio_progression_phase: null, cardio_progression_intensity_percent: 50 },
    ];

    for (const patch of bads) {
      const result = cardio.validateCardioPlanConfig({ ...validConfig(), ...patch });
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test('accepts the valid config and matching method/basis pairs', () => {
    expect(cardio.validateCardioPlanConfig(validConfig())).toEqual({ ok: true, errors: [] });
    expect(cardio.validateCardioPlanConfig({
      ...validConfig(),
      cardio_method: 'karvonen',
      target_heart_rate_basis: '% HRR',
    })).toEqual({ ok: true, errors: [] });
  });

  test('keeps an unclassified modality unclassified', () => {
    expect(cardio.validateCardioPlanConfig({
      ...validConfig(),
      cardio_modality: 'Sled push',
      cardio_modality_category: null,
    })).toEqual({ ok: true, errors: [] });
  });

  test('accepts the progression phase boundaries and rejects a lone field', () => {
    const boundaries = [
      ['initial', 40],
      ['initial', 60],
      ['improvement', 60],
      ['improvement', 80],
      ['maintenance', 80],
      ['maintenance', 90],
    ];
    for (const [phase, percent] of boundaries) {
      expect(cardio.validateCardioPlanConfig({
        ...validConfig(),
        cardio_progression_phase: phase,
        cardio_progression_intensity_percent: percent,
      })).toEqual({ ok: true, errors: [] });
    }
  });

  test('rejects a non-object config that claims a cardio source', () => {
    expect(cardio.validateCardioPlanConfig('k11').ok).toBe(false);
    expect(cardio.validateCardioPlanConfig([]).ok).toBe(false);
  });
});

describe('session builder validation', () => {
  test('rejects decimal, negative and out-of-range phase values', () => {
    expect(cardio.buildCardioSession(180, 60, [{ name: 'Work', durationMinutes: 20.5 }])).toBeNull();
    expect(cardio.buildCardioSession(180, 60, [{ name: 'Work', durationMinutes: -1 }])).toBeNull();
    expect(cardio.buildCardioSession(180, 60, [{ name: 'Work', durationMinutes: 20, intensityFraction: 1.2 }])).toBeNull();
  });

  test('formats whole percentages only', () => {
    expect(cardio.formatIntensityPercent(0.7)).toBe('70%');
    expect(cardio.formatIntensityPercent(0.85)).toBe('85%');
  });
});
