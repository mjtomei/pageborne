import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

import fitz
from PIL import Image

spec = importlib.util.spec_from_file_location('optimizer', Path(__file__).parents[1] / 'scripts/pdf-optimize-images.py')
optimizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(optimizer)


class ImageOptimizationTest(unittest.TestCase):
    def test_raster_reduction_preserves_vector_text_geometry_bookmarks_and_source(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / 'source.pdf', Path(folder) / 'output.pdf'
            with fitz.open() as doc:
                page = doc.new_page(width=400, height=600)
                page.insert_text((30, 30), 'Measuring XY drop: S(A,B) and subscripts')
                image = Image.new('RGBA', (400, 240), (0, 60, 120, 180))
                blob = io.BytesIO(); image.save(blob, format='PNG')
                page.insert_image(fitz.Rect(20, 60, 380, 276), stream=blob.getvalue())
                doc.set_toc([[1, 'Measuring XY drop', 1]])
                doc.save(source)
            original = source.read_bytes()
            report = optimizer.optimize(source, output, threshold=50_000, pixels=10_000, side=140)
            self.assertEqual(source.read_bytes(), original)
            self.assertTrue(report['textAndGeometryPreserved'])
            self.assertEqual(len(report['images']), 1)
            with fitz.open(output) as doc:
                for image in doc[0].get_images():
                    self.assertLessEqual(image[2] * image[3], 10_000)
                    self.assertGreater(image[1], 0, 'transparency mask remains')
            with self.assertRaises(ValueError):
                optimizer.optimize(source, source)
            with self.assertRaises(ValueError):
                optimizer.optimize(source, output)


if __name__ == '__main__':
    unittest.main()
