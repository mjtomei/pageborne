"""Classify bounded generation without accepting partial transcriptions."""


def batch_results(items, rows, eos_ids, decode, correct, *, max_tokens=4096,
                  time_limited=False, memory_stopped=False):
    if memory_stopped:
        raise RuntimeError('OCR stopped by memory watchdog; no result committed')
    if len(rows) != len(items):
        raise RuntimeError('Incomplete OCR batch; no result committed')
    output = []
    for item, values in zip(items, rows):
        end = next((i + 1 for i, token in enumerate(values) if token in eos_ids), None)
        result = {'number': item['number'], 'turn': item['turn']}
        if end is None:
            # A normal generation budget is a page-level limitation, not a CUDA
            # failure. Keep geometry for future repair, but never decode/correct
            # from this prefix or present it as a completed transcription.
            if not values or (len(values) < max_tokens and not time_limited):
                raise RuntimeError('Unexpected incomplete OCR response; no result committed')
            result.update(extracted=item['extracted'], fallback={
                'code': 'ocr-output-limit',
                'reason': 'token-limit' if len(values) >= max_tokens else 'time-limit',
                'generatedTokens': len(values), 'maxTokens': max_tokens,
            })
        else:
            markdown = decode(values[:end])
            result.update(markdown=markdown, extracted=correct(item['extracted'], markdown))
        output.append(result)
    return output
