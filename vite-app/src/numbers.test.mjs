// Tests for how a typed number is read.
//
// Run with: node --test src/numbers.test.mjs
//
// NumField deliberately lets a comma through — "1,5" is one and a half on
// half the world's keyboards — and nonNegative used to read the FIRST comma
// as the decimal point. On this crew's keyboards a comma before three
// trailing digits is a thousands separator, so "1,200" became 1.2 and a
// $1,200 day rate was published as $1.20 with nothing anywhere saying so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nonNegative, decimalString } from "./data.js";

test("a decimal comma is a decimal point", () => {
  assert.equal(nonNegative("1,5"), 1.5);
  assert.equal(nonNegative("2,25"), 2.25);
  assert.equal(nonNegative("0,5"), 0.5);
});

test("a comma before three trailing digits is a thousands separator", () => {
  assert.equal(nonNegative("1,200"), 1200);
  assert.equal(nonNegative("12,500"), 12500);
  assert.equal(nonNegative("1,234,567"), 1234567);
});

test("with both marks present the last one is the decimal point", () => {
  assert.equal(nonNegative("1,234.50"), 1234.5);
  assert.equal(nonNegative("1.234,50"), 1234.5);
});

test("plain numbers pass through untouched", () => {
  assert.equal(nonNegative("8"), 8);
  assert.equal(nonNegative("8.5"), 8.5);
  assert.equal(nonNegative(8.5), 8.5);
  assert.equal(decimalString("1200"), "1200");
});

test("nothing, rubbish and negatives floor to zero", () => {
  assert.equal(nonNegative(""), 0);
  assert.equal(nonNegative("abc"), 0);
  assert.equal(nonNegative("-4"), 0);
  assert.equal(nonNegative(null), 0);
});
