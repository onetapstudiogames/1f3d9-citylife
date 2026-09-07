import assert from 'node:assert/strict';
import test from 'node:test';

import { Grid, DARK, toPlainText } from '../scripts/lib/grid.mjs';
import { paintPicker, updatePicker } from '../scripts/lib/follow-picker.mjs';

const residents = [
  { id: '4', handle: 'zeta' },
  { id: '2', handle: 'Beta' },
  { id: '1', handle: 'alpha' },
  { id: '3', handle: 'beta' },
];

test('updatePicker filters case-insensitively and wraps through sorted handles', () => {
  const typed = updatePicker({ query: '', index: 0 }, 'B', { name: 'b' }, residents);
  assert.deepEqual(typed, { picker: { query: 'B', index: 0 } });

  const down = updatePicker(typed.picker, undefined, { name: 'down' }, residents);
  assert.deepEqual(down, { picker: { query: 'B', index: 1 } });

  const wrappedDown = updatePicker(down.picker, undefined, { name: 'down' }, residents);
  assert.deepEqual(wrappedDown, { picker: { query: 'B', index: 0 } });

  const wrappedUp = updatePicker(wrappedDown.picker, undefined, { name: 'up' }, residents);
  assert.deepEqual(wrappedUp, { picker: { query: 'B', index: 1 } });

  const selected = updatePicker(wrappedUp.picker, '\r', { name: 'return' }, residents);
  assert.deepEqual(selected, { picker: { query: 'B', index: 1 }, handle: 'beta' });
});

test('updatePicker treats q and f as query text, removes a whole grapheme, and cancels on Escape', () => {
  const q = updatePicker({ query: '', index: 0 }, 'q', { name: 'q' }, residents);
  const f = updatePicker(q.picker, 'f', { name: 'f' }, residents);
  assert.equal(f.picker.query, 'qf');

  const emoji = updatePicker({ query: 'café', index: 7 }, undefined, { name: 'backspace' }, residents);
  assert.deepEqual(emoji, { picker: { query: 'caf', index: 0 } });

  const cancelled = updatePicker(f.picker, '\u001b', { name: 'escape' }, residents);
  assert.deepEqual(cancelled, { picker: { query: 'qf', index: 0 }, cancelled: true });
});

test('updatePicker keeps an empty result stable and ignores control input', () => {
  const empty = { query: 'nothing-here', index: 99 };
  assert.deepEqual(updatePicker(empty, undefined, { name: 'down' }, residents), {
    picker: { query: 'nothing-here', index: 0 },
  });
  assert.deepEqual(updatePicker(empty, '\r', { name: 'return' }, residents), {
    picker: { query: 'nothing-here', index: 0 },
  });
  assert.deepEqual(updatePicker({ query: '', index: 0 }, '\u001b[2J', {}, residents), {
    picker: { query: '', index: 0 },
  });
});

test('paintPicker clones the frame and paints a centered, scrolling picker at 80x24', () => {
  const frame = new Grid(80, 24, DARK.bg);
  frame.put(0, 0, 'city', DARK.ink);
  const before = structuredClone(frame.cells);
  const manyResidents = Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    handle: `resident-${String(index).padStart(2, '0')}`,
  }));

  const painted = paintPicker(frame, { query: 'resident', index: 18 }, manyResidents, 'resident-03');
  const plain = toPlainText(painted);

  assert.notEqual(painted, frame);
  assert.deepEqual(frame.cells, before);
  assert.equal(painted.width, 80);
  assert.equal(painted.height, 24);
  assert.match(plain, /Follow a resident/);
  assert.match(plain, /Filter: resident/);
  assert.match(plain, /resident-18/);
  assert.doesNotMatch(plain, /resident-00/);
  assert.ok(painted.cells.flat().some((cell) => cell[1] === DARK.hi));
});

test('paintPicker erases the old scene beneath every blank panel cell', () => {
  const frame = new Grid(80, 24, DARK.bg);
  for (let row = 0; row < frame.height; row += 1) {
    frame.put(0, row, 'X'.repeat(frame.width), DARK.ink, DARK.room, frame.width);
  }

  const painted = paintPicker(frame, { query: '', index: 0 }, residents);
  const blankInteriorRow = painted.cells[8].slice(21, 59);

  assert.ok(blankInteriorRow.every(([character, , background]) => character === ' ' && background === DARK.bubble));
});

test('paintPicker shows empty matches and clips unsafe Unicode through Grid.put', () => {
  const frame = new Grid(17, 7, DARK.bg);
  const painted = paintPicker(
    frame,
    { query: '\u001b[2J猫✨abcdefghijklmnopqrstuvwxyz', index: 12 },
    [{ id: '1', handle: 'bad\nname\u001b[31m旗🇺🇸' }],
  );

  assert.equal(painted.width, 17);
  assert.equal(painted.height, 7);
  assert.ok(painted.cells.every((row) => row.length === 17));
  const paintedCharacters = painted.cells.flat().map(([character]) => character).join('');
  assert.doesNotMatch(paintedCharacters, /[\u0000-\u001f\u007f-\u009f]/u);
});

test('paintPicker stays within zero and tiny frames', () => {
  for (const [width, height] of [[0, 0], [1, 1], [2, 2], [5, 3]]) {
    const frame = new Grid(width, height, DARK.bg);
    const painted = paintPicker(frame, { query: '猫✨', index: 2 }, residents, 'alpha');
    assert.equal(painted.width, width);
    assert.equal(painted.height, height);
    assert.equal(painted.cells.length, height);
    assert.ok(painted.cells.every((row) => row.length === width));
  }
});
