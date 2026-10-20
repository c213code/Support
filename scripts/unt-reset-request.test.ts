import assert from "node:assert/strict";
import test from "node:test";
import { mentionsUntTest } from "../src/lib/untResetRequest";

test("ДТ and БТ are aliases, including Kazakh suffixes and lowercase text", () => {
  for (const text of ["ДТ жоқ", "БТ шықпай тұр", "бт-ны ашу керек", "дт шықпайды", "деңгейлік тест жоқ"]) {
    assert.equal(mentionsUntTest(text), true, text);
  }
});

test("aliases must not match fragments or the separate ҰБТ term", () => {
  for (const text of ["ҰБТ", "Жұптық жұмыс", "сабтест", "дтест", "", null, undefined]) {
    assert.equal(mentionsUntTest(text), false, String(text));
  }
});
