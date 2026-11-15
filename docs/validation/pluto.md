# Pluto in SPHEREx: validation

*Measured on 2026-11-15 from SPHEREx Level-2 images of releases DR1 and QR3. Every number below is in
[`frontend/public/planet-x/pluto.json`](../../frontend/public/planet-x/pluto.json) or was printed by the scripts that
write it: [`scripts/pluto_scan_s3.py`](../../scripts/pluto_scan_s3.py) (finds the images),
[`scripts/pluto_measure.py`](../../scripts/pluto_measure.py) (measures Pluto in each),
[`scripts/pluto_products.py`](../../scripts/pluto_products.py) (blinks, spectrum, stacks, summary) and
[`scripts/pluto_planetx_facts.py`](../../scripts/pluto_planetx_facts.py) (the Planet X geometry). Pluto's predicted
positions come from JPL Horizons (target 999, Pluto itself; ephemeris `plu060_merged`).*

## In plain words

Pluto was the original "Planet X": Clyde Tombaugh found it in 1930 by blinking two photographic plates taken six
days apart and spotting the one dot that had moved. We did the same search in SPHEREx's infrared images.

- **SPHEREx saw Pluto 236 times.** Pluto lands on a detector in 236 SPHEREx images (118 exposures, each read by
  two detectors that share the sky behind a beam splitter), in four visits: late April 2025, late September to mid
  October 2025, late April to mid May 2026 and early October 2026. Together they cover 0.74 to 5.01 µm.
- **It is where JPL predicts, to a fraction of an arcsecond.** In the 59 cleanest measurements, SPHEREx's
  position for Pluto differs from JPL's prediction by 0.18 arcsec (east) and 0.20 arcsec (north) rms, a thirtieth
  of a 6.15-arcsec pixel. The mean offset is 0.015 ± 0.010 arcsec east and 0.012 ± 0.009 arcsec north.
- **The spot is Pluto, not a star.** Where Pluto was, the same sky imaged on other dates, after Pluto had moved
  on, holds a median of −0.4% of Pluto's brightness: nothing. Pluto moved 72 to 300 arcsec across the stars within
  each visit and 2.4 to 4.1 degrees between visits.
- **SPHEREx sees Pluto's methane ice.** Pluto's infrared colours dip where methane ice absorbs sunlight: by 31% at
  1.6 to 1.8 µm, 62% at 2.15 to 2.45 µm and 89% at 3.05 to 3.65 µm, each relative to the neighbouring wavelengths.
- **A single SPHEREx exposure reaches about magnitude 17.7** (AB, 5 sigma, 0.75 to 3.8 µm) at Pluto's position,
  and 17.1 at 3.8 to 5 µm.
- **Could SPHEREx find a new Planet X? Not one like the predicted Planet Nine.** It would be about 3 magnitudes
  (14 to 21 times) fainter than SPHEREx's four-survey depth at 3.4 µm, and from 300 au or more it moves at most about
  five pixels during a week-long visit. What SPHEREx can catch is nearby objects that move fast, like the cold brown
  dwarf WISE 0855−0714, found by its motion in WISE images.

## 1. Finding the images

IRSA's image search (SIA), TAP and IBE search returned HTTP 502 for most requests on 15 November 2026, while its
file server and the public S3 copy of the data (`nasa-irsa-spherex`) kept working. So instead of asking the search
service, [`pluto_scan_s3.py`](../../scripts/pluto_scan_s3.py) reads the FITS headers directly
([`pluto_find.py`](../../scripts/pluto_find.py) does the same job with SIA when it works):

1. Pluto's geocentric track from Horizons in 6-hour steps, 2025-04-20 to 2026-11-16: 9.43 degrees long, RA
   304.1 to 308.6 degrees, Dec −23.7 to −22.8 degrees. Cubic interpolation of this table agrees with Horizons
   computed at the exact exposure times to 4 × 10⁻⁶ arcsec.
2. The S3 listing has 151 half-week folders of Level-2 files (DR1: 2025 week 17 to 2026 week 20; QR3: 2026 weeks
   20 to 40). We scanned the 65 folders in which Pluto's solar elongation was between 80 and 140 degrees at some
   point of the week (SPHEREx observes roughly at right angles to the Sun or further from it; the images found
   turned out to be at 89.6 to 119.2 degrees). Some folders hold a main processing run and a small `l2b_retry` run;
   both are read.
3. For each of the 43,977 observations in those folders, one ~26 kB range read of the middle detector's first
   exposure gives its pointing (CRVAL) and time (MJD-AVG). Observations whose pointing was within 12 degrees of
   Pluto then had their other detectors' headers read, and every exposure of any detector that could hold Pluto
   (1,076 headers) was checked: 258 candidates.
4. Exact check with each file's own header: Pluto's direction at MJD-AVG is moved from the geocentre to SPHEREx
   (the header's X_SC, Y_SC, Z_SC; a shift of 0.11 arcsec median, 0.17 arcsec at most) and must land on the
   2040 × 2040 detector through the file's TAN-SIP WCS. 236 do; 22 candidates fall just off the detector. The
   wavelength at Pluto's pixel comes from each file's WCS-WAVE table.

| Visit (`visit` in pluto.json) | Dates (UTC) | Release | Images (exposures) | Clean | Wavelengths | Solar elongation | Pluto moved |
|---|---|---|---:|---:|---|---|---:|
| 0 | 2025-04-25 to 05-01 | DR1 | 10 (5) | 9 | 1.21–4.57 µm | 91.4–97.4° | 95″ |
| 1 | 2025-09-25 to 10-12 | DR1 | 108 (54) | 91 | 0.75–4.98 µm | 102.0–119.2° | 300″ |
| 2 | 2026-04-25 to 05-12 | DR1 | 98 (49) | 91 | 0.74–4.99 µm | 89.6–106.7° | 220″ |
| 3 | 2026-09-29 to 10-02 | QR3 | 20 (10) | 17 | 1.63–5.01 µm | 113.6–116.5° | 72″ |

Detectors: D1 38, D2 38, D3 42, D4 38, D5 38, D6 42 images. During these visits Pluto was 34.85 to 35.49 au from
Earth, at V = 14.51 to 14.57 (Horizons), and moved 0.13 to 1.31 arcsec per hour. Over the whole Horizons track the
rate ranges from 0.07 to 4.8 arcsec per hour: SPHEREx sees Pluto 90 to 120 degrees from the Sun, near the times
when its apparent motion slows and reverses (0.065 arcsec per hour on 14 October 2025, 100 degrees from the Sun),
not near opposition (3.5 arcsec per hour in July 2025) or conjunction, when it moves fastest (4.8 arcsec per hour
in late January 2026, 4 degrees from the Sun).
Every exposure lasts 113.6 s; the PSF FWHM in the headers is 7.4 to 9.0 arcsec (median 8.1).

## 2. Measuring Pluto

For each image, [`pluto_measure.py`](../../scripts/pluto_measure.py) reads a 49 × 49 pixel stamp around the
predicted position and measures, with the project's forced photometry and the file's own ePSF:

- the flux at the predicted position, with its error and the pixel flags;
- a fitted position, compared with the prediction (measured minus predicted, east and north);
- the 5-sigma depth of the same estimator: 5 × 1.4826 × MAD of the fluxes at up to 40 random positions in the
  stamp, at least 5 pixels from Pluto;
- the static sky: the flux at Pluto's position in other images of the same detector taken while Pluto was at
  least 40 arcsec away.

**The pipeline flags Pluto as an outlier.** With the Lab's science mask, 17.8% of the pixels within 1.5 pixels of
Pluto carried the OUTLIER flag ("Pixel flagged by Detect Outliers"), against 1.2% of the pixels more than 6 pixels
away, and 118 of the 236 images had at least one flagged pixel on Pluto. Those pixels hold Pluto's light: keeping
them changes Pluto's flux by a factor of 1.000 (median; 10th to 90th percentile 0.991 to 1.020; 44 images with S/N
above 10 and 1 to 3 flagged core pixels). So the measurement clears OUTLIER within 2.5 pixels of the predicted
position (126 images had it there) and keeps every other flag. The median S/N rises from 7.6 to 12.4. The flux
with the plain science mask stays in the measurement file for comparison.

**Clean measurements** (208 of 236) are inside the stamp, unsaturated, have no masked pixel in Pluto's 3 × 3 core
and no known source under Pluto. Excluded: 3 too close to the detector edge, 1 saturated (OVERFLOW), 10 with a
static source under Pluto (more than 3 sigma and more than 3% of Pluto's flux) and 14 with a masked core pixel.
Of the 208, 197 have S/N of at least 3 and 161 of at least 5; the median S/N is 13.0 and the highest 68.0.

## 3. Results

### Position

| Selection | n | Median offset (E, N) | Weighted mean (E, N) | rms (E, N) | 90% within | Largest |
|---|---:|---|---|---|---:|---:|
| Clean, fitted S/N ≥ 20 | 59 | −0.003″, +0.033″ | +0.015 ± 0.010″, +0.012 ± 0.009″ | 0.18″, 0.20″ | 0.41″ | 0.77″ |
| Clean, fitted S/N ≥ 10 | 121 | +0.045″, +0.060″ | +0.054 ± 0.009″, +0.019 ± 0.009″ | 1.28″, 0.28″ | 0.71″ | 8.6″ |

In the S/N ≥ 20 set the formal position errors (median 0.082 arcsec) are too small by a factor of about 2.3 (reduced
chi-square 4.8 east, 5.5 north), so a single exposure locates Pluto to about 0.2 arcsec. The S/N ≥ 10 set's large
east scatter comes from three methane-band measurements (D4, 3.4 to 3.6 µm, 12 October 2025) that sit 6 to 9 arcsec
east: the static sky at Pluto's position holds 21 to 41% of Pluto's (faint) flux there, below the blend threshold.
Per visit (clean, S/N ≥ 10), the median offsets are +0.22″ E, +0.01″ N (4 images), +0.07″, +0.09″ (51), +0.04″,
−0.04″ (57) and −0.11″, +0.15″ (9).

### Is it Pluto?

- It is at the predicted position in all four visits, to a fraction of an arcsecond (above), while it moved 72 to
  300 arcsec across the stars within each visit and 2.4 to 4.1 degrees between visits.
- The same sky without Pluto is empty: in the 122 images that have a later or earlier image of the same detector
  covering Pluto's position after Pluto left, the static flux there is −0.4% of Pluto's flux (median; 10th to 90th
  percentile −8.3% to +10.5%). The 10 exceptions are the blends excluded above.
- The sky-fixed blink in the bundle shows it directly: Pluto moves 55 arcsec in 2.7 days past stars that stay put.

### Brightness and spectrum

Pluto with Charon (unresolved) is AB magnitude 14.24 below 1 µm (median of 22 clean measurements). The spectrum
averages the clean measurements in 30 logarithmic wavelength bins (inverse-variance means; errors scaled up by the
square root of the reduced chi-square where the points scatter more than their errors). To show where Pluto is
darker than sunlight, each bin is divided by a 5772 K blackbody (the IAU nominal solar temperature, a rough
stand-in for the solar spectrum) scaled to Pluto below 1 µm.

| Band (marked on the page) | Relative reflectance in the band | Continuum used | Depth | References |
|---|---|---|---|---|
| 1.60–1.80 µm | 0.82 | 1.19 at 1.45–1.60 µm | 0.31 ± 0.02 | Cruikshank, Pilcher & Morrison 1976; Grundy, Schmitt & Quirico 2002 |
| 2.15–2.45 µm | 0.43 | 1.12 at 1.80–2.05 µm | 0.62 ± 0.03 | Protopapa et al. 2017; Grundy, Schmitt & Quirico 2002 |
| 3.05–3.65 µm | 0.088 | 0.83 at 2.60–2.85 µm | 0.89 ± 0.015 | Grundy, Schmitt & Quirico 2002; Olkin et al. 2007 |

All three are methane-ice absorptions. Methane was first found on Pluto in 1976 by comparing its brightness at
1.55 and 1.73 µm, the first of these bands. Other dips are not marked: the 1.36 µm bin (0.79 ± 0.02) is not
identified in the references used here, the 2.92 µm bin (0.50 ± 0.08) scatters strongly (reduced chi-square 29.5),
and the 0.89 µm methane band reported by Protopapa et al. 2017 is at most a 4% dip in these data (0.96 ± 0.015 at
0.87 µm).

### Depth

| Wavelengths | Images | Median 5-sigma depth (AB) | 10th–90th percentile |
|---|---:|---:|---|
| 0.75–3.8 µm | 155 | 17.75 | 17.37–18.12 |
| 3.8–5.0 µm | 81 | 17.09 | 16.55–17.53 |

Crill et al. 2025 give 18.5 to 19 AB at 0.75 to 3.8 µm and 16.6 to 18 AB at 3.8 to 5 µm for a single 112.5 s
visit; Bock et al. 2026 give 19.5 to 19.9 and 17.8 to 18.8 AB after four all-sky surveys. Our single-exposure
depth is 0.75 to 1.25 magnitudes shallower at the short wavelengths and inside the published range at the long ones.
We did not separate the causes. Pluto lies 3.5 to 4.3 degrees south of the ecliptic, where zodiacal light is
brightest; at Galactic latitude −29 to −32 degrees, random positions include faint stars; and our estimator is
forced photometry at random positions, not the mission's sensitivity model.

## 4. The page bundle

`frontend/public/planet-x/` holds `pluto.json` (139 kB) and 19 PNG images (71 kB). Images are rendered as
the Lab renders frames: north up, 6.15-arcsec pixels, zodiacal light subtracted, the science mask applied (masked
pixels transparent), an asinh stretch with one pair of limits per product. As in the measurement, OUTLIER is
cleared within 2.5 pixels of Pluto. Blink frames need S/N ≥ 20, at most 15% masked pixels (typical frames have 4
to 13%) and a flat background (quadrant medians within one pixel-noise sigma): 47 of 51 candidate frames pass.

- **Tracked blink** (`tracked-0` to `-5`, D1, 0.76 to 1.11 µm): six frames from 25 April to 12 May 2026, centred
  on Pluto's predicted position; Pluto stays in the middle while the stars stream 220 arcsec past it.
- **Sky-fixed blink** (`skyfixed-0` to `-2`, D1): one fixed patch of sky on 25, 26 and 27 April 2026; Pluto moves
  55 arcsec (9 pixels) past fixed stars.
- **Spectrum**: every clean measurement (wavelength, bandwidth, flux, error, detector, visit), the 30 bins, the
  sunlight curve and the three bands with their references.
- **Shift-and-stack**, two runs. The S/N here comes from difference images: the static sky (the per-pixel median of
  all the star-aligned frames, which rejects Pluto because it covers any one pixel in only a few of them) is
  subtracted from every frame, and the S/N is an aperture flux (radius 2 pixels) over the scatter of 200 random
  apertures in the same image.
  - *Bright* (`stack-stars`, `stack-pluto`; D1, 19 frames from 9 observations over 17.7 days, path 220 arcsec): on
    the stars, Pluto spreads into a row of nine dots with S/N 2.6 to 10.9 each; on Pluto's motion it is one point
    and the stars become dotted trails. Pluto is bright here (single-frame S/N 76), and the stacked S/N (64) is
    limited by the residuals of stars that change brightness from frame to frame (each frame is at a different
    wavelength), not by noise.
  - *Faint* (`stack-faint-*`; D6, 4.42 to 4.94 µm, 17 frames from 7 observations over 12.4 days, path 265 arcsec):
    Pluto's median S/N in a single difference frame is 2.5 (13 frames measurable); stacked on its motion it is
    7.3, close to the √N expectation of 8.9 for the 13 measurable frames; stacked on the stars, the dots have S/N
    −1.5 to 1.9. The `-diff-single`, `-diff-stars` and `-diff-pluto` images show the difference frames in units of
    their own pixel noise (linear, ±5 sigma).

## 5. Could SPHEREx find a new Planet X?

- **Too faint.** Brown & Batygin 2016 put Planet Nine at V = 22 to 25. Their 2021 estimate of its orbit has a
  semi-major axis of about 380 au, a perihelion of about 300 au and about 6 Earth masses. A search of Zwicky
  Transient Facility data ruled out 56% of the predicted parameter space (Brown & Batygin 2022); with Pan-STARRS
  and Dark Energy Survey searches added, 78% is ruled out, and much of the rest is fainter than V = 21 (Brown,
  Holman & Batygin 2024). For a 10-Earth-mass planet at 700 au, Linder & Mordasini 2016 estimate V = 21.7,
  L = 20.1 and WISE W1 = W2 = 20.1 (Vega). With the WISE Vega-to-AB offsets (+2.699 for W1, +3.339 for W2),
  that is 22.8 AB at 3.4 µm and 23.4 AB at 4.6 µm: 2.9 to 3.3 magnitudes (14 to 21 times) below SPHEREx's four-survey depth of 19.5 to 19.9 AB at 3.4 µm, and 4.6 to 5.6 magnitudes below
  17.8 to 18.8 AB at 4.6 µm. A single exposure (17.7 AB measured here) is shallower still.
- **Little motion within a visit, a long jump between visits.** SPHEREx sees a given patch of sky about every six
  months, from opposite sides of Earth's orbit, so between two visits the baseline is about 2 au across the line of
  sight. For circular, coplanar orbits ([`pluto_planetx_facts.py`](../../scripts/pluto_planetx_facts.py)) the apparent
  shift between two visits at right angles to the Sun is 1,251 to 1,500 arcsec (203 to 244 pixels) at 300 au, 767 to
  883 arcsec (125 to 144 pixels) at 500 au and 392 to 433 arcsec (64 to 70 pixels) at 1,000 au. Within a 7-day visit
  seen 89.6 to 119.2 degrees from the Sun (the range of the Pluto images), the planet's track is 1.3 to 31.2, 1.0 to
  19.3 and 0.7 to 10.0 arcsec long (at most 5.1, 3.1 and 1.6 pixels). The motion is mostly parallax: it is shortest
  near 90 degrees, where Earth moves almost along the line of sight and the apparent motion stops and reverses, and
  longest at 112 to 119 degrees. The same model at 35 au gives 1.35 arcsec per hour at 119 degrees and 0.17 at 102
  degrees; Horizons gives Pluto 1.31 and 0.13 at the start (119.2 degrees) and end (102.0 degrees) of visit 1. Pluto
  moved 72 to 300 arcsec within each visit.
- **What SPHEREx can catch instead: nearby objects that move fast.** The cold brown dwarf WISE 0855−0714, 2.2 pc
  away and 225 to 260 K, was found because it moved 8.1 arcsec a year in multi-epoch WISE images (Luhman 2014);
  this project's mover finder recovers it as a faint mover-like spot in SPHEREx images
  ([movers validation](movers.md)).

## 6. What went wrong or is uncertain

- **IRSA's search services were down** (HTTP 502) from about 01:26 PT on 15 November 2026. The S3 header scan
  replaced them. It scans only folders with Pluto's solar elongation between 80 and 140 degrees; all 236 images
  found are at 89.6 to 119.2 degrees.
- **Horizons rejected time lists of 100 times** (a 2.2 kB URL) with HTTP 502; requests now carry at most 50
  ([`pxh.sky.horizons`](../../backend/src/pxh/sky/horizons.py)).
- **The first stacks failed.** Measured on the raw co-adds, smeared stars dominated the random-aperture noise, and
  frames narrower than 7 arcmin left no room for random apertures; the S/N now comes from difference images and
  stack frames are at least 6 arcmin wide.
- **Charon is not resolved.** Charon orbits 19,596 km from Pluto, at most about 0.8 arcsec at 35 au, well inside
  one pixel: every flux is Pluto plus Charon, and the light centre shifts slightly as Charon orbits.
- **Pluto's brightness can change as it rotates** (once every 6.387 days), and the spectrum combines dates: some
  bins scatter more than their errors (reduced chi-square up to 38).
- **The sunlight curve is a blackbody**, which differs from the real solar spectrum by more than the smallest
  features; only dips far larger than that (31 to 89%) are marked.
- **Position errors** from the fit are about 2.3 times too small (above), and only 122 of the 236 images have a
  static-sky check; a faint star under Pluto in the others would go unnoticed.

## References

- Bock, J. J., et al. 2026, ApJ, 999, 139. doi:10.3847/1538-4357/ae2be2
- Brown, M. E. & Batygin, K. 2016, ApJL, 824, L23. doi:10.3847/2041-8205/824/2/L23
- Brown, M. E. & Batygin, K. 2021, AJ, 162, 219. doi:10.3847/1538-3881/ac2056
- Brown, M. E. & Batygin, K. 2022, AJ, 163, 102. doi:10.3847/1538-3881/ac32dd
- Brown, M. E., Holman, M. J. & Batygin, K. 2024, AJ, 167, 146. doi:10.3847/1538-3881/ad24e9
- Crill, B. P., et al. 2025, ApJS, 281, 10. doi:10.3847/1538-4365/ae04cc
- Cruikshank, D. P., Pilcher, C. B. & Morrison, D. 1976, Science, 194, 835. doi:10.1126/science.194.4267.835
- Explanatory Supplement to the WISE All-Sky Data Release Products, section IV.4.h, Table 3 (Vega to AB offsets)
- Grundy, W. M., Schmitt, B. & Quirico, E. 2002, Icarus, 155, 486. doi:10.1006/icar.2001.6726
- IAU 2015 Resolution B3 (nominal solar effective temperature, 5772 K)
- Linder, E. F. & Mordasini, C. 2016, A&A, 589, A134. arXiv:1602.07465
- Luhman, K. L. 2014, ApJL, 786, L18. doi:10.1088/2041-8205/786/2/L18
- NASA Space Science Data Coordinated Archive, Pluto fact sheet (rotation period, Charon's distance)
- Olkin, C. B., et al. 2007, AJ, 133, 420. doi:10.1086/509616
- Protopapa, S., et al. 2017, Icarus, 287, 218. doi:10.1016/j.icarus.2016.11.028
- Tombaugh, C. W. 1946, Astronomical Society of the Pacific Leaflet No. 209; Lowell Observatory archives (plates of
  23 and 29 January 1930, the discovery on the blink comparator on 18 February 1930, the announcement on 13 March 1930)
