// Validation for the Super Helper level grids. A typo in a level string —
// a ragged row, a second start, a forgotten finish — should fail here, in
// node, not surface as a black canvas after somebody finds the egg.

import test from "node:test";
import assert from "node:assert/strict";
import { LEVELS, ROWS } from "./superHelperLevels.js";

test("there are ten shifts", () => {
  assert.equal(LEVELS.length, 10);
});

for (let i = 0; i < LEVELS.length; i++) {
  const grid = LEVELS[i];
  const n = i + 1;
  const all = grid.join("");

  test(`level ${n} is a rectangle of the right height`, () => {
    assert.equal(grid.length, ROWS);
    const w = grid[0].length;
    for (const row of grid) assert.equal(row.length, w, "ragged row");
    assert.ok(w >= 20, "narrower than one screen");
  });

  test(`level ${n} has exactly one start and one finish`, () => {
    assert.equal([...all].filter(c => c === "S").length, 1);
    assert.equal([...all].filter(c => c === "F").length, 1);
  });

  test(`level ${n} uses only known tiles`, () => {
    assert.ok(/^[.#=o^SEFWB]+$/.test(all), "unknown tile character");
  });

  test(`level ${n} starts on solid ground`, () => {
    const r = grid.findIndex(row => row.includes("S"));
    const c = grid[r].indexOf("S");
    const below = grid[r + 1] && grid[r + 1][c];
    assert.ok(below === "#" || below === "=", "start would fall into nothing");
  });

  test(`level ${n} keeps every gap jumpable`, () => {
    // The physics clears about five tiles of flat gap; pits stay at three
    // or less so nobody needs a perfect take-off. A pit is a run of
    // bottom-row emptiness.
    const bottom = grid[ROWS - 1];
    let widest = 0, run = 0;
    for (const ch of bottom) {
      run = ch === "#" ? 0 : run + 1;
      widest = Math.max(widest, run);
    }
    assert.ok(widest <= 3, `a ${widest}-tile pit cannot be jumped`);
  });

  test(`level ${n} gives the sign something to stand on`, () => {
    // The sign is the last obstacle and stands at a different height each
    // shift — but whatever the height, there must be footing at it, or
    // the level cannot be completed at all.
    const r = grid.findIndex(row => row.includes("F"));
    const c = grid[r].indexOf("F");
    const under = [grid[r + 1]?.[c], grid[r + 1]?.[c - 1], grid[r + 1]?.[c + 1], grid[r + 2]?.[c]];
    assert.ok(under.some(ch => ch === "#" || ch === "="), "the sign floats");
  });

  test(`level ${n} puts sparks on something solid`, () => {
    // A spark cell with air under it would hang mid-sky and read as a
    // rendering bug rather than a hazard.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        if (grid[r][c] !== "^") continue;
        const below = r + 1 < ROWS ? grid[r + 1][c] : "#";
        assert.ok(below === "#", `sparks floating at row ${r} col ${c}`);
      }
    }
  });
}
