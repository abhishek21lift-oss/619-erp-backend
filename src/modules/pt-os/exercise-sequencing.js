'use strict';

function isPower(ex) {
  const cat = String(ex.category || '').toLowerCase();
  if (cat.includes('olympic') || cat.includes('powerlifting') || cat.includes('plyometric')) return true;
  const name = String(ex.name || '').toLowerCase();
  return /clean|snatch|jerk/.test(name);
}

function isCompound(ex) {
  return String(ex.mechanic || '').toLowerCase() === 'compound';
}

function isCardio(ex) {
  const cat = String(ex.category || '').toLowerCase();
  return cat.includes('cardio') || String(ex.movementPattern || '').toLowerCase() === 'locomotion';
}

function priority(ex) {
  if (isPower(ex)) return 10;
  if (isCompound(ex)) return 20;
  if (isCardio(ex)) return 60;
  return 50;
}

function phaseFor(ex) {
  if (isPower(ex)) return 'Power / High-Skill';
  if (isCompound(ex)) return 'Primary Compound';
  if (isCardio(ex)) return 'Conditioning';
  return 'Accessory / Isolation';
}

function sequenceWorkout(exercises) {
  const indexed = (exercises || []).map((e, i) => ({ e, i }));
  const sorted = [...indexed].sort((a, b) => {
    const la = a.e.locked ? 0 : 1;
    const lb = b.e.locked ? 0 : 1;
    if (la !== lb) return la - lb;
    if (a.e.locked && b.e.locked) return a.i - b.i;
    const pa = priority(a.e);
    const pb = priority(b.e);
    if (pa !== pb) return pa - pb;
    return a.i - b.i;
  });
  return sorted.map((item, idx) => {
    const ex = item.e;
    let reason = 'Accessory/isolation work placed later.';
    if (ex.locked) reason = 'Locked by trainer; order preserved.';
    else if (isPower(ex)) reason = 'Power/high-skill movement placed early while fresh.';
    else if (isCompound(ex)) reason = 'Compound movement before isolation work.';
    else if (isCardio(ex)) reason = 'Conditioning placed after resistance work.';
    return Object.assign({}, ex, { sequenceOrder: idx + 1, phase: phaseFor(ex), reason });
  });
}

function reorderExercises(exercises, fromIndex, toIndex) {
  const arr = [...(exercises || [])];
  const [moved] = arr.splice(fromIndex, 1);
  arr.splice(toIndex, 0, moved);
  return arr;
}

module.exports = { sequenceWorkout, reorderExercises, isPower, isCompound, isCardio, priority };
