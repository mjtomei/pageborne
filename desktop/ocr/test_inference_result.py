import unittest
from inference_result import batch_results


class InferenceResultTests(unittest.TestCase):
    def setUp(self):
        self.items = [{'number': 7, 'turn': 90, 'extracted': {'text': [{'text': 'Original geometry'}]}},
                      {'number': 8, 'turn': 0, 'extracted': {'text': []}}]
        self.decoded = []

    def decode(self, values):
        self.decoded.append(values)
        return 'Complete transcription'

    def results(self, rows, **kwargs):
        return batch_results(self.items[:len(rows)], rows, {9}, self.decode,
                             lambda geometry, text: {'text': [{'text': text}]}, **kwargs)

    def test_output_limit_discards_prefix_and_preserves_other_completed_pages(self):
        result = self.results([[1] * 4096, [3, 9, 0]])
        self.assertEqual(result[0]['fallback']['reason'], 'token-limit')
        self.assertEqual(result[0]['fallback']['generatedTokens'], 4096)
        self.assertEqual(result[0]['extracted'], self.items[0]['extracted'])
        self.assertEqual(result[0]['turn'], 90)
        self.assertNotIn('markdown', result[0])
        self.assertEqual(result[1]['markdown'], 'Complete transcription')
        self.assertEqual(self.decoded, [[3, 9]])

    def test_time_limit_is_recoverable_only_without_a_memory_stop(self):
        self.assertEqual(self.results([[1, 2]], time_limited=True)[0]['fallback']['reason'], 'time-limit')
        self.assertFalse(self.decoded)
        for rows in [[[1] * 4096], [[1, 9]]]:
            with self.assertRaisesRegex(RuntimeError, 'memory watchdog'):
                self.results(rows, time_limited=True, memory_stopped=True)
        self.assertFalse(self.decoded)

    def test_unexplained_incomplete_or_empty_output_remains_fatal(self):
        for rows in [[[1, 2]], [[]]]:
            with self.assertRaisesRegex(RuntimeError, 'Unexpected incomplete'):
                self.results(rows)
        with self.assertRaisesRegex(RuntimeError, 'Incomplete OCR batch'):
            batch_results(self.items, [[9]], {9}, self.decode, lambda *args: {})

    def test_eos_at_budget_is_complete(self):
        result = self.results([[1] * 4095 + [9]])
        self.assertNotIn('fallback', result[0])
        self.assertIn('markdown', result[0])


if __name__ == '__main__':
    unittest.main()
