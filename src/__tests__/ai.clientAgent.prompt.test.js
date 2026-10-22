'use strict';
// prompt pure-function contract tests.

const { systemPrompt } = require('../lib/ai/agent/prompt');

describe('systemPrompt', () => {
  test('names the client from the ERP', () => {
    const prompt = systemPrompt({ clientName: 'Alice Sharma', toolsRun: [], toolsFailed: [] });
    expect(prompt).toContain('Alice Sharma');
    expect(prompt).toContain('ONE client: Alice Sharma');
  });

  test('lists tools that ran', () => {
    const prompt = systemPrompt({
      clientName: 'Bob',
      toolsRun: ['getClientProfile', 'getClientAttendance'],
      toolsFailed: [],
    });
    expect(prompt).toContain('Data retrieved for this question: getClientProfile, getClientAttendance.');
  });

  test('lists tools that failed', () => {
    const prompt = systemPrompt({
      clientName: 'Bob',
      toolsRun: ['getClientProfile'],
      toolsFailed: ['getClientAttendance', 'getClientPayments'],
    });
    expect(prompt).toContain('These could not be retrieved: getClientAttendance, getClientPayments.');
    expect(prompt).toContain('Say so if the question depended on them. Do not guess at what they would have contained.');
  });

  test('instructs "no data" honestly when no tools ran', () => {
    const prompt = systemPrompt({ clientName: 'Carol', toolsRun: [], toolsFailed: [] });
    expect(prompt).toContain('No data could be retrieved for this question. Say that plainly rather than answering from general knowledge.');
  });

  test('includes medical boundary', () => {
    const prompt = systemPrompt({ clientName: 'Dave', toolsRun: [], toolsFailed: [] });
    expect(prompt).toContain('MEDICAL BOUNDARY.');
    expect(prompt).toContain('You are not a clinician.');
    expect(prompt).toContain('Report recorded injuries, PAR-Q answers and limitations as written');
    expect(prompt).toContain('recommend the trainer seeks qualified medical advice');
    expect(prompt).toContain('Do not diagnose or prescribe treatment');
  });

  test('includes grounding duty', () => {
    const prompt = systemPrompt({ clientName: 'Eve', toolsRun: [], toolsFailed: [] });
    expect(prompt).toContain('GROUNDING — this is your first duty.');
    expect(prompt).toContain('Every factual claim you make must come from the retrieved data');
    expect(prompt).toContain('database is the source of truth');
    expect(prompt).toContain('If the data does not contain something, say so plainly');
    expect(prompt).toContain("I don't have a recent recorded weight for this client");
  });

  test('includes scope restriction to one client', () => {
    const prompt = systemPrompt({ clientName: 'Frank', toolsRun: [], toolsFailed: [] });
    expect(prompt).toContain('SCOPE.');
    expect(prompt).toContain('Answer only about Frank');
    expect(prompt).toContain('no access to other clients');
    expect(prompt).toContain('covers one client at a time');
  });

  test('includes read-only constraint', () => {
    const prompt = systemPrompt({ clientName: 'Grace', toolsRun: [], toolsFailed: [] });
    expect(prompt).toContain('YOU CANNOT CHANGE ANYTHING.');
    expect(prompt).toContain('read-only access');
    expect(prompt).toContain('cannot create, edit or delete records');
    expect(prompt).toContain('Never imply an action has been taken');
  });

  test('includes style guidance', () => {
    const prompt = systemPrompt({ clientName: 'Henry', toolsRun: [], toolsFailed: [] });
    expect(prompt).toContain('STYLE.');
    expect(prompt).toContain('Lead with the answer');
    expect(prompt).toContain('Be specific and brief');
    expect(prompt).toContain('Use figures and dates from the data');
    expect(prompt).toContain('Do not open with pleasantries');
    expect(prompt).toContain('No emoji');
  });

  test('includes fact/interpretation/recommendation separation', () => {
    const prompt = systemPrompt({ clientName: 'Iris', toolsRun: [], toolsFailed: [] });
    expect(prompt).toContain('SEPARATE WHAT YOU KNOW FROM WHAT YOU THINK.');
    expect(prompt).toContain('FACT — what the data says');
    expect(prompt).toContain('INTERPRETATION — what you read into it');
    expect(prompt).toContain('RECOMMENDATION — what you suggest doing');
    expect(prompt).toContain('Never present an interpretation as though the database stated it');
  });

  test('combines all sections when toolsRun, toolsFailed, and no data all apply', () => {
    const prompt = systemPrompt({
      clientName: 'Jack',
      toolsRun: ['getClientSummary'],
      toolsFailed: ['getClientAttendance'],
    });
    // Should have both toolsRun and toolsFailed sections
    expect(prompt).toContain('Data retrieved for this question: getClientSummary.');
    expect(prompt).toContain('These could not be retrieved: getClientAttendance.');
    // Should NOT have the "no data" message since toolsRun has entries
    expect(prompt).not.toContain('No data could be retrieved for this question');
  });

  test('handles empty arrays gracefully', () => {
    const prompt = systemPrompt({ clientName: 'Test', toolsRun: [], toolsFailed: [] });
    expect(prompt).toContain('Test');
    expect(prompt).not.toContain('Data retrieved');
    expect(prompt).not.toContain('could not be retrieved');
    expect(prompt).toContain('No data could be retrieved');
  });
});