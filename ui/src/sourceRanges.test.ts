import { expect, it } from "vitest";
import { verifySourceRange } from "./sourceRanges";

it("uses locator positions to distinguish repeated text and verifies the exact body", () => {
  const text = "Repeated words\nDifferent words\nRepeated words";
  expect(
    verifySourceRange(text, {
      locator: "document; line 3",
      body: "Repeated words",
    })?.range,
  ).toEqual({ start: 31, end: 45 });
  expect(
    verifySourceRange(text, {
      locator: "document; line 2",
      body: "Repeated words",
    }),
  ).toBeNull();
  expect(
    verifySourceRange(text, { locator: "unknown", body: "Repeated words" }),
  ).toBeNull();
});

it("normalizes line locators while retaining raw character locators from older renditions", () => {
  const text = "One\r\nTwo\rThree";
  expect(
    verifySourceRange(text, {
      locator: "document; lines 2-3",
      body: "Two\nThree",
    }),
  ).toEqual({ text: "One\nTwo\nThree", range: { start: 4, end: 13 } });
  expect(
    verifySourceRange(text, {
      locator: "document; characters 4-8",
      body: "\r\nTwo",
    }),
  ).toEqual({ text, range: { start: 3, end: 8 } });
});

it("converts inclusive Go character counts to UTF-16 without splitting astral characters", () => {
  const text = "heading\nA😀BC😀D";
  expect(
    verifySourceRange(text, {
      locator: "section; line 2, characters 2-5",
      body: "😀BC😀",
    })?.range,
  ).toEqual({ start: 9, end: 15 });
  expect(
    verifySourceRange("A😀B", {
      locator: "document; characters 2-2",
      body: "😀",
    })?.range,
  ).toEqual({ start: 1, end: 3 });
});

it("verifies the contiguous heading and partial final line of an oversized section", () => {
  const text = "## Heading\nA😀BC\nLast";
  expect(
    verifySourceRange(text, {
      locator: "Heading; lines 1-2, characters 1-2 of line 2",
      body: "## Heading\nA😀",
    })?.range,
  ).toEqual({ start: 0, end: 14 });
  expect(
    verifySourceRange(text, {
      locator: "Heading; lines 1-2, characters 2-3 of line 2",
      body: "## Heading\n😀B",
    }),
  ).toBeNull();
});

it.each([
  "line 0",
  "line 4",
  "lines 2-1",
  "line 1, characters 1-99",
  "characters 0-2",
  "characters 1-99999999999999999999",
  "lines 1-2, characters 1-2 of line 3",
])("rejects invalid locator %s without guessing", (locator) => {
  expect(verifySourceRange("One\nTwo", { locator, body: "One" })).toBeNull();
});
