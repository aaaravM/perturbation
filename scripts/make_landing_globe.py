"""Still of the SPHEREx all-sky globe for the home page.

The home page draws the globe live with WebGL (frontend/src/components/landing/globe-gl.ts). This
still is the same view at rest: shown before WebGL starts, when motion is reduced, and as the Sky
card's preview. It uses the same projection and shading as the shader, so the two line up.

Projection: orthographic globe seen from outside, mirrored so that it reads like the sky from
Earth (north up, east to the left), centred on RA0, Dec0.

Run from the repo root:
    uv run --project backend python scripts/make_landing_globe.py
"""

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
TEXTURE = ROOT / "frontend/public/textures/spherex-sky-rgb-4k.webp"
OUT = ROOT / "frontend/public/landing/globe-hero.webp"

# Keep in step with HERO_VIEW in frontend/src/components/landing/story-data.ts.
RA0, DEC0 = 300.0, 18.0
SIZE = 1200


def main() -> None:
    tex = np.asarray(Image.open(TEXTURE).convert("RGB"), dtype=np.float32) / 255.0
    th, tw, _ = tex.shape

    a, d = np.radians(RA0), np.radians(DEC0)
    e_z = np.array([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)])
    e_up = np.array([-np.sin(d) * np.cos(a), -np.sin(d) * np.sin(a), np.cos(d)])
    e_right = np.array([np.sin(a), -np.cos(a), 0.0])  # east to the left

    r = SIZE / 2
    j, i = np.meshgrid(np.arange(SIZE) + 0.5, np.arange(SIZE) + 0.5)
    qx, qy = (j - r) / r, (i - r) / r
    r2 = qx**2 + qy**2
    inside = r2 < 1.0
    z = np.sqrt(np.clip(1.0 - r2, 0.0, 1.0))
    vx, vy = qx, -qy
    s = vx[..., None] * e_right + vy[..., None] * e_up + z[..., None] * e_z
    ra = np.mod(np.arctan2(s[..., 1], s[..., 0]), 2 * np.pi)
    dec = np.arcsin(np.clip(s[..., 2], -1.0, 1.0))

    # Bilinear lookup; RA wraps, Dec clamps.
    u = ra / (2 * np.pi) * tw - 0.5
    v = (0.5 - dec / np.pi) * th - 0.5
    u0 = np.floor(u).astype(int)
    v0 = np.clip(np.floor(v).astype(int), 0, th - 1)
    fu, fv = (u - u0)[..., None], (v - np.floor(v))[..., None]
    u1 = (u0 + 1) % tw
    u0 %= tw
    v1 = np.clip(v0 + 1, 0, th - 1)
    col = (
        tex[v0, u0] * (1 - fu) * (1 - fv)
        + tex[v0, u1] * fu * (1 - fv)
        + tex[v1, u0] * (1 - fu) * fv
        + tex[v1, u1] * fu * fv
    )

    # Limb shading and a one-pixel soft edge, as in the shader.
    t = np.clip(z / 0.5, 0.0, 1.0)
    shade = 0.55 + 0.45 * (t * t * (3 - 2 * t))
    col *= shade[..., None]
    rho = np.sqrt(r2)
    k = np.clip((rho - 0.86) / 0.14, 0.0, 1.0)
    col += (0.10 * k * k * (3 - 2 * k))[..., None]  # faint rim, so the sphere reads as a globe
    alpha = np.clip((1.0 - np.sqrt(r2)) * r, 0.0, 1.0) * inside

    rgba = np.dstack([np.clip(col, 0, 1), alpha]) * 255.0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba.astype(np.uint8), "RGBA").save(OUT, "WEBP", quality=84, method=6)
    print(OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
