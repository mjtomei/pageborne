import unittest
from types import SimpleNamespace as Obj
from nano import measured_lines


class NanoGeometry(unittest.TestCase):
    def test_measured_line_boxes_are_scaled_without_inventing_words(self):
        item = Obj(x=10, y=20, width=100, height=10, text='Two real words', confidence=.97)
        result = measured_lines(Obj(width=200, height=400, text_items=[item]), 900, 1800)
        self.assertEqual(result[0]['x'], 45)
        self.assertEqual(result[0]['height'], 45)
        self.assertEqual(result[0]['confidence'], 97)
        self.assertNotIn('words', result[0])

    def test_invalid_geometry_is_not_silently_saved(self):
        with self.assertRaises(ValueError):
            measured_lines(Obj(width=0, height=400, text_items=[]), 900, 1800)
        with self.assertRaises(ValueError):
            measured_lines(Obj(width=200, height=400, text_items=[Obj(x=0, y=0, width=1, height=1, text='x', confidence=float('nan'))]), 900, 1800)


if __name__ == '__main__':
    unittest.main()
