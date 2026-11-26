#!/usr/bin/env python3
"""Download the two OpenCV model files compare_faces.py needs into face-match/models/.

Pinned to fixed commits of github.com/opencv/opencv_zoo and checked against SHA-256, so a
changed or tampered file fails the download (and the Docker build) instead of being used.
Files already present with the right checksum are kept.

    python3 face-match/fetch_models.py
"""

import hashlib
import os
import sys
import urllib.request

MODELS_DIR = os.environ.get("FACE_MATCH_MODELS_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

MODELS = [
    (
        "face_detection_yunet_2023mar.onnx",
        "https://github.com/opencv/opencv_zoo/raw/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
    (
        "face_recognition_sface_2021dec.onnx",
        "https://github.com/opencv/opencv_zoo/raw/ba91a3b91d00d76e86540d4013f944bd6b514e39/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    ),
]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    os.makedirs(MODELS_DIR, exist_ok=True)
    for name, url, expected in MODELS:
        path = os.path.join(MODELS_DIR, name)
        if os.path.isfile(path) and sha256(path) == expected:
            print(f"{name}: already present")
            continue
        partial = path + ".part"
        with urllib.request.urlopen(url, timeout=120) as response, open(partial, "wb") as out:
            while chunk := response.read(1 << 20):
                out.write(chunk)
        actual = sha256(partial)
        if actual != expected:
            os.remove(partial)
            print(f"{name}: checksum mismatch (expected {expected}, got {actual})", file=sys.stderr)
            return 1
        os.replace(partial, path)
        print(f"{name}: downloaded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
