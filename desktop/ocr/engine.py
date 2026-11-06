"""One resident Xiaomi model; private JSON-lines IPC, no network listener."""
import json
import os
from pathlib import Path
import sys
import time

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
import torch
from PIL import Image
from transformers import AutoModelForImageTextToText, AutoProcessor, StoppingCriteria, StoppingCriteriaList
from correction import correct
from guard import memory, pressure
from inference_result import batch_results

PROMPT = ('Extract all information from the main body of the document image and represent it '
          'in markdown format, ignoring headers and footers. Tables should be expressed in OTSL '
          'format, formulas in the document should be represented using LATEX format, and the '
          'parsing should be organized according to the reading order.')


class MemoryStop(StoppingCriteria):
    def __init__(self):
        self.tripped = False

    def __call__(self, input_ids, scores, **kwargs):
        self.tripped = self.tripped or pressure(memory())
        return self.tripped


def main():
    config = json.loads(Path(sys.argv[1]).read_text())
    budget = min(float(config.get('gpuMemoryGiB', 4)), 6)
    if budget <= 0: raise ValueError('GPU memory budget must be positive')
    if pressure(memory()) or memory()['free_bytes'] < (budget+12)*1024**3:
        raise RuntimeError('Insufficient memory headroom to load OCR')
    torch.set_num_threads(4)
    torch.cuda.set_per_process_memory_fraction(budget*1024**3/torch.cuda.get_device_properties(0).total_memory)
    processor = AutoProcessor.from_pretrained(config['modelPath'], local_files_only=True)
    processor.tokenizer.padding_side = 'left'
    model = AutoModelForImageTextToText.from_pretrained(config['modelPath'], local_files_only=True,
        dtype=torch.float16, attn_implementation='sdpa', device_map='cuda').eval()
    eos = model.generation_config.eos_token_id
    eos_ids = set(eos if isinstance(eos, list) else [eos])
    print(json.dumps({'ready': True}), flush=True)
    for request in sys.stdin:
        items = json.loads(request)['items']
        if not 1 <= len(items) <= 4: raise ValueError('OCR supports batches of one to four pages')
        conversations = []
        for item in items:
            with Image.open(item['image']) as source:
                image = source.convert('RGB'); image.thumbnail((2048, 2048))
            conversations.append([{'role': 'user', 'content': [
                {'type': 'image', 'image': image}, {'type': 'text', 'text': PROMPT}]}])
        if pressure(memory()): raise RuntimeError('Memory pressure before OCR batch')
        start = time.monotonic()
        inputs = processor.apply_chat_template(conversations, tokenize=True, add_generation_prompt=True,
            return_dict=True, return_tensors='pt', padding=True, enable_thinking=False).to('cuda')
        torch.cuda.reset_peak_memory_stats()
        memory_stop = MemoryStop()
        generation_start = time.monotonic()
        with torch.inference_mode():
            tokens = model.generate(**inputs, do_sample=False, max_new_tokens=4096, max_time=300,
                                    stopping_criteria=StoppingCriteriaList([memory_stop]))
        torch.cuda.synchronize()
        output = batch_results(items, tokens[:, inputs['input_ids'].shape[1]:].tolist(), eos_ids,
            lambda values: processor.decode(values, skip_special_tokens=True), correct,
            time_limited=time.monotonic()-generation_start >= 300,
            memory_stopped=memory_stop.tripped or pressure(memory()))
        print(json.dumps({'items': output, 'seconds': time.monotonic()-start,
                          'peakGpuBytes': torch.cuda.max_memory_allocated()}), flush=True)
        del inputs, tokens, conversations, output
        # Release unused large-batch buffers while keeping weights resident.
        torch.cuda.empty_cache()


if __name__ == '__main__': main()
