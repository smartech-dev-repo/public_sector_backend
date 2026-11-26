"""Tests for compare_faces.py, run through its real command line.

    npm run face-match:test      (after npm run face-match:setup)

The scores asserted are wide bands around what OpenCV 4.12 gives these photos, so they hold on
both the local wheel and Alpine's package while still catching a broken pipeline.
"""

import base64
import json
import os
import subprocess
import sys
import unittest

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "compare_faces.py")
FIXTURES = os.path.join(HERE, "fixtures")
SFACE_SAME_PERSON_CUTOFF = 0.363


def photo(name):
    with open(os.path.join(FIXTURES, name), "rb") as file:
        return base64.b64encode(file.read()).decode()


def encode(image, ext=".jpg"):
    ok, data = cv2.imencode(ext, image)
    assert ok
    return base64.b64encode(data.tobytes()).decode()


def run(payload, *args):
    stdin = payload if isinstance(payload, str) else json.dumps(payload)
    return subprocess.run([sys.executable, SCRIPT, *args], input=stdin, capture_output=True, text=True, timeout=60)


def compare(candidate, **references):
    result = run({"candidate": candidate, "references": references})
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


class CompareFacesTest(unittest.TestCase):
    def test_check_loads_the_models(self):
        result = run("", "--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["ok"])

    def test_same_person_scores_above_the_cutoff_and_others_below(self):
        out = compare(photo("collins-1.jpg"), same=photo("collins-2.jpg"), other=photo("williams-1.jpg"))
        self.assertGreater(out["results"]["same"]["score"], 0.6)
        self.assertLess(out["results"]["other"]["score"], 0.25)

    def test_a_selfie_matches_an_official_portrait(self):
        out = compare(photo("williams-selfie.jpg"), id=photo("williams-1.jpg"))
        self.assertGreater(out["results"]["id"]["score"], SFACE_SAME_PERSON_CUTOFF)

    def test_a_sideways_or_upside_down_selfie_still_matches(self):
        selfie = cv2.imdecode(np.frombuffer(base64.b64decode(photo("williams-selfie.jpg")), np.uint8), cv2.IMREAD_COLOR)
        for rotation in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE):
            out = compare(encode(cv2.rotate(selfie, rotation)), id=photo("williams-1.jpg"))
            self.assertGreater(out["results"]["id"]["score"], SFACE_SAME_PERSON_CUTOFF, rotation)

    def test_a_small_low_quality_id_photo_can_still_be_compared(self):
        portrait = cv2.imdecode(np.frombuffer(base64.b64decode(photo("williams-1.jpg")), np.uint8), cv2.IMREAD_COLOR)
        small = cv2.resize(portrait, (180, 225), interpolation=cv2.INTER_AREA)
        ok, data = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 60])
        out = compare(photo("williams-selfie.jpg"), id=base64.b64encode(data.tobytes()).decode())
        self.assertIn("score", out["results"]["id"])

    def test_a_group_photo_is_refused_as_the_candidate(self):
        out = compare(photo("group.jpg"), id=photo("collins-1.jpg"))
        self.assertEqual(out, {"error": "MULTIPLE_FACES_IN_CANDIDATE"})

    def test_a_candidate_without_a_face_is_refused(self):
        blank = np.full((400, 300, 3), 200, np.uint8)
        self.assertEqual(compare(encode(blank, ".png"), id=photo("collins-1.jpg")), {"error": "NO_FACE_IN_CANDIDATE"})

    def test_an_unreadable_candidate_is_refused(self):
        not_an_image = base64.b64encode(b"not an image").decode()
        self.assertEqual(compare(not_an_image, id=photo("collins-1.jpg")), {"error": "UNREADABLE_CANDIDATE"})

    def test_references_that_cannot_be_compared_are_reported_one_by_one(self):
        blank = np.full((400, 300, 3), 200, np.uint8)
        out = compare(
            photo("collins-1.jpg"),
            bvn=photo("collins-2.jpg"),
            nin=encode(blank, ".png"),
            other="%%%not-base64%%%",
        )
        self.assertIn("score", out["results"]["bvn"])
        self.assertEqual(out["results"]["nin"], {"error": "NO_FACE"})
        self.assertEqual(out["results"]["other"], {"error": "UNREADABLE_IMAGE"})

    def test_malformed_input_exits_with_code_2(self):
        self.assertEqual(run("not json").returncode, 2)
        self.assertEqual(run({"candidate": photo("collins-1.jpg")}).returncode, 2)
        self.assertEqual(run([1, 2]).returncode, 2)

    def test_missing_models_exit_with_code_1(self):
        env = {**os.environ, "FACE_MATCH_MODELS_DIR": os.path.join(HERE, "no-such-dir")}
        result = subprocess.run([sys.executable, SCRIPT, "--check"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("model file missing", result.stderr)


if __name__ == "__main__":
    unittest.main()
