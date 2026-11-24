"""Local CPU recognition. Model assets are installed/verified before startup.

LiteParse is Apache-2.0; OCRia-nano weights/configuration have their own modified
Open RAIL-M license. This adapter includes no model assets or upstream code.
"""
import json
import math
import os
import sys
import time


def measured_lines(page, width, height):
    if not all(math.isfinite(n) and n > 0 for n in (width, height, page.width, page.height)):
        raise ValueError("Invalid Nano page geometry")
    sx, sy = width / page.width, height / page.height
    lines = []
    for item in page.text_items:
        if not item.text.strip():
            continue
        if not all(math.isfinite(n) for n in (item.x, item.y, item.width, item.height)) or item.width <= 0 or item.height <= 0:
            raise ValueError("Invalid Nano text geometry")
        confidence = item.confidence
        if confidence is None or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError("Invalid Nano confidence")
        # Nano's `words` may hold a whole line. Never invent per-word positions
        # or pass its paragraph/table classifications to the reader.
        lines.append(dict(x=item.x * sx, y=item.y * sy, width=item.width * sx,
                          height=item.height * sy, text=item.text.strip(),
                          confidence=confidence * 100, nanoConfidence=confidence))
    return sorted(lines, key=lambda line: (line['y'], line['x']))


def main():
    from pathlib import Path
    from importlib.metadata import version
    config = json.loads(Path(sys.argv[1]).read_text())
    if version('liteparse') != '2.21.1':
        raise RuntimeError('Install the pinned LiteParse 2.21.1 runtime')
    model = Path(config['modelPath']).resolve()
    if model.name != 'ocria-nano':
        raise ValueError('modelPath must point to the installed ocria-nano directory')
    os.environ['LITEPARSE_MODEL_DIR'] = str(model.parent)
    os.environ['OMP_NUM_THREADS'] = '1'
    os.environ['OPENBLAS_NUM_THREADS'] = '1'
    from liteparse import LiteParse, models
    if not any(Path(m.path).resolve() == model and m.complete for m in models.list()):
        raise RuntimeError('Nano model package is incomplete; install it before running OCR')
    parser = LiteParse(ocr_backend='ocria-nano', output_format='text', num_workers=1,
                       dpi=250, quiet=True, extract_blocks=False, emit_word_boxes=False)
    print(json.dumps(dict(ready=True, backend='cpu', model='OCRia-nano-1', workers=1)), flush=True)
    try:
        for line in sys.stdin:
            request = json.loads(line)
            results = []
            for item in request['items']:
                start = time.monotonic()
                parsed = parser.parse(item['image'])
                if parsed.page_errors or len(parsed.pages) != 1:
                    raise RuntimeError('Incomplete Nano recognition')
                text = measured_lines(parsed.pages[0], item['width'], item['height'])
                results.append(dict(number=item['number'], extracted=dict(text=text), markdown='',
                                    recognition=dict(model='OCRia-nano-1', backend='cpu', workers=1,
                                                     ms=round((time.monotonic()-start)*1000))))
            print(json.dumps(dict(items=results)), flush=True)
    finally:
        parser.close()


if __name__ == '__main__':
    main()
