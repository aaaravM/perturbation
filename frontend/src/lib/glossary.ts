// Plain-language explanations for the technical words used across the site.
// Used by <Term k="..."> (components/ui/term.tsx): a dotted underline with a small "?" that explains on hover, focus or tap.

export interface GlossaryEntry {
  term: string;
  short: string;
}

export const GLOSSARY = {
  spherex: { term: "SPHEREx", short: "NASA's infrared space telescope, launched in March 2025. It maps the entire sky every six months in 102 colours of infrared light." },
  infrared: { term: "Infrared", short: "Light with longer wavelengths than our eyes can see. It passes through dust and shows cool objects such as brown dwarfs." },
  micron: { term: "Micron (µm)", short: "One millionth of a metre. SPHEREx sees wavelengths from 0.75 to 5 µm; visible light is about 0.4 to 0.7 µm." },
  wavelength: { term: "Wavelength", short: "The distance between crests of a light wave. Different wavelengths are different colours of light." },
  channels: { term: "102 colours", short: "SPHEREx splits its 0.75–5 µm range into 102 narrow channels, 17 on each of its 6 detectors, so every spot on the sky gets a spectrum." },
  detector: { term: "Detector", short: "One of SPHEREx's six infrared camera chips, D1 to D6. Each covers a different slice of wavelengths, from D1 (shortest) to D6 (longest)." },
  epoch: { term: "Epoch", short: "One visit by SPHEREx to a patch of sky. It comes back about every six months, so comparing epochs shows what changed." },
  survey: { term: "Survey (S1–S4)", short: "SPHEREx maps the sky in passes. S1 and S2 were its first year, with the telescope turned 180° between them; S3 and S4 are year two." },
  blink: { term: "Blink", short: "Flipping quickly between images of the same sky taken at different times. Anything that moved or changed brightness jumps out. Pluto was found this way in 1930." },
  coadd: { term: "Co-add", short: "Several exposures stacked into one image, which brings out faint objects and averages away noise." },
  difference: { term: "Difference image", short: "One image subtracted from another. Things that did not change cancel out; a mover leaves a dark-and-bright pair and a changing star glows or darkens." },
  properMotion: { term: "Proper motion", short: "How fast a star drifts across the sky over the years, in arcseconds per year. Nearby, fast stars move the most." },
  arcsecond: { term: "Arcsecond (″)", short: "A tiny angle: 1/3600 of a degree. The full Moon is about 1,800 arcseconds across." },
  arcminute: { term: "Arcminute (′)", short: "1/60 of a degree, or 60 arcseconds. The full Moon is about 30 arcminutes across." },
  positionAngle: { term: "Position angle (PA)", short: "The direction something moves or points on the sky, measured from north towards east: 0° is north, 90° is east." },
  parallax: { term: "Parallax", short: "The small yearly wobble of a nearby star caused by Earth orbiting the Sun. The bigger the wobble, the closer the star: it is how distances are measured." },
  lightYear: { term: "Light-year", short: "The distance light travels in a year, about 9.46 trillion kilometres." },
  parsec: { term: "Parsec", short: "About 3.26 light-years: the distance at which a star's parallax is one arcsecond." },
  magnitude: { term: "Magnitude", short: "Astronomers' brightness scale, where smaller numbers are brighter. Five magnitudes is a factor of 100. The faintest stars you can see by eye are about magnitude 6." },
  abMagnitude: { term: "AB magnitude", short: "A magnitude scale tied to a fixed amount of energy per frequency, so brightness can be compared fairly across wavelengths." },
  flux: { term: "Flux (µJy)", short: "How much light arrives from an object at a given wavelength. A microjansky (µJy) is a tiny unit of it." },
  spectrum: { term: "Spectrum", short: "An object's brightness measured across many wavelengths. Its shape reveals temperature and molecules such as water and methane." },
  spectralType: { term: "Spectral type", short: "A star's class from its spectrum, from hot O and B stars to cool M stars. L, T and Y are brown dwarfs." },
  colourIndex: { term: "Colour index (B−V)", short: "How much brighter a star is in blue light than in yellow-green light. Small or negative values mean hot, blue stars; large values mean cool, red ones." },
  brownDwarf: { term: "Brown dwarf", short: "An object bigger than a planet but too small to burn hydrogen like a star. Cool ones glow mostly in infrared light." },
  tDwarf: { term: "T dwarf", short: "A cool brown dwarf, roughly 500–1,300 °C, whose infrared spectrum shows water and methane absorption." },
  redDwarf: { term: "Red dwarf", short: "A small, cool, faint star: the most common kind in our galaxy. Barnard's Star is one." },
  variableStar: { term: "Variable star", short: "A star whose brightness changes over time." },
  mira: { term: "Mira variable", short: "A pulsating red giant that swells and shrinks over months, changing brightness a lot as it does." },
  tTauri: { term: "T Tauri star", short: "A very young star still wrapped in the disk of gas and dust it formed from." },
  saturated: { term: "Saturated", short: "So bright that the detector's pixels filled up. The centre of the image is unreliable, so the star is measured from its outer glow." },
  psf: { term: "PSF", short: "Point spread function: the shape a single point of light makes on the detector. Fitting it gives precise positions and brightness." },
  gaia: { term: "Gaia DR3", short: "Data Release 3 of ESA's Gaia mission: positions, motions, distances and colours for nearly 2 billion stars." },
  hipparcos: { term: "Hipparcos", short: "ESA's earlier star-mapping satellite (1989–1993). It measured positions, motions and distances for about 118,000 bright and nearby stars." },
  wise: { term: "WISE / AllWISE", short: "NASA's Wide-field Infrared Survey Explorer, which mapped the whole sky in infrared around 2010. Comparing it with SPHEREx shows about 15 years of motion." },
  rightAscension: { term: "Right ascension (RA)", short: "Sky longitude, measured eastward along the celestial equator, in hours or degrees." },
  declination: { term: "Declination (Dec)", short: "Sky latitude: degrees north (+) or south (−) of the celestial equator." },
  j2000: { term: "J2000", short: "A standard reference date, 1 January 2000, for star coordinates. Fast stars have moved since then, so we also show where they are now." },
  fieldOfView: { term: "Field of view", short: "How much of the sky an image or view covers." },
  falseColour: { term: "False colour", short: "Invisible infrared wavelengths shown as visible colours: here short wavelengths are blue and long ones red." },
  zodiacal: { term: "Zodiacal light", short: "A faint glow of sunlight scattered by dust in our solar system. It is subtracted from SPHEREx images." },
  flags: { term: "Flags", short: "Labels the SPHEREx pipeline puts on pixels with problems, such as saturation, cosmic-ray hits or detector defects." },
  photocentre: { term: "Photocentre", short: "The light-weighted centre of an image. For two blended stars it shifts when one of them brightens or dims, which can look like motion." },
  sigma: { term: "Signal-to-noise (σ)", short: "How strongly a measurement stands out from random noise. A 5σ result is very unlikely to be a fluke." },
  deepField: { term: "Deep field", short: "Patches near the ecliptic poles that SPHEREx observes almost every orbit, giving dense coverage over time." },
  constellation: { term: "Constellation", short: "One of the 88 official regions of the sky." },
  galactic: { term: "Galactic coordinates", short: "Sky coordinates centred on the Milky Way: galactic latitude 0° runs along the plane of our galaxy." },
  dataRelease: { term: "Data release", short: "A public batch of mission data. SPHEREx DR1 holds its first year; Quick Release 3 adds newer observations every week." },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;
