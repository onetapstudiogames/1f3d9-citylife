import { DARK, Grid } from './grid.mjs';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const unsafeText = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const normalizedText = (value) => String(value ?? '').normalize('NFC');

const publicResidents = (residents) => (Array.isArray(residents) ? residents : [])
  .map((resident, order) => {
    if (
      resident === null
      || typeof resident !== 'object'
      || !Object.hasOwn(resident, 'id')
      || !Object.hasOwn(resident, 'handle')
    ) return null;
    const handle = normalizedText(resident.handle);
    if (handle.length === 0) return null;
    return { id: resident.id, handle, foldedHandle: handle.toLowerCase(), order };
  })
  .filter(Boolean)
  .sort((left, right) => {
    if (left.foldedHandle < right.foldedHandle) return -1;
    if (left.foldedHandle > right.foldedHandle) return 1;
    return left.order - right.order;
  });

const pickerState = (picker) => ({
  query: normalizedText(picker?.query),
  index: Number.isFinite(picker?.index) ? Math.trunc(picker.index) : 0,
});

const matchingResidents = (residents, query) => {
  const foldedQuery = normalizedText(query).toLowerCase();
  return publicResidents(residents).filter(({ foldedHandle }) => foldedHandle.includes(foldedQuery));
};

const boundedIndex = (index, length) => {
  if (length === 0) return 0;
  return ((index % length) + length) % length;
};

const removeLastGrapheme = (value) => {
  const segments = [...graphemeSegmenter.segment(value)];
  return segments.slice(0, -1).map(({ segment }) => segment).join('');
};

const isPrintable = (text, key) => (
  typeof text === 'string'
  && text.length > 0
  && !key?.ctrl
  && !key?.meta
  && !unsafeText.test(text)
);

/** Update the pure resident-picker state for one readline key event. */
export const updatePicker = (picker, text, key = {}, residents = []) => {
  const state = pickerState(picker);
  const matches = matchingResidents(residents, state.query);
  const current = { ...state, index: boundedIndex(state.index, matches.length) };

  if (key.name === 'escape') return { picker: current, cancelled: true };

  if (key.name === 'return' || key.name === 'enter') {
    const selected = matches[current.index];
    return selected ? { picker: current, handle: selected.handle } : { picker: current };
  }

  if (key.name === 'backspace') {
    return { picker: { query: removeLastGrapheme(state.query), index: 0 } };
  }

  if (key.name === 'up' || key.name === 'down') {
    const movement = key.name === 'up' ? -1 : 1;
    return { picker: { ...current, index: boundedIndex(current.index + movement, matches.length) } };
  }

  if (isPrintable(text, key)) {
    return { picker: { query: normalizedText(`${state.query}${text}`), index: 0 } };
  }

  return { picker: current };
};

const cloneGrid = (frame) => {
  const clone = new Grid(frame?.width, frame?.height, DARK.bg);
  for (let row = 0; row < clone.height; row += 1) {
    for (let column = 0; column < clone.width; column += 1) {
      const cell = frame?.cells?.[row]?.[column];
      if (Array.isArray(cell)) clone.cells[row][column] = cell.slice(0, 3);
    }
  }
  return clone;
};

const overlaySize = (size, preferred, roomyThreshold) => {
  if (size < roomyThreshold) return size;
  return Math.min(preferred, size - 2);
};

/** Paint a resident picker onto a cloned frame without writing to the terminal. */
export const paintPicker = (frame, picker, residents = [], currentHandle) => {
  const grid = cloneGrid(frame);
  if (grid.width === 0 || grid.height === 0) return grid;

  const state = pickerState(picker);
  const matches = matchingResidents(residents, state.query);
  const selectedIndex = boundedIndex(state.index, matches.length);
  const overlayWidth = overlaySize(grid.width, 40, 20);
  const overlayHeight = overlaySize(grid.height, 12, 10);
  const left = Math.floor((grid.width - overlayWidth) / 2);
  const top = Math.floor((grid.height - overlayHeight) / 2);
  const hasBorder = overlayWidth >= 3 && overlayHeight >= 3;
  const inset = hasBorder ? 1 : 0;
  const contentLeft = left + inset;
  const contentTop = top + inset;
  const contentWidth = Math.max(0, overlayWidth - (inset * 2));
  const contentHeight = Math.max(0, overlayHeight - (inset * 2));

  const blankPanelRow = ' '.repeat(overlayWidth);
  for (let row = top; row < top + overlayHeight; row += 1) {
    grid.put(left, row, blankPanelRow, null, DARK.bubble, overlayWidth);
  }
  if (hasBorder) {
    const horizontal = '─'.repeat(overlayWidth - 2);
    grid.put(left, top, `┌${horizontal}┐`, DARK.line, DARK.bubble, overlayWidth);
    grid.put(left, top + overlayHeight - 1, `└${horizontal}┘`, DARK.line, DARK.bubble, overlayWidth);
    for (let row = top + 1; row < top + overlayHeight - 1; row += 1) {
      grid.put(left, row, '│', DARK.line, DARK.bubble, 1);
      grid.put(left + overlayWidth - 1, row, '│', DARK.line, DARK.bubble, 1);
    }
  }

  if (contentHeight === 0 || contentWidth === 0) return grid;
  grid.put(contentLeft, contentTop, 'Follow a resident', DARK.hi, DARK.bubble, contentWidth);

  const filterRow = contentTop + (contentHeight >= 3 ? 2 : 1);
  if (filterRow < contentTop + contentHeight) {
    grid.put(contentLeft, filterRow, `Filter: ${state.query}`, DARK.ink, DARK.bubble, contentWidth);
  }

  const listTop = filterRow + (contentHeight >= 5 ? 2 : 1);
  const visibleRows = Math.max(0, (contentTop + contentHeight) - listTop);
  if (visibleRows === 0) return grid;

  if (matches.length === 0) {
    grid.put(contentLeft, listTop, 'No matches', DARK.muted, DARK.bubble, contentWidth);
    return grid;
  }

  const firstVisible = Math.min(
    Math.max(0, selectedIndex - Math.floor(visibleRows / 2)),
    Math.max(0, matches.length - visibleRows),
  );
  for (let offset = 0; offset < visibleRows && firstVisible + offset < matches.length; offset += 1) {
    const resident = matches[firstVisible + offset];
    const selected = firstVisible + offset === selectedIndex;
    const current = resident.handle === currentHandle;
    const marker = selected ? '›' : current ? '•' : ' ';
    const foreground = selected ? DARK.hi : current ? DARK.ink : DARK.muted;
    grid.put(contentLeft, listTop + offset, `${marker} ${resident.handle}`, foreground, DARK.bubble, contentWidth);
  }

  return grid;
};
