"""Models that run in the API: candidate scoring, spectral classes and false-discovery-rate control.

Training code lives in the separate ``ml/`` project (PyTorch). Trained weights are exported to
``pxh/ml/weights/`` and evaluated here with plain NumPy, so the deployed API needs no deep-learning library.
"""
