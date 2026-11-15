// Public files of the Sky globe. Kept apart from sky-globe.tsx so that importing a URL (the flat
// fallback map does) does not pull three.js into the page: the globe itself is loaded on demand.
// The textures are made by scripts/make_sky_texture.py and documented in spherex-sky.json.

export const SKY_TEXTURE_4K = "/textures/spherex-sky-rgb-4k.webp";
export const SKY_TEXTURE_2K = "/textures/spherex-sky-rgb-2k.webp";
/** Twice the detail of the 4k map; fetched on desktops once the camera comes close. */
export const SKY_TEXTURE_8K = "/textures/spherex-sky-rgb-8k.webp";
/** One SPHEREx colour (about 1.25 um) on its own, in grey. Loaded only when asked for. */
export const SKY_TEXTURE_MONO = "/textures/spherex-sky-mono-4k.webp";
