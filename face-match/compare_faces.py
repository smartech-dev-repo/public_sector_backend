#!/usr/bin/env python3
"""Compare one face photo against reference photos (e.g. a selfie against the BVN and NIN photos).

Called by the API (src/face-verification/python-face-verification.provider.ts), one process per
comparison. Uses OpenCV's YuNet face detector and SFace face recognizer; the two model files are
fetched by fetch_models.py.

Input on stdin, JSON:
    {"candidate": "<base64 image>", "references": {"bvn": "<base64 image>", "nin": "<base64 image>"}}

Output on stdout, JSON, exit code 0:
    {"results": {"bvn": {"score": 0.61}, "nin": {"error": "NO_FACE"}}}
    {"error": "NO_FACE_IN_CANDIDATE"}          the candidate photo has no detectable face
    {"error": "MULTIPLE_FACES_IN_CANDIDATE"}   it shows more than one person (a group photo)
    {"error": "UNREADABLE_CANDIDATE"}          the candidate photo isn't an image OpenCV can read

"score" is the cosine similarity of the two face embeddings, clamped to 0..1. SFace's published
same-person cutoff is 0.363. A reference that can't be compared carries "error" instead:
UNREADABLE_IMAGE or NO_FACE.

A non-zero exit means the comparison itself failed (bad input, missing models); the reason is
on stderr.

    python3 compare_faces.py --check   loads the models and prints {"ok": true, "opencv": "..."}
"""

import base64
import json
import os
import sys

import cv2
import numpy as np

MODELS_DIR = os.environ.get("FACE_MATCH_MODELS_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
DETECTOR_MODEL = "face_detection_yunet_2023mar.onnx"
RECOGNIZER_MODEL = "face_recognition_sface_2021dec.onnx"

# Large photos are shrunk (detection doesn't need the detail, and it bounds the work);
# small ones, such as ID photos, are enlarged so the detector can find the face.
MAX_SIDE = 1280
MIN_SIDE = 480
DETECTION_SCORE = 0.6
# The main face must be at least this share of the photo's shorter side; anything smaller is
# too little detail to compare (a distant figure, not a portrait).
MIN_FACE_SHARE = 0.08
# A second face at least this share of the main face's width is a second person in the picture
# (a group photo), so it can't be told who is being verified.
SECOND_FACE_SHARE = 0.5
MAX_IMAGE_BYTES = 10 * 1024 * 1024


class InputError(Exception):
    pass


def load_models():
    detector_path = os.path.join(MODELS_DIR, DETECTOR_MODEL)
    recognizer_path = os.path.join(MODELS_DIR, RECOGNIZER_MODEL)
    for path in (detector_path, recognizer_path):
        if not os.path.isfile(path):
            raise FileNotFoundError(f"model file missing: {path} (run face-match/fetch_models.py)")
    detector = cv2.FaceDetectorYN.create(detector_path, "", (320, 320), DETECTION_SCORE, 0.3, 5000)
    recognizer = cv2.FaceRecognizerSF.create(recognizer_path, "")
    return detector, recognizer


def decode(data):
    try:
        raw = base64.b64decode(data, validate=True)
    except (ValueError, TypeError):
        return None
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        return None
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        return None
    return resize(image)


def resize(image):
    height, width = image.shape[:2]
    longest, shortest = max(height, width), min(height, width)
    scale = 1.0
    if longest > MAX_SIDE:
        scale = MAX_SIDE / longest
    elif shortest < MIN_SIDE:
        scale = min(MIN_SIDE / shortest, MAX_SIDE / longest)
    if scale == 1.0:
        return image
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    return cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=interpolation)


def main_face(detector, image):
    """(largest face, number of people in the photo), or (None, 0) if there's no usable face."""
    height, width = image.shape[:2]
    detector.setInputSize((width, height))
    _, faces = detector.detect(image)
    if faces is None or len(faces) == 0:
        return None, 0
    largest = max(faces, key=lambda face: face[2] * face[3])
    if largest[2] < MIN_FACE_SHARE * min(height, width):
        return None, 0
    people = sum(1 for face in faces if face[2] >= SECOND_FACE_SHARE * largest[2])
    return largest, people


ROTATIONS = (None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE)


def embedding(detector, recognizer, image):
    """(embedding of the main face, number of people in the photo), or (None, 0).

    Phone photos are often stored sideways. EXIF orientation is applied when the image is
    decoded, but some cameras rotate the pixels without a tag, so all four orientations are
    tried and the one where the detector is most confident wins (it's trained on upright faces,
    and its landmarks always come out upright-shaped, so they can't be used to tell)."""
    best = None
    for rotation in ROTATIONS:
        rotated = image if rotation is None else cv2.rotate(image, rotation)
        face, people = main_face(detector, rotated)
        if face is not None and (best is None or face[14] > best[0][14]):
            best = (face, people, rotated)
    if best is None:
        return None, 0
    face, people, rotated = best
    return recognizer.feature(recognizer.alignCrop(rotated, face)), people


def compare(request, detector, recognizer):
    candidate_data = request.get("candidate")
    references = request.get("references")
    if not isinstance(candidate_data, str) or not isinstance(references, dict) or not references:
        raise InputError("expected {candidate: base64, references: {name: base64}}")

    candidate = decode(candidate_data)
    if candidate is None:
        return {"error": "UNREADABLE_CANDIDATE"}
    candidate_feature, people = embedding(detector, recognizer, candidate)
    if candidate_feature is None:
        return {"error": "NO_FACE_IN_CANDIDATE"}
    if people > 1:
        return {"error": "MULTIPLE_FACES_IN_CANDIDATE"}

    results = {}
    for name, data in references.items():
        reference = decode(data) if isinstance(data, str) else None
        if reference is None:
            results[name] = {"error": "UNREADABLE_IMAGE"}
            continue
        # An ID photo is a single portrait; the largest face is the holder.
        reference_feature, _ = embedding(detector, recognizer, reference)
        if reference_feature is None:
            results[name] = {"error": "NO_FACE"}
            continue
        cosine = recognizer.match(candidate_feature, reference_feature, cv2.FaceRecognizerSF_FR_COSINE)
        results[name] = {"score": round(min(max(float(cosine), 0.0), 1.0), 4)}
    return {"results": results}


def main():
    detector, recognizer = load_models()
    if "--check" in sys.argv[1:]:
        print(json.dumps({"ok": True, "opencv": cv2.__version__}))
        return 0
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise InputError("expected a JSON object")
        print(json.dumps(compare(request, detector, recognizer)))
        return 0
    except (InputError, json.JSONDecodeError) as error:
        print(f"bad input: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - reported to the caller on stderr
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
