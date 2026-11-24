#!/usr/bin/env python3
"""Create a phone-safe PDF copy; never overwrite the input (requires PyMuPDF, Pillow).

Only oversized raster XObjects change. Text, equations, vectors, page geometry
and bookmarks remain PDF content. Run this on a desktop before importing a PDF
whose compressed image streams expand beyond a phone's memory budget.
"""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path

import fitz
from PIL import Image


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def signature(doc):
    return {"pages": [(tuple(p.mediabox), tuple(p.cropbox), p.rotation, p.get_text("words")) for p in doc],
            "contents": doc.get_toc(), "metadata": doc.metadata}


def optimize(source, output, threshold=8_000_000, pixels=2_000_000, side=2048):
    source, output = Path(source), Path(output)
    if source.resolve() == output.resolve() or output.exists():
        raise ValueError("Choose a new output path; originals are never overwritten.")
    before_hash = sha(source)
    changed = []
    with fitz.open(source) as doc:
        if doc.is_encrypted:
            raise ValueError("Encrypted PDFs are not supported.")
        before = signature(doc)
        images = {}
        for page in doc:
            for image in page.get_images(full=True):
                xref, mask, width, height = image[:4]
                if width * height > threshold:
                    images.setdefault(xref, (page.number, mask, width, height))
        for xref, (number, mask, width, height) in images.items():
            factor = min(1, side / max(width, height), math.sqrt(pixels / (width * height)))
            size = (max(1, int(width * factor)), max(1, int(height * factor)))
            pix = fitz.Pixmap(doc, xref)
            if pix.colorspace and pix.colorspace.n not in (1, 3):
                pix = fitz.Pixmap(fitz.csRGB, pix)
            if mask:
                pix = fitz.Pixmap(pix, fitz.Pixmap(doc, mask))
            mode = ("LA" if pix.alpha else "L") if pix.colorspace.n == 1 else ("RGBA" if pix.alpha else "RGB")
            image = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
            del pix
            reduced = image.resize(size, Image.Resampling.LANCZOS)
            image.close()
            encoded = io.BytesIO()
            reduced.save(encoded, format="PNG")
            reduced.close()
            doc[number].replace_image(xref, stream=encoded.getvalue())
            changed.append({"page": number + 1, "xref": xref, "before": [width, height], "after": list(size)})
        with output.open('xb') as destination:
            doc.save(destination, garbage=4, deflate=True)
    try:
        with fitz.open(output) as result:
            if signature(result) != before:
                raise ValueError("PDF text, geometry, bookmarks or metadata changed; refusing the copy.")
        if sha(source) != before_hash:
            raise ValueError("The source changed during conversion.")
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return {"sourceSha256": before_hash, "sha256": sha(output), "sourceBytes": source.stat().st_size,
            "bytes": output.stat().st_size, "pages": len(before["pages"]), "images": changed,
            "textAndGeometryPreserved": True, "originalUnchanged": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()
    print(json.dumps(optimize(args.source, args.output), indent=2))
