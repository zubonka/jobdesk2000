import { test } from "node:test";
import assert from "node:assert/strict";
import { html, raw, escapeHtml, safeUrl } from "../../public/js/core/dom.js";

test("html escapes every interpolated value", () => {
  const out = html`<p title="${`"a" & 'b'`}">${"<script>alert(1)</script>"}</p>`;
  assert.equal(String(out), `<p title="&quot;a&quot; &amp; &#39;b&#39;">&lt;script&gt;alert(1)&lt;/script&gt;</p>`);
});

test("html leaves the template's own markup alone", () => {
  assert.equal(String(html`<b class="x">ok</b>`), `<b class="x">ok</b>`);
});

test("html nests html results and raw() without escaping them twice", () => {
  const item = html`<li>${"<i>"}</li>`;
  assert.equal(String(html`<ul>${item}${raw("<hr>")}</ul>`), "<ul><li>&lt;i&gt;</li><hr></ul>");
});

test("html joins arrays and escapes their items", () => {
  const rows = ["<a>", html`<b>${"&"}</b>`, 3];
  assert.equal(String(html`${rows}`), "&lt;a&gt;<b>&amp;</b>3");
});

test("html renders null, undefined and false as nothing, but keeps 0", () => {
  assert.equal(String(html`[${null}${undefined}${false}${0}]`), "[0]");
});

test("escapeHtml covers the five special characters", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

test("safeUrl keeps http(s) links", () => {
  assert.equal(safeUrl("https://jobs.example.com/1?a=b"), "https://jobs.example.com/1?a=b");
  assert.equal(safeUrl("  HTTP://example.com  "), "HTTP://example.com");
});

test("safeUrl turns every other scheme into #", () => {
  for (const url of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)", "//evil.example", "example.com", "", null, undefined]) {
    assert.equal(safeUrl(url), "#", String(url));
  }
});
