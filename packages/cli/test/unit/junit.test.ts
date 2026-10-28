import { describe, expect, it } from "vitest";
import { readJunitXml } from "../../src/adapter/junit/xml.js";
import { readReports } from "../../src/adapter/vitest/report.js";
import { makeTmpRepo } from "../helpers/fixture.js";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="sales" tests="3">
    <testcase name="sales &gt; rejects insufficient stock" classname="src/sales.test.ts"/>
    <testcase name="sales &gt; idempotent" classname="src/sales.test.ts">
      <failure message="AssertionError: expected 2 to be 1"><![CDATA[AssertionError: expected 2 to be 1]]></failure>
    </testcase>
    <testcase name="sales &gt; skipped">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;

describe("readJunitXml", () => {
  it("maps pass, fail and skipped test cases", () => {
    expect(readJunitXml(XML)).toEqual([
      { runtimeId: "sales > rejects insufficient stock", outcome: "pass" },
      {
        runtimeId: "sales > idempotent",
        outcome: "fail",
        message: "AssertionError: expected 2 to be 1",
      },
      { runtimeId: "sales > skipped", outcome: "not-run" },
    ]);
  });

  it("uses the failure body when the producer omits the message attribute", () => {
    const xml = `<testsuite><testcase name="t"><failure><![CDATA[AssertionError: nope &amp; done]]></failure></testcase></testsuite>`;
    expect(readJunitXml(xml)).toEqual([
      { runtimeId: "t", outcome: "fail", message: "AssertionError: nope & done" },
    ]);
  });

  it("returns null for malformed XML or a document with no testcase", () => {
    expect(readJunitXml("<testsuite><testcase")).toBeNull();
    expect(readJunitXml("<testsuite></testsuite>")).toBeNull();
    expect(readJunitXml("<testcase name=\"unclosed\">")).toBeNull();
  });
});

describe("readReports JUnit fallback", () => {
  it("reads a JUnit file when the path is not Vitest JSON", async () => {
    const root = await makeTmpRepo({ "reports/junit.xml": XML });
    expect(await readReports(["reports/junit.xml"], root)).toEqual([
      { runtimeId: "sales > rejects insufficient stock", outcome: "pass" },
      {
        runtimeId: "sales > idempotent",
        outcome: "fail",
        message: "AssertionError: expected 2 to be 1",
      },
      { runtimeId: "sales > skipped", outcome: "not-run" },
    ]);
  });
});
