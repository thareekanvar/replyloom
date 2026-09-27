const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|json|log|html?|xml|yaml|yml)$/i

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "")
}

/**
 * Pulls readable text out of a user-picked document so it can be fed into the
 * agent's knowledge base ingest pipeline (which chunk + embeds plain text).
 * Text formats are read straight from the file; PDFs are extracted client-side
 * with pdfjs (worker imported on demand, so SSR never loads it).
 */
export async function extractTextFromDocument(
  file: File
): Promise<{ source: string; text: string }> {
  const isPdf =
    file.type === "application/pdf" || /\.pdf$/i.test(file.name)

  let text: string
  if (isPdf) {
    const [{ getDocument, GlobalWorkerOptions }, workerModule] =
      await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ])
    GlobalWorkerOptions.workerSrc = workerModule.default
    const data = await file.arrayBuffer()
    const pdf = await getDocument({ data }).promise
    try {
      const parts: string[] = []
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const content = await page.getTextContent()
        parts.push(
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ")
        )
      }
      text = parts.join("\n\n")
    } finally {
      const asAny = pdf as unknown as { destroy?: () => Promise<void> }
      if (typeof asAny.destroy === "function") {
        await asAny.destroy()
      }
    }
  } else if (TEXT_EXTENSIONS.test(file.name) || file.type.startsWith("text/")) {
    text = await file.text()
  } else {
    throw new Error(
      "Unsupported file type. Upload a PDF or a text file (.txt, .md, .csv, .json, .html)."
    )
  }

  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error("No readable text found in this file.")
  }
  return { source: baseName(file.name), text: trimmed }
}