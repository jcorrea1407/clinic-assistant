import { describe, expect, it } from "vitest";
import uplandSheet from "../clients/upland/fact-sheet.json" with { type: "json" };
import { FactSheetError, localJsonSource, parseFactSheet } from "../src/facts/source.js";

const sheet = () => structuredClone(uplandSheet) as typeof uplandSheet;

describe("fact sheet validation", () => {
  it("accepts Upland's sheet", () => {
    expect(() => parseFactSheet(sheet())).not.toThrow();
  });

  it("rejects a public-rule line without a sourceUrl", () => {
    const s = sheet();
    const rule = s.collections.faq.find((f) => f.kind === "public-rule")!;
    rule.sourceUrl = null;
    expect(() => parseFactSheet(s)).toThrow(FactSheetError);
    expect(() => parseFactSheet(s)).toThrow(`"${rule.slug}" is a public-rule, so it needs a sourceUrl`);
  });

  it("rejects a concern marked public-rule, since concerns carry no source", () => {
    const s = sheet();
    s.collections.concerns[0]!.kind = "public-rule";
    expect(() => parseFactSheet(s)).toThrow("needs a sourceUrl");
  });

  it("rejects a non-https source", () => {
    const s = sheet();
    s.collections.faq.find((f) => f.sourceUrl)!.sourceUrl = "http://example.com/rule";
    expect(() => parseFactSheet(s)).toThrow(FactSheetError);
  });

  it("rejects a concern routed to a practitioner who doesn't exist", () => {
    const s = sheet();
    s.collections.concerns[0]!.whoTreats.push("nobody");
    expect(() => parseFactSheet(s)).toThrow('lists unknown practitioner "nobody"');
  });

  it("rejects a practitioner and concern that disagree", () => {
    const s = sheet();
    const maya = s.collections.practitioners.find((p) => p.slug === "maya-okafor")!;
    maya.concerns.push("back-and-neck");
    expect(() => parseFactSheet(s)).toThrow(`"back-and-neck" doesn't list "maya-okafor"`);
  });

  it("rejects duplicate slugs in a collection", () => {
    const s = sheet();
    s.collections.faq.push(structuredClone(s.collections.faq[0]!));
    expect(() => parseFactSheet(s)).toThrow("Duplicate slug");
  });

  it("rejects unknown fields, so a typo can't slip through", () => {
    const s = sheet();
    (s.collections.clinicFacts[0] as Record<string, unknown>).vaule = "typo";
    expect(() => parseFactSheet(s)).toThrow(FactSheetError);
  });
});

describe("local JSON source", () => {
  it("strips every internalNote before the facts leave the loader", async () => {
    const raw = sheet();
    expect(JSON.stringify(raw)).toContain("internalNote");

    const facts = await localJsonSource(raw).load();
    const json = JSON.stringify(facts);
    expect(json).not.toContain("internalNote");
    // A note's text must not survive under another key either.
    expect(json).not.toContain("Practitioner review needed");
  });

  it("keeps the facts themselves", async () => {
    const facts = await localJsonSource(sheet()).load();
    expect(facts.clinic).toBe("Upland Physio, Chiro & Massage");
    expect(facts.collections.practitioners).toHaveLength(5);
    expect(facts.collections.redFlagTriggers.map((t) => t.slug)).toContain("chest-pain");
  });
});
