/**
 * PDF Handler — Extract content from PDF files for the WhatsApp agent
 * 
 * Strategy:
 * 1. Try text extraction first (pdf-parse) — works for native/digital PDFs (CSF, estados de cuenta)
 * 2. If text is minimal (<50 chars), convert first page to image (pdftoppm) — works for scanned PDFs
 * 3. Return either extracted text OR base64 image for Vision processing
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type PdfResult = {
  /** "text" if we extracted text, "image" if we converted to image */
  type: "text" | "image";
  /** Extracted text (if type=text) */
  text?: string;
  /** Base64 image of first page (if type=image) */
  imageBase64?: string;
  /** Number of pages */
  pages: number;
};

/**
 * Process a PDF buffer and extract content
 */
export async function processPdf(pdfBuffer: Buffer): Promise<PdfResult> {
  // Step 1: Try text extraction
  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(pdfBuffer);
    const text = (data.text || "").trim();
    const pages = data.numpages || 1;

    // If we got meaningful text (more than 50 chars), return it
    if (text.length > 50) {
      return { type: "text", text: text.slice(0, 4000), pages }; // Cap at 4000 chars for LLM context
    }

    // Otherwise fall through to image conversion (probably a scanned PDF)
    console.log(`[PDF] Text extraction got only ${text.length} chars — converting to image`);
  } catch (e: any) {
    console.error("[PDF] pdf-parse error:", e.message);
  }

  // Step 2: Convert first page to image using pdftoppm
  try {
    const tmpBase = join(tmpdir(), `cmu-pdf-${Date.now()}`);
    const tmpPdf = tmpBase + ".pdf";
    const tmpImg = tmpBase + "-1"; // pdftoppm appends page number

    writeFileSync(tmpPdf, pdfBuffer);

    // Convert first page to JPEG at 200 DPI
    execSync(`pdftoppm -jpeg -r 200 -f 1 -l 1 "${tmpPdf}" "${tmpBase}"`, {
      timeout: 15000,
    });

    // pdftoppm creates file like: tmpBase-1.jpg or tmpBase-01.jpg
    let imgPath = "";
    for (const suffix of ["-1.jpg", "-01.jpg", "-001.jpg"]) {
      const candidate = tmpBase + suffix;
      if (existsSync(candidate)) { imgPath = candidate; break; }
    }

    if (imgPath) {
      const imgBuffer = readFileSync(imgPath);
      const base64 = `data:image/jpeg;base64,${imgBuffer.toString("base64")}`;

      // Cleanup
      try { unlinkSync(tmpPdf); } catch {}
      try { unlinkSync(imgPath); } catch {}

      return { type: "image", imageBase64: base64, pages: 1 };
    }

    // Cleanup on failure
    try { unlinkSync(tmpPdf); } catch {}
    console.error("[PDF] pdftoppm produced no output");
  } catch (e: any) {
    console.error("[PDF] pdftoppm error:", e.message);
  }

  // Step 3: If all else fails, return empty text result
  return { type: "text", text: "(PDF no legible — pide al usuario que envíe foto del documento)", pages: 0 };
}

/**
 * Check if a media type is a PDF
 */
export function isPdf(mediaType: string | null): boolean {
  if (!mediaType) return false;
  return mediaType.toLowerCase().includes("pdf") || mediaType.toLowerCase().includes("application/pdf");
}
