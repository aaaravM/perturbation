// Plain-language explanations for <Term k="..."> (components/ui/term.tsx): a word with a dotted
// underline and a small "?" that explains itself on hover, keyboard focus or a tap.
//
// The rule for using one:
// - Only genuinely technical words that a curious member of the public would not know, such as
//   arcsecond, proper motion, parallax, epoch, difference image, co-add, magnitude, spectral type,
//   T dwarf, point spread function, RUWE or false-discovery rate.
// - Never plain words, even on a technical page: "102 colours", light-year, constellation,
//   wavelength, infrared, spectrum, field of view, detector, survey, data release.
// - Never on headings, buttons or links, and not where the same sentence already explains it.
// - Only the first occurrence on a page or panel, and at most about two in a paragraph.
// Each explanation is one or two short sentences in plain words, and any number in it is real.

export interface GlossaryEntry {
  term: string;
  short: string;
}

export const GLOSSARY = {
  // Angles, positions and motion on the sky.
  arcsecond: { term: "Arcsecond (″)", short: "A tiny angle: 1/3600 of a degree. The full Moon is about 1,800 arcseconds across." },
  arcminute: { term: "Arcminute (′)", short: "1/60 of a degree, or 60 arcseconds. The full Moon is about 30 arcminutes across." },
  properMotion: { term: "Proper motion", short: "How fast a star drifts across the sky over the years, in arcseconds per year. Nearby, fast stars move the most." },
  positionAngle: { term: "Position angle (PA)", short: "The direction something moves or points on the sky, measured from north towards east: 0° is north, 90° is east." },
  parallax: { term: "Parallax", short: "The small yearly wobble of a nearby star caused by Earth orbiting the Sun. The bigger the wobble, the closer the star: it is how distances are measured." },
  parsec: { term: "Parsec", short: "About 3.26 light-years: the distance at which a star's parallax is one arcsecond." },
  rightAscension: { term: "Right ascension (RA)", short: "Sky longitude, measured eastward along the celestial equator, in hours or degrees." },
  declination: { term: "Declination (Dec)", short: "Sky latitude: degrees north (+) or south (−) of the celestial equator." },
  galactic: { term: "Galactic coordinates", short: "Sky coordinates centred on the Milky Way: galactic latitude 0° runs along the plane of our galaxy." },
  j2000: { term: "J2000", short: "A standard reference date, 1 January 2000, for star coordinates. Fast stars have moved since then, so we also show where they are now." },
  icrs: { term: "ICRS", short: "The International Celestial Reference System: the standard frame that modern sky coordinates are given in, fixed to distant quasars." },
  radialVelocity: { term: "Radial velocity", short: "How fast a star moves towards us (negative) or away from us (positive), measured from the shift of lines in its spectrum." },

  // Brightness, colour and spectra.
  magnitude: { term: "Magnitude", short: "Astronomers' brightness scale, where smaller numbers are brighter. Five magnitudes is a factor of 100. The faintest stars you can see by eye are about magnitude 6." },
  abMagnitude: { term: "AB magnitude", short: "A magnitude scale tied to a fixed amount of energy per frequency, so brightness can be compared fairly across wavelengths." },
  flux: { term: "Flux (µJy)", short: "How much light arrives from an object at a given wavelength. A microjansky (µJy) is a tiny unit of it." },
  micron: { term: "Micron (µm)", short: "One millionth of a metre. SPHEREx sees wavelengths from 0.75 to 5 µm; visible light is about 0.4 to 0.7 µm." },
  colourIndex: { term: "Colour index (B−V)", short: "The difference between a star's blue (B) and yellow-green (V) magnitudes. Small or negative values mean hot, blue stars; large values mean cool, red ones." },
  bpRp: { term: "BP−RP colour", short: "Gaia's colour index: the difference between a star's blue (BP) and red (RP) magnitudes. Small values mean hot, blue stars; large values mean cool, red ones." },
  spectralType: { term: "Spectral type", short: "A star's class from its spectrum, from hot O and B stars to cool M stars. L, T and Y are brown dwarfs." },
  chiSquare: { term: "χ²/dof", short: "How far the brightness points scatter from a flat line, compared with their error bars. About 1 means steady; much more than 1 means the brightness really changes." },
  sigma: { term: "Signal-to-noise (σ)", short: "How strongly a measurement stands out from random noise. A 5σ result is very unlikely to be a fluke." },
  saturated: { term: "Saturated", short: "So bright that the detector's pixels filled up. The centre of the image is unreliable, so the star is measured from its outer glow." },
  psf: { term: "Point spread function (PSF)", short: "The shape a single point of light makes on the detector. Fitting it gives precise positions and brightness." },
  photocentre: { term: "Photocentre", short: "The light-weighted centre of an image. For two blended stars it shifts when one of them brightens or dims, which can look like motion." },
  aperture: { term: "Aperture", short: "A circle drawn around an object in an image; the light inside it is added up to measure how bright the object is." },

  // Kinds of object.
  brownDwarf: { term: "Brown dwarf", short: "An object bigger than a planet but too small to burn hydrogen like a star. Cool ones glow mostly in infrared light." },
  tDwarf: { term: "T dwarf", short: "A cool brown dwarf, about 500 to 1,300 kelvin (roughly 200 to 1,000 °C), whose infrared spectrum shows deep water and methane absorption." },
  redDwarf: { term: "Red dwarf", short: "A small, cool, faint star: the most common kind in our galaxy. Barnard's Star is one." },
  mira: { term: "Mira variable", short: "A pulsating red giant that swells and shrinks over months, changing brightness a lot as it does." },
  tTauri: { term: "T Tauri star", short: "A very young star still wrapped in the disk of gas and dust it formed from." },

  // SPHEREx images.
  epoch: { term: "Epoch", short: "One visit by SPHEREx to a patch of sky. It comes back about every six months, so comparing epochs shows what changed." },
  blink: { term: "Blink", short: "Flipping quickly between images of the same sky taken at different times. Anything that moved or changed brightness jumps out. Pluto was found this way in 1930." },
  coadd: { term: "Co-add", short: "Several exposures stacked into one image, which brings out faint objects and averages away noise." },
  difference: { term: "Difference image", short: "One image subtracted from another. Things that did not change cancel out; a mover leaves a dark-and-bright pair and a changing star glows or darkens." },
  deepField: { term: "Deep field", short: "Patches near the ecliptic poles that SPHEREx observes almost every orbit, giving dense coverage over time." },
  stretch: { term: "Stretch", short: "How pixel values become screen brightness. Linear keeps them in proportion; asinh and log lift faint detail without washing out bright stars." },
  zodiacal: { term: "Zodiacal light", short: "A faint glow of sunlight scattered by dust between the planets. It adds a smooth background to every SPHEREx image." },
  artifact: { term: "Artifact", short: "Something in an image that is not really on the sky, such as a cosmic-ray hit, a detector defect or a reflection." },

  // Catalogues.
  gaia: { term: "Gaia DR3", short: "Data Release 3 of ESA's Gaia mission: positions and brightness for about 1.8 billion stars, with motions and distances for most of them." },
  hipparcos: { term: "Hipparcos", short: "ESA's earlier star-mapping satellite (1989–1993). It measured positions, motions and distances for about 118,000 bright and nearby stars." },
  wise: { term: "WISE / AllWISE", short: "NASA's Wide-field Infrared Survey Explorer, which mapped the whole sky in infrared around 2010. Comparing it with SPHEREx shows about 15 years of motion." },
  catwise: { term: "CatWISE", short: "A catalogue of nearly 1.9 billion infrared sources, with their positions and motions, from NASA's WISE and NEOWISE images taken between 2010 and 2018." },
  ruwe: { term: "RUWE", short: "Gaia's goodness-of-fit for a star's measured position over time. Close to 1 is a clean single star; above about 1.4 often means an unseen companion." },

  // Searching and statistics.
  candidate: { term: "Candidate", short: "Something the search flagged as possibly real and worth a closer look. It is not a discovery until other data confirm it." },
  neuralNetwork: { term: "Neural network", short: "A computer model that learns to recognise patterns from many labelled examples, instead of following rules written by hand." },
  classifier: { term: "Classifier", short: "A model that sorts things into categories: for example a spectrum into a type of star, or a detection into real or artifact." },
  injection: { term: "Injection test", short: "Hiding fake objects of known brightness and motion in real images, then counting how many the search finds. It shows what the search can and cannot see." },
  completeness: { term: "Completeness", short: "The share of real objects of a given brightness that a search actually finds, measured with injection tests." },
  falseAlarm: { term: "False alarm", short: "A detection that looks real but comes from noise or an image artifact." },
  pValue: { term: "p-value", short: "How often noise alone would give a result at least this strong. A small p-value means chance is an unlikely explanation, not that the result is certainly real." },
  qValue: { term: "q-value", short: "A p-value adjusted for testing many candidates at once: the expected share of false alarms among all results at least this strong." },
  falseDiscoveryRate: { term: "False-discovery rate", short: "Of all the candidates a search reports, the share expected to be false alarms." },
  anomaly: { term: "Anomaly", short: "Something that does not fit the patterns a model learned from known objects, flagged for a person to check. It may be rare, or just an artifact." },
  calibratedConfidence: { term: "Calibrated confidence", short: "A score adjusted so it reads as a probability: of all candidates scored 80%, about 80 in 100 should turn out to be real." },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;
