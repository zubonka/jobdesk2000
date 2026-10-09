// Text extraction from PDF files. pdf.js is big, so it is loaded from the CDN only when the first PDF is chosen.

const CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
const INTEGRITY = "sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==";
const WORKER_INTEGRITY = "sha512-BbrZ76UNZq5BhH7LL7pn9A4TKQpQeNCHOo65/akfelcIBbcVvYWOFQKPXIrykE3qZxYjmDX573oa4Ywsc7rpTw==";

let loading = null;

// The worker runs with this site's origin, so it is checked like the main script: fetched with its SRI hash
// and handed to pdf.js as a blob: URL (a plain workerSrc would be importScripts()-ed without any check).
async function verifiedWorkerUrl() {
  const res = await fetch(CDN + "pdf.worker.min.js", { integrity: WORKER_INTEGRITY, mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error("pdf.js worker HTTP " + res.status);
  return URL.createObjectURL(new Blob([await res.text()], { type: "text/javascript" }));
}

function loadScript() {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CDN + "pdf.min.js";
    script.integrity = INTEGRITY;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => resolve(window.pdfjsLib));
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("pdf.js failed to load"));
    });
    document.head.appendChild(script);
  });
}

function loadPdfJs() {
  loading ||= Promise.all([loadScript(), verifiedWorkerUrl()])
    .then(([pdfjsLib, workerUrl]) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjsLib;
    })
    .catch((err) => {
      loading = null; // a failed load (offline, blocked CDN, wrong hash) must not stick: the next PDF tries again
      throw err;
    });
  return loading;
}

// All pages as plain text: line breaks where pdf.js reports an end of line, runs of spaces collapsed.
export async function pdfToText(file) {
  const pdfjsLib = await loadPdfJs();
  // 3.11 compiles font glyphs and PDF functions with new Function (CVE-2024-4367); text extraction needs neither
  const task = pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false });
  try {
    const pdf = await task.promise;
    let text = "";
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const { items } = await page.getTextContent();
      text += items.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("") + "\n";
    }
    return text.replace(/[ \t]+/g, " ").trim();
  } finally {
    // every document gets its own worker; destroying the task ends it
    task.destroy();
  }
}
